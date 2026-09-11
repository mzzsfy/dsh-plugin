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

// 速度配对分子:decode 口径取 decodeTokens;存量旧格式行(带时长无 decodeTokens)
// 回落 outputTokens,聚合随新数据自然收敛
const speedTokensOf = (row) => (row.durationMs ? row.decodeTokens ?? row.outputTokens : 0)

export function aggregateRange(rows, g, from, to) {
  const form = BUCKET_FORMS[g]
  const slots = enumerateBucketKeys(form)(from, to).map((key) => emptySlot(key))
  const slotByKey = new Map(slots.map((slot) => [slot.day, slot]))
  const modelTotals = new Map()
  const providerTotals = new Map()
  const activeBuckets = new Set()
  // 槽级配对:桶串 → 速度对 {decodeTokens, durationMs} 与首字对 {ttftMs, ttftSteps},
  // 与模型级同口径(仅带配对数据的行计入)
  const slotSpeeds = new Map()
  const slotTtfts = new Map()
  for (const row of rows) {
    const slot = slotByKey.get(row.bucket)
    // 桶串未落在枚举序列(如改粒度前的历史残行)不可归属,跳过防崩
    if (!slot) continue
    const tokens = rowTokens(row)
    addRowToSlot(slot, row, tokens)
    // 纯 timing 行(零 token 桶 + decode 配对)不参与归因,但仍进配对聚合
    if (tokens > 0) {
      activeBuckets.add(row.bucket)
      slot.byModel[row.model] = (slot.byModel[row.model] ?? 0) + tokens
      slot.byProvider[row.provider] = (slot.byProvider[row.provider] ?? 0) + tokens
    }
    if (row.durationMs) {
      const pair = slotSpeeds.get(row.bucket) ?? { decodeTokens: 0, durationMs: 0 }
      pair.decodeTokens += speedTokensOf(row)
      pair.durationMs += row.durationMs
      slotSpeeds.set(row.bucket, pair)
    }
    if (row.ttftSteps > 0) {
      const pair = slotTtfts.get(row.bucket) ?? { ttftMs: 0, ttftSteps: 0 }
      pair.ttftMs += row.ttftMs ?? 0
      pair.ttftSteps += row.ttftSteps
      slotTtfts.set(row.bucket, pair)
    }
    const modelTotal = modelTotals.get(row.model)
    if (modelTotal) {
      modelTotal.tokens += tokens
      modelTotal.inputTokens += row.inputTokens
      modelTotal.outputTokens += row.outputTokens
      modelTotal.cacheReadTokens += row.cacheReadTokens
      modelTotal.cacheWriteTokens += row.cacheWriteTokens
      modelTotal.speedDurationMs += row.durationMs ?? 0
      modelTotal.speedOutputTokens += speedTokensOf(row)
      modelTotal.ttftMs += row.ttftMs ?? 0
      modelTotal.ttftSteps += row.ttftSteps ?? 0
    } else {
      modelTotals.set(row.model, {
        provider: row.provider,
        tokens,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        speedDurationMs: row.durationMs ?? 0,
        speedOutputTokens: speedTokensOf(row),
        ttftMs: row.ttftMs ?? 0,
        ttftSteps: row.ttftSteps ?? 0,
      })
    }
    providerTotals.set(row.provider, (providerTotals.get(row.provider) ?? 0) + tokens)
  }
  // 槽级 speed/ttft 条件挂:无配对数据的槽不挂字段(存量槽形契约不变)
  for (const slot of slots) {
    const speedPair = slotSpeeds.get(slot.day)
    if (speedPair && speedPair.durationMs > 0) slot.speed = speedPair.decodeTokens / (speedPair.durationMs / MS_PER_SECOND)
    const ttftPair = slotTtfts.get(slot.day)
    if (ttftPair && ttftPair.ttftSteps > 0) slot.ttft = ttftPair.ttftMs / ttftPair.ttftSteps
  }
  const totals = { tokens: 0, requests: 0, turns: 0, cacheHit: 0, cacheMiss: 0 }
  for (const slot of slots) {
    totals.tokens += slot.total
    totals.requests += slot.requests
    totals.turns += slot.turns
    totals.cacheHit += slot.cacheHit
    totals.cacheMiss += slot.cacheMiss
  }
  // speed = decode 配对口径(decodeTokens ÷ 时长秒);ttft = 首 token 延迟
  // 加权平均(毫秒);仅配对数据存在的条目挂字段,无数据条目不挂;
  // 纯 timing 行可能产生 0-token 条目,列表保持只含 token 行(存量契约)
  const models = [...modelTotals.entries()]
    .filter(([, agg]) => agg.tokens > 0)
    .map(([model, agg]) => ({
      model,
      provider: agg.provider,
      tokens: agg.tokens,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      percent: percentOf(agg.tokens, totals.tokens),
      ...(agg.speedDurationMs > 0 ? { speed: agg.speedOutputTokens / (agg.speedDurationMs / MS_PER_SECOND) } : {}),
      ...(agg.ttftSteps > 0 ? { ttft: agg.ttftMs / agg.ttftSteps } : {}),
    }))
    .sort((a, b) => b.tokens - a.tokens)
  const providers = [...providerTotals.entries()]
    .filter(([, tokens]) => tokens > 0)
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
