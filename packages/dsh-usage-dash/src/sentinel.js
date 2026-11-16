// 异常哨兵:以同星期历史为基线,在分钟/小时桶上检测燃烧速率突变、缓存命中率
// 骤降、模型漂移与静默燃烧(无用户输入的持续计费)。纯函数零 IO,事件只带
// 可复核的证据数值,不做"可能/也许"式猜测。

import { costOf, matchPrice } from './pricing.js'
import {
  DEFAULT_MINUTE_RETENTION_DAYS,
  GRANULARITY_DAILY,
  GRANULARITY_HOURLY,
  GRANULARITY_MINUTE,
  dayKey,
  hourKey,
  minuteKey,
} from './store.js'

export const SENTINEL_KINDS = ['burn-spike', 'cache-drop', 'model-drift', 'quiet-burn']
export const SENTINEL_LEVELS = ['info', 'warn', 'danger']
// 基线至少覆盖的星期数:样本更少时任何检测都会把正常波动当异常
export const MIN_BASELINE_DAYS = 7
export const DEFAULT_SENTINEL_CONFIG = {
  burnMultiplier: 3,
  cacheDropPoints: 20,
  quietBurnMinutes: 20,
}

export const SENTINEL_INTERVAL_MS = 60 * 1000
// 同 kind 冷却窗口:跨 tick 的持续条件只提醒一次,避免同一异常刷屏
export const SENTINEL_KIND_COOLDOWN_MS = 30 * 60 * 1000
export const SENTINEL_MAX_EVENTS = 50
export const BASELINE_WEEKS = 26
export const BURN_WINDOW_MINUTES = 30
export const CACHE_WINDOW_MINUTES = 60
export const QUIET_COST_WINDOW_MINUTES = 60
// 拿不到用户输入事件时的保守近似窗口:最近 30 分钟无请求才视为静默
export const QUIET_FALLBACK_MINUTES = 30
export const BASELINE_CACHE_TTL_MS = 10 * 60 * 1000

const MS_PER_MINUTE = 60 * 1000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR
const HOURS_PER_DAY = 24
const DANGER_MULTIPLE = 2

const EVENT_TEXT = {
  'burn-spike': {
    title: '费用燃烧突增',
    suggestion: '核对最近请求与定价规则,确认是否为预期内的批量任务',
  },
  'cache-drop': {
    title: '缓存命中率骤降',
    suggestion: '检查最近请求的提示词前缀是否变化,或模型缓存策略是否调整',
  },
  'model-drift': {
    title: '主用模型漂移',
    suggestion: '确认新模型是否为预期切换;若非预期,检查默认模型与降级配置',
  },
  'quiet-burn': {
    title: '静默燃烧',
    suggestion: '确认后台任务是否仍在运行;如非预期,结束该会话或任务',
  },
}

const toFinite = (value) => (Number.isFinite(value) ? value : 0)

const nullableNumber = (value) => (Number.isFinite(value) ? value : null)

const roundTo = (value, digits) => {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

// 分位采用线性插值:样本少时比最近秩更平滑,首尾不受单点尖峰直接顶满
function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const index = (sorted.length - 1) * ratio
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

// 配置归一:非法阈值回落默认,保证宿主设置与控制台写入同一口径
export function normalizeSentinelConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const numberAtLeast = (value, minimum, fallback) => (
    Number.isFinite(value) && value >= minimum ? value : fallback
  )
  return {
    burnMultiplier: numberAtLeast(source.burnMultiplier, 1, DEFAULT_SENTINEL_CONFIG.burnMultiplier),
    cacheDropPoints: numberAtLeast(source.cacheDropPoints, 1, DEFAULT_SENTINEL_CONFIG.cacheDropPoints),
    quietBurnMinutes: numberAtLeast(source.quietBurnMinutes, 1, DEFAULT_SENTINEL_CONFIG.quietBurnMinutes),
  }
}

