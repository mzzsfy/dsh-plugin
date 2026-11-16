// K线缓存: 只存内存(TTL 与 routingRevision 双失效)。键里的冒号是命名空间, 不落盘就没有文件名约束
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// TTL 唯一事实源(design.md 数据结构节): 按周期定寿命。分时不走这张表, 它有自己的当日缓存(trend-cache.mjs)
const TTL_BY_PERIOD = { '1d': HOUR, '1w': DAY, '1M': DAY }
const DEFAULT_LIMIT = 250
// limit 是请求契约的一部分: 250 与 1000 根的结果不同, 不隔离会互相命中错数据
const keyOf = ({ providerInstanceId, market, period, code, limit = DEFAULT_LIMIT }) => `kline:${providerInstanceId}:${market}:${period}:${code}:${limit}`

export function createKlineCache({ cacheTable, now }) {
  const key = keyParts => keyOf(keyParts)
  async function get(keyParts, routingRevision) {
    const raw = await cacheTable.get(key(keyParts))
    if (!raw || raw.kind !== 'kline') return null
    const ttl = TTL_BY_PERIOD[keyParts.period]
    if (now() - raw.fetchedAt >= ttl || raw.payload?.routingRevision !== routingRevision) {
      // 过期即删: update 返回 undefined 会把空值写进表, 之后 records() 遍历到这里就炸
      await cacheTable.delete(key(keyParts)).catch(() => {})
      return null
    }
    return raw
  }
  async function put(keyParts, result, routingRevision) {
    if (!TTL_BY_PERIOD[keyParts.period]) return
    const value = { kind: 'kline', source: result.providerInstanceId, fetchedAt: now(), payload: { ...result, routingRevision } }
    await cacheTable.put(key(keyParts), value).catch(() => {})
  }
  return { get, put }
}
