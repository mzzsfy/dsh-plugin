import { securitySchema } from './schemas.mjs'
import { fail } from './market-model.mjs'
const DAY = 24 * 60 * 60 * 1000
const localDate = ms => new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
export function createCatalog({ state, getControl = state.get, router, executor, now = Date.now, changed = () => {} }) {
  const flights = new Map(), candidates = new Map()
  let stopped = false
  const controllers = new Set()
  function records(kind) {
    const config = getControl(), result = []
    for (const [, cache] of state.cache.entries()) {
      if (cache.kind !== kind || cache.payload?.routingRevision !== config.routingRevision || !Array.isArray(cache.payload?.items) || kind === 'catalog' && cache.payload.items.some(s => !securitySchema.safeParse(s).success) || kind === 'calendar' && cache.payload.items.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.isOpen !== 'boolean')) continue
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
    const score = s => s.code === query ? 0 : s.officialName.toLowerCase() === query ? 1 : s.code.startsWith(query) ? 2 : s.officialName.toLowerCase().includes(query) ? 3 : s.cnspell?.toLowerCase().startsWith(query) ? 4 : 99
    return all().map(s => ({ s, rank: score(s) })).filter(r => r.rank < 99).sort((a, b) => a.rank - b.rank || a.s.id.localeCompare(b.s.id)).slice(0, limit).map(r => r.s)
  }
  return {
    search,
    async browse({ market, offset, limit }) {
      // 未就绪指无有效缓存记录;同步后为空是合法状态。
      if (!records('catalog').some(c => c.payload.market === market)) fail('CATALOG_NOT_READY', '目录未就绪，请先在设置中同步目录', 422)
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
      const config = structuredClone(getControl()), results = new Map(search(q).map(s => [s.id, s]))
      for (const route of config.routes.filter(r => r.capability === 'search')) {
        const selected = router.select('search', route.market)
        const batch = await executor.run(selected.instance, 'search', { q, limit: 20, market: route.market, routingRevision: config.routingRevision }, { signal })
        if (stopped || getControl().routingRevision !== config.routingRevision) fail('ROUTE_CONFLICT', '目录路由已变化', 409)
        for (const s of batch.items) {
          if (!securitySchema.safeParse(s).success) fail('BAD_PAYLOAD', '来源返回不受支持的证券身份', 502)
          candidates.set(s.id, { security: s, until: now() + 5 * 60 * 1000, revision: config.routingRevision }); results.set(s.id, s)
        }
      }
      for (const [id, c] of candidates) if (c.until <= now()) candidates.delete(id)
      while (candidates.size > 200) candidates.delete(candidates.keys().next().value)
      if (!config.routes.some(r => r.capability === 'search') && !records('catalog').length) fail('CATALOG_NOT_READY', '目录未就绪，请先在设置中配置目录来源或搜索来源并同步', 422)
      return [...results.values()].slice(0, 20)
    },
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
      if (!day || typeof day.isOpen !== 'boolean') return { state: 'unknown' }
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
