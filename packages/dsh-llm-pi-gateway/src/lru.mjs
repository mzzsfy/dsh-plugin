// 有界 LRU 键值缓存:Map 的插入序即使用序,命中重排为最近使用,
// 写入超上限时淘汰最久未用键,供长会话/多模型场景的进程内缓存封顶。

/**
 * @param {number} limit 容量上限,超过即淘汰最久未用键
 * @returns {{readonly size: number, get: (key: string) => unknown, set: (key: string, value: unknown) => unknown}}
 */
export function createLru(limit) {
  const entries = new Map()
  return {
    get size() {
      return entries.size
    },
    get(key) {
      if (!entries.has(key)) return undefined
      const value = entries.get(key)
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)
      if (entries.size > limit) entries.delete(entries.keys().next().value)
      return value
    },
  }
}