// 按天用量建基线:以同星期几的中位与 p95 作为正常区间;样本不足时只报天数
export function buildBaseline(dayCosts) {
  const byDay = new Map()
  let anonymous = 0
  for (const item of Array.isArray(dayCosts) ? dayCosts : []) {
    const weekday = Number(item?.weekday)
    const cost = Number(item?.cost)
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue
    if (!Number.isFinite(cost) || cost < 0) continue
    const day = typeof item?.day === 'string' && item.day.length > 0 ? item.day : `#${anonymous++}`
    const entry = byDay.get(day)
    if (entry) entry.cost += cost
    else byDay.set(day, { weekday, cost })
  }
  const days = byDay.size
  if (days < MIN_BASELINE_DAYS) return { days, byWeekday: {}, p95: 0, insufficient: true }
  const entries = [...byDay.values()]
  const overall = entries.map((entry) => entry.cost).sort((left, right) => left - right)
  const byWeekday = {}
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const values = entries
      .filter((entry) => entry.weekday === weekday)
      .map((entry) => entry.cost)
      .sort((left, right) => left - right)
    byWeekday[weekday] = { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
  }
  return { days, byWeekday, p95: percentile(overall, 0.95), insufficient: false }
}

function weekdayOfDayKey(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.slice(0, 10))) return null
  const [year, month, date] = day.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay()
}

function resolveWeekday(weekday, day, now) {
  if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) return weekday
  const fromDay = weekdayOfDayKey(day)
  if (fromDay !== null) return fromDay
  return new Date(now).getDay()
}

function modelEntriesOf(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.length > 0 ? [{ model: value }] : []
  if (value && typeof value === 'object') return [value]
  return []
}

function topModelEntryOf(value) {
  let top = null
  for (const entry of modelEntriesOf(value)) {
    const model = typeof entry === 'string' ? entry : entry?.model
    if (typeof model !== 'string' || model.length === 0) continue
    const share = Number.isFinite(entry?.share) ? entry.share : null
    if (top === null) {
      top = { model, share }
      continue
    }
    const better = share !== null && (top.share === null || share > top.share)
    if (better) top = { model, share }
  }
  return top
}

function knownModelsOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.models)) {
    return value.models
      .map((entry) => (typeof entry === 'string' ? entry : entry?.model))
      .filter((model) => typeof model === 'string' && model.length > 0)
  }
  return modelEntriesOf(value)
    .map((entry) => (typeof entry === 'string' ? entry : entry?.model))
    .filter((model) => typeof model === 'string' && model.length > 0)
}

function windowMinutesOf(recent, fallback) {
  return Number.isFinite(recent?.windowMinutes) && recent.windowMinutes > 0
    ? recent.windowMinutes
    : fallback
}

