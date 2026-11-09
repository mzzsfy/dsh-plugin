import { securitySchema } from './schemas.mjs'
import { fail, sessionStateOf } from './market-model.mjs'
const DAY = 24 * 60 * 60 * 1000
const SEARCH_TTL = 60 * 1000
const SEARCH_CACHE_LIMIT = 64
const SEARCH_FLIGHT_LIMIT = 32
const CANDIDATE_TTL = 5 * 60 * 1000
const CANDIDATE_LIMIT = 200
// 有界写入: Map 迭代序即插入序, 超限淘汰最早条目, 保证长跑内存不随查询次数增长
export function setBounded(map, key, value, limit) {
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value)
  return map
}
const localDate = ms => new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
// 实例id→其适配器 markets 集合(搜索市场面唯一事实源)
function adapterMarketsOf(config, registry) {
  const map = new Map()
  for (const p of config.providers.filter(p => p.enabled)) {
    const adapter = (registry?.descriptors() || []).find(d => d.adapterId === p.adapterId)
    map.set(p.id, new Set(adapter?.markets || []))
  }
  return map
}

export function createCatalog({ state, getControl = state.get, router, executor, registry, now = Date.now, changed = () => {} }) {
  const flights = new Map(), candidates = new Map(), searchCache = new Map(), searchFlights = new Map()
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
      // 缓存缺失不再报错甩给用户: 返回 syncing 态并触发后台同步(sync 内部 flights 去重), 同步后为空是合法状态
      if (!records('catalog').some(c => c.payload.market === market)) {
        this.sync(market, ['catalog']).catch(() => {})
        return { syncing: true, total: 0, items: [] }
      }
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
    status: () => records('catalog').map(c => ({ source: c.source, fetchedAt: c.fetchedAt, complete: c.payload.complete, stale: now() - c.fetchedAt > (c.kind === 'calendar' ? 7 * DAY : DAY) })),
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
    stats: () => ({ searchCache: searchCache.size, candidates: candidates.size, searchFlights: searchFlights.size, syncFlights: flights.size }),
    async ensure() {
      for (const route of getControl().routes.filter(r => ['catalog', 'calendar'].includes(r.capability))) {
        if (getControl().providers.find(p => p.id === route.primaryInstanceId)?.budget.requestsPerMinute === null) continue
        const caches = records(route.capability).filter(c => c.payload.market === route.market)
        const cache = caches[0]
        const today = localDate(now())
        const missing = !cache || now() - cache.fetchedAt > (route.capability === 'calendar' ? 7 * DAY : DAY) || route.capability === 'calendar' && !cache.payload.items.some(day => day.date === today)
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
            const request = { market, routingRevision: config.routingRevision, startDate: localDate(now() - 7 * DAY), endDate: localDate(now() + 45 * DAY) }
            const batch = await executor.run(selected.instance, capability, request, { signal: controller.signal })
            if (stopped || config.routingRevision !== getControl().routingRevision) fail('ROUTE_CONFLICT', '来源已变化，旧目录已丢弃', 409)
            if (!Array.isArray(batch.items) || capability === 'catalog' && batch.items.some(s => !securitySchema.safeParse(s).success || s.exchange !== market) || capability === 'calendar' && batch.items.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.isOpen !== 'boolean')) fail('BAD_PAYLOAD', '目录来源返回不受支持的证券身份', 502)
            const items = batch.items
            await state.cache.put(`${capability}:${selected.instance.id}:${market}`, { kind: capability, source: selected.instance.id, fetchedAt: now(), payload: { routingRevision: config.routingRevision, market, complete: batch.complete ?? true, items } })
            status.push({ capability, ok: true, count: items.length }); changed()
          } catch (e) { status.push({ capability, ok: false, error: { code: e.code, message: e.message } }) }
        }
        return status
      })()
      flights.set(key, job)
      job.finally(() => { flights.delete(key); controllers.delete(controller) }).catch(() => {})
      return job
    },
    marketState(market) {
      const date = localDate(now()), day = records('calendar').filter(c => c.payload.market === market).flatMap(c => c.payload.items).find(d => d.date === date)
      // 没同步过日历就按市场自身的时段判断, 别让八市场统一显示「未知」; 有日历数据时以日历(含节假日)为准
      if (!day || typeof day.isOpen !== 'boolean') return { state: sessionStateOf(market, now()) }
      const local = new Date(now() + 8 * 60 * 60 * 1000), minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
      const at = minute => Date.parse(`${date}T00:00:00+08:00`) + minute * 60 * 1000
      if (!day.isOpen) return { state: 'closed', nextAt: at(24 * 60 + 9 * 60 + 15) }
      if (minutes < 9 * 60 + 15) return { state: 'preopen', nextAt: at(9 * 60 + 15) }
      if (minutes < 9 * 60 + 25) return { state: 'auction' }
      if (minutes < 9 * 60 + 30) return { state: 'preopen', nextAt: at(9 * 60 + 30) }
      if (minutes < 11 * 60 + 30 || minutes >= 13 * 60 && minutes < 15 * 60) return { state: 'trading' }
      if (minutes < 13 * 60) return { state: 'break', nextAt: at(13 * 60) }
      return { state: 'closed', nextAt: at(24 * 60 + 9 * 60 + 15) }
    },
    async dispose() { stopped = true; for (const c of controllers) c.abort(); candidates.clear(); await Promise.allSettled([...flights.values()]) },
  }
}
