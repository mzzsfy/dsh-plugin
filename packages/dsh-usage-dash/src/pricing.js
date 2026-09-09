// 定价纯函数:规则匹配与四桶计价,零宿主依赖、零 IO、无全局状态。
// 本地时区取 Date 本地分量,timestamp 接受 Date 或 epoch 毫秒;匹配只读遍历入参规则。

export const UNIT_PER_MILLION = 'perMillion'
export const CURRENCIES = ['¥', '$']
export const CONDITION_KINDS = ['dailyWindow', 'weekdays', 'monthDays', 'dateRange']
export const TOKENS_PER_MILLION = 1000 * 1000

const MODEL_WILDCARD = '*'
const SEGMENT_SEPARATOR = '/'
// 请求侧无斜杠时的 vendor 段缺省值,与存储行 provider 口径同源
export const PROVIDER_UNSET = 'default'
// 档位权重:vendor 段通配 1 档、model 段通配 2 档,和越小越优先(模型名精确档恒优于供应商精确档)
const VENDOR_WILDCARD_TIER = 1
const MODEL_WILDCARD_TIER = 2
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

// 所有范围条件统一左闭右开;from>to 跨午夜/跨月环绕;from===to 空区间不成立
const dailyWindowMatches = (condition, date) => {
  const from = toMinutesOfDay(condition.from)
  const to = toMinutesOfDay(condition.to)
  if (Number.isNaN(from) || Number.isNaN(to)) return false
  const m = minutesOfDay(date)
  if (from < to) return m >= from && m < to
  if (from > to) return m >= from || m < to
  return false
}

// days 空数组不成立;0=周日,取 getDay()
const weekdaysMatches = (condition, date) => {
  const { days } = condition
  return Array.isArray(days) && days.length > 0 && days.includes(date.getDay())
}

// 号段左闭右开;from>to 跨月环绕(账单周期);to 允许 32 表达"到月末";日号必须整数,2 月无 31 号自然不触发
const monthDaysMatches = (condition, date) => {
  const { from, to } = condition
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false
  if (from === to) return false
  const d = date.getDate()
  return from < to ? d >= from && d < to : d >= from || d < to
}

// 零填充 YYYY-MM-DD 字典序左闭右开;from>=to 空区间不成立
const dateRangeMatches = (condition, date) => {
  const { from, to } = condition
  if (typeof from !== 'string' || typeof to !== 'string') return false
  if (!ISO_DAY_PATTERN.test(from) || !ISO_DAY_PATTERN.test(to) || from >= to) return false
  const iso = formatDate(date)
  return iso >= from && iso < to
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

// 规则模型键必须两段式:首个 / 前 vendor 段、后模型段(允许含 /),首位斜杠或无斜杠均非法
export const splitRuleSegments = (pattern) => {
  const slash = pattern.indexOf(SEGMENT_SEPARATOR)
  return slash > 0 ? [pattern.slice(0, slash), pattern.slice(slash + SEGMENT_SEPARATOR.length)] : null
}

// 段须非空且不含空白:含空白的模型键永不匹配真实请求
const SEGMENT_PATTERN = /^\S+$/

export const isTwoSegmentModel = (pattern) => {
  const segments = splitRuleSegments(pattern)
  return segments !== null && segments.every((segment) => SEGMENT_PATTERN.test(segment))
}

// 请求侧模型键按同构规则分段,无 / 或首位斜杠时 vendor 段缺省归 default(与存储行口径一致)
export const splitRequestSegments = (model) => splitRuleSegments(model) ?? [PROVIDER_UNSET, model]

// 段级比对:规则段为通配或与请求段相等;两段全过才成立,通配段按各自档位计权
const matchTier = (ruleSegments, requestSegments) => {
  const [ruleVendor, ruleModel] = ruleSegments
  const [requestVendor, requestModel] = requestSegments
  if (ruleVendor !== MODEL_WILDCARD && ruleVendor !== requestVendor) return null
  if (ruleModel !== MODEL_WILDCARD && ruleModel !== requestModel) return null
  return (ruleVendor === MODEL_WILDCARD ? VENDOR_WILDCARD_TIER : 0)
    + (ruleModel === MODEL_WILDCARD ? MODEL_WILDCARD_TIER : 0)
}

const toLocalDate = (timestamp) => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

// 匹配链:全名 > 模型名(vendor 通配)> 供应商(model 通配)> '*/*' 全通;
// 档位最小者胜,同档按数组序取首个;高档条件不满足自然落低档;无命中为 null(调用方计 unpriced)
export const matchPrice = (rules, model, timestamp) => {
  const date = toLocalDate(timestamp)
  if (!Array.isArray(rules) || !date || typeof model !== 'string') return null
  const requestSegments = splitRequestSegments(model)
  let bestTier = Infinity
  let bestPrice = null
  for (const rule of rules) {
    if (!isRuleShaped(rule)) continue
    const ruleSegments = splitRuleSegments(rule.model)
    if (!ruleSegments) continue
    const tier = matchTier(ruleSegments, requestSegments)
    if (tier === null || tier >= bestTier) continue
    if (!rule.conditions.every((condition) => conditionMatches(condition, date))) continue
    bestTier = tier
    bestPrice = rule.price
  }
  return bestPrice
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