// input: { config, baseline, recent: {windowMinutes, cost, hitRate, quietCost, quietWindowMinutes},
//          history: {hitRate}, modelShare: {current, baseline}, idleMinutes, idleBasis, weekday, now }
export function detectAnomalies(input = {}) {
  const config = normalizeSentinelConfig(input.config)
  // 开关由调度层(tick)把关,检测本身只回答"这些数据算不算异常"
  const baseline = input.baseline
  if (!baseline || baseline.insufficient === true || !(Number(baseline.days) >= MIN_BASELINE_DAYS)) return []

  const recent = input.recent ?? {}
  const history = input.history ?? {}
  const modelShare = input.modelShare ?? {}
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const weekday = resolveWeekday(input.weekday, input.day, now)
  const events = []
  let sequence = 0
  const push = (kind, level, evidence) => {
    sequence += 1
    events.push({
      id: `${kind}:${now}:${sequence}`,
      kind,
      level,
      at: now,
      title: EVENT_TEXT[kind].title,
      evidence,
      suggestion: EVENT_TEXT[kind].suggestion,
    })
  }

  const recentCost = toFinite(recent.cost)
  const weekdayP95 = Number(baseline.byWeekday?.[weekday]?.p95)
  const burnWindowMinutes = windowMinutesOf(recent, BURN_WINDOW_MINUTES)
  // 基线是整日费用,检测窗口只有几十分钟:先把窗口费用外推到整日同口径,
  // 否则窗口永远小于日 p95,燃烧突增这条规则实际永不触发
  const minutesPerDay = MS_PER_DAY / MS_PER_MINUTE
  const projectedDaily = burnWindowMinutes > 0 ? recentCost * (minutesPerDay / burnWindowMinutes) : 0
  if (weekdayP95 > 0 && projectedDaily > weekdayP95 * config.burnMultiplier) {
    const multiplier = projectedDaily / weekdayP95
    push('burn-spike', multiplier >= config.burnMultiplier * DANGER_MULTIPLE ? 'danger' : 'warn', {
      recentCost: roundTo(recentCost, 2),
      projectedDaily: roundTo(projectedDaily, 2),
      p95: roundTo(weekdayP95, 4),
      multiplier: roundTo(multiplier, 4),
      windowMinutes: burnWindowMinutes,
    })
  }

  const recentHitRate = nullableNumber(recent.hitRate)
  const baselineHitRate = nullableNumber(history.hitRate)
  if (recentHitRate !== null && baselineHitRate !== null) {
    const dropPoints = baselineHitRate - recentHitRate
    if (dropPoints > config.cacheDropPoints) {
      push('cache-drop', dropPoints >= config.cacheDropPoints * DANGER_MULTIPLE ? 'danger' : 'warn', {
        recentHitRate: roundTo(recentHitRate, 2),
        baselineHitRate: roundTo(baselineHitRate, 2),
        dropPoints: roundTo(dropPoints, 2),
        thresholdPoints: config.cacheDropPoints,
        windowMinutes: CACHE_WINDOW_MINUTES,
      })
    }
  }

  const currentModel = topModelEntryOf(modelShare.current)
  const baselineModel = topModelEntryOf(modelShare.baseline)
  if (
    currentModel !== null
    && baselineModel !== null
    && currentModel.model !== baselineModel.model
    && !knownModelsOf(modelShare.baseline).includes(currentModel.model)
  ) {
    push('model-drift', 'info', {
      currentModel: currentModel.model,
      currentShare: currentModel.share === null ? null : roundTo(currentModel.share, 4),
      baselineModel: baselineModel.model,
      baselineShare: baselineModel.share === null ? null : roundTo(baselineModel.share, 4),
      windowHours: 24,
    })
  }

  const idleMinutes = nullableNumber(input.idleMinutes)
  const quietCost = toFinite(recent.quietCost ?? recent.cost)
  if (idleMinutes !== null && idleMinutes >= config.quietBurnMinutes && quietCost > 0) {
    const basis = typeof input.idleBasis === 'string'
      ? input.idleBasis
      : (typeof recent.idleBasis === 'string' ? recent.idleBasis : 'last-input')
    push('quiet-burn', 'warn', {
      idleMinutes: roundTo(idleMinutes, 1),
      cost: roundTo(quietCost, 2),
      windowMinutes: windowMinutesOf({ windowMinutes: recent.quietWindowMinutes }, QUIET_COST_WINDOW_MINUTES),
      thresholdMinutes: config.quietBurnMinutes,
      basis,
    })
  }

  return events
}

// 桶键解析为墙钟分量:定价条件只读日期/时段分量,不参与跨时区绝对时刻运算
function dateOfBucket(bucket, granularity) {
  if (typeof bucket !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})(?::(\d{2}))?)?/.exec(bucket)
  if (!match) return null
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const hour = granularity === GRANULARITY_DAILY ? 0 : Number(match[4] ?? 0)
  const minute = Number(match[5] ?? 0)
  return new Date(year, month - 1, date, hour, minute)
}

const tokensOfRow = (row) => (
  toFinite(row?.inputTokens)
  + toFinite(row?.outputTokens)
  + toFinite(row?.cacheReadTokens)
  + toFinite(row?.cacheWriteTokens)
)

const requestsOfRow = (row) => toFinite(row?.requests)

function costOfRow(row, rules, granularity) {
  if (typeof row?.model !== 'string') return 0
  const price = matchPrice(rules, row.model, dateOfBucket(row.bucket, granularity))
  return price ? costOf(price, row) : 0
}

// 阈值来自存储,开关只来自 features 投影:存储里的 enabled 不再参与判定
function resolveConfig(deps) {
  const source = typeof deps?.config === 'function' ? deps.config() : deps?.config
  return { ...normalizeSentinelConfig(source), enabled: source?.enabled === true }
}

