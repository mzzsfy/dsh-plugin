import { marketDate } from './market-model.mjs'
// 报价拍点: 分时上游不可用时, 用报价轮询攒下的点续在当日真实分时后面, 好过断在最后一根。
// 同一分钟只留最后一条(分钟图的分辨率就是这样), 一天一换; 单证券点数按最长交易时段封顶,
// 证券数也有上限——详情页浏览会带来大量一次性的 peek 报价, 不封就会一直涨。
const MINUTE_SECONDS = 60
// 伦敦 8.5 小时是最长的一个交易时段, 其余市场都比它短
const POINTS_LIMIT = 8 * 60 + 30
const SECURITY_LIMIT = 200
const minuteOf = seconds => Math.floor(seconds / MINUTE_SECONDS)
export function createTickStore({ now = Date.now, limit = POINTS_LIMIT, securities = SECURITY_LIMIT }) {
  const store = new Map()
  const pointsFor = (securityId, sessionDate) => {
    const entry = store.get(securityId)
    // 命中即移到队尾: 淘汰的是"最久没报价"的证券, 不是最早进来的
    if (entry?.sessionDate === sessionDate) { store.delete(securityId); store.set(securityId, entry); return entry.points }
    const points = []
    store.delete(securityId)
    store.set(securityId, { sessionDate, points })
    while (store.size > securities) store.delete(store.keys().next().value)
    return points
  }
  return {
    push(securityId, market, at, price) {
      // 缺失值不是 0: Number(null) 会得到真实的 0, 在图上就是一条贴着地板的价格
      const stamp = at == null || at === '' ? NaN : Number(at), value = price == null || price === '' ? NaN : Number(price)
      if (!Number.isFinite(stamp) || !Number.isFinite(value)) return
      const points = pointsFor(securityId, marketDate(market, stamp * 1000))
      // 同一分钟的点是同一根分钟线的不同快照, 后到的覆盖前一条
      const last = points.at(-1)
      if (last && minuteOf(last.at) === minuteOf(stamp)) { points[points.length - 1] = { at: stamp, price: value }; return }
      points.push({ at: stamp, price: value })
      // 画线要时间序: 补历史点或来源时钟回拨都会让插入顺序不等于时间顺序, 排序后再裁剪
      points.sort((a, b) => a.at - b.at)
      if (points.length > limit) points.splice(0, points.length - limit)
    },
    series(securityId, market) {
      const entry = store.get(securityId)
      if (!entry || entry.sessionDate !== marketDate(market, now())) return []
      return entry.points.map(point => ({ ...point }))
    },
    delete(securityId) { store.delete(securityId) },
    clear() { store.clear() },
    get size() { return store.size },
  }
}
