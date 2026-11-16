import { marketDate } from './market-model.mjs'
// 当日分时缓存: 一个交易日一份, 成功一次就覆盖前一份, 只在上游失败时读取。
// 数据日期取最后一根分时的时间而不是请求时刻: 周末/盘前请求拿到的是上一交易日的线, 不能当成今天的缓存。
const keyOf = ({ market, code, limit }) => `trend:${market}:${code}:${limit}`
const dayOf = (market, payload) => {
  const at = Number(payload?.candles?.at(-1)?.at)
  return Number.isFinite(at) ? marketDate(market, at * 1000) : null
}
export function createTrendCache({ table, now = Date.now }) {
  return {
    async get(key) {
      const raw = await table.get(keyOf(key))
      // 过期即删: 否则旧记录继续占着淘汰池, 还会被后来者当成"当日缓存"
      const stale = !raw || raw.kind !== 'trend' || !raw.payload?.candles?.length || raw.sessionDate !== marketDate(key.market, now())
      if (!stale) return raw
      if (raw) await table.delete(keyOf(key)).catch(() => {})
      return null
    },
    // 空结果(上游成功但没数据)和兜底结果都不写: 缓存只存"完整的一次真分时"
    async put(key, result) {
      const sessionDate = dayOf(key.market, result)
      if (!sessionDate || result.complete === false || result.offline) return
      await table.put(keyOf(key), { kind: 'trend', sessionDate, cachedAt: now(), payload: result }).catch(() => {})
    },
  }
}
