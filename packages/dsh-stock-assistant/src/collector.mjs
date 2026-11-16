import { StockError, fail, makeSecurity } from './market-model.mjs'
import { TRANSIENT_CODES } from './provider-router.mjs'
// 本地闸门错误: 请求没打到上游, 既不算成功也不算失败
const localGate = error => error?.local === true || error?.code === 'CANCELLED'
// 报价时间距获取时间不超过该秒数视为实时; 免凭据公开源常缺延迟声明, 由时间戳差派生
const REALTIME_WINDOW_SECONDS = 90
// 适配器未声明延迟但带报价时间时, 按时差派生 delayKind; 缺时间戳保持 unknown 不编造。
// 非交易时段(休市/午休/未开盘)报价停在最后成交那一刻, 时差是"多久没新数据"而不是"数据延迟", 单独标 closed 交给界面报时间点。
export function deriveDelay(quote, now, trading = true) {
  if (quote.delayKind !== 'unknown' || !quote.quoteAt) return quote
  const lagSeconds = Math.max(0, Math.round((now() - Date.parse(quote.quoteAt)) / 1000))
  if (!Number.isFinite(lagSeconds)) return quote
  if (lagSeconds <= REALTIME_WINDOW_SECONDS) { quote.delayKind = 'realtime'; return quote }
  if (!trading) { quote.delayKind = 'closed'; quote.delaySeconds = null; return quote }
  quote.delayKind = 'delayed'; quote.delaySeconds = lagSeconds
  return quote
}
const BUSINESS = entry => JSON.stringify(entry && { ...entry, lastAttemptAt: undefined, quote: entry.quote && { ...entry.quote, receivedAt: undefined } })
export function createCollector({ getControl, router, registry, executor, resolveSecurity = null, changed = () => {}, touched = () => {}, now = Date.now, active = () => false, calendarState = () => ({ state: 'unknown' }), timers = globalThis, random = Math.random, ticks = null }) {
  const quotes = new Map(), marketPhases = new Map(), flights = new Map(), rounds = new Map(), blocked = new Map(), failures = new Map(), controllers = new Set()
  let generation = 0, timer, stopped = false, lastStart = -Infinity, manualWaiters = 0
  const entries = () => Object.fromEntries([...quotes].map(([id, value]) => [id, structuredClone(value)]))
  // 常驻快照只给自选: peek(详情/浏览临时打开的非自选)报价没有生命周期归属, 留在快照里会随浏览次数无界增长。
  // 读取时顺带清掉非自选键, 让"详情关闭后无人再要"的报价在下一拍自然释放。
  function watchEntries() {
    const order = getControl().watchlist.order, wanted = new Set(order)
    for (const id of [...quotes.keys()]) if (!wanted.has(id)) quotes.delete(id)
    return Object.fromEntries(order.filter(id => quotes.has(id)).map(id => [id, structuredClone(quotes.get(id))]))
  }
  // 本拍显式请求且请求开始时不在自选的证券(peek): 只有它们能在"当前不在自选"时写入报价。
  // 自选里的标的永远按当下自选判定: 否则移除自选与在飞批次之间的窗口会把刚删掉的标的写回来
  // (快照过滤会挡住展示, 但内存仍无界)。
  const stillWanted = (id, peek) => peek?.has(id) === true || getControl().watchlist.items[id] !== undefined
  // 缓存新鲜度: 全部自选都有未过期报价才算新鲜, 用于进入面板时跳过重复拉取
  const freshWithin = ms => {
    const order = getControl().watchlist.order
    if (!order.length) return false
    return order.every(id => { const quote = quotes.get(id)?.quote; return quote && Number.isFinite(quote.receivedAt) && now() - quote.receivedAt < ms })
  }
  function apply(id, entry, peek) {
    if (!stillWanted(id, peek)) return
    const before = quotes.get(id)
    quotes.set(id, entry); touched()
    if (BUSINESS(before) !== BUSINESS(entry)) changed()
  }
  // 同轮补救的下一格: 沿环前进一格, 到末级时回到主源; 不给无预算或已停用的实例派活
  function spareOf(selected, config) {
    const route = config.routes.find(r => r.id === selected.route.id)
    if (!route || route.failoverMode !== 'network') return null
    const id = router.nextInRing(route.id, selected.instance.id)
    const instance = id ? config.providers.find(p => p.id === id && p.enabled !== false && p.budget?.requestsPerMinute !== null) : null
    return instance && instance.id !== selected.instance.id ? { ...selected, instance } : null
  }
  function backoff(id, error) {
    if (!error) { failures.delete(id); blocked.delete(id); return }
    // 调用方取消不是来源故障: 不记失败、不进入退避
    if (error.code === 'CANCELLED') return
    const n = (failures.get(id) || 0) + 1; failures.set(id, n)
    const permanent = ['AUTH', 'PERMISSION', 'BAD_PAYLOAD', 'UNSUPPORTED_CAPABILITY', 'BUDGET_UNKNOWN'].includes(error.code)
    const delay = error.code === 'RATE_LIMIT' ? error.retryAfterMs || 60 * 1000 : Math.min(120, 15 * 2 ** (n - 1)) * 1000 * (1 + random() / 5)
    blocked.set(id, permanent ? Infinity : now() + delay)
  }
  async function batch(selected, securities, periodic, config, gen, signal, phaseOf, peek) {
    const { route, instance, routeEpoch } = selected
    const key = `${config.routingRevision}:${route.id}:${instance.id}:${routeEpoch}:${securities.map(s => s.id).sort().join(',')}`
    if (flights.has(key)) return flights.get(key)
    const until = blocked.get(route.id) || 0
    if (until > now()) {
      // 本地闸门拦下的请求没打上游: 标记出来, 免得被当成一次真实的失败/成功去改路由计数
      const error = new StockError(Number.isFinite(until) ? 'RATE_LIMIT' : 'SOURCE_PAUSED', Number.isFinite(until) ? '来源正在退避，请稍后刷新' : '来源已暂停，请在设置中检查', Number.isFinite(until) ? 429 : 422, { retryAfterMs: Number.isFinite(until) ? Math.ceil(until - now()) : null })
      error.local = true
      throw error
    }
    const controller = new AbortController(); controllers.add(controller)
    // 调用方取消/断开时中止已发出的上游批次, 而不是只停止等待
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) forwardAbort()
    const job = (async () => {
      try {
        const result = await executor.run(instance, 'quotes', { securities, routingRevision: config.routingRevision, routeEpoch, requestId: key, market: route.market }, { signal: controller.signal, periodic })
        if (stopped || gen !== generation || getControl().routingRevision !== config.routingRevision || router.select('quotes', route.market).routeEpoch !== routeEpoch) throw new StockError('CANCELLED', '路由已变化，旧报价已丢弃', 409)
        const map = new Map(), requested = new Set(securities.map(s => s.id))
        for (const quote of result.items) {
          if (!requested.has(quote.securityId)) continue
          if (map.has(quote.securityId) || quote.providerInstanceId !== instance.id) fail('BAD_PAYLOAD', '报价身份或来源冲突', 502)
          // 只有明确处于非交易时段才改口径; 日历缺失(unknown)不能当成休市, 否则等于凭空断言收盘
          const marketState = phaseOf(securities.find(s => s.id === quote.securityId)?.exchange).state
          deriveDelay(quote, now, marketState === 'unknown' || marketState === 'trading' || marketState === 'auction')
          if (quote.delayKind === 'unknown' && !route.acceptUnknownDelay) fail('BAD_PAYLOAD', '路由不接受未知延迟行情', 422)
          if (route.maxDelaySeconds !== null && quote.delayKind !== 'unknown' && quote.delaySeconds > route.maxDelaySeconds) fail('BAD_PAYLOAD', '报价延迟超过路由限制', 422)
          map.set(quote.securityId, quote)
        }
        for (const s of securities) {
          const quote = map.get(s.id), old = quotes.get(s.id)
          if (quote?.quoteAt && old?.quote?.quoteAt && old.quote.providerInstanceId === instance.id && old.quote.routeEpoch === routeEpoch && Date.parse(quote.quoteAt) < Date.parse(old.quote.quoteAt)) continue
          const entry = quote ? { quote: { ...quote, routeId: route.id, routeEpoch, routingRevision: config.routingRevision, sessionState: phaseOf(s.exchange).state || 'unknown' }, health: 'ok', lastError: null, lastAttemptAt: now() } : { quote: old?.quote || null, health: 'no-data', lastError: result.errors?.find(e => e.securityId === s.id) || { code: 'NO_DATA', message: '来源未返回报价' }, lastAttemptAt: now() }
          apply(s.id, entry, peek)
          // 每拍报价都留一个点: 分时上游断开时, 这些点要续在当日真实分时后面
          if (quote) ticks?.push(s.id, s.exchange, quote.quoteAt ? Math.floor(Date.parse(quote.quoteAt) / 1000) : Math.floor(now() / 1000), quote.last)
        }
        return { routeId: route.id, ok: true }
      } catch (error) {
        if (gen !== generation || stopped || error.code === 'CANCELLED') throw error
        for (const s of securities) apply(s.id, { quote: quotes.get(s.id)?.quote || null, health: error.code === 'RATE_LIMIT' ? 'limited' : 'error', lastError: { code: error.code || 'NETWORK', message: error.message, retryAfterMs: error.retryAfterMs || null }, lastAttemptAt: now() }, peek)
        return { routeId: route.id, ok: false, error }
      } finally { signal?.removeEventListener('abort', forwardAbort); controllers.delete(controller) }
    })()
    flights.set(key, job)
    job.catch(() => {}).finally(() => { if (flights.get(key) === job) flights.delete(key) })
    return job
  }
  async function refresh(ids, options = {}) {
    if (stopped) fail('STOPPED', '股票工具已停止', 503)
    if (!options.periodic) manualWaiters++
    const refreshController = new AbortController()
    const forwardAbort = () => refreshController.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (options.signal?.aborted) forwardAbort()
    try {
    const config = structuredClone(getControl()), gen = generation
    // 一轮刷新内市场状态只算一次: 逐证券/逐批次重复调 calendarState 会反复全量扫描日历缓存
    const phaseCache = new Map(), phaseOf = market => { if (!phaseCache.has(market)) phaseCache.set(market, calendarState(market)); return phaseCache.get(market) }
    // 证券解析链: 对象形态(搜索候选peek, 客户端持有完整身份)直接构造; 字符串形态自选优先, 目录缓存兜底, 两者皆无拒 NOT_FOUND
    const securities = (ids || config.watchlist.order).map(id => typeof id === 'object' && id?.id ? makeSecurity(id.exchange, id.code, id.officialName || id.code, { catalogSource: 'peek' }) : config.watchlist.items[id] || resolveSecurity?.(id) || fail('NOT_FOUND', '自选证券不存在', 404))
    // peek 集合只在请求开始时确定: 请求开始仍在自选的标的按当下自选判定, 避免移除竞态把旧报价写回来
    const peek = ids ? new Set(securities.filter(s => config.watchlist.items[s.id] === undefined).map(s => s.id)) : null
    const grouped = new Map(), immediate = []
    const closeMarkets = new Set(securities.map(s => s.exchange).filter(market => phaseOf(market).state === 'closed' && marketPhases.get(market) === 'trading'))
    for (const s of securities) {
      const phase = phaseOf(s.exchange)
      if (options.periodic && phase.nextAt > now() && !closeMarkets.has(s.exchange)) continue
      marketPhases.set(s.exchange, phase.state)
      try {
        const selected = router.select('quotes', s.exchange)
        if (!grouped.has(selected.route.id)) grouped.set(selected.route.id, { selected, securities: [] })
        grouped.get(selected.route.id).securities.push(s)
      } catch (e) { immediate.push({ ok: false, error: e }); apply(s.id, { quote: null, health: 'unconfigured', lastError: { code: e.code, message: e.message }, lastAttemptAt: now() }, peek) }
    }
    lastStart = now()
    const tasks = [...grouped.values()].map(async group => {
      const { selected, securities: list } = group, spare = spareOf(selected, config)
      const roundKey = `${config.routingRevision}:${selected.route.id}:${selected.instance.id}:${selected.routeEpoch}:${list.map(s => s.id).sort().join(',')}`
      if (rounds.has(roundKey)) return rounds.get(roundKey)
      // 同一来源的分批: 主源与备源各自按自己的批量上限切, 但核对/落库逻辑完全一致
      const pull = async sel => {
        const size = Math.min(20, registry.get(sel.instance.adapterId).descriptor.maxQuoteBatch), out = []
        for (let start = 0; start < list.length; start += size) {
          try { out.push(await batch(sel, list.slice(start, start + size), !!options.periodic, config, gen, refreshController.signal, phaseOf, peek)) }
          catch (e) { out.push({ ok: false, error: e }); break }
        }
        return out
      }
      const job = (async () => {
      let results = await pull(selected)
      const allNetwork = results.length && results.every(r => !r.ok && TRANSIENT_CODES.includes(r.error?.code))
      // 本地闸门拦下的轮次没打上游, 不能当成功也不能当失败: 否则末级退避会把失败计数反复清零, 环永远转不回去
      const localOnly = results.length && results.every(r => !r.ok && localGate(r.error))
      const upstreamError = results.find(r => !r.ok && !localGate(r.error))?.error
      if (gen === generation && !localOnly) {
        const failure = allNetwork || upstreamError ? upstreamError ?? results[0]?.error : null
        const transient = failure && TRANSIENT_CODES.includes(failure.code)
        // 网络类失败且有环可退时不设退避: 下一轮还能先试当前来源, 计满三次由路由器持久切走。
        // 凭据/响应畸形这类永久故障跟环无关, 照旧退避, 否则每轮都拿同一个错误去撞上游
        backoff(selected.route.id, transient && spare ? null : failure)
        router.recordRound(selected.route.id, failure)
      }
      // 主源整轮断网: 本轮就换备源, 不让用户等三次刷新的空窗。
      // 计满三次的那一轮 recordRound 可能已经把当前选择挪到备源, 这时必须按新选择取代次,
      // 否则 batch 的代次校验会把备源结果当成旧路由丢弃
      if (allNetwork) {
        let target = null
        if (!stopped && gen === generation) { try { const current = router.select('quotes', selected.route.market); if (current.instance.id !== selected.instance.id) target = current } catch {} }
        target ??= spare
        if (target) {
          const retried = await pull(target)
          if (retried.some(r => r.ok)) {
            if (gen === generation) backoff(selected.route.id, null)
            results = retried
          }
        }
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
      refreshController.signal.addEventListener('abort', abort, { once: true }); stopListening = () => refreshController.signal.removeEventListener('abort', abort)
      if (refreshController.signal.aborted) abort()
    })]) : work
    let completed
    try { completed = await waited } finally { stopListening() }
    const results = [...immediate, ...completed.flat()]
    if (gen !== generation || config.routingRevision !== getControl().routingRevision) fail('ROUTE_CONFLICT', '配置已变化，请重新刷新', 409)
    // 后台回切把路由换代次, 在飞批次会被判成旧路由丢弃: 只有整轮都是这种取消才静默交回上一份数据,
    // 混着真实故障时必须照常报错, 不能拿旧数据盖住凭据失效/无路由
    if (results.length && results.every(r => !r.ok && r.error?.code === 'CANCELLED')) return entries()
    if (results.length && results.every(r => !r.ok)) throw results.find(r => r.error?.code !== 'CANCELLED')?.error ?? results[0].error
    return entries()
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort)
      if (!options.periodic) manualWaiters--
      if (!active() && !manualWaiters) for (const c of controllers) c.abort()
    }
  }
  function reconcile() {
    timers.clearTimeout(timer)
    if (stopped || !active()) return
    const config = getControl()
    if (!config.watchlist.order.length) return
    const phaseCache = new Map(), phaseOf = market => { if (!phaseCache.has(market)) phaseCache.set(market, calendarState(market)); return phaseCache.get(market) }
    const markets = [...new Set(config.watchlist.order.map(id => config.watchlist.items[id].exchange))]
    const states = markets.map(exchange => phaseOf(exchange))
    const closing = markets.some(market => phaseOf(market).state === 'closed' && marketPhases.get(market) === 'trading')
    const allowed = closing || states.some(s => !s.nextAt)
    const groupCosts = new Map(), available = []
    for (const market of markets) {
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
    refresh, entries, watchEntries, reconcile, freshWithin,
    // 自选移除后清掉它的行情, 否则 quotes 与 /snapshot 随增删次数无界增长
    prune(id) { quotes.delete(id); ticks?.delete(id); touched() },
    // 凭据更新成功: 清掉引用该凭据(数据源或代理)的路由失败/AUTH 暂停, 下一次刷新立即重试
    recoverCredential(ref) {
      const config = getControl()
      for (const route of config.routes) {
        const targets = [route.primaryInstanceId, ...route.fallbackInstanceIds]
        if (targets.some(id => { const provider = config.providers.find(p => p.id === id); return provider && (provider.credentialRef === ref || provider.proxyCredentialRef === ref) })) {
          blocked.delete(route.id); failures.delete(route.id)
        }
      }
      reconcile()
    },
    resume() { blocked.clear(); failures.clear(); reconcile() },
    // 路由换源: 只清这条路由的退避与失败计数并重排下一轮, 不动 generation/在飞请求
    routeChanged(id) { blocked.delete(id); failures.delete(id); changed(); reconcile() },
    reset() { generation++; for (const c of controllers) c.abort(); flights.clear(); quotes.clear(); marketPhases.clear(); blocked.clear(); failures.clear(); ticks?.clear(); lastStart = -Infinity; touched(); changed(); reconcile() },
    cancelIdle() { timers.clearTimeout(timer); if (!active() && !manualWaiters) for (const c of controllers) c.abort() },
    dispose() { stopped = true; generation++; timers.clearTimeout(timer); for (const c of controllers) c.abort(); flights.clear(); ticks?.clear() },
  }
}
