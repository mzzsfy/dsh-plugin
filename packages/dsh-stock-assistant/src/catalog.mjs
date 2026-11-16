import { securitySchema } from './schemas.mjs'
import { fail, marketDate, marketStateOf } from './market-model.mjs'
const DAY = 24 * 60 * 60 * 1000
const SEARCH_TTL = 60 * 1000
const SEARCH_CACHE_LIMIT = 64
const SEARCH_FLIGHT_LIMIT = 32
const CANDIDATE_TTL = 5 * 60 * 1000
const CANDIDATE_LIMIT = 200
// 同步失败后自动重试的间隔: 失败原因(缺路由/来源不可达)不会在一秒内自愈, 每次浏览都重试等于打上游;
// 用户仍可从设置页或浏览页手动重试
const AUTO_SYNC_RETRY_MS = 30 * 1000
const SYNC_ATTEMPT_LIMIT = 64
// 目录一天、日历一周过期: 过期数据仍可展示, 但浏览/后台预热要重新同步, 不能一直吃旧快照
const CATALOG_TTL = DAY, CALENDAR_TTL = 7 * DAY
// 市场状态只随分钟粒度的时段边界变化; 5 秒短缓存挡掉采集热路径的重复全量扫描
const MARKET_STATE_TTL = 5 * 1000
const MARKET_STATE_CACHE_LIMIT = 64
// 有界写入: Map 迭代序即插入序, 超限淘汰最早条目, 保证长跑内存不随查询次数增长
export function setBounded(map, key, value, limit) {
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value)
  return map
}
// 实例id→其适配器 markets 集合(搜索市场面唯一事实源)
function adapterMarketsOf(config, registry) {
  const map = new Map()
  for (const p of config.providers.filter(p => p.enabled)) {
    const adapter = (registry?.descriptors() || []).find(d => d.adapterId === p.adapterId)
    map.set(p.id, new Set(adapter?.markets || []))
  }
  return map
}

