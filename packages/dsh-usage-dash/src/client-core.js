// client 纯函数层:零 DOM 零宿主依赖,供 node --test 与 client.js 共用。
// 桶串本地时区推导,同粒度字典序即时间序;滚动窗口映射为 {from,to} 闭区间。
export const DAY_PRESETS = ['7', '14', '30', '90']
export const HOUR_PRESETS = ['24h', '48h', '72h']
export const MINUTE_PRESETS = ['60m', '180m', '360m']

const HOUR_PRESET_HOURS = { '24h': 24, '48h': 48, '72h': 72 }
const MINUTE_PRESET_MINUTES = { '60m': 60, '180m': 180, '360m': 360 }

export const DEFAULT_RANGE = '30'
export const DEFAULT_HOUR_PRESET = '24h'
export const DEFAULT_MINUTE_PRESET = '60m'

// 天视图渲染上限;时/分上限 = 闭区间桶数(预设 N 得 N+1 槽)
export const DAY_MAX_SLOTS = 180
export const API_PREFIX = '/api/usage-dash/'
export const ENDPOINTS = { range: 'range', hours: 'hours', minutes: 'minutes', status: 'status', reset: 'reset' }

// 宿主语义 token 之外的插件本地模型色板容量与哨兵
export const GROUP_TOP_COUNT = 5
export const OTHER_MODEL = '\u0000other'

const PAD_WIDTH = 2
const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_MINUTE = 60 * 1000

