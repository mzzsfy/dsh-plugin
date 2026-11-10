import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createRegistry } from './provider-registry.mjs'
import { createRouter } from './provider-router.mjs'
import { tushare } from './providers/tushare.mjs'
import { tencent } from './providers/tencent.mjs'
import { sina } from './providers/sina.mjs'
import { eastmoney } from './providers/eastmoney.mjs'
import { xueqiu } from './providers/xueqiu.mjs'
import { finnhub } from './providers/finnhub.mjs'
import { openState, digest } from './state.mjs'
import { parseConfiguration, preferencesSchema, defaultConfig, klineQuerySchema } from './schemas.mjs'
import { createWatchlistService } from './service.mjs'
import { createBudget } from './budget.mjs'
import { createExecutor } from './executor.mjs'
import { createCollector, deriveDelay } from './collector.mjs'
import { createCatalog } from './catalog.mjs'
import { createDemand } from './demand.mjs'
import { createKlineCache } from './kline-cache.mjs'
import { fail, parseSecurityId, MARKET_META } from './market-model.mjs'
const WINDOW = 5 * 60 * 1000
const US_SYMBOL_TTL = 24 * 60 * 60 * 1000
const US_SYMBOL_LIMIT = 500
const PROBE_LIMIT = 512
export async function createApplication({ storageDomain, providers = [tushare, tencent, sina, eastmoney, xueqiu, finnhub], publish = () => {}, env = process.env, credentials = null, fetch = globalThis.fetch, now = Date.now, timers = globalThis, vendorAvailable = true }) {
  const serverEpoch = randomUUID(), checks = new Map()
  // 凭据解析: 宿主提供 credentials 服务时交给它(插件存储层优先, 再逐层回退到进程环境与 .env 文件),
  // 否则退回进程环境变量。引用只表示"哪个密钥", 值始终由宿主保管。
  // 接口按能力逐个核对: 宿主给的对象缺哪个方法, 就只退回哪条路径, 而不是在取数时炸掉。
  const credentialStore = credentials && ['resolve', 'set', 'unset'].every(method => typeof credentials[method] === 'function') ? credentials : null
  const resolveCredential = credentialStore ? async ref => (await credentialStore.resolve(ref))?.value : async ref => env[ref]
  // 目标粒度探针缓存: instanceId:capability:market → {status, until}; 配置保存校验按目标增量引用, 不随无关字段改动失效
  const probeCache = new Map()
  let snapshotSeq = 0, stopped = false, collector, catalog, demand, watchlist
  let ensuring = null, lastEnsure = -Infinity, ensureError = null, hadDemand = false, ensureCaches = () => {}
  const usSymbols = new Map()
  const touched = () => snapshotSeq++
  const changed = () => { touched(); publish({ type: 'invalidate', serverEpoch, snapshotSeq, scopes: ['snapshot'] }) }
  // 凭据存在性只给设置页看, 而解析是异步的、快照是同步的: 保存配置与启动时各算一次, 快照读这份结果。
  const credentialPresence = new Map()
  const refreshCredentialPresence = async () => {
    for (const p of state.get().providers) credentialPresence.set(p.id, p.credentialRef === null || !!(await resolveCredential(p.credentialRef)))
  }
  let state, registry, executor, getControl, router, klineCache
  try {
    state = await openState(storageDomain, changed, now)
    await refreshCredentialPresence()
    registry = createRegistry(providers)
    const budget = createBudget(now)
    // 代理 dispatcher 工厂: undici ProxyAgent(实例级上游出口), 包不可用时该实例代理静默降级直连
    let proxyFactory = null
    try { const undici = await import('undici'); proxyFactory = url => new undici.ProxyAgent(url) } catch {}
    executor = createExecutor({ registry, budget, env, resolveCredential, fetch, now, timers, usSymbols, proxyFactory })
    getControl = state.get
    router = createRouter(getControl, now, () => collector?.reset())
    klineCache = createKlineCache({ cacheTable: state.klineCache, now })
    catalog = createCatalog({ state, getControl, router, executor, registry, now, changed })
    demand = createDemand(() => {
      const wanted = demand.active(), opening = wanted && !hadDemand; hadDemand = wanted
      if (wanted) {
        ensureCaches()
        // 缓存新鲜时进入面板不重复打上游(限流主因); 过期才拉取, 定时器照常量节奏维持
        const freshFor = (getControl().preferences?.refreshSeconds ?? 15) * 1000
        if (opening && !collector?.freshWithin(freshFor)) collector?.refresh().catch(() => {})
        collector?.reconcile()
      } else collector?.cancelIdle()
    }, now, timers)
    collector = createCollector({ getControl, router, registry, executor, resolveSecurity: catalog.resolve, changed, touched, now, timers, active: demand.active, calendarState: catalog.marketState })
    watchlist = createWatchlistService(state, catalog.resolve, now)
    // 面板活跃(demand)时让路: 目录后台同步占满并发槽会拖死交互请求(浏览504实测), 仅在面板空闲时补目录
    ensureCaches = () => {
      if (ensuring || now() - lastEnsure < 60 * 1000 || demand.active()) return
      lastEnsure = now()
      ensuring = catalog.ensure().catch(e => { ensureError = { message: e.message, at: now() }; changed() }).finally(() => { ensuring = null; collector?.reconcile() })
    }
  } catch (e) {
    // 打开成功后任何一步初始化失败都要关域: 否则同名域一直占着已打开槽位, 重载只会一直 already-open。
    // 关域自身抛错不能盖掉原始原因。
    try { await state?.close() } catch {}
    throw e
  }
  const snapshot = () => {
    const control = state.get(); delete control.operations
    return { serverEpoch, snapshotSeq, routingRevision: control.routingRevision, control, quotes: collector.entries(), routeSelections: router.selections(), catalogs: catalog.status(), adapters: registry.descriptors(), suggested: defaultConfig(), ensureError, vendorAvailable, providerStatus: control.providers.map(p => ({ id: p.id, credentialPresent: p.credentialRef === null || credentialPresence.get(p.id) === true, credentialRef: p.credentialRef, proxy: !!p.proxy, endpointsCovered: Object.keys(p.endpoints || {}).length, recentRequests: executor.recentRequests(p.id) })), klineReady: Object.fromEntries(control.routes.filter(r => r.capability === 'kline').map(r => [r.market, true])), markets: Object.fromEntries(Object.entries(MARKET_META).map(([market, meta]) => [market, { currency: meta.currency, verified: meta.verifiedByDefault }])) }
  }
  function assertLive() { if (stopped) fail('STOPPED', '股票工具已停止', 503) }
  async function providerCheck(input, signal) {
    assertLive()
    const config = parseConfiguration({ providers: input.providers, routes: input.routes })
    const caps = z.array(z.enum(['quotes', 'catalog', 'search', 'calendar', 'kline'])).min(1).max(5).parse(input.capabilities)
    const at = now()
    for (const [id, check] of checks) if (check.until <= at) checks.delete(id)
    // 过期目标直接淘汰: 键空间随实例/市场/能力组合有界, 但不留过期条目占位
    for (const [key, entry] of probeCache) if (entry.until <= at) probeCache.delete(key)
    if (checks.size >= 64) fail('CHECK_LIMIT', '检查请求过多，请稍后重试', 429)
    const results = []
    for (const route of config.routes.filter(r => caps.includes(r.capability))) for (const target of [route.primaryInstanceId, ...route.fallbackInstanceIds]) {
      const instance = config.providers.find(p => p.id === target)
      registry.validate(instance, route)
      const key = `${instance.id}:${route.capability}:${route.market}`
      if (results.some(r => r.key === key)) continue
      // 探针耗时就是这一条路由端到端拿数据的真实延迟, 用于把「能不能用」和「快不快」一起回给用户
      const startedAt = now()
      try {
        const result = await executor.run(instance, route.capability, { market: route.market, instrument: route.instrument }, { probe: true, signal })
        const status = result.status === 'ready' ? 'ready' : 'unavailable'
        probeCache.set(key, { status, until: now() + WINDOW })
        while (probeCache.size > PROBE_LIMIT) probeCache.delete(probeCache.keys().next().value)
        results.push({ key, providerInstanceId: instance.id, capability: route.capability, market: route.market, status, ms: now() - startedAt })
      } catch (e) { results.push({ key, providerInstanceId: instance.id, capability: route.capability, market: route.market, status: 'denied', ms: now() - startedAt, error: { code: e.code, message: e.message } }) }
    }
    const checkId = randomUUID()
    checks.set(checkId, { hash: digest(config), until: now() + WINDOW, results })
    if (digest(config) === digest({ providers: getControl().providers, routes: getControl().routes }) && results.length && results.every(r => r.status === 'ready')) collector.resume()
    return { checkId, checks: results }
  }
  async function configuration(operation) {
    assertLive()
    const config = parseConfiguration(operation.payload)
    const replay = state.replay({ ...operation, action: 'configuration', payload: config })
    if (replay) return replay
    // 保存不做连通性闸门: 探针是给人看的诊断信息, 不该把人挡在门外。契约只校验路由自身的合法性,
    // 按能力挑源已经由前端按适配器能力过滤, 后端再校验一次目标是否具备该能力即可。
    for (const route of config.routes) {
      for (const target of [route.primaryInstanceId, ...route.fallbackInstanceIds]) registry.validate(config.providers.find(p => p.id === target), route)
    }
    const result = await state.mutate({ ...operation, action: 'configuration', payload: config }, current => {
      if (JSON.stringify(current.providers) === JSON.stringify(config.providers) && JSON.stringify(current.routes) === JSON.stringify(config.routes)) return current
      return { ...current, ...config, routingRevision: current.routingRevision + 1 }
    })
    if (!result.unchanged) { router.reset(); collector.reset(); await refreshCredentialPresence() }
    return result
  }

  // 搜索候选项服务端补全市场元数据(单一事实源 MARKET_META),client 零映射表。
  function decorateWithMarketMeta(items) {
    for (const item of items) if (item?.exchange && !item.currency) {
      const meta = MARKET_META[item.exchange]
      if (meta) { item.currency = meta.currency; item.priceScale = meta.priceScale }
    }
  }
  // kline 即时故障转移: 触发码 NETWORK/TIMEOUT/BAD_PAYLOAD 且有备源→逐备源各试一次;每次尝试后 recordRound 记账;RATE_LIMIT 不触发。
  async function runWithFailover(route, primary, fallbacks, request, signal) {
    const chain = [primary, ...fallbacks]
    let lastError
    for (const cand of chain) {
      try {
        return await executor.run(cand, 'kline', request, { signal })
      } catch (e) {
        lastError = e
        router.recordRound(route.id, e)
        if (!['NETWORK', 'TIMEOUT', 'BAD_PAYLOAD'].includes(e.code)) throw e
      }
    }
    throw lastError
  }

  return {
    snapshot, providerCheck, configuration,
    demand(message) { assertLive(); demand.update(message) },
    async search(q, phase = 'local', signal) {
      assertLive()
      if (typeof q !== 'string' || [...q].length > 100) fail('INVALID_QUERY', '搜索词过长')
      const items = phase === 'remote' ? await catalog.remote(q, signal) : catalog.search(q)
      decorateWithMarketMeta(items)
      const routingRevision = state.get().routingRevision
      if (phase === 'remote') {
        for (const item of items) {
          const row = item.raw && typeof item.raw === 'object' ? item.raw : null
          if (row?.MktNum && /^10[567]$/.test(row.MktNum)) {
            usSymbols.set(`US:${row.Code}`, { mktNum: row.MktNum, jys: row.JYS || null, at: now() })
            while (usSymbols.size > US_SYMBOL_LIMIT) usSymbols.delete(usSymbols.keys().next().value)
          }
        }
      }
      for (const [key, value] of usSymbols) if (now() - value.at > US_SYMBOL_TTL) usSymbols.delete(key)
      return { items, catalogs: catalog.status(), routingRevision }
    },
    async kline(input, signal) {
      assertLive()
      const parsed = klineQuerySchema.safeParse(input)
      if (!parsed.success) fail('INVALID_PARAM', 'K线请求参数无效', 400)
      const { securityId: sid, period, limit, force } = parsed.data
      let exchange, code
      try { ({ exchange, code } = parseSecurityId(sid)) } catch { fail('INVALID_PARAM', '证券身份无效', 400) }
      const config = state.get()
      const { route, instance } = router.select('kline', exchange, 'equity')
      const fallbacks = route.fallbackInstanceIds.map(id => config.providers.find(p => p.id === id && p.enabled !== false)).filter(Boolean)
      // force=1 跳过缓存读(详情页手动刷新);缓存写入仍按正常策略,失败回源不额外惩罚
      if (force !== '1') {
        for (const cand of [instance, ...fallbacks]) {
          const cached = await klineCache.get({ providerInstanceId: cand.id, market: exchange, period, code }, config.routingRevision)
          if (cached) return { ...cached.payload, source: cand.id, revision: config.revision }
        }
      }
      const result = await runWithFailover(route, instance, fallbacks, { securityId: sid, market: exchange, code, period, adjust: 'qfq', limit }, signal)
      if (period !== 'trend') await klineCache.put({ providerInstanceId: result.providerInstanceId, market: exchange, period, code }, result, config.routingRevision)
      return { ...result, source: result.providerInstanceId, revision: config.revision }
    },
    async browse(input) {
      assertLive()
      if (!MARKET_META[input.market]) fail('INVALID_REQUEST', '市场参数无效')
      // 市场概览: 代表指数不入目录/自选, 走 quotes 管道直拉; 失败静默为 null 不阻断目录浏览
      const INDEX = { XSHG: { id: 'XSHG:index:000001', exchange: 'XSHG', code: '000001', name: '上证指数' }, XSHE: { id: 'XSHE:index:399001', exchange: 'XSHE', code: '399001', name: '深证成指' }, XHKG: { id: 'XHKG:index:HSI', exchange: 'XHKG', code: 'HSI', name: '恒生指数' }, XNAS: { id: 'XNAS:index:NDX', exchange: 'XNAS', code: 'NDX', name: '纳斯达克100' }, XNYS: { id: 'XNYS:index:DJI', exchange: 'XNYS', code: 'DJI', name: '道琼斯' }, XJPX: { id: 'XJPX:index:N225', exchange: 'XJPX', code: 'N225', name: '日经225' }, XKRX: { id: 'XKRX:index:KOSPI', exchange: 'XKRX', code: 'KOSPI', name: '韩国综指' }, XLON: { id: 'XLON:index:FTSE', exchange: 'XLON', code: 'FTSE', name: '富时100' } }
      const index = INDEX[input.market]
      // 概览指数是装饰性数据: 无路由或拉取失败(含5s短超时不与目录翻页争槽)都静默为 null, 不阻断目录浏览
      let overview = null
      try {
        const route = router.select('quotes', input.market)
        if (route.instance) {
          const result = await executor.run(route.instance, 'quotes', { securities: [{ id: index.id, exchange: index.exchange, code: index.code }], routingRevision: state.get().routingRevision }, { signal: AbortSignal.timeout(5 * 1000) })
          const quote = result.items?.find(q => q.securityId === index.id)
          if (quote && quote.last !== null) { deriveDelay(quote, now, quote.sessionState === 'trading'); overview = { name: index.name, last: quote.last, change: quote.change, changePct: quote.changePct, quoteAt: quote.quoteAt, delayKind: quote.delayKind, delaySeconds: quote.delaySeconds, source: quote.providerInstanceId } }
        }
      } catch {}
      return { ...await catalog.browse(input), overview, catalogs: catalog.status(), routingRevision: state.get().routingRevision }
    },
    async sync(input) {
      assertLive()
      if (!MARKET_META[input.market] || input.expectedRoutingRevision !== state.get().routingRevision) fail('ROUTE_CONFLICT', '目录路由已变化', 409)
      const result = await catalog.sync(input.market); collector.reconcile(); return result
    },
    async watchlist(operation) { assertLive(); const result = await watchlist.execute(operation); collector.reconcile(); return result },
    // 密钥只写宿主的凭据存储, 不回显也不落插件状态;引用必须已被某个数据源声明, 插件不越界写别人的密钥空间。
    async credential(input) {
      assertLive()
      if (!credentialStore) fail('UNSUPPORTED', '宿主未提供凭据服务', 501)
      const ref = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).parse(input.ref)
      if (!state.get().providers.some(p => p.credentialRef === ref)) fail('INVALID_REQUEST', '该凭据未被任何数据源使用', 422)
      const value = input.value === null ? null : z.string().min(1).max(512).parse(input.value)
      if (value === null) await credentialStore.unset(ref)
      else await credentialStore.set(ref, value)
      await refreshCredentialPresence()
      return { ref, present: value !== null }
    },
    async preferences(operation) {
      assertLive()
      const parsed = preferencesSchema.partial().safeParse(operation.payload)
      if (!parsed.success) fail('INVALID_PREFERENCES', '显示偏好无效')
      const result = await state.mutate({ ...operation, action: 'preferences' }, current => ({ ...current, preferences: { ...current.preferences, ...parsed.data } }))
      collector.reconcile(); return result
    },
    async refresh(input = {}, signal) {
      assertLive()
      if (input.expectedRoutingRevision !== undefined && input.expectedRoutingRevision !== state.get().routingRevision) fail('ROUTE_CONFLICT', '路由配置已变化', 409)
      if (input.securities && (!Array.isArray(input.securities) || input.securities.length > 100 || input.securities.some(s => typeof s === 'string' ? typeof s !== 'string' : !(typeof s === 'object' && typeof s.id === 'string' && typeof s.exchange === 'string' && typeof s.code === 'string')))) fail('INVALID_REFRESH', '刷新证券参数无效')
      try { await collector.refresh(input.securities, { signal }) } catch (e) { e.snapshot = snapshot(); throw e }
      return snapshot()
    },
    async routeSelection(input, signal) {
      assertLive()
      const config = state.get(), route = config.routes.find(r => r.id === input.routeId)
      if (!route || input.target !== 'primary' || input.expectedRoutingRevision !== config.routingRevision) fail('ROUTE_CONFLICT', '路由配置已变化', 409)
      const instance = config.providers.find(p => p.id === route.primaryInstanceId)
      const selected = router.selections()[route.id]
      if (selected.routeEpoch !== input.expectedRouteEpoch || selected.switchedAt !== null && now() - selected.switchedAt < 10 * 60 * 1000) fail('ROUTE_CONFLICT', '来源已变化或备用驻留期未结束', 409)
      const checked = await executor.run(instance, 'quotes', { market: route.market }, { probe: true, signal })
      if (checked.status !== 'ready' || config.routingRevision !== state.get().routingRevision) fail('CHECK_REQUIRED', '主源未就绪或路由已变化', 422)
      router.switchPrimary(route.id, input.expectedRouteEpoch); return snapshot()
    },
    async close() { stopped = true; demand.dispose(); collector.dispose(); const cacheClosed = catalog.dispose(); executor.dispose(); await cacheClosed; await ensuring; await state.close() },
  }
}
