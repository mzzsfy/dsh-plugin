// 定价规则匹配与四桶计价,零宿主依赖、零 IO。
// 本地时区取 Date 本地分量,timestamp 接受 Date 或 epoch 毫秒;匹配不改写入参。

export const UNIT_PER_MILLION = 'perMillion'
export const CURRENCIES = ['¥', '$']
export const CONDITION_KINDS = ['dailyWindow', 'weekdays', 'monthDays', 'dateRange']
export const TOKENS_PER_MILLION = 1000 * 1000
// 全通配模型键,用于声明全局兜底。
export const GLOBAL_DEFAULT_MODEL = '*/*'

const MODEL_WILDCARD = '*'
const SEGMENT_SEPARATOR = '/'
// 请求侧无斜杠时的 vendor 段缺省值,与存储行 provider 口径同源
export const PROVIDER_UNSET = 'default'
const SEGMENT_EXACT = 0
const SEGMENT_PREFIX = 1
const SEGMENT_SUFFIX = 2
const SEGMENT_INFIX = 3
const SEGMENT_ANY = 4
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

// 所有范围条件统一双侧包含;from>to 跨午夜/跨月环绕;from===to 单点/单日
const dailyWindowMatches = (condition, date) => {
  const from = toMinutesOfDay(condition.from)
  const to = toMinutesOfDay(condition.to)
  if (Number.isNaN(from) || Number.isNaN(to)) return false
  const m = minutesOfDay(date)
  if (from <= to) return m >= from && m <= to
  return m >= from || m <= to
}

// days 空数组不成立;0=周日,取 getDay()
const weekdaysMatches = (condition, date) => {
  const { days } = condition
  return Array.isArray(days) && days.length > 0 && days.includes(date.getDay())
}

// 号段双侧包含;from>to 跨月环绕(账单周期);from===to 单日,2 月无 31 号自然不触发
const monthDaysMatches = (condition, date) => {
  const { from, to } = condition
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false
  const d = date.getDate()
  return from <= to ? d >= from && d <= to : d >= from || d <= to
}

// 零填充 YYYY-MM-DD 字典序双侧包含;from>to 配置错误不成立(编辑器校验拦截)
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
  if (!condition || typeof condition.kind !== 'string' || !Object.hasOwn(CONDITION_MATCHERS, condition.kind)
    || !(date instanceof Date) || Number.isNaN(date.getTime())) return false
  return CONDITION_MATCHERS[condition.kind](condition, date)
}

// 跳过形状残缺的规则,旧规则缺 conditions 或为 null 时视为无条件。
const isRuleShaped = (rule) =>
  !!rule && typeof rule === 'object' && typeof rule.model === 'string'
  && (rule.unit === undefined || rule.unit === UNIT_PER_MILLION)
  && !!rule.price && typeof rule.price === 'object' && !Array.isArray(rule.price)
  && (rule.conditions === undefined || rule.conditions === null || Array.isArray(rule.conditions))

// 只去除同模型后续无条件规则,保留其余原序,避免归一改变不同模式间的平局结果。
export const normalizePricingRules = (rules) => {
  if (!Array.isArray(rules)) return []
  const seen = new Set()
  return rules.filter((rule) => {
    if (!rule || typeof rule !== 'object') return false
    if (rule.conditions != null && (!Array.isArray(rule.conditions) || rule.conditions.length !== 0)) return true
    const model = rule.model
    if (seen.has(model)) return false
    seen.add(model)
    return true
  })
}

// 规则以首个斜杠分段,其后的斜杠属于型号。
export const splitRuleSegments = (pattern) => {
  if (typeof pattern !== 'string') return null
  const slash = pattern.indexOf(SEGMENT_SEPARATOR)
  return slash > 0 ? [pattern.slice(0, slash), pattern.slice(slash + SEGMENT_SEPARATOR.length)] : null
}

const compilePricingSegment = (segment) => {
  if (segment === '' || /\s/.test(segment)) return null
  const star = segment.indexOf(MODEL_WILDCARD)
  if (star < 0) return { kind: SEGMENT_EXACT, head: segment, tail: '', literalLength: segment.length }
  if (star !== segment.lastIndexOf(MODEL_WILDCARD)) return null
  const head = segment.slice(0, star)
  const tail = segment.slice(star + MODEL_WILDCARD.length)
  const kind = head ? (tail ? SEGMENT_INFIX : SEGMENT_PREFIX) : (tail ? SEGMENT_SUFFIX : SEGMENT_ANY)
  return { kind, head, tail, literalLength: head.length + tail.length }
}