// 26 周天桶:每天按行模型命中价计费,形成同星期几基线与历史缓存命中率
async function readBaselineContext(deps, rules, nowMs) {
  const timeZone = deps?.timeZone
  const from = dayKey(nowMs - BASELINE_WEEKS * 7 * MS_PER_DAY, timeZone)
  const to = dayKey(nowMs, timeZone)
  const rows = await deps.store.rangeRows(GRANULARITY_DAILY, from, to)
  const byDay = new Map()
  const modelTokens = new Map()
  let historyHit = 0
  let historyMiss = 0
  for (const row of rows) {
    const day = typeof row?.bucket === 'string' ? row.bucket.slice(0, 10) : ''
    const weekday = weekdayOfDayKey(day)
    if (weekday === null) continue
    const tokens = tokensOfRow(row)
    if (tokens <= 0) continue
    let entry = byDay.get(day)
    if (!entry) {
      entry = { day, weekday, cost: 0, tokens: 0 }
      byDay.set(day, entry)
    }
    entry.cost += costOfRow(row, rules, GRANULARITY_DAILY)
    entry.tokens += tokens
    if (typeof row.model === 'string') {
      modelTokens.set(row.model, (modelTokens.get(row.model) ?? 0) + tokens)
    }
    historyHit += toFinite(row.cacheReadTokens)
    historyMiss += toFinite(row.inputTokens) + toFinite(row.cacheWriteTokens)
  }
  const dayCosts = [...byDay.values()]
    .filter((entry) => entry.cost > 0)
    .map(({ day, weekday, cost, tokens }) => ({ day, weekday, cost, tokens }))
  const baseline = buildBaseline(dayCosts)
  const rankedModels = [...modelTokens.entries()].sort((left, right) => right[1] - left[1])
  const totalTokens = rankedModels.reduce((sum, [, tokens]) => sum + tokens, 0)
  const top = rankedModels[0]
  return {
    baseline,
    historyHitRate: historyHit + historyMiss > 0 ? (historyHit / (historyHit + historyMiss)) * 100 : null,
    baselineModel: top?.[0] ?? '',
    baselineModels: rankedModels.map(([model]) => model),
    baselineShare: totalTokens > 0 ? top[1] / totalTokens : null,
  }
}

// 最近窗口:分钟桶可用时取分钟桶,否则按小时桶近似;同时给 24h 模型占比
async function readRecentContext(deps, rules, nowMs) {
  const timeZone = deps?.timeZone
  const maxWindow = Math.max(BURN_WINDOW_MINUTES, CACHE_WINDOW_MINUTES, QUIET_COST_WINDOW_MINUTES)
  const retention = typeof deps?.retentionDays === 'function'
    ? deps.retentionDays()
    : DEFAULT_MINUTE_RETENTION_DAYS
  let minuteRows = []
  if (Number.isFinite(retention) && retention > 0) {
    minuteRows = await deps.store.rangeRows(
      GRANULARITY_MINUTE,
      minuteKey(nowMs - maxWindow * MS_PER_MINUTE, timeZone),
      minuteKey(nowMs, timeZone),
    )
  }
  const hourRows = await deps.store.rangeRows(
    GRANULARITY_HOURLY,
    hourKey(nowMs - HOURS_PER_DAY * MS_PER_HOUR, timeZone),
    hourKey(nowMs, timeZone),
  )
  const useMinutes = minuteRows.length > 0
  const granularity = useMinutes ? GRANULARITY_MINUTE : GRANULARITY_HOURLY
  const windowRows = useMinutes ? minuteRows : hourRows
  const keyOf = (minutesAgo) => (
    useMinutes
      ? minuteKey(nowMs - minutesAgo * MS_PER_MINUTE, timeZone)
      : hourKey(nowMs - minutesAgo * MS_PER_MINUTE, timeZone)
  )
  const burnFrom = keyOf(BURN_WINDOW_MINUTES)
  const cacheFrom = keyOf(CACHE_WINDOW_MINUTES)
  const quietFrom = keyOf(QUIET_COST_WINDOW_MINUTES)
  const requestsFrom = keyOf(QUIET_FALLBACK_MINUTES)

  let burnCost = 0
  let quietCost = 0
  let requests30m = 0
  let cacheHit = 0
  let cacheMiss = 0
  for (const row of windowRows) {
    if (typeof row?.bucket !== 'string') continue
    if (row.bucket >= quietFrom) quietCost += costOfRow(row, rules, granularity)
    if (row.bucket >= burnFrom) burnCost += costOfRow(row, rules, granularity)
    if (row.bucket >= requestsFrom) requests30m += requestsOfRow(row)
    if (row.bucket >= cacheFrom) {
      cacheHit += toFinite(row.cacheReadTokens)
      cacheMiss += toFinite(row.inputTokens) + toFinite(row.cacheWriteTokens)
    }
  }

  const modelTokens = new Map()
  for (const row of hourRows) {
    if (typeof row?.model !== 'string') continue
    const tokens = tokensOfRow(row)
    if (tokens <= 0) continue
    modelTokens.set(row.model, (modelTokens.get(row.model) ?? 0) + tokens)
  }
  const rankedModels = [...modelTokens.entries()].sort((left, right) => right[1] - left[1])
  const totalTokens = rankedModels.reduce((sum, [, tokens]) => sum + tokens, 0)
  const top = rankedModels[0]

  return {
    recent: {
      windowMinutes: BURN_WINDOW_MINUTES,
      cost: burnCost,
      hitRate: cacheHit + cacheMiss > 0 ? (cacheHit / (cacheHit + cacheMiss)) * 100 : null,
      quietCost,
      quietWindowMinutes: QUIET_COST_WINDOW_MINUTES,
      requests: requests30m,
    },
    currentModelShare: top ? { model: top[0], share: top[1] / totalTokens } : null,
  }
}

