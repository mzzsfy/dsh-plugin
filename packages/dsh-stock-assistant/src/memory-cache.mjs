// 可重建的派生数据只放内存: K 线、目录、日历丢了重拉即可, 落盘只会把控制记录一起拖大
const CACHE_LIMIT = 512

// 与数据域 table 同形的最小实现: catalog 只遍历 entries, kline-cache 只 get/put/delete
export function createMemoryCache({ limit = CACHE_LIMIT } = {}) {
  const records = new Map()
  return {
    get: key => records.get(key),
    async put(key, value) {
      records.delete(key)
      records.set(key, value)
      // 超限先丢最久未写的: 缓存的命门是内存, 不是命中率
      while (records.size > limit) records.delete(records.keys().next().value)
    },
    async delete(key) { return records.delete(key) },
    entries: () => records.entries(),
    get size() { return records.size },
  }
}
