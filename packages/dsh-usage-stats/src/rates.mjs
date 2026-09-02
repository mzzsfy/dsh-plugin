// 汇率解析与新鲜度判定:纯函数,网络请求由 host 半区执行。

// 全源失败且无历史缓存时的兜底汇率(每 USD 兑 CNY)。
export const DEFAULT_USD_CNY = 7.2

// 刷新节奏:每 6 小时。
export const RATE_TTL_MS = 6 * 60 * 60 * 1000

// 超过刷新周期即视为非实时,沿用上次值并标注。
export function isRateStale(fetchedAt, now) {
  return !(now - fetchedAt < RATE_TTL_MS)
}

// 腾讯财经行情文本:v_whUSDCNY="100~USDCNY~7.2531~..."。
export function parseTencentRate(text) {
  if (typeof text !== 'string') return null
  const match = text.match(/USDCNY[^0-9]+([0-9]+\.[0-9]+)/)
  const rate = match ? Number(match[1]) : NaN
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

// open.er-api 响应:{ result: "success", rates: { CNY } }。
export function parseErApiRate(payload) {
  const rate = payload && payload.rates ? Number(payload.rates.CNY) : NaN
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

// 拉取成功刷新并清除标注;失败沿用上次汇率并标注非实时;无任何历史时用兜底值。
export function resolveRate(previous, outcome, now) {
  if (outcome && outcome.ok && Number.isFinite(outcome.rate) && outcome.rate > 0) {
    return { rate: outcome.rate, fetchedAt: now, stale: false }
  }
  if (previous && Number.isFinite(previous.rate) && previous.rate > 0) {
    return { rate: previous.rate, fetchedAt: previous.fetchedAt, stale: true }
  }
  return { rate: DEFAULT_USD_CNY, fetchedAt: 0, stale: true }
}