const compilePricingModel = (pattern) => {
  const segments = splitRuleSegments(pattern)
  if (!segments) return null
  const provider = compilePricingSegment(segments[0])
  const model = compilePricingSegment(segments[1])
  return provider && model ? { provider, model } : null
}

export const isTwoSegmentModel = (pattern) => compilePricingModel(pattern) !== null

// 请求侧无斜杠或首位斜杠时沿用缺省供应商。
export const splitRequestSegments = (model) => splitRuleSegments(model) ?? [PROVIDER_UNSET, model]

// 只缓存规则的模式编译结果,条目随规则引用回收,改写 model 时重新编译。
const pricingPatternCache = new WeakMap()
const compiledPricingModel = (rule) => {
  const source = rule.model
  const cached = pricingPatternCache.get(rule)
  if (cached?.source === source) return cached.pattern
  const pattern = compilePricingModel(source)
  pricingPatternCache.set(rule, { source, pattern })
  return pattern
}

const pricingSegmentMatches = (segment, value) => {
  if (segment.kind === SEGMENT_EXACT) return value === segment.head
  if (segment.kind === SEGMENT_ANY) return true
  return value.length >= segment.literalLength && value.startsWith(segment.head) && value.endsWith(segment.tail)
}

const comparePricingSegments = (a, b) => {
  if (a.kind === SEGMENT_EXACT || b.kind === SEGMENT_EXACT) return a.kind - b.kind
  return b.literalLength - a.literalLength || a.kind - b.kind
}

const comparePricingPriority = (a, aCount, b, bCount) =>
  comparePricingSegments(a.provider, b.provider) || comparePricingSegments(a.model, b.model) || bCount - aCount

const toLocalDate = (timestamp) => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

const pricingConditionsMatch = (conditions, date) => {
  for (let index = 0; index < conditions.length; index += 1) {
    if (!conditionMatches(conditions[index], date)) return false
  }
  return true
}

// 热路径单遍择优;解释路径复用相同的匹配和比较,另收集所有候选。
const selectPricingRule = (rules, model, timestamp, candidates) => {
  if (!Array.isArray(rules) || rules.length === 0 || typeof model !== 'string') return null
  const date = toLocalDate(timestamp)
  if (!date) return null
  const [requestProvider, requestModel] = splitRequestSegments(model)
  let winner = null
  let bestPattern = null
  let bestCount = 0
  for (const rule of rules) {
    if (!isRuleShaped(rule)) continue
    const pattern = compiledPricingModel(rule)
    if (!pattern || !pricingSegmentMatches(pattern.provider, requestProvider)
      || !pricingSegmentMatches(pattern.model, requestModel)) continue
    const conditions = rule.conditions
    const conditionCount = conditions?.length ?? 0
    // 只取胜者时,无法超越当前胜者的规则不再评估条件。
    const isBetter = bestPattern === null || comparePricingPriority(pattern, conditionCount, bestPattern, bestCount) < 0
    if (!isBetter && !candidates) continue
    if (conditionCount > 0 && !pricingConditionsMatch(conditions, date)) continue
    if (candidates) candidates.push({ rule, pattern, conditionCount })
    if (isBetter) {
      bestPattern = pattern
      bestCount = conditionCount
      winner = rule
    }
  }
  return winner
}

export const resolvePricingRule = (rules, model, timestamp) => {
  const ranked = []
  const winner = selectPricingRule(rules, model, timestamp, ranked)
  const compare = (a, b) => comparePricingPriority(a.pattern, a.conditionCount, b.pattern, b.conditionCount)
  // 稳定排序保留同优先级原序,冲突仅含与首条实质并列的规则。
  ranked.sort(compare)
  const candidates = ranked.map(({ rule }) => rule)
  const firstLower = ranked.findIndex((entry) => compare(entry, ranked[0]) !== 0)
  const topCount = firstLower === -1 ? ranked.length : firstLower
  return { winner, candidates, conflictRules: topCount > 1 ? candidates.slice(0, topCount) : [] }
}

export const matchPrice = (rules, model, timestamp) => selectPricingRule(rules, model, timestamp)?.price ?? null

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
