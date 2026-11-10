// K线缓存: 只存内存(TTL 与 routingRevision 双失效)。键里的冒号是命名空间, 不落盘就没有文件名约束
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// TTL 唯一事实源(design.md 数据结构节): trend 0=不缓存, 其余按周期
const TTL_BY_PERIOD = { trend: 0, '1d': HOUR, '1w': DAY, '1M': DAY }
const keyOf = ({ providerInstanceId, market, period, code }) => `kline:${providerInstanceId}:${market}:${period}:${code}`

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
  async function invalidate(keyParts) {
    await cacheTable.delete(key(keyParts)).catch(() => {})
  }
  return { get, put, invalidate }
}