const pad = (value) => String(value).padStart(PAD_WIDTH, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

export function dayBucket(date) {
  return formatDate(date)
}
export function hourBucket(date) {
  return `${formatDate(date)}T${pad(date.getHours())}`
}
export function minuteBucket(date) {
  return `${hourBucket(date)}:${pad(date.getMinutes())}`
}

export function localDay(offsetDays, now = new Date()) {
  const shifted = new Date(now)
  shifted.setDate(shifted.getDate() + offsetDays)
  return formatDate(shifted)
}

const hourValueOf = (presetId) => HOUR_PRESET_HOURS[presetId]
const minuteValueOf = (presetId) => MINUTE_PRESET_MINUTES[presetId]

export function resolveDayRange(presetId, now = new Date()) {
  const days = Number(presetId)
  if (!Number.isInteger(days) || days <= 0) return null
  return { from: localDay(-(days - 1), now), to: formatDate(now) }
}

export function resolveHourRange(presetId, now = new Date()) {
  const hours = hourValueOf(presetId)
  if (!hours) return null
  return { from: hourBucket(new Date(now.getTime() - hours * MS_PER_HOUR)), to: hourBucket(now) }
}

export function resolveMinuteRange(presetId, now = new Date()) {
  const minutes = minuteValueOf(presetId)
  if (!minutes) return null
  return { from: minuteBucket(new Date(now.getTime() - minutes * MS_PER_MINUTE)), to: minuteBucket(now) }
}

export function maxSlotsFor(view, presetId) {
  if (view === 'hour') return hourValueOf(presetId) + 1
  if (view === 'minute') return minuteValueOf(presetId) + 1
  return DAY_MAX_SLOTS
}

export function trimSlots(slots, max) {
  return slots.length > max ? slots.slice(-max) : slots
}

const DEFAULT_ERROR_CODE = 'error'
const DEFAULT_ERROR_MESSAGE = 'usage api error'
const envelopeFailure = (code, message) => ({ ok: false, code, message })

export function parseEnvelope(json) {
  if (!json || typeof json !== 'object') return envelopeFailure(DEFAULT_ERROR_CODE, DEFAULT_ERROR_MESSAGE)
  if (json.ok === true) return { ok: true, value: json.value }
  if (json.ok === false) {
    const error = json.error ?? {}
    return envelopeFailure(error.code ?? DEFAULT_ERROR_CODE, error.message ?? DEFAULT_ERROR_MESSAGE)
  }
  return envelopeFailure(DEFAULT_ERROR_CODE, DEFAULT_ERROR_MESSAGE)
}

export const MESSAGES = {
  nav: '使用统计',
  range: '时间范围',
  'rangePreset.7': '最近 7 天',
  'rangePreset.14': '最近 14 天',
  'rangePreset.30': '最近 30 天',
  'rangePreset.90': '最近 90 天',
  rangeCustom: '自定义',
  from: '开始日期',
  to: '结束日期',
  refresh: '刷新',
  loading: '加载中',
  tokens: 'Tokens 用量',
  tokensHint: '服务商总口径:未缓存输入 + 输出 + 缓存命中 token',
  cachedTokens: '缓存命中',
  sessions: '会话数量',
  requests: '请求数量',
  activeDays: '活跃天数',
  cacheRate: '平均缓存命中率',
  cacheRateHint: '时间段内缓存命中 token 占输入 token 的比例',
  cacheHitRate: '缓存命中率',
  hitRateLegend: '缓存命中率',
  topModel: '最常用模型',
  topModelHint: '按 token 用量排序,非调用次数',
  heatmap: '活跃热力图',
  heatLess: '较少',
  heatMore: '较多',
  dailyTrend: '按天 Token 趋势',
  trendLimited: '仅显示最近 {n} 天',
  modelUsage: '模型用量',
  other: '其他',
  total: '总用量',
  percent: '占比',
  asOf: '统计截至',
  empty: '当前时间范围内暂无用量数据。Token 用量从本面板启用后开始累计,并会一次性回扫已有的历史会话。',
  viewDay: '按天',
  viewHour: '按小时',
  viewMinute: '按分钟',
  viewGroup: '统计粒度',
  'status.idle': '已收录 {n} 个会话',
  'status.running': '回扫中 {done}/{total}',
  rebuild: '重建',
  rebuildConfirm: '确认重建',
  hourTrend: '按小时 Token 趋势',
  minuteTrend: '按分钟 Token 趋势',
  hourPreset: '最近 {n} 小时',
  minutePreset: '最近 {n} 分钟',
  trendLimitedHour: '数据量过大,仅显示最近 {n} 小时',
  trendLimitedMinute: '数据量过大,仅显示最近 {n} 分钟',
  trendTruncated: '数据量过大,仅显示最近部分',
  recordFailures: '{n} 条记录写入失败',
}

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g

export function t(key, params) {
  const text = MESSAGES[key] ?? key
  if (!params) return text
  return text.replace(PLACEHOLDER_PATTERN, (raw, name) => (name in params ? String(params[name]) : raw))
}

const COMPACT_BASE = 1000
const DECIMAL_DIGITS = 1
export function formatTokens(value) {
  return value.toLocaleString('en-US')
}
export function formatCompact(value) {
  if (value >= COMPACT_BASE ** 3) return (value / COMPACT_BASE ** 3).toFixed(DECIMAL_DIGITS) + 'B'
  if (value >= COMPACT_BASE ** 2) return (value / COMPACT_BASE ** 2).toFixed(DECIMAL_DIGITS) + 'M'
  if (value >= COMPACT_BASE) return (value / COMPACT_BASE).toFixed(DECIMAL_DIGITS) + 'k'
  return String(value)
}
export function formatPercent(value) {
  return (Math.round(value * 10) / 10).toFixed(1) + '%'
}
export function cacheRate(hit, miss) {
  const total = hit + miss
  return total <= 0 ? null : (hit / total) * 100
}
export function cacheRateText(hit, miss) {
  const rate = cacheRate(hit, miss)
  return rate === null ? '—' : formatPercent(rate)
}

const REF_SPLIT_LIMIT = 2
export function modelNameOf(ref) {
  const parts = ref.split('/')
  return parts.length < REF_SPLIT_LIMIT ? ref : parts.slice(1).join('/')
}
export function providerOf(ref) {
  const parts = ref.split('/')
  return parts.length < REF_SPLIT_LIMIT ? 'default' : parts[0]
}

export function shortDay(day) {
  const parts = day.split('-')
  return `${Number(parts[1])}/${Number(parts[2])}`
}

const DAY_KEY_LENGTH = 'YYYY-MM-DD'.length
const MIDNIGHT_HOUR = '00'
const MIDNIGHT_TIME = '00:00'
export function hourTickLabel(key) {
  const hour = key.slice(DAY_KEY_LENGTH + 1)
  return hour === MIDNIGHT_HOUR ? `${shortDay(key.slice(0, DAY_KEY_LENGTH))} ${hour}:00` : `${hour}:00`
}
export function minuteTickLabel(key) {
  const time = key.slice(DAY_KEY_LENGTH + 1)
  return time === MIDNIGHT_TIME ? `${shortDay(key.slice(0, DAY_KEY_LENGTH))} ${time}` : time
}

export function isEmptyRange(value) {
  return value.tokens === 0 && value.cacheHit === 0 && value.requests === 0 && value.turns === 0
}

const toRankedModels = (totals) =>
  [...totals.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens)

// 逐槽 byModel 把非 top 模型并入哨兵桶,模型顺序 = 图例序(哨兵恒最后)
const foldSlotsByTop = (slots, topModels) => {
  const top = new Set(topModels)
  return slots.map((slot) => {
    const byModel = {}
    for (const [model, tokens] of Object.entries(slot.byModel)) {
      const target = top.has(model) ? model : OTHER_MODEL
      byModel[target] = (byModel[target] ?? 0) + tokens
    }
    return { ...slot, byModel }
  })
}

const topWithOther = (ranked) => {
  const models = ranked.slice(0, GROUP_TOP_COUNT)
  if (ranked.length > GROUP_TOP_COUNT) {
    models.push({ model: OTHER_MODEL, tokens: ranked.slice(GROUP_TOP_COUNT).reduce((sum, item) => sum + item.tokens, 0) })
  }
  return models
}

export function groupStats(stats) {
  const models = topWithOther(stats.models)
  const topModels = models.filter((item) => item.model !== OTHER_MODEL).map((item) => item.model)
  return { models, daily: foldSlotsByTop(stats.daily, topModels) }
}

export function groupPointSlots(slots) {
  const totals = new Map()
  for (const slot of slots) {
    for (const [model, tokens] of Object.entries(slot.byModel)) {
      totals.set(model, (totals.get(model) ?? 0) + tokens)
    }
  }
  const models = topWithOther(toRankedModels(totals))
  const topModels = models.filter((item) => item.model !== OTHER_MODEL).map((item) => item.model)
  return { models, daily: foldSlotsByTop(slots, topModels) }
}

// 趋势图视口常量
export const CHART_HEIGHT = 220
export const CHART_PAD = { left: 46, right: 65, top: 10, bottom: 26 }
const BAR_WIDTH_RATIO = 0.62
const BAR_MIN_WIDTH = 3
const BAR_MAX_WIDTH = 30
const AXIS_TICK_COUNT = 4

export function niceTicks(max, count) {
  if (max <= 0 || count <= 0) return []
  const raw = max / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / magnitude
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude
  const ticks = []
  for (let value = step; value <= max; value += step) ticks.push(value)
  return ticks
}

// 堆叠柱几何:模型序即堆叠序(哨兵最后画柱顶),输出槽分段与左轴刻度
export function trendLayout(slots, modelOrder, avail, labelMinPitch) {
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom
  const innerWidth = Math.max(1, avail - CHART_PAD.left - CHART_PAD.right)
  const count = slots.length
  const step = count > 1 ? innerWidth / (count - 1) : innerWidth
  const barWidth = Math.max(BAR_MIN_WIDTH, Math.min(BAR_MAX_WIDTH, step * BAR_WIDTH_RATIO))
  const maxTotal = Math.max(1, ...slots.map((slot) => slot.total))
  const bars = slots.map((slot, index) => {
    const centerX = CHART_PAD.left + barWidth / 2 + index * step
    let yBottom = CHART_PAD.top + plotHeight
    const segments = []
    for (const model of modelOrder) {
      const tokens = slot.byModel[model] ?? 0
      if (tokens === 0) continue
      const height = (tokens / maxTotal) * plotHeight
      yBottom -= height
      segments.push({ model, y: yBottom, height })
    }
    return { key: slot.day, x: centerX, segments }
  })
  return {
    width: avail,
    height: CHART_HEIGHT,
    plotHeight,
    step,
    barWidth,
    maxTotal,
    ticks: niceTicks(maxTotal, AXIS_TICK_COUNT),
    labelEvery: Math.max(1, Math.ceil(labelMinPitch / step)),
    bars,
  }
}
