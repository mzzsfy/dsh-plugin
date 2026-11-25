import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createRegistry } from './provider-registry.mjs'
import { createRouter, RECOVERY_PROBE_MS, TRANSIENT_CODES } from './provider-router.mjs'
import { createRecovery, createRecoveryLoop } from './recovery.mjs'
import { tushare } from './providers/tushare.mjs'
import { tencent } from './providers/tencent.mjs'
import { sina } from './providers/sina.mjs'
import { eastmoney } from './providers/eastmoney.mjs'
import { xueqiu } from './providers/xueqiu.mjs'
import { finnhub } from './providers/finnhub.mjs'
import { openState, digest } from './state.mjs'
import { parseConfiguration, preferencesSchema, defaultConfig, klineQuerySchema, refreshSecuritiesSchema, CAPABILITIES, TREND_ROUTE_MIGRATION, tickPeriodMs } from './schemas.mjs'
import { createWatchlistService } from './service.mjs'
import { createBudget } from './budget.mjs'
import { createExecutor } from './executor.mjs'
import { createCollector, deriveDelay } from './collector.mjs'
import { createCatalog } from './catalog.mjs'
import { createDemand } from './demand.mjs'
import { createKlineCache } from './kline-cache.mjs'
import { createTrendCache, trendSessionDate } from './trend-cache.mjs'
import { createTickStore } from './ticks.mjs'
import { fail, parseSecurityId, MARKET_META, clockInZone } from './market-model.mjs'
const WINDOW = 5 * 60 * 1000
// 分时来源(东财/腾讯)的时间戳统一按北京时间给出, 拍点线的横轴必须与之一致, 否则切到离线时整体偏移
const TREND_SOURCE_TIME_ZONE = 'Asia/Shanghai'
const US_SYMBOL_TTL = 24 * 60 * 60 * 1000
const US_SYMBOL_LIMIT = 500
export async function createApplication({ storageDomain, providers = [tushare, tencent, sina, eastmoney, xueqiu, finnhub], publish = () => {}, env = process.env, credentials = null, fetch = globalThis.fetch, now = Date.now, timers = globalThis, vendorAvailable = true }) {
  const serverEpoch = randomUUID(), checks = new Map()
  // 凭据解析: 宿主提供 credentials 服务时交给它(插件存储层优先, 再逐层回退到进程环境与 .env 文件),
  // 否则退回进程环境变量。引用只表示"哪个密钥", 值始终由宿主保管。
  // 接口按能力逐个核对: 宿主给的对象缺哪个方法, 就只退回哪条路径, 而不是在取数时炸掉。
  const credentialStore = credentials && ['resolve', 'set', 'unset'].every(method => typeof credentials[method] === 'function') ? credentials : null
  const resolveCredential = credentialStore ? async ref => (await credentialStore.resolve(ref))?.value : async ref => env[ref]
  let snapshotSeq = 0, stopped = false, collector, catalog, demand, watchlist, recoveryLoop
  let ensuring = null, lastEnsure = -Infinity, ensureError = null, hadDemand = false, ensureCaches = () => {}
  const usSymbols = new Map()
  const touched = () => snapshotSeq++
  const changed = () => { touched(); publish({ type: 'invalidate', serverEpoch, snapshotSeq, scopes: ['snapshot'] }) }
  // 凭据存在性只给设置页看, 而解析是异步的、快照是同步的: 保存配置与启动时各算一次, 快照读这份结果。
  const credentialPresence = new Map()
  const refreshCredentialPresence = async () => {
    for (const p of state.get().providers) {
      credentialPresence.set(`${p.id}:credential`, p.credentialRef === null || !!(await resolveCredential(p.credentialRef)))
      if (p.proxyCredentialRef) credentialPresence.set(`${p.id}:proxy`, !!(await resolveCredential(p.proxyCredentialRef)))
    }
  }
  let state, registry, executor, getControl, router, klineCache, trendCache, ticks
  try {
    state = await openState(storageDomain, changed, now)
    await refreshCredentialPresence()
    registry = createRegistry(providers)
    const budget = createBudget(now)
    // 代理出口: undici ProxyAgent + 同一份 undici.fetch。dispatcher 是 undici 私有契约,
    // Node 内置 fetch 不认 userland dispatcher(invalid onRequestStart method), 不能混用。
    // 包不可用时两者都为 null, 代理实例在请求时明确 NETWORK/502, 不静默直连。
    let proxyFactory = null, proxyFetch = null
    try {
      const undici = await import('undici')
      if (typeof undici.fetch === 'function') { proxyFactory = url => new undici.ProxyAgent(url); proxyFetch = (...args) => undici.fetch(...args) }
    } catch {}
    executor = createExecutor({ registry, budget, env, resolveCredential, fetch, proxyFetch, now, timers, usSymbols, proxyFactory, tickPeriodMs: () => tickPeriodMs(state.get().preferences) })
    getControl = state.get
    // 自动故障切换/手动回主源只换来源: 清掉该路由的退避与失败计数即可, 不能重置 collector。
    // 重置会递增代次并中止在飞请求, 当前刷新随后被判定成"配置已变化"抛假 ROUTE_CONFLICT。
    router = createRouter(getControl, now, routeId => collector?.routeChanged(routeId))
    klineCache = createKlineCache({ cacheTable: state.klineCache, now })
    // 分时当日缓存走独立小池: 它与报价拍点都只放内存, 不入配置记录
    trendCache = createTrendCache({ table: state.trendCache, now })
    ticks = createTickStore({ now })
    // 回探跟着面板活跃走: 有人看时每 RECOVERY_PROBE_MS 把已降级路由的上级全探一遍, 没人看就停
    recoveryLoop = createRecoveryLoop({ probe: createRecovery({ getControl, router, executor }), timers, interval: RECOVERY_PROBE_MS, canRun: () => executor.idle() })
    catalog = createCatalog({ state, getControl, router, executor, registry, now, changed })
    demand = createDemand(() => {
      const wanted = demand.active(), opening = wanted && !hadDemand; hadDemand = wanted
      if (wanted) {
        // 缓存新鲜时进入面板不重复打上游(限流主因); 过期才拉取, 定时器照常量节奏维持
        const freshFor = (getControl().preferences?.refreshSeconds ?? 15) * 1000
        if (opening && !collector?.freshWithin(freshFor)) collector?.refresh(undefined, { automatic: true }).catch(() => {})
        collector?.reconcile()
      } else {
        // 后台预热只在面板空闲时做: 之前只写在 wanted 分支又要求 !demand.active(), 两个条件互斥,
        // 目录/日历永远不会在后台补, 过期目录只能等用户手动同步。
        collector?.cancelIdle(); ensureCaches()
      }
      // 排在首屏刷新之后: 探测也占额度, 不该跟用户要的数据抢顺序
      recoveryLoop.sync(wanted)
    }, now, timers)
    collector = createCollector({ getControl, router, registry, executor, resolveSecurity: catalog.resolve, changed, touched, now, timers, active: demand.active, calendarState: catalog.marketState, ticks })
    watchlist = createWatchlistService(state, catalog.resolve, now)
    // 存量配置升级: 分时能力独立后没有 trend 路由的库在打开时补齐。
    // 补齐失败不该让整个面板躺下(面板可用性高于分时), 记下原因继续, 与目录预热同构
    try { await ensureTrendRoutes() } catch (e) { ensureError = { message: `分时来源补齐失败：${e.message}`, at: now() } }
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
    return { serverEpoch, snapshotSeq, routingRevision: control.routingRevision, control, quotes: collector.watchEntries(), routeSelections: router.selections(), catalogs: catalog.status(), adapters: registry.descriptors(), suggested: defaultConfig(), ensureError, vendorAvailable, providerStatus: control.providers.map(p => ({ id: p.id, credentialPresent: p.credentialRef === null || credentialPresence.get(`${p.id}:credential`) === true, credentialRef: p.credentialRef, proxy: !!p.proxy, proxyCredentialRef: p.proxyCredentialRef ?? null, proxyCredentialPresent: p.proxyCredentialRef ? credentialPresence.get(`${p.id}:proxy`) === true : null, endpointsCovered: Object.keys(p.endpoints || {}).length, recentRequests: executor.recentRequests(p.id) })), klineReady: Object.fromEntries(control.routes.filter(r => r.capability === 'kline').map(r => [r.market, true])), markets: Object.fromEntries(Object.entries(MARKET_META).map(([market, meta]) => [market, { currency: meta.currency, verified: meta.verifiedByDefault }])) }
  }
  function assertLive() { if (stopped) fail('STOPPED', '股票工具已停止', 503) }
  async function providerCheck(input, signal) {
    assertLive()
    const config = parseConfiguration({ providers: input.providers, routes: input.routes })
    const caps = z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length).parse(input.capabilities)
    const at = now()
    for (const [id, check] of checks) if (check.until <= at) checks.delete(id)
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
        // 探针必须由同名能力的端点产出: 适配器拿别的能力冒充(漏实现分支)时不能当就绪, 且要说清是谁被验了
        const ready = result?.status === 'ready' && result.capability === route.capability
        results.push({ key, providerInstanceId: instance.id, capability: route.capability, market: route.market, status: ready ? 'ready' : 'unavailable', ms: now() - startedAt, ...(ready ? {} : { error: { code: 'PROBE_MISMATCH', message: `探针校验的是${result?.capability ?? '未知'}能力` } }) })
      } catch (e) { results.push({ key, providerInstanceId: instance.id, capability: route.capability, market: route.market, status: 'denied', ms: now() - startedAt, error: { code: e.code, message: e.message } }) }
    }
    const checkId = randomUUID()
    checks.set(checkId, { hash: digest(config), until: now() + WINDOW, results })
    // 解除采集暂停只认行情: 分时/目录/K 线的探针失败不该左右行情采集状态机
    const quoteResults = results.filter(r => r.capability === 'quotes')
    if (digest(config) === digest({ providers: getControl().providers, routes: getControl().routes }) && quoteResults.length && quoteResults.every(r => r.status === 'ready')) collector.resume()
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
  // K 线类请求的即时故障转移: 触发码 NETWORK/TIMEOUT/BAD_PAYLOAD 时顺着「环上下一格」试一次;
  // 只有当前选择自己的失败算一轮, 顺着链试备源是同一轮里的补救, 不额外计次
  async function runWithFailover(capability, route, primary, fallbacks, request, signal, reportRound = error => router.recordRound(route.id, error)) {
    const chain = [primary, ...fallbacks]
    let lastError, unsupported
    for (const [index, cand] of chain.entries()) {
      try {
        const result = await executor.run(cand, capability, request, { signal })
        // 当前选择能出数就是最好的证据: 清掉它的失败计数与探测退避
        if (index === 0) reportRound(null)
        return result
      } catch (e) {
        if (signal?.aborted) throw e
        if (index === 0) reportRound(e)
        // 备源不支持这个能力就继续试下一个; 用户该看到的是主源的真实错误, 不是备源的描述符差异
        if (e.code === 'UNSUPPORTED_CAPABILITY') { unsupported ??= e; continue }
        lastError = e
        // 分时 429 只说明当前来源这一分钟没额度: 同轮换备源出数, 不能把整轮钉死在限流源上
        const retryable = TRANSIENT_CODES.includes(e.code) || e.code === 'BAD_PAYLOAD' || (capability === 'trend' && e.code === 'RATE_LIMIT')
        if (!retryable) throw e
      }
    }
    throw lastError ?? unsupported
  }
  // 分时没有路由时用户只会看到"未配置数据来源", 看不出缺的是哪一种能力
  function selectRoute(capability, market) {
    try { return router.select(capability, market, 'equity') }
    catch (e) {
      if (capability === 'trend' && e.code === 'NO_ROUTE') fail('NO_ROUTE', '未配置分时来源：请在设置的能力路由里为分时指定来源', 422)
      throw e
    }
  }
  // 分时拆成独立能力之前的存量配置没有 trend 路由: 打开时按适配器能力声明补齐, 优先沿用该市场 K 线的来源。
  // 不能假设某个具体来源: 谁声明了 trend 且覆盖该市场, 谁才有资格承接下来。
  async function ensureTrendRoutes() {
    const control = state.get()
    if (control.routeMigration >= TREND_ROUTE_MIGRATION) return
    const declared = registry.descriptors()
    const capable = (instance, market) => {
      const descriptor = declared.find(d => d.adapterId === instance.adapterId)
      return !!descriptor?.capabilities.includes('trend') && descriptor.markets.includes(market)
    }
    // 市场面取现有任意路由: 分时不依赖 K 线, 用户删掉 K 线路由不代表这个市场不要分时
    const markets = [...new Set(control.routes.map(r => r.market))]
    const missing = [], spares = []
    for (const market of markets) {
      const route = control.routes.find(r => r.market === market && r.capability === 'trend')
      if (!route) {
        const kline = control.routes.find(r => r.market === market && r.capability === 'kline')
        const order = [kline?.primaryInstanceId, ...control.providers.map(p => p.id)].filter(Boolean)
        const target = order.map(id => control.providers.find(p => p.id === id)).find(instance => instance?.enabled !== false && capable(instance, market))
        if (target) missing.push({ id: `${market.toLowerCase()}-trend`, capability: 'trend', market, instrument: 'equity', primaryInstanceId: target.id, fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
        continue
      }
      // 主源不该是唯一来源: 分时只有一个来源时, 它一断就整块空白。把其它声明分时的实例登记为网络失败后的备源
      // 已有备用源的不再追加: 自动切换是用户开关, 迁移既不替他打开, 也不改他已经配好的备用链
      if (route.fallbackInstanceIds.length) continue
      const spare = control.providers.find(p => p.enabled !== false && p.id !== route.primaryInstanceId && capable(p, market))
      if (spare) spares.push({ id: route.id, fallback: spare.id })
    }
    // 一条也补不出来且当前没有任何分时路由, 说明只是「暂时没有可用分时源」: 不烧迁移标记,
    // 之后装上声明分时的源还能自动补; 已有分时路由(或刚补出来)才算迁移完成, 用户删掉后不该复活
    if (!missing.length && !spares.length && !control.routes.some(r => r.capability === 'trend')) return
    const patch = route => {
      const spare = spares.find(s => s.id === route.id)
      return spare ? { ...route, fallbackInstanceIds: [...route.fallbackInstanceIds, spare.fallback], failoverMode: 'network' } : route
    }
    await state.mutate({ operationId: randomUUID(), expectedRevision: control.revision, action: 'trend-routes', payload: { added: missing.map(r => r.id), spared: spares.map(s => s.id) } }, current => ({ ...current, routeMigration: TREND_ROUTE_MIGRATION, routes: [...current.routes.map(patch), ...missing], routingRevision: missing.length || spares.length ? current.routingRevision + 1 : current.routingRevision }))
  }

  // 分时离线兜底: 只续在当日真实分时后面。
  // 没有真实分时打底时, 几个报价点连成的线说明不了走势, 不如把上游错误如实抛出去
  async function offlineTrend(key, error) {
    const { market, securityId } = key
    const cached = await trendCache.get(key)
    if (!cached) return null
    const real = cached.payload.candles || []
    const lastAt = Number(real.at(-1)?.at)
    // 只补最后一根之后、且不在同一分钟的新报价: 早于它的已经在图里, 同一分钟的会画成重复的一根
    const lastMinute = Math.floor(lastAt / 60)
    const extra = Number.isFinite(lastAt) ? ticks.series(securityId, market).filter(point => point.at > lastAt && Math.floor(point.at / 60) > lastMinute) : []
    const appended = extra.map(point => ({ time: clockInZone(TREND_SOURCE_TIME_ZONE, point.at), at: point.at, open: point.price, high: point.price, low: point.price, close: point.price }))
    return {
      ...cached.payload,
      ...(appended.length ? { complete: false } : {}),
      // 拍点只有收盘价: 开高低补齐成同一个值, 否则客户端按 OHLC 校验会把每根都丢掉, 图上仍然是空的
      candles: [...real, ...appended],
      sessionDate: cached.sessionDate,
      offline: { kind: 'cache', cachedAt: cached.cachedAt, appended: appended.length, reason: error.message },
    }
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
      // 分时与日/周/月是两种上游, 各走各的路由: K 线来源不供分时时, 分时不该跟着一起死
      const capability = period === 'trend' ? 'trend' : 'kline'
      const { route, instance, routeEpoch } = selectRoute(capability, exchange)
      // 同轮补救只取环上的下一格: 走到末级时回到主源, 否则末级是死胡同。
      // 分时跳过停用/无预算成员, 与 recordRound 的切换口径一致; K 线维持原语义
      const usable = provider => provider && provider.enabled !== false && provider.budget?.requestsPerMinute !== null
      const next = capability === 'trend' ? router.nextInRing(route.id, instance.id, provider => !usable(provider)) : router.nextInRing(route.id, instance.id)
      const fallbacks = next ? config.providers.filter(p => p.id === next && usable(p)) : []
      const request = { securityId: sid, market: exchange, code, period, adjust: 'qfq', limit }
      if (capability === 'trend') {
        const keyOfSelection = (epoch, instanceId) => ({ market: exchange, code, limit, securityId: sid, routeKey: `${config.routingRevision}:${route.id}:${epoch}:${instanceId}` })
        const key = keyOfSelection(routeEpoch, instance.id)
        const assertRoute = epoch => {
          if (config.routingRevision !== state.get().routingRevision || router.select('trend', exchange).routeEpoch !== epoch) fail('ROUTE_CONFLICT', '分时来源已变化，请重新刷新', 409)
        }
        const result = await trendCache.fetch(key, signal, async (sharedSignal, moveTo) => {
          let epoch = routeEpoch, activeKey = key
          const reportRound = error => {
            assertRoute(epoch)
            router.recordRound(route.id, error)
            const current = router.select('trend', exchange)
            if (current.routeEpoch !== epoch && fallbacks.some(spare => spare.id === current.instance.id)) {
              epoch = current.routeEpoch
              activeKey = keyOfSelection(epoch, current.instance.id)
              moveTo(activeKey)
            }
          }
          try {
            const data = await runWithFailover(capability, route, instance, fallbacks, request, sharedSignal, reportRound)
            assertRoute(epoch)
            await trendCache.put(activeKey, data)
            return { ...data, routeEpoch: epoch }
          } catch (error) {
            if (!sharedSignal.aborted) {
              assertRoute(epoch)
              error.routeEpoch = epoch
            }
            throw error
          }
        }).catch(async error => {
          if (['CANCELLED', 'ROUTE_CONFLICT'].includes(error.code)) throw error
          const epoch = error.routeEpoch ?? routeEpoch
          assertRoute(epoch)
          const current = router.select('trend', exchange)
          const offline = await offlineTrend(keyOfSelection(epoch, current.instance.id), error)
          if (!offline) throw error
          return { ...offline, routeEpoch: epoch }
        })
        assertRoute(result.routeEpoch)
        const sessionDate = result.offline ? result.sessionDate : trendSessionDate(exchange, result)
        return { ...result, source: result.providerInstanceId, revision: config.revision, serverEpoch, routingRevision: config.routingRevision, sessionDate }
      }
      if (force !== '1') {
        for (const cand of [instance, ...fallbacks.filter(spare => spare.id !== instance.id)]) {
          const cached = await klineCache.get({ providerInstanceId: cand.id, market: exchange, period, code, limit }, config.routingRevision)
          if (cached) return { ...cached.payload, source: cand.id, revision: config.revision }
        }
      }
      const result = await runWithFailover(capability, route, instance, fallbacks, request, signal)
      await klineCache.put({ providerInstanceId: result.providerInstanceId, market: exchange, period, code, limit }, result, config.routingRevision)
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
      // 概览时段与采集同源: 都走 catalog.marketState(日历 + 市场本地时段), 不用来源字段猜
      const phase = catalog.marketState(input.market)
      try {
        const route = router.select('quotes', input.market)
        if (route.instance) {
          const result = await executor.run(route.instance, 'quotes', { securities: [{ id: index.id, exchange: index.exchange, code: index.code }], routingRevision: state.get().routingRevision }, { signal: AbortSignal.timeout(5 * 1000) })
          const quote = result.items?.find(q => q.securityId === index.id)
          if (quote && quote.last !== null) { deriveDelay(quote, now, ['trading', 'auction', 'unknown'].includes(phase.state)); overview = { name: index.name, last: quote.last, change: quote.change, changePct: quote.changePct, quoteAt: quote.quoteAt, delayKind: quote.delayKind, delaySeconds: quote.delaySeconds, sessionState: phase.state, source: quote.providerInstanceId } }
        }
      } catch {}
      return { ...await catalog.browse(input), overview, catalogs: catalog.status(), routingRevision: state.get().routingRevision }
    },
    async sync(input) {
      assertLive()
      if (!MARKET_META[input.market] || input.expectedRoutingRevision !== state.get().routingRevision) fail('ROUTE_CONFLICT', '目录路由已变化', 409)
      // 只同步该市场真实配置的能力: 默认参数同时要目录+日历, 没配日历时每次手动同步都必然回一条 NO_ROUTE 错误
      const capabilities = ['catalog', 'calendar'].filter(capability => state.get().routes.some(route => route.capability === capability && route.market === input.market))
      if (!capabilities.length) fail('NO_ROUTE', '该市场未配置目录或日历来源', 422)
      const result = await catalog.sync(input.market, capabilities); collector.reconcile(); return result
    },
    async watchlist(operation) {
      assertLive()
      const result = await watchlist.execute(operation)
      // 移除后立即丢弃该标的行情; 否则已删自选的旧报价仍留在 /snapshot 并无限累积
      if (operation.action === 'remove' && operation.payload?.securityId) collector.prune(operation.payload.securityId)
      collector.reconcile(); return result
    },
    // 密钥只写宿主的凭据存储, 不回显也不落插件状态;引用必须已被某个数据源声明, 插件不越界写别人的密钥空间。
    async credential(input) {
      assertLive()
      if (!credentialStore) fail('UNSUPPORTED', '宿主未提供凭据服务', 501)
      const ref = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).parse(input.ref)
      if (!state.get().providers.some(p => p.credentialRef === ref || p.proxyCredentialRef === ref)) fail('INVALID_REQUEST', '该凭据未被任何数据源使用', 422)
      const value = input.value === null ? null : z.string().min(1).max(512).parse(input.value)
      if (value === null) await credentialStore.unset(ref)
      else await credentialStore.set(ref, value)
      await refreshCredentialPresence()
      // 填入正确密钥后立即解除引用该凭据实例的 AUTH 永久暂停, 不必再点一次"检查所有来源"
      collector.recoverCredential(ref)
      return { ref, present: value !== null }
    },
    async preferences(operation) {
      assertLive()
      const parsed = preferencesSchema.partial().safeParse(operation.payload)
      if (!parsed.success) fail('INVALID_PREFERENCES', '显示偏好无效')
      // partial 会给缺省键补默认值, 合并时只取本次提交的键, 否则半更新会把另一项重置成默认
      const submitted = operation.payload && typeof operation.payload === 'object' ? operation.payload : {}
      const patch = Object.fromEntries(Object.entries(parsed.data).filter(([key, value]) => Object.hasOwn(submitted, key) && value !== undefined))
      const result = await state.mutate({ ...operation, action: 'preferences' }, current => ({ ...current, preferences: { ...current.preferences, ...patch } }))
      collector.reconcile(); return result
    },
    async refresh(input = {}, signal) {
      assertLive()
      if (input.expectedRoutingRevision !== undefined && input.expectedRoutingRevision !== state.get().routingRevision) fail('ROUTE_CONFLICT', '路由配置已变化', 409)
      const submitted = input.securities === undefined ? undefined : refreshSecuritiesSchema.safeParse(input.securities)
      if (submitted && !submitted.success) {
        const [first] = submitted.error.issues, path = first.path.length ? first.path.join('.') : '根'
        fail('INVALID_REFRESH', `刷新证券参数无效：${path} ${first.message}`, 400)
      }
      let quotes
      try { quotes = await collector.refresh(submitted?.data, { signal, automatic: input.automatic === true }) } catch (e) {
        // peek 刷新失败时 collector 里还留着带 lastError 的条目(否则详情只剩"等待报价");
        // 常驻快照按自选过滤会顺手删掉它, 这里在快照构造前抓一份只随本次错误下发的报价。
        const failed = e.quotes ?? collector.entries()
        e.snapshot = { ...snapshot(), quotes: failed }
        throw e
      }
      // peek 报价只随本次响应下发, 不进常驻快照: 详情关闭后服务端不再保留任何非自选报价
      return { ...snapshot(), quotes }
    },
    async routeSelection(input, signal) {
      assertLive()
      const config = state.get(), route = config.routes.find(r => r.id === input.routeId)
      if (!route || input.target !== 'primary' || input.expectedRoutingRevision !== config.routingRevision) fail('ROUTE_CONFLICT', '路由配置已变化', 409)
      const instance = config.providers.find(p => p.id === route.primaryInstanceId)
      const selected = router.selections()[route.id]
      if (selected.routeEpoch !== input.expectedRouteEpoch) fail('ROUTE_CONFLICT', '来源已变化', 409)
      registry.validate(instance, route)
      // 探针按这条路由自身的能力: 用 quotes 探针验 K 线路由会在来源缺报价时误判, 也没验到要切过去的能力
      const checked = await executor.run(instance, route.capability, { capability: route.capability, market: route.market, instrument: route.instrument }, { probe: true, signal })
      if (checked.status !== 'ready' || config.routingRevision !== state.get().routingRevision) fail('CHECK_REQUIRED', '主源未就绪或路由已变化', 422)
      router.switchPrimary(route.id, input.expectedRouteEpoch); return snapshot()
    },
    async close() { stopped = true; recoveryLoop?.stop(); trendCache.dispose(); executor.dispose(); await recoveryLoop?.idle?.(); demand.dispose(); collector.dispose(); const cacheClosed = catalog.dispose(); await cacheClosed; await ensuring; await state.close() },
  }
}
