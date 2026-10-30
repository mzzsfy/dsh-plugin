import { StockError, fail } from './market-model.mjs'
const BUSINESS = entry => JSON.stringify(entry && { ...entry, lastAttemptAt: undefined, quote: entry.quote && { ...entry.quote, receivedAt: undefined } })
export function createCollector({ getControl, router, registry, executor, changed = () => {}, touched = () => {}, now = Date.now, active = () => false, calendarState = () => ({ state: 'unknown' }), timers = globalThis, random = Math.random }) {
  const quotes = new Map(), marketPhases = new Map(), flights = new Map(), rounds = new Map(), blocked = new Map(), failures = new Map(), controllers = new Set()
  let generation = 0, timer, stopped = false, lastStart = -Infinity, manualWaiters = 0
  const entries = () => Object.fromEntries([...quotes].map(([id, value]) => [id, structuredClone(value)]))
  function apply(id, entry) {
    const before = quotes.get(id)
    quotes.set(id, entry); touched()
    if (BUSINESS(before) !== BUSINESS(entry)) changed()
  }
  function backoff(id, error) {
    if (!error) { failures.delete(id); blocked.delete(id); return }
    const n = (failures.get(id) || 0) + 1; failures.set(id, n)
    const permanent = ['AUTH', 'PERMISSION', 'BAD_PAYLOAD', 'UNSUPPORTED_CAPABILITY', 'BUDGET_UNKNOWN'].includes(error.code)
    const delay = error.code === 'RATE_LIMIT' ? error.retryAfterMs || 60 * 1000 : Math.min(120, 15 * 2 ** (n - 1)) * 1000 * (1 + random() / 5)
    blocked.set(id, permanent ? Infinity : now() + delay)
  }
  async function batch(selected, securities, periodic, config, gen) {
    const { route, instance, routeEpoch } = selected
    const key = `${config.routingRevision}:${route.id}:${routeEpoch}:${securities.map(s => s.id).sort().join(',')}`
    if (flights.has(key)) return flights.get(key)
    const until = blocked.get(route.id) || 0
    if (until > now()) fail(Number.isFinite(until) ? 'RATE_LIMIT' : 'SOURCE_PAUSED', Number.isFinite(until) ? '来源正在退避，请稍后刷新' : '来源已暂停，请在设置中检查', Number.isFinite(until) ? 429 : 422, { retryAfterMs: Number.isFinite(until) ? Math.ceil(until - now()) : null })
    const controller = new AbortController(); controllers.add(controller)
    const job = (async () => {
      try {
        const result = await executor.run(instance, 'quotes', { securities, routingRevision: config.routingRevision, routeEpoch, requestId: key, market: route.market }, { signal: controller.signal, periodic })
        if (stopped || gen !== generation || getControl().routingRevision !== config.routingRevision || router.select('quotes', route.market).routeEpoch !== routeEpoch) throw new StockError('CANCELLED', '路由已变化，旧报价已丢弃', 409)
        const map = new Map(), requested = new Set(securities.map(s => s.id))
        for (const quote of result.items) {
          if (!requested.has(quote.securityId)) continue
          if (map.has(quote.securityId) || quote.providerInstanceId !== instance.id) fail('BAD_PAYLOAD', '报价身份或来源冲突', 502)
          if (quote.delayKind === 'unknown' && !route.acceptUnknownDelay) fail('BAD_PAYLOAD', '路由不接受未知延迟行情', 422)
          if (route.maxDelaySeconds !== null && quote.delayKind !== 'unknown' && quote.delaySeconds > route.maxDelaySeconds) fail('BAD_PAYLOAD', '报价延迟超过路由限制', 422)
          map.set(quote.securityId, quote)
        }
        for (const s of securities) {
          const quote = map.get(s.id), old = quotes.get(s.id)
          if (quote?.quoteAt && old?.quote?.quoteAt && old.quote.providerInstanceId === instance.id && old.quote.routeEpoch === routeEpoch && Date.parse(quote.quoteAt) < Date.parse(old.quote.quoteAt)) continue
          const entry = quote ? { quote: { ...quote, routeId: route.id, routeEpoch, routingRevision: config.routingRevision, sessionState: calendarState(s.exchange).state || 'unknown' }, health: 'ok', lastError: null, lastAttemptAt: now() } : { quote: old?.quote || null, health: 'no-data', lastError: result.errors?.find(e => e.securityId === s.id) || { code: 'NO_DATA', message: '来源未返回报价' }, lastAttemptAt: now() }
          apply(s.id, entry)
        }
        return { routeId: route.id, ok: true }
      } catch (error) {
        if (gen !== generation || stopped || error.code === 'CANCELLED') throw error
        for (const s of securities) apply(s.id, { quote: quotes.get(s.id)?.quote || null, health: error.code === 'RATE_LIMIT' ? 'limited' : 'error', lastError: { code: error.code || 'NETWORK', message: error.message, retryAfterMs: error.retryAfterMs || null }, lastAttemptAt: now() })
        return { routeId: route.id, ok: false, error }
      } finally { controllers.delete(controller) }
    })()
    flights.set(key, job)
    job.catch(() => {}).finally(() => { if (flights.get(key) === job) flights.delete(key) })
    return job
  }
  async function refresh(ids, options = {}) {
    if (stopped) fail('STOPPED', '股票工具已停止', 503)
    if (!options.periodic) manualWaiters++
    try {
    const config = structuredClone(getControl()), gen = generation
    const securities = (ids || config.watchlist.order).map(id => config.watchlist.items[id] || fail('NOT_FOUND', '自选证券不存在', 404))
    const grouped = new Map(), immediate = []
    const closeMarkets = new Set(securities.map(s => s.exchange).filter(market => calendarState(market).state === 'closed' && marketPhases.get(market) === 'trading'))
    for (const s of securities) {
      const phase = calendarState(s.exchange)
      if (options.periodic && phase.nextAt > now() && !closeMarkets.has(s.exchange)) continue
      marketPhases.set(s.exchange, phase.state)
      try {
        const selected = router.select('quotes', s.exchange)
        if (!grouped.has(selected.route.id)) grouped.set(selected.route.id, { selected, securities: [] })
        grouped.get(selected.route.id).securities.push(s)
      } catch (e) { immediate.push({ ok: false, error: e }); apply(s.id, { quote: null, health: 'unconfigured', lastError: { code: e.code, message: e.message }, lastAttemptAt: now() }) }
    }
    lastStart = now()
    const tasks = [...grouped.values()].map(async group => {
      const { selected, securities: list } = group, size = Math.min(20, registry.get(selected.instance.adapterId).descriptor.maxQuoteBatch)
      const roundKey = `${config.routingRevision}:${selected.route.id}:${selected.routeEpoch}:${list.map(s => s.id).sort().join(',')}`
      if (rounds.has(roundKey)) return rounds.get(roundKey)
      const job = (async () => {
      const results = []
      for (let start = 0; start < list.length; start += size) {
        try { results.push(await batch(selected, list.slice(start, start + size), !!options.periodic, config, gen)) }
        catch (e) { results.push({ ok: false, error: e }); break }
      }
      if (gen === generation) {
        const error = results.every(r => !r.ok) ? results[0]?.error : null
        backoff(selected.route.id, error)
        const allNetwork = results.length && results.every(r => !r.ok && ['NETWORK', 'TIMEOUT'].includes(r.error?.code))
        router.recordRound(selected.route.id, allNetwork ? error : null)
      }
      return results
      })()
      rounds.set(roundKey, job)
      job.catch(() => {}).finally(() => { if (rounds.get(roundKey) === job) rounds.delete(roundKey) })
      return job
    })
    const work = Promise.all(tasks)
    let stopListening = () => {}
    const waited = options.signal ? Promise.race([work, new Promise((_, reject) => {
      const abort = () => reject(new StockError('CANCELLED', '刷新等待已取消', 504))
      options.signal.addEventListener('abort', abort, { once: true }); stopListening = () => options.signal.removeEventListener('abort', abort)
      if (options.signal.aborted) abort()
    })]) : work
    let completed
    try { completed = await waited } finally { stopListening() }
    const results = [...immediate, ...completed.flat()]
    if (gen !== generation || config.routingRevision !== getControl().routingRevision) fail('ROUTE_CONFLICT', '配置已变化，请重新刷新', 409)
    if (results.length && results.every(r => !r.ok)) throw results[0].error
    return entries()
    } finally { if (!options.periodic) manualWaiters--; if (!active() && !manualWaiters) for (const c of controllers) c.abort() }
  }
  function reconcile() {
    timers.clearTimeout(timer)
    if (stopped || !active()) return
    const config = getControl()
    if (!config.watchlist.order.length) return
    const states = [...new Set(config.watchlist.order.map(id => config.watchlist.items[id].exchange))].map(exchange => calendarState(exchange))
    const closing = [...new Set(config.watchlist.order.map(id => config.watchlist.items[id].exchange))].some(market => calendarState(market).state === 'closed' && marketPhases.get(market) === 'trading')
    const allowed = closing || states.some(s => !s.nextAt)
    const groupCosts = new Map(), available = []
    for (const market of new Set(config.watchlist.order.map(id => config.watchlist.items[id].exchange))) {
      try {
        const { route, instance } = router.select('quotes', market)
        if (instance.budget?.requestsPerMinute === null) continue
        const until = blocked.get(route.id) || 0
        if (Number.isFinite(until)) available.push(until)
        const count = config.watchlist.order.filter(id => config.watchlist.items[id].exchange === market).length
        const size = Math.min(20, registry.get(instance.adapterId).descriptor.maxQuoteBatch), batches = Math.ceil(count / size)
        const budget = instance.budget
        const total = groupCosts.get(instance.quotaGroup || instance.id) || { count: 0, limit: Infinity }
        total.count += batches
        total.limit = Math.min(total.limit, budget?.requestsPerMinute || 50, budget?.capabilityLimits?.quotes || budget?.requestsPerMinute || 50)
        groupCosts.set(instance.quotaGroup || instance.id, total)
      } catch {}
    }
    if (!available.length) return
    const quotaInterval = Math.max(0, ...[...groupCosts.values()].map(g => g.count / Math.max(1, Math.floor(g.limit * 0.9)) * 60 * 1000))
    const base = Math.max(config.preferences.refreshSeconds * 1000, quotaInterval, states.some(s => s.state === 'unknown') ? 60 * 1000 : 0)
    const wake = allowed ? Math.max(now(), lastStart + base, Math.min(...available)) : Math.min(...states.map(s => s.nextAt))
    timer = timers.setTimeout(() => { refresh(undefined, { periodic: true }).catch(() => {}).finally(reconcile) }, Math.max(1000, wake - now())); timer?.unref?.()
  }
  return {
    refresh, entries, reconcile,
    resume() { blocked.clear(); failures.clear(); reconcile() },
    reset() { generation++; for (const c of controllers) c.abort(); flights.clear(); quotes.clear(); marketPhases.clear(); blocked.clear(); failures.clear(); lastStart = -Infinity; touched(); changed(); reconcile() },
    cancelIdle() { timers.clearTimeout(timer); if (!active() && !manualWaiters) for (const c of controllers) c.abort() },
    dispose() { stopped = true; generation++; timers.clearTimeout(timer); for (const c of controllers) c.abort(); flights.clear() },
  }
}
