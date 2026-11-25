import { WORKSPACE_UNKNOWN } from './store.js'
import { isSyntheticWorkspaceId } from './workspace-id.js'
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

// 桶键前缀宽度:D 段定位日桶,M 行截取父 H 桶
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

// pattern 锚定桶串外形,suffix 补全为本地时区可解析日期,format 回读校验分量合法性
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

// 无注册目录的分组合成门槛:主会话数必须严格大于它才单独展示;
// 不足门槛的合成行并回未知,不能因为分组而把总量拆丢。
export const SYNTHETIC_WORKSPACE_MIN_SESSIONS = 3

const sessionCountsOf = (sessionRows) => {
  const counts = new Map()
  for (const row of sessionRows) {
    if (row === null || typeof row !== 'object' || !Array.isArray(row.sessions)) continue
    const workspaceId = typeof row.workspaceId === 'string' && row.workspaceId !== '' ? row.workspaceId : WORKSPACE_UNKNOWN
    if (!counts.has(workspaceId)) counts.set(workspaceId, new Set())
    const sessions = counts.get(workspaceId)
    for (const id of row.sessions) sessions.add(id)
  }
  return new Map([...counts].map(([id, sessions]) => [id, sessions.size]))
}

const mergeWorkspaceGroup = (target, source) => {
  target.tokens += source.tokens
  target.requests += source.requests
  target.turns += source.turns
  for (const day of source.activeDays) target.activeDays.add(day)
  for (const [model, entry] of source.models) {
    const current = target.models.get(model)
    if (current === undefined) {
      target.models.set(model, {
        model: entry.model,
        tokens: entry.tokens,
        requests: entry.requests,
        turns: entry.turns,
        activeDays: new Set(entry.activeDays),
      })
      continue
    }
    current.tokens += entry.tokens
    current.requests += entry.requests
    current.turns += entry.turns
    for (const day of entry.activeDays) current.activeDays.add(day)
  }
}

const emptyWorkspaceGroup = (workspaceId) => ({
  workspaceId,
  tokens: 0,
  requests: 0,
  turns: 0,
  activeDays: new Set(),
  models: new Map(),
})

