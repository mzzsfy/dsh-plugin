import { marketDate, StockError } from './market-model.mjs'
// 数据日期取最后一根分时的时间，避免把盘前收到的上个交易日数据当成当天数据。
const windowKeyOf = ({ market, code, limit, routeKey = '' }) => `trend:${market}:${code}:${limit}:${routeKey}`
// 离线缓存不按路由代次拆分: 当天真实分时换源后仍是同一只股票的有效兜底
const cacheKeyOf = ({ market, code, limit }) => `trend:${market}:${code}:${limit}`
const TREND_INTERVAL_MS = 60 * 1000
const MAX_WINDOWS = 1024
const cancelled = () => new StockError('CANCELLED', '分时请求已取消', 503)
const cooling = retryAfterMs => new StockError('RATE_LIMIT', '分时尚未到刷新时间', 429, { retryable: true, retryAfterMs })
export function trendSessionDate(market, payload) {
  const at = payload?.candles?.at(-1)?.at
  return Number.isFinite(at) ? marketDate(market, at * 1000) : null
}
export function createTrendCache({ table, now = Date.now }) {
  const flights = new Map(), windows = new Map()
  const wait = async (flight, signal) => {
    flight.waiters++
    const sharedSignal = flight.controller.signal
    const waitingSignal = signal ? AbortSignal.any([signal, sharedSignal]) : sharedSignal
    let onAbort
    try {
      return await Promise.race([flight.promise, new Promise((_, reject) => {
        onAbort = () => reject(cancelled())
        waitingSignal.addEventListener('abort', onAbort, { once: true })
        if (waitingSignal.aborted) onAbort()
      })])
    } finally {
      waitingSignal.removeEventListener('abort', onAbort)
      if (--flight.waiters === 0 && !flight.settled) flight.controller.abort(cancelled())
    }
  }
  return {
    async fetch(key, signal, fetchTrend) {
      if (signal?.aborted) throw cancelled()
      const day = marketDate(key.market, now())
      let id = `${windowKeyOf(key)}:${day}`
      const currentFlight = flights.get(id)
      if (currentFlight && !currentFlight.controller.signal.aborted) return wait(currentFlight, signal)
      const at = now(), previous = windows.get(id)
      if (previous?.nextAt > at) {
        if (previous.error) {
          if (previous.error.code === 'CANCELLED') throw cooling(previous.nextAt - at)
          const { code, message, status, retryable, routeEpoch } = previous.error
          throw new StockError(code, message, status, { retryable, routeEpoch, retryAfterMs: previous.nextAt - at })
        }
        if (previous.result) return previous.result
        throw cooling(previous.nextAt - at)
      }
      for (const [windowId, window] of windows) {
        if (window.nextAt <= at && !flights.has(windowId)) windows.delete(windowId)
      }
      if (windows.size >= MAX_WINDOWS && !previous) throw cooling(TREND_INTERVAL_MS)
      const window = { nextAt: at + TREND_INTERVAL_MS }, controller = new AbortController()
      windows.set(id, window)
      const flight = { controller, waiters: 0, settled: false, promise: null }
      flights.set(id, flight)
      // 本轮触发切源时，备源已经由同一轮尝试。把在飞与冷却移到新选择，避免换代马上重复回源。
      const moveTo = nextKey => {
        if (flights.get(id) !== flight) return
        const nextId = `${windowKeyOf(nextKey)}:${day}`
        // 目标键已有另一轮在飞或冷却: 让那一轮保持原样, 本轮的窗口留在旧键
        if (flights.has(nextId) || windows.has(nextId)) return
        flights.delete(id)
        windows.delete(id)
        id = nextId
        flights.set(id, flight)
        windows.set(id, window)
      }
      flight.promise = Promise.resolve().then(async () => {
        try {
          if (controller.signal.aborted) throw cancelled()
          const result = await fetchTrend(controller.signal, moveTo)
          if (controller.signal.aborted) throw cancelled()
          // 空响应只占刷新窗口。非空结果(含盘前上一交易日)可在同一窗口内复用；
          // 只有属于当天的完整真分时才写离线表。
          if (!result.candles?.length || (!result.offline && result.complete !== false)) window.result = result
          return result
        } catch (error) {
          window.error = error
          if (error.retryAfterMs > 0) window.nextAt = Math.max(window.nextAt, now() + error.retryAfterMs)
          throw error
        } finally {
          // 执行器排队和同轮补救也耗时，从整轮收尾算下一次刷新时间。
          window.nextAt = Math.max(window.nextAt, now() + TREND_INTERVAL_MS)
          flight.settled = true
          if (flights.get(id) === flight) flights.delete(id)
        }
      })
      return wait(flight, signal)
    },
    dispose() {
      for (const flight of flights.values()) flight.controller.abort(cancelled())
      flights.clear()
      windows.clear()
    },
    async get(key) {
      const raw = await table.get(cacheKeyOf(key))
      // 过期即删: 否则旧记录继续占着淘汰池, 还会被后来者当成"当日缓存"
      const stale = !raw || raw.kind !== 'trend' || !raw.payload?.candles?.length || raw.sessionDate !== marketDate(key.market, now())
      if (!stale) return raw
      if (raw) await table.delete(cacheKeyOf(key)).catch(() => {})
      return null
    },
    // 空结果(上游成功但没数据)和兜底结果都不写: 缓存只存"完整的一次真分时"
    async put(key, result) {
      const sessionDate = trendSessionDate(key.market, result)
      if (!sessionDate || result.complete === false || result.offline || sessionDate !== marketDate(key.market, now())) return
      await table.put(cacheKeyOf(key), { kind: 'trend', sessionDate, cachedAt: now(), payload: result }).catch(() => {})
    },
  }
}
