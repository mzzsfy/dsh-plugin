// 用量聚合纯函数:store 行形状仅作数据约定,零宿主依赖。
// 桶串本地时区推导,同粒度字典序即时间序;daily 零值槽全枚举,超槽数保最新丢最旧。

import { costOf, matchPrice } from './pricing.js'

export const MAX_SLOTS = 2000

const PAD_WIDTH = 2
const PERCENT_SCALE = 100
const MS_PER_SECOND = 1000

const GRANULARITY_DAILY = 'D'
const GRANULARITY_HOURLY = 'H'
const GRANULARITY_MINUTE = 'M'

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const HOUR_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/
const MINUTE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

// 桶串前缀宽:D 段定位日槽,M 行截取父 H 桶
const DAY_KEY_WIDTH = 'YYYY-MM-DD'.length
const HOUR_KEY_WIDTH = 'YYYY-MM-DDTHH'.length

const pad = (value) => String(value).padStart(PAD_WIDTH, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const formatHour = (date) => `${formatDate(date)}T${pad(date.getHours())}`
const formatMinute = (date) => `${formatHour(date)}:${pad(date.getMinutes())}`

const nextDay = (date) => {
  const next = new Date(date)
  next.setDate(next.getDate() + 1)
  return next
}
const nextHour = (date) => {
  const next = new Date(date)
  next.setHours(next.getHours() + 1)
  return next
}
const nextMinute = (date) => {
  const next = new Date(date)
  next.setMinutes(next.getMinutes() + MINUTE_STEP_MINUTES)
  return next
}

// 分钟桶粒度:枚举与桶键共用同一步长,from 必须对齐桶边界
const MINUTE_STEP_MINUTES = 10

// pattern 锚定桶串形态,suffix 补全为本地时区可解析日期串,format 回读校验分量合法性
const BUCKET_FORMS = {
  [GRANULARITY_DAILY]: { pattern: DAY_KEY_PATTERN, suffix: 'T00:00:00', format: formatDate, step: nextDay },
  [GRANULARITY_HOURLY]: { pattern: HOUR_KEY_PATTERN, suffix: ':00:00', format: formatHour, step: nextHour },
  [GRANULARITY_MINUTE]: { pattern: MINUTE_KEY_PATTERN, suffix: ':00', format: formatMinute, step: nextMinute, align: MINUTE_STEP_MINUTES },
}

const parseBucketKey = (key, form) => {
  if (typeof key !== 'string' || !form.pattern.test(key)) return null
  const parsed = new Date(`${key}${form.suffix}`)
  return Number.isNaN(parsed.getTime()) || form.format(parsed) !== key ? null : parsed
}

const enumerateBucketKeys = (form) => (from, to) => {
  const start = parseBucketKey(from, form)
  const end = parseBucketKey(to, form)
  if (!start || !end) return []
  if (form.align && start.getMinutes() % form.align !== 0) return []
  const keys = []
  for (let cursor = start, key = form.format(cursor); key <= to; key = form.format(cursor)) {
    keys.push(key)
    cursor = form.step(cursor)
  }
  return keys
}

export const daysInRange = enumerateBucketKeys(BUCKET_FORMS[GRANULARITY_DAILY])
export const hourKeysInRange = enumerateBucketKeys(BUCKET_FORMS[GRANULARITY_HOURLY])
export const minuteKeysInRange = enumerateBucketKeys(BUCKET_FORMS[GRANULARITY_MINUTE])

const emptySlot = (day) => ({
  day,
  total: 0,
  byModel: {},
  byProvider: {},
  requests: 0,
  turns: 0,
  cacheHit: 0,
  cacheMiss: 0,
})

const addRowToSlot = (slot, row, tokens) => {
  slot.total += tokens
  slot.requests += row.requests
  slot.turns += row.turns
  slot.cacheHit += row.cacheReadTokens
  slot.cacheMiss += row.inputTokens + row.cacheWriteTokens
}

const percentOf = (part, total) => (total === 0 ? 0 : (part / total) * PERCENT_SCALE)

const rowTokens = (row) => row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens

export function aggregateRange(rows, g, from, to) {
  const form = BUCKET_FORMS[g]
  const slots = enumerateBucketKeys(form)(from, to).map((key) => emptySlot(key))
  const slotByKey = new Map(slots.map((slot) => [slot.day, slot]))
  const modelTotals = new Map()
  const providerTotals = new Map()
  const activeBuckets = new Set()
  for (const row of rows) {
    const slot = slotByKey.get(row.bucket)
    // 桶串未落在枚举序列(如改粒度前的历史残行)不可归属,跳过防崩
    if (!slot) continue
    const tokens = rowTokens(row)
    addRowToSlot(slot, row, tokens)
    if (tokens === 0) continue
    activeBuckets.add(row.bucket)
    slot.byModel[row.model] = (slot.byModel[row.model] ?? 0) + tokens
    slot.byProvider[row.provider] = (slot.byProvider[row.provider] ?? 0) + tokens
    const modelTotal = modelTotals.get(row.model)
    if (modelTotal) {
      modelTotal.tokens += tokens
      modelTotal.speedDurationMs += row.durationMs ?? 0
      modelTotal.speedOutputTokens += row.durationMs ? row.outputTokens : 0
    } else {
      modelTotals.set(row.model, {
        provider: row.provider,
        tokens,
        speedDurationMs: row.durationMs ?? 0,
        speedOutputTokens: row.durationMs ? row.outputTokens : 0,
      })
    }
    providerTotals.set(row.provider, (providerTotals.get(row.provider) ?? 0) + tokens)
  }
  const totals = { tokens: 0, requests: 0, turns: 0, cacheHit: 0, cacheMiss: 0 }
  for (const slot of slots) {
    totals.tokens += slot.total
    totals.requests += slot.requests
    totals.turns += slot.turns
    totals.cacheHit += slot.cacheHit
    totals.cacheMiss += slot.cacheMiss
  }
  // speed = 配对口径的输出 token ÷ 模型时长秒;仅时长>0 的行计入分子分母,
  // 存量旧格式行只进 tokens 不进分母,无时长数据条目不挂 speed 字段
  const models = [...modelTotals.entries()]
    .map(([model, agg]) => ({
      model,
      provider: agg.provider,
      tokens: agg.tokens,
      percent: percentOf(agg.tokens, totals.tokens),
      ...(agg.speedDurationMs > 0 ? { speed: agg.speedOutputTokens / (agg.speedDurationMs / MS_PER_SECOND) } : {}),
    }))
    .sort((a, b) => b.tokens - a.tokens)
  const providers = [...providerTotals.entries()]
    .map(([provider, tokens]) => ({ provider, tokens, percent: percentOf(tokens, totals.tokens) }))
    .sort((a, b) => b.tokens - a.tokens)
  const truncated = slots.length > MAX_SLOTS
  const daily = truncated ? slots.slice(-MAX_SLOTS) : slots
  const top = models[0]
  const result = {
    from,
    to,
    tokens: totals.tokens,
    requests: totals.requests,
    turns: totals.turns,
    cacheHit: totals.cacheHit,
    cacheMiss: totals.cacheMiss,
    activeDays: activeBuckets.size,
    topModel: top?.model ?? '',
    topProvider: top?.provider ?? '',
    daily,
    models,
    providers,
  }
  if (truncated) result.truncated = true
  return result
}

// 聚合计价的槽定位:D 折叠到日槽,H/M 即本槽;计价一律取行所属 H 桶起点
const COST_SLOT_KEYS = {
  [GRANULARITY_DAILY]: (bucket) => bucket.slice(0, DAY_KEY_WIDTH),
  [GRANULARITY_HOURLY]: (bucket) => bucket,
  [GRANULARITY_MINUTE]: (bucket) => bucket,
}

// 聚合计价:以可见槽为唯一口径,cost 行按 H 桶起点匹配价格后累加;
// unpriced = 有 token 而未命中价的去重 H 桶数,被截断丢弃的行整体不参与。
// 纯函数返回新 result,不修改入参;调用方不调用则响应无 cost/unpriced 字段
export function attachCosts(result, costRows, granularity, rules) {
  const slotKeyOf = COST_SLOT_KEYS[granularity]
  const slotOfDay = new Map(result.daily.map((slot) => [slot.day, slot]))
  const slotCosts = new Map()
  const modelCosts = new Map(result.models.map((entry) => [entry.model, 0]))
  const unpricedHours = new Set()
  for (const row of costRows) {
    const slot = slotOfDay.get(slotKeyOf(row.bucket))
    if (!slot || rowTokens(row) === 0) continue
    const hourKey = row.bucket.slice(0, HOUR_KEY_WIDTH)
    const date = parseBucketKey(hourKey, BUCKET_FORMS[GRANULARITY_HOURLY])
    if (!date) continue
    const price = matchPrice(rules, row.model, date)
    if (!price) {
      unpricedHours.add(hourKey)
      continue
    }
    const cost = costOf(price, row)
    slotCosts.set(slot.day, (slotCosts.get(slot.day) ?? 0) + cost)
    if (modelCosts.has(row.model)) modelCosts.set(row.model, modelCosts.get(row.model) + cost)
  }
  const daily = result.daily.map((slot) => ({ ...slot, cost: slotCosts.get(slot.day) ?? 0 }))
  const cost = daily.reduce((sum, slot) => sum + slot.cost, 0)
  const models = result.models.map((entry) => ({ ...entry, cost: modelCosts.get(entry.model) }))
  return { ...result, daily, models, cost, unpriced: unpricedHours.size }
}
