// 定价纯函数:规则匹配与四桶计价,零宿主依赖、零 IO、无全局状态。
// 本地时区取 Date 本地分量,timestamp 接受 Date 或 epoch 毫秒;匹配只读遍历入参规则。

export const UNIT_PER_MILLION = 'perMillion'
export const CURRENCIES = ['¥', '$']
export const CONDITION_KINDS = ['dailyWindow', 'weekdays', 'monthDays', 'dateRange']
export const TOKENS_PER_MILLION = 1000 * 1000

const MODEL_WILDCARD = '*'
const MINUTES_PER_HOUR = 60
const DAY_PART_WIDTH = 2
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const pad = (value) => String(value).padStart(DAY_PART_WIDTH, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

const minutesOfDay = (date) => date.getHours() * MINUTES_PER_HOUR + date.getMinutes()

const toMinutesOfDay = (hhmm) => {
  if (typeof hhmm !== 'string') return Number.NaN
  const [hours, minutes] = hhmm.split(':')
  const h = Number(hours)
  const m = Number(minutes)
  return Number.isFinite(h) && Number.isFinite(m) ? h * MINUTES_PER_HOUR + m : Number.NaN
}

// from<to 含头不含尾;from>to 跨午夜;from===to 全天生效
const dailyWindowMatches = (condition, date) => {
  const from = toMinutesOfDay(condition.from)
  const to = toMinutesOfDay(condition.to)
  if (Number.isNaN(from) || Number.isNaN(to)) return false
  const m = minutesOfDay(date)
  if (from < to) return m >= from && m < to
  if (from > to) return m >= from || m < to
  return true
}

// days 空数组不成立;0=周日,取 getDay()
const weekdaysMatches = (condition, date) => {
  const { days } = condition
  return Array.isArray(days) && days.length > 0 && days.includes(date.getDay())
}

// 号段双闭;from>to 跨月环绕(如 26~25 账单周期);日号必须整数,2 月无 31 号自然不触发
const monthDaysMatches = (condition, date) => {
  const { from, to } = condition
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false
  const d = date.getDate()
  return from <= to ? d >= from && d <= to : d >= from || d <= to
}

// 要求零填充 YYYY-MM-DD 字典序双闭;from>to 属配置错误不成立,非规范串同样不成立
const dateRangeMatches = (condition, date) => {
  const { from, to } = condition
  if (typeof from !== 'string' || typeof to !== 'string') return false
  if (!ISO_DAY_PATTERN.test(from) || !ISO_DAY_PATTERN.test(to) || from > to) return false
  const iso = formatDate(date)
  return iso >= from && iso <= to
}

const CONDITION_MATCHERS = {
  dailyWindow: dailyWindowMatches,
  weekdays: weekdaysMatches,
  monthDays: monthDaysMatches,
  dateRange: dateRangeMatches,
}

// 单条件判定;未知 kind、形状残缺或非法 Date 一律不成立
export const conditionMatches = (condition, date) => {
  const matcher = condition && CONDITION_MATCHERS[condition.kind]
  if (!matcher || !(date instanceof Date) || Number.isNaN(date.getTime())) return false
  return matcher(condition, date)
}

// 形状残缺规则跳过:缺 model/price、unit 非 perMillion、conditions 非数组(含缺失)
const isRuleShaped = (rule) =>
  !!rule && typeof rule === 'object' && typeof rule.model === 'string'
  && (rule.unit === undefined || rule.unit === UNIT_PER_MILLION)
  && !!rule.price && typeof rule.price === 'object' && !Array.isArray(rule.price)
  && Array.isArray(rule.conditions)

const firstMatchingPrice = (rules, date, modelFilter) => {
  for (const rule of rules) {
    if (!isRuleShaped(rule) || !modelFilter(rule)) continue
    if (rule.conditions.every((condition) => conditionMatches(condition, date))) return rule.price
  }
  return null
}

const toLocalDate = (timestamp) => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

// 精确子集按数组序取首个命中;无精确子集或全不命中回落 '*' 子集;仍无命中为 null(调用方计 unpriced)
export const matchPrice = (rules, model, timestamp) => {
  const date = toLocalDate(timestamp)
  if (!Array.isArray(rules) || !date || typeof model !== 'string') return null
  return firstMatchingPrice(rules, date, (rule) => rule.model === model)
    ?? firstMatchingPrice(rules, date, (rule) => rule.model === MODEL_WILDCARD)
}

const BUCKET_PRICE_KEYS = [
  { tokens: 'inputTokens', price: 'input' },
  { tokens: 'outputTokens', price: 'output' },
  { tokens: 'cacheReadTokens', price: 'cacheRead' },
  { tokens: 'cacheWriteTokens', price: 'cacheWrite' },
]

const toFiniteNumber = (value) => (Number.isFinite(value) ? value : 0)

// 费用 = Σ(桶 token × 桶单价) / 每百万;缺桶或非法值按 0,原始浮点不圆整(展示层负责)
export const costOf = (price, buckets) => {
  let raw = 0
  for (const { tokens, price: priceKey } of BUCKET_PRICE_KEYS) {
    raw += toFiniteNumber(buckets?.[tokens]) * toFiniteNumber(price?.[priceKey])
  }
  return raw / TOKENS_PER_MILLION
}