function isSubagentSession(session) {
  const header = session?.header ?? session
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return Boolean(header.parentSession) && (Number(header.delegationDepth) >= 1)
}

// 挂载点:持有事件表与基线缓存,向路由暴露 status/ack;定时器随 ctx.effect 释放
export function installSentinel(ctx, deps = {}) {
  const state = {
    events: [],
    baseline: null,
    config: resolveConfig(deps),
    reason: 'initializing',
    updatedAt: null,
    currency: null,
  }
  const lastKindAt = new Map()
  let baselineCache = null
  let lastInputAt = null
  let running = null
  let cleaned = false
  let effectDispose = null

  const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now())
  const setIntervalFn = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval
  const clearIntervalFn = typeof deps.clearInterval === 'function' ? deps.clearInterval : clearInterval
  const intervalMs = Number.isFinite(deps.intervalMs) && deps.intervalMs > 0
    ? deps.intervalMs
    : SENTINEL_INTERVAL_MS
  const baselineTtl = Number.isFinite(deps.baselineTtlMs) ? deps.baselineTtlMs : BASELINE_CACHE_TTL_MS

  const appendEvents = (detected) => {
    for (const event of detected) {
      const lastAt = lastKindAt.get(event.kind)
      if (lastAt !== undefined && event.at - lastAt < SENTINEL_KIND_COOLDOWN_MS) continue
      lastKindAt.set(event.kind, event.at)
      state.events.push(event)
    }
    if (state.events.length > SENTINEL_MAX_EVENTS) {
      state.events.splice(0, state.events.length - SENTINEL_MAX_EVENTS)
    }
  }

  const runDetection = async () => {
    const nowMs = now()
    const config = resolveConfig(deps)
    state.config = config
    if (!config.enabled) {
      // 关掉只停检测,历史事件留着当参考,清空等于把「上次出过什么事」一起删了
      state.reason = 'disabled'
      state.updatedAt = nowMs
      return
    }
    if (!deps.store || typeof deps.store.rangeRows !== 'function') {
      state.events = []
      state.reason = 'unavailable'
      state.updatedAt = nowMs
      return
    }
    const rules = typeof deps.pricing?.rules === 'function' ? deps.pricing.rules() : []
    if (!Array.isArray(rules) || rules.length === 0) {
      state.events = []
      state.baseline = null
      state.currency = null
      state.reason = 'no-pricing'
      state.updatedAt = nowMs
      return
    }
    state.currency = rules.find((rule) => typeof rule?.currency === 'string')?.currency ?? null
    const revision = typeof deps.pricing?.revision === 'function' ? deps.pricing.revision() : 0
    let baselineContext = baselineCache
      && baselineCache.revision === revision
      && nowMs < baselineCache.expiresAt
      ? baselineCache.value
      : null
    if (!baselineContext) {
      baselineContext = await readBaselineContext(deps, rules, nowMs)
      baselineCache = { revision, expiresAt: nowMs + baselineTtl, value: baselineContext }
    }
    state.baseline = baselineContext.baseline
    if (baselineContext.baseline.insufficient) {
      state.events = []
      state.reason = 'baseline-insufficient'
      state.updatedAt = nowMs
      return
    }
    const recentContext = await readRecentContext(deps, rules, nowMs)
    const requests30m = recentContext.recent.requests
    const idle = lastInputAt === null
      ? {
          idleMinutes: requests30m > 0 ? 0 : QUIET_FALLBACK_MINUTES,
          idleBasis: 'request-window-approx',
        }
      : {
          idleMinutes: Math.max(0, (nowMs - lastInputAt) / MS_PER_MINUTE),
          idleBasis: 'last-input',
        }
    const detected = detectAnomalies({
      config,
      baseline: baselineContext.baseline,
      recent: recentContext.recent,
      history: { hitRate: baselineContext.historyHitRate },
      modelShare: {
        current: recentContext.currentModelShare,
        baseline: {
          model: baselineContext.baselineModel,
          share: baselineContext.baselineShare,
          models: baselineContext.baselineModels,
        },
      },
      idleMinutes: idle.idleMinutes,
      idleBasis: idle.idleBasis,
      weekday: weekdayOfDayKey(dayKey(nowMs, deps.timeZone)),
      now: nowMs,
    })
    appendEvents(detected)
    state.reason = null
    state.updatedAt = nowMs
  }

  // 在飞时复用同一次检测,但调用方多半刚改过开关,拿到的会是旧结论:
  // 排一轮补跑,并让所有等待者等同一轮补跑(而不是只有第一个等)。
  // 旗标必须是共享的那条 promise:布尔旗标在 then 里消费后,其余等待者会立刻拿着半新半旧的状态返回
  let pending = null
  const refresh = () => {
    if (running) {
      pending ??= running.then(() => {
        pending = null
        return refresh()
      }, (error) => {
        // 拒绝也要放掉排队,否则下一次在飞会把这条已拒绝的链直接交出去
        pending = null
        throw error
      })
      return pending
    }
    running = runDetection()
      .catch((error) => {
        state.reason = 'error'
        state.updatedAt = now()
        ctx.logger?.warn?.(`usage-dash: sentinel 检测失败 ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        running = null
      })
    // 两个分支都回同一形状:调用方拿到的是这次检测之后的结论,不用猜是 undefined 还是快照
    return running.then(() => status())
  }

  const status = () => ({
    events: state.events
      .slice()
      .reverse()
      .map((event) => ({ ...event, evidence: { ...event.evidence } })),
    baseline: state.baseline === null
      ? null
      : {
          ...state.baseline,
          byWeekday: Object.fromEntries(
            Object.entries(state.baseline.byWeekday ?? {}).map(([weekday, value]) => [weekday, { ...value }]),
          ),
        },
    config: { ...state.config },
    reason: state.reason,
    updatedAt: state.updatedAt,
    currency: state.currency,
    timeZone: deps.timeZone ?? null,
  })

  const ack = (ids) => {
    const targets = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
    const before = state.events.length
    state.events = state.events.filter((event) => !targets.has(event.id))
    return { acked: before - state.events.length }
  }

  const onSessionEvent = (session, event) => {
    if (!event || typeof event !== 'object') return
    if (event.type !== 'user/message' && event.type !== 'turn/start') return
    // 子 agent 的 turn/start 不是用户输入,不能刷新静默计时
    if (event.type === 'turn/start' && isSubagentSession(session)) return
    const at = Number.isFinite(event.time) ? event.time : now()
    lastInputAt = lastInputAt === null ? at : Math.max(lastInputAt, at)
  }

  const setup = () => {
    const offSession = typeof ctx?.on === 'function' ? ctx.on('session/event', onSessionEvent) : null
    void refresh()
    const timer = setIntervalFn(() => {
      void refresh()
    }, intervalMs)
    // 宿主的进程常驻由其它服务维持;检测定时器不应单独拖住测试或短命令进程
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => {
      cleaned = true
      clearIntervalFn(timer)
      if (typeof offSession === 'function') offSession()
    }
  }

  const localCleanup = setup()
  const registeredCleanup = typeof ctx?.effect === 'function'
    ? ctx.effect(() => localCleanup, 'usage-dash: sentinel')
    : null
  effectDispose = typeof registeredCleanup === 'function' ? registeredCleanup : localCleanup
  const dispose = () => {
    if (cleaned) return
    if (typeof effectDispose === 'function') effectDispose()
  }

  return { status, ack, dispose, refresh }
}
