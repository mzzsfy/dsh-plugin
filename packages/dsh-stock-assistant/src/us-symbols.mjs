// 美股代码 → 交易所标识(mktNum/JYS)的映射: 上游只在部分接口给出, 下游拼 secid 与后缀时要用。
// 写入方是适配器(ctx.usSymbols), 没有自然的回收点, 所以上限与过期都由容器自己保证。
// 必须保持 Map 接口: 适配器只用 get/set, 测试里大量注入裸 Map。
export const US_SYMBOL_LIMIT = 500
export const US_SYMBOL_TTL = 24 * 60 * 60 * 1000

class UsSymbols extends Map {
  constructor({ now, limit, ttl }) {
    super()
    this.now = now
    this.limit = limit
    this.ttl = ttl
  }
  get(key) {
    const entry = super.get(key)
    if (entry === undefined) return undefined
    // 过期的映射等于没有: 留着只会让拼错 secid 的请求打到一个早就换过的市场
    if (this.now() - entry.at > this.ttl) { this.delete(key); return undefined }
    return entry
  }
  // 写入即移到尾部: Map 的迭代序就是淘汰序, 不重排会让最活跃的映射停在头部先被淘汰
  set(key, value) {
    this.delete(key)
    super.set(key, value)
    while (this.size > this.limit) this.delete(this.keys().next().value)
    return this
  }
}

export const createUsSymbols = ({ now = Date.now, limit = US_SYMBOL_LIMIT, ttl = US_SYMBOL_TTL } = {}) => new UsSymbols({ now, limit, ttl })
