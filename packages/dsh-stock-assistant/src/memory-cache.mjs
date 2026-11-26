// 可重建的派生数据只放内存: K 线、目录、日历丢了重拉即可, 落盘只会把控制记录一起拖大
const CACHE_LIMIT = 512

// 与数据域 table 同形的最小实现: catalog 只遍历 entries, kline-cache 只 get/put/delete
export function createMemoryCache({ limit = CACHE_LIMIT } = {}) {
  const records = new Map()
  // 版本号让消费方按"这份缓存变过没有"做记忆化: 目录展平与校验是整表成本, 不该每次搜索都付
  let version = 0
  return {
    get: key => records.get(key),
    async put(key, value) {
      version += 1
      records.delete(key)
      records.set(key, value)
      // 超限先丢最久未写的: 缓存的命门是内存, 不是命中率
      while (records.size > limit) records.delete(records.keys().next().value)
    },
    async delete(key) { const removed = records.delete(key); if (removed) version += 1; return removed },
    entries: () => records.entries(),
    get size() { return records.size },
    get version() { return version },
  }
}
