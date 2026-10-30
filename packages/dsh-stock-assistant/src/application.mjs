import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createRegistry } from './provider-registry.mjs'
import { createRouter } from './provider-router.mjs'
import { tushare } from './providers/tushare.mjs'
import { tencent } from './providers/tencent.mjs'
import { sina } from './providers/sina.mjs'
import { eastmoney } from './providers/eastmoney.mjs'
import { openState, digest } from './state.mjs'
import { parseConfiguration, preferencesSchema, defaultConfig, klineQuerySchema } from './schemas.mjs'
import { createWatchlistService } from './service.mjs'
import { createBudget } from './budget.mjs'
import { createExecutor } from './executor.mjs'
import { createCollector } from './collector.mjs'
import { createCatalog } from './catalog.mjs'
import { createDemand } from './demand.mjs'
import { createKlineCache } from './kline-cache.mjs'
import { fail, parseSecurityId, MARKET_META } from './market-model.mjs'
const WINDOW = 5 * 60 * 1000
const US_SYMBOL_TTL = 24 * 60 * 60 * 1000
export async function createApplication({ storageDomain, providers = [tushare, tencent, sina, eastmoney], publish = () => {}, env = process.env, fetch = globalThis.fetch, now = Date.now, timers = globalThis, vendorAvailable = true }) {
  const serverEpoch = randomUUID(), checks = new Map()
  let snapshotSeq = 0, stopped = false, collector, catalog, demand
  const usSymbols = new Map()
  const touched = () => snapshotSeq++
  const changed = () => { touched(); publish({ type: 'invalidate', serverEpoch, snapshotSeq, scopes: ['snapshot'] }) }
  const state = await openState(storageDomain, changed, now)
  const registry = createRegistry(providers), budget = createBudget(now)
  const executor = createExecutor({ registry, budget, env, fetch, now, timers, usSymbols })
  const getControl = state.get
  const router = createRouter(getControl, now, () => collector?.reset())
  const klineCache = createKlineCache({ cacheTable: state.cache, now })
  catalog = createCatalog({ state, getControl, router, executor, now, changed })
  let ensuring = null, lastEnsure = -Infinity, ensureError = null
  const ensureCaches = () => {
    if (ensuring || now() - lastEnsure < 60 * 1000) return
    lastEnsure = now()
    ensuring = catalog.ensure().catch(e => { ensureError = { message: e.message, at: now() }; changed() }).finally(() => { ensuring = null; collector?.reconcile() })
  }
  let hadDemand = false
  demand = createDemand(() => {
    const wanted = demand.active(), opening = wanted && !hadDemand; hadDemand = wanted
    if (wanted) {
      ensureCaches()
      if (opening) collector?.refresh().catch(() => {})
      collector?.reconcile()
    } else collector?.cancelIdle()
  }, now, timers)
  collector = createCollector({ getControl, router, registry, executor, changed, touched, now, timers, active: demand.active, calendarState: catalog.marketState })
  const watchlist = createWatchlistService(state, catalog.resolve, now)
  const snapshot = () => {
    const control = state.get(); delete control.operations
    return { serverEpoch, snapshotSeq, routingRevision: control.routingRevision, control, quotes: collector.entries(), routeSelections: router.selections(), catalogs: catalog.status(), adapters: registry.descriptors(), suggested: defaultConfig(), ensureError, vendorAvailable, providerStatus: control.providers.map(p => ({ id: p.id, credentialPresent: p.credentialEnv === null || !!env[p.credentialEnv] })), klineReady: Object.fromEntries(control.routes.filter(r => r.capability === 'kline').map(r => [r.market, true])) }
  }
  function assertLive() { if (stopped) fail('STOPPED', '股票工具已停止', 503) }
  async function providerCheck(input, signal) {
    assertLive()
    const config = parseConfiguration({ providers: input.providers, routes: input.routes })
    const caps = z.array(z.enum(['quotes', 'catalog', 'search', 'calendar', 'kline'])).min(1).max(5).parse(input.capabilities)
    const at = now()
    for (const [id, check] of checks) if (check.until <= at) checks.delete(id)
    if (checks.size >= 64) fail('CHECK_LIMIT', '检查请求过多，请稍后重试', 429)
    const results = []
    for (const route of config.routes.filter(r => caps.includes(r.capability))) for (const target of [route.primaryInstanceId, ...route.fallbackInstanceIds]) {
      const instance = config.providers.find(p => p.id === target)
      registry.validate(instance, route)
      const key = `${instance.id}:${route.capability}:${route.market}`
      if (results.some(r => r.key === key)) continue
      try {
        const result = await executor.run(instance, route.capability, { market: route.market, instrument: route.instrument }, { probe: true, signal })
        results.push({ key, providerInstanceId: instance.id, capability: route.capability, market: route.market, status: result.status === 'ready' ? 'ready' : 'unavailable' })
      } catch (e) { results.push({ key, providerInstanceId: instance.id, capability: route.capability, market: route.market, status: 'denied', error: { code: e.code, message: e.message } }) }
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
    const hash = digest(config), valid = (operation.checkIds || []).map(id => checks.get(id)).filter(c => c?.until > now() && c.hash === hash)
    if (config.providers.some(p => p.enabled) && !valid.length) fail('CHECK_REQUIRED', '配置已变化，请重新检查来源能力', 422)
    for (const route of config.routes) for (const target of [route.primaryInstanceId, ...route.fallbackInstanceIds]) {
      const instance = config.providers.find(p => p.id === target); registry.validate(instance, route)
      if (!valid.some(c => c.results.some(r => r.providerInstanceId === target && r.capability === route.capability && r.market === route.market && r.status === 'ready'))) fail('CHECK_REQUIRED', '请先检查所有路由目标能力', 422)
    }
    const result = await state.mutate({ ...operation, action: 'configuration', payload: config }, current => {
      if (JSON.stringify(current.providers) === JSON.stringify(config.providers) && JSON.stringify(current.routes) === JSON.stringify(config.routes)) return current
      return { ...current, ...config, routingRevision: current.routingRevision + 1 }
    })
    if (!result.unchanged) { router.reset(); collector.reset() }
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
          if (row?.MktNum && /^10[567]$/.test(row.MktNum)) usSymbols.set(`US:${row.Code}`, { mktNum: row.MktNum, jys: row.JYS || null, at: now() })
        }
      }
      for (const [key, value] of usSymbols) if (now() - value.at > US_SYMBOL_TTL) usSymbols.delete(key)
      return { items, catalogs: catalog.status(), routingRevision }
    },
    async kline(input, signal) {
      assertLive()
      const parsed = klineQuerySchema.safeParse(input)
      if (!parsed.success) fail('INVALID_PARAM', 'K线请求参数无效', 400)
      const { securityId: sid, period, limit } = parsed.data
      let exchange, code
      try { ({ exchange, code } = parseSecurityId(sid)) } catch { fail('INVALID_PARAM', '证券身份无效', 400) }
      const config = state.get()
      const { route, instance } = router.select('kline', exchange, 'equity')
      const fallbacks = route.fallbackInstanceIds.map(id => config.providers.find(p => p.id === id && p.enabled !== false)).filter(Boolean)
      for (const cand of [instance, ...fallbacks]) {
        const cached = await klineCache.get({ providerInstanceId: cand.id, market: exchange, period, code }, config.routingRevision)
        if (cached) return { data: { ...cached.payload, source: cand.id }, revision: config.revision }
      }
      const result = await runWithFailover(route, instance, fallbacks, { securityId: sid, market: exchange, code, period, adjust: 'qfq', limit }, signal)
      if (period !== 'trend') await klineCache.put({ providerInstanceId: result.providerInstanceId, market: exchange, period, code }, result, config.routingRevision)
      return { data: { ...result, source: result.providerInstanceId }, revision: config.revision }
    },
    async browse(input) {
      assertLive()
      if (!['XSHG', 'XSHE'].includes(input.market)) fail('INVALID_REQUEST', '市场参数无效')
      return { ...await catalog.browse(input), catalogs: catalog.status(), routingRevision: state.get().routingRevision }
    },
    async sync(input) {
      assertLive()
      if (!['XSHG', 'XSHE'].includes(input.market) || input.expectedRoutingRevision !== state.get().routingRevision) fail('ROUTE_CONFLICT', '目录路由已变化', 409)
      const result = await catalog.sync(input.market); collector.reconcile(); return result
    },
    async watchlist(operation) { assertLive(); const result = await watchlist.execute(operation); collector.reconcile(); return result },
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
      if (input.securities && (!Array.isArray(input.securities) || input.securities.length > 100 || input.securities.some(id => typeof id !== 'string'))) fail('INVALID_REFRESH', '刷新证券参数无效')
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