// 工作区对比:按行所属工作区聚合,同时保留模型拆分供界面按模型筛选;
// 零 token 的 turn 行仍计入请求/轮次,不把工作区用量误报成零。合成目录
// 只有主会话数过门槛才保留,否则并回未知分组,保证总数不变。
function aggregateWorkspaces(rows, workspaceSessionCounts) {
  const groups = new Map()
  for (const row of rows) {
    const workspaceId = typeof row.workspaceId === 'string' && row.workspaceId !== '' ? row.workspaceId : WORKSPACE_UNKNOWN
    const tokens = rowTokens(row)
    let group = groups.get(workspaceId)
    if (!group) {
      group = emptyWorkspaceGroup(workspaceId)
      groups.set(workspaceId, group)
    }
    group.tokens += tokens
    group.requests += row.requests
    group.turns += row.turns
    if (tokens > 0) {
      group.activeDays.add(row.bucket.slice(0, DAY_KEY_WIDTH))
      let model = group.models.get(row.model)
      if (!model) {
        model = { model: row.model, tokens: 0, requests: 0, turns: 0, activeDays: new Set() }
        group.models.set(row.model, model)
      }
      model.tokens += tokens
      model.requests += row.requests
      model.turns += row.turns
      model.activeDays.add(row.bucket.slice(0, DAY_KEY_WIDTH))
    }
  }
  for (const [workspaceId, group] of groups) {
    if (!isSyntheticWorkspaceId(workspaceId)) continue
    if ((workspaceSessionCounts?.get(workspaceId) ?? 0) > SYNTHETIC_WORKSPACE_MIN_SESSIONS) continue
    let unknown = groups.get(WORKSPACE_UNKNOWN)
    if (unknown === undefined) {
      unknown = emptyWorkspaceGroup(WORKSPACE_UNKNOWN)
      groups.set(WORKSPACE_UNKNOWN, unknown)
    }
    mergeWorkspaceGroup(unknown, group)
    groups.delete(workspaceId)
  }
  return [...groups.values()]
    .map((group) => ({
      workspaceId: group.workspaceId,
      tokens: group.tokens,
      requests: group.requests,
      turns: group.turns,
      activeDays: group.activeDays.size,
      models: [...group.models.values()]
        .map(({ activeDays: days, ...model }) => ({ ...model, activeDays: days.size }))
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || a.workspaceId.localeCompare(b.workspaceId))
}

// 会话索引行并集:同会话跨桶只计一次;采集侧已过滤派生会话与超期桶,
// 这里只做去重计数(畸形容错,观测数据不让聚合崩)
function countSessions(sessionRows) {
  const ids = new Set()
  for (const row of sessionRows) {
    if (row === null || typeof row !== 'object' || !Array.isArray(row.sessions)) continue
    for (const id of row.sessions) ids.add(id)
  }
  return ids.size
}

// 速度配对分子:decode 口径取 decodeTokens;存量旧格式行(带时长无 decodeTokens)
// 回落 outputTokens,聚合随新数据自然收敛
const speedTokensOf = (row) => (row.durationMs ? row.decodeTokens ?? row.outputTokens : 0)

export function aggregateRange(rows, g, from, to, sessionRows = [], workspaceSessionCounts) {
  const form = BUCKET_FORMS[g]
  const slots = enumerateBucketKeys(form)(from, to).map((key) => emptySlot(key))
  const slotByKey = new Map(slots.map((slot) => [slot.day, slot]))
  const modelTotals = new Map()
  const providerTotals = new Map()
  // 活跃天 = 有 token 产出的自然日(桶键按日去重,跨粒度统一口径)
  const activeDays = new Set()
  // 档级配对:桶串 → 速度对 {decodeTokens, durationMs} 与首字对 {ttftMs, ttftSteps},
  const slotSpeeds = new Map()
  const slotTtfts = new Map()
  // 工作区对比与主聚合共用同一份可归属行,残行不会只进一边
  const workspaceRows = []
  for (const row of rows) {
    const slot = slotByKey.get(row.bucket)
    // 桶串未落在枚举序列(如改粒度前的历史残行)不可归属,跳过防崩
    if (!slot) continue
    workspaceRows.push(row)
    const tokens = rowTokens(row)
    addRowToSlot(slot, row, tokens)
    // 纯 timing 行(零 token 桶 + decode 配对)不参与归属,但仍进配对聚合
    if (tokens > 0) {
      activeDays.add(row.bucket.slice(0, DAY_KEY_WIDTH))
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
  // 加权平均(毫秒);仅配对数据存在的条目挂字段,无数据条目不挂
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
    activeDays: activeDays.size,
    sessions: countSessions(sessionRows),
    topModel: top?.model ?? '',
    topProvider: top?.provider ?? '',
    daily,
    models,
    providers,
    byWorkspace: aggregateWorkspaces(workspaceRows, workspaceSessionCounts ?? sessionCountsOf(sessionRows)),
  }
  if (truncated) result.truncated = true
  return result
}

// 聚合计价的桶定位:D 折叠到日槽,H/M 即本桶;计价一律取行所属 H 桶起点
const COST_SLOT_KEYS = {
  [GRANULARITY_DAILY]: (bucket) => bucket.slice(0, DAY_KEY_WIDTH),
  [GRANULARITY_HOURLY]: (bucket) => bucket,
  [GRANULARITY_MINUTE]: (bucket) => bucket,
}

// 聚合计价:以可见槽为唯一口径,cost 行按 H 桶起点匹配价格后累加;
// 档级逐模型拆分,costByModel 供金额柱状图按模型堆叠。
// 日档的历史日可能只剩日桶行(H 桶仅保留 HOUR_RETENTION_DAYS),这些日按日桶起点计价兜底。
export function attachCosts(result, costRows, granularity, rules, fallbackRows = []) {
  // 未配置规则不是零价:不挂 cost/unpriced,避免汇总卡把「未计价」显示成 ¥0.00
  if (!Array.isArray(rules) || rules.length === 0) return result
  const slotKeyOf = COST_SLOT_KEYS[granularity]
  const slotOfDay = new Map(result.daily.map((slot) => [slot.day, slot]))
  const slotCosts = new Map()
  const slotCostsByModel = new Map()
  // 只记录真正命中价格的模型:未命中规则保持无 cost 字段,与无规则路径同形,
  // 避免客户端把「未定价」渲染成确定的 ¥0.00
  const modelCosts = new Map()
  const unpricedHours = new Set()
  const daysWithHourly = new Set()
  const recordCost = (row, date) => {
    const slot = slotOfDay.get(slotKeyOf(row.bucket))
    if (!slot || rowTokens(row) === 0) return
    const price = matchPrice(rules, row.model, date)
    if (!price) {
      unpricedHours.add(granularity === GRANULARITY_MINUTE ? row.bucket.slice(0, HOUR_KEY_WIDTH) : row.bucket)
      return
    }
    const cost = costOf(price, row)
    slotCosts.set(slot.day, (slotCosts.get(slot.day) ?? 0) + cost)
    let perModel = slotCostsByModel.get(slot.day)
    if (perModel === undefined) {
      perModel = new Map()
      slotCostsByModel.set(slot.day, perModel)
    }
    perModel.set(row.model, (perModel.get(row.model) ?? 0) + cost)
    modelCosts.set(row.model, (modelCosts.get(row.model) ?? 0) + cost)
  }
  for (const row of costRows) {
    const slot = slotOfDay.get(slotKeyOf(row.bucket))
    if (!slot || rowTokens(row) === 0) continue
    daysWithHourly.add(slot.day)
    const date = parseBucketKey(row.bucket.slice(0, HOUR_KEY_WIDTH), BUCKET_FORMS[GRANULARITY_HOURLY])
    if (date) recordCost(row, date)
  }
  for (const row of fallbackRows) {
    const slot = slotOfDay.get(slotKeyOf(row.bucket))
    if (!slot || rowTokens(row) === 0 || daysWithHourly.has(slot.day)) continue
    const date = parseBucketKey(row.bucket, BUCKET_FORMS[GRANULARITY_DAILY])
    if (date) recordCost(row, date)
  }
  const daily = result.daily.map((slot) => {
    const slotCost = slotCosts.get(slot.day)
    if (slotCost === undefined) return slot
    return { ...slot, cost: slotCost, costByModel: Object.fromEntries(slotCostsByModel.get(slot.day) ?? []) }
  })
  const pricedSlots = daily.filter((slot) => slot.cost !== undefined)
  const cost = pricedSlots.reduce((sum, slot) => sum + slot.cost, 0)
  const models = result.models.map((entry) => {
    const modelCost = modelCosts.get(entry.model)
    return modelCost === undefined ? entry : { ...entry, cost: modelCost }
  })
  return { ...result, daily, models, ...(pricedSlots.length > 0 ? { cost } : {}), unpriced: unpricedHours.size }
}