const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
export function createCatalog({ state, getControl = state.get, router, executor, registry, now = Date.now, changed = () => {} }) {
  const flights = new Map(), candidates = new Map(), searchCache = new Map(), searchFlights = new Map(), marketStateCache = new Map(), syncAttempts = new Map()
  let stopped = false
  const controllers = new Set()
  function records(kind) {
    const config = getControl(), result = []
    for (const [, cache] of state.cache.entries()) {
      // 缓存表可能残留空记录(历史 update 语义写坏), 一条坏数据不能拖死整轮报价
      if (!cache || cache.kind !== kind || cache.payload?.routingRevision !== config.routingRevision || !Array.isArray(cache.payload?.items) || kind === 'catalog' && cache.payload.items.some(s => !securitySchema.safeParse(s).success) || kind === 'calendar' && cache.payload.items.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.isOpen !== 'boolean')) continue
      result.push(cache)
    }
    return result
  }
  function all() {
    const map = new Map()
    for (const cache of records('catalog')) for (const s of cache.payload.items) if (securitySchema.safeParse(s).success) map.set(s.id, s)
    return [...map.values()]
  }
  function search(q, limit = 20) {
    const query = q.trim().toLowerCase()
    if (!query) return []
    // 代码大小写不敏感: 美股代码全大写, 逐字比较会让本地目录搜不到 aapl/apple
    const score = s => { const code = s.code.toLowerCase(), name = s.officialName.toLowerCase(); return code === query ? 0 : name === query ? 1 : code.startsWith(query) ? 2 : name.includes(query) ? 3 : s.cnspell?.toLowerCase().startsWith(query) ? 4 : 99 }
    return all().map(s => ({ s, rank: score(s) })).filter(r => r.rank < 99).sort((a, b) => a.rank - b.rank || a.s.id.localeCompare(b.s.id)).slice(0, limit).map(r => r.s)
  }
  return {
    search,
    async browse({ market, offset, limit }) {
      // 缓存缺失不再报错甩给用户: 返回 syncing 态并触发后台同步(sync 内部 flights 去重), 同步后为空是合法状态。
      // 失败要带出口: 只回 syncing 会让"首次同步中"永远挂着, 用户既不知道失败也没有重试入口。
      const cached = records('catalog').filter(c => c.payload.market === market)
      if (!cached.length) {
        const revision = getControl().routingRevision
        const attempt = syncAttempts.get(`catalog:${market}`)
        // 只认当前路由版本下的失败: 换过路由还回旧版本的错误, 会把已经修好的市场显示成失败
        const failed = attempt?.ok === false && attempt.revision === revision
        const due = !failed || now() - attempt.at >= AUTO_SYNC_RETRY_MS
        if (due) this.sync(market, ['catalog']).catch(() => {})
        return { syncing: true, syncError: failed ? attempt.error : null, syncAttemptAt: failed ? attempt.at : null, total: 0, items: [] }
      }
      // 已有目录但过期: 先展示旧数据, 同时后台刷新, 下一次浏览/轮询就能拿到新目录
      const newest = Math.max(...cached.map(c => c.fetchedAt))
      if (now() - newest > CATALOG_TTL) this.sync(market, ['catalog']).catch(() => {})
      const securities = all().filter(s => s.exchange === market).sort((a, b) => a.code.localeCompare(b.code))
      const start = Math.max(0, Math.trunc(Number(offset) || 0)), size = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 50)))
      return { total: securities.length, items: securities.slice(start, start + size) }
    },
    resolve(id) {
      const cached = all().find(s => s.id === id)
      if (cached) return cached
      const candidate = candidates.get(id)
      return candidate && candidate.until > now() && candidate.revision === getControl().routingRevision ? candidate.security : null
    },
    status: () => records('catalog').map(c => ({ source: c.source, fetchedAt: c.fetchedAt, complete: c.payload.complete, stale: now() - c.fetchedAt > (c.kind === 'calendar' ? CALENDAR_TTL : CATALOG_TTL) })),
    async remote(q, signal) {
      const config = structuredClone(getControl()), revision = config.routingRevision, key = `${revision}:${q.trim().toLowerCase()}`
      // 结果缓存与在途合并: 联想接口按查询词去重, 退格重输同一词零远端开销
      const cached = searchCache.get(key)
      if (cached && cached.until > now()) return cached.items
      const inflight = searchFlights.get(key)
      if (inflight && !inflight.signal?.aborted) return inflight.job
      const job = (async () => {
        const results = new Map(search(q).map(s => [s.id, s]))
        // 搜索市场面=启用实例的适配器市场并集(suggest 天然全市场, 已启用市场语义跟随实例能力而非路由)
        const adapterMarkets = adapterMarketsOf(config, registry)
        const searchAdapters = new Set((registry?.descriptors() || []).filter(d => d.capabilities.includes('search')).map(d => d.adapterId))
        const searchRoutes = new Map(config.routes.filter(r => r.capability === 'search').map(r => [r.market, r]))
        // 实例→负责市场: 有 search 路由用路由实例, 无路由用支持 search 的启用实例直连(市场过滤在适配器端)
        const assignments = new Map()
        for (const market of new Set([...adapterMarkets.values()].flatMap(set => [...set]))) {
          const instance = searchRoutes.has(market) ? router.select('search', market).instance
            : config.providers.find(p => p.enabled && searchAdapters.has(p.adapterId) && adapterMarkets.get(p.id)?.has(market))
              || config.providers.find(p => p.enabled && searchAdapters.has(p.adapterId))
          if (!instance) continue
          const entry = assignments.get(instance.id) || { instance, markets: new Set() }
          entry.markets.add(market); assignments.set(instance.id, entry)
        }
        // 一个实例只请求一次: 联想端点为全市场端点, 按市场循环是重复请求同一份数据
        const batches = await Promise.allSettled([...assignments.values()].map(async ({ instance, markets }) => ({ markets, batch: await executor.run(instance, 'search', { q, limit: 20, market: null, routingRevision: revision }, { signal }) })))
        for (const settled of batches) {
          // 单来源限速不终止整个搜索: 其余实例候选照常下发
          if (settled.status === 'rejected') { if (settled.reason?.code === 'RATE_LIMIT') continue; throw settled.reason }
          const { markets, batch } = settled.value
          if (stopped || getControl().routingRevision !== revision) fail('ROUTE_CONFLICT', '目录路由已变化', 409)
          for (const s of batch.items) {
            if (!securitySchema.safeParse(s).success) fail('BAD_PAYLOAD', '来源返回不受支持的证券身份', 502)
            if (!markets.has(s.exchange)) continue
            candidates.set(s.id, { security: s, until: now() + CANDIDATE_TTL, revision }); results.set(s.id, s)
          }
        }
        for (const [id, c] of candidates) if (c.until <= now()) candidates.delete(id)
        while (candidates.size > CANDIDATE_LIMIT) candidates.delete(candidates.keys().next().value)
        if (!config.routes.some(r => r.capability === 'search') && !records('catalog').length) fail('CATALOG_NOT_READY', '目录未就绪，请先在设置中配置目录来源或搜索来源并同步', 422)
        const items = [...results.values()].slice(0, 20)
        setBounded(searchCache, key, { items, until: now() + SEARCH_TTL }, SEARCH_CACHE_LIMIT)
        return items
      })()
      setBounded(searchFlights, key, { job, signal }, SEARCH_FLIGHT_LIMIT)
      try { return await job } finally { if (searchFlights.get(key)?.job === job) searchFlights.delete(key) }
    },
    // 内存占用可观测: 长跑核对缓存不越界
    stats: () => ({ searchCache: searchCache.size, candidates: candidates.size, searchFlights: searchFlights.size, syncFlights: flights.size, syncAttempts: syncAttempts.size }),
    async ensure() {
      for (const route of getControl().routes.filter(r => ['catalog', 'calendar'].includes(r.capability))) {
        if (getControl().providers.find(p => p.id === route.primaryInstanceId)?.budget.requestsPerMinute === null) continue
        const caches = records(route.capability).filter(c => c.payload.market === route.market)
        const cache = caches[0]
        const today = marketDate(route.market, now())
        const ttl = route.capability === 'calendar' ? CALENDAR_TTL : CATALOG_TTL
        const missing = !cache || now() - cache.fetchedAt > ttl || route.capability === 'calendar' && !cache.payload.items.some(day => day.date === today)
        if (missing) await this.sync(route.market, [route.capability])
      }
    },
    async sync(market, capabilities = ['catalog', 'calendar']) {
      const config = structuredClone(getControl()), key = `${config.routingRevision}:${market}:${capabilities.join(',')}`
      if (flights.has(key)) return flights.get(key)
      const controller = new AbortController(); controllers.add(controller)
      const job = (async () => {
        const status = []
        for (const capability of capabilities) {
          try {
            const selected = router.select(capability, market)
            const today = marketDate(market, now())
            const request = { market, routingRevision: config.routingRevision, startDate: shiftDate(today, -7), endDate: shiftDate(today, 45) }
            const batch = await executor.run(selected.instance, capability, request, { signal: controller.signal })
            if (stopped || config.routingRevision !== getControl().routingRevision) fail('ROUTE_CONFLICT', '来源已变化，旧目录已丢弃', 409)
            if (!Array.isArray(batch.items) || capability === 'catalog' && batch.items.some(s => !securitySchema.safeParse(s).success || s.exchange !== market) || capability === 'calendar' && batch.items.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.isOpen !== 'boolean')) fail('BAD_PAYLOAD', '目录来源返回不受支持的证券身份', 502)
            const items = batch.items
            await state.cache.put(`${capability}:${selected.instance.id}:${market}`, { kind: capability, source: selected.instance.id, fetchedAt: now(), payload: { routingRevision: config.routingRevision, market, complete: batch.complete ?? true, items } })
            if (capability === 'calendar') marketStateCache.clear()
            setBounded(syncAttempts, `${capability}:${market}`, { ok: true, at: now(), revision: config.routingRevision }, SYNC_ATTEMPT_LIMIT)
            status.push({ capability, ok: true, count: items.length }); changed()
          } catch (e) {
            setBounded(syncAttempts, `${capability}:${market}`, { ok: false, at: now(), revision: config.routingRevision, error: { code: e.code, message: e.message } }, SYNC_ATTEMPT_LIMIT)
            status.push({ capability, ok: false, error: { code: e.code, message: e.message } })
          }
        }
        return status
      })()
      flights.set(key, job)
      job.finally(() => { flights.delete(key); controllers.delete(controller) }).catch(() => {})
      return job
    },
    marketState(market) {
      const at = now(), date = marketDate(market, at), revision = getControl().routingRevision
      const key = `${market}:${date}:${revision}`
      const cached = marketStateCache.get(key)
      if (cached && at - cached.at < MARKET_STATE_TTL) return { ...cached.value }
      // 没同步过日历就按市场自身时段判断(仍给 nextAt, 休市不再按秒轮询); 有日历时以日历(含节假日)为准
      const days = new Map()
      for (const cache of records('calendar')) if (cache.payload.market === market) for (const day of cache.payload.items) days.set(day.date, day.isOpen)
      const value = marketStateOf(market, at, days)
      marketStateCache.set(key, { at, value })
      while (marketStateCache.size > MARKET_STATE_CACHE_LIMIT) marketStateCache.delete(marketStateCache.keys().next().value)
      return { ...value }
    },
    async dispose() { stopped = true; for (const c of controllers) c.abort(); candidates.clear(); await Promise.allSettled([...flights.values()]) },
  }
}
