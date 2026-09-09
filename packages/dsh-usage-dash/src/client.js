(() => {
// 用量统计面板 client 半区:设置页 settings.section 注入与底部信息栏接管,en/zh 双语。
// 无构建:createElement + 一次性样式注入。
// 单文件自包含:client-modules bundle 以经典 script 整源求值,禁止 import/export;整文件 IIFE 书挡,
// 顶层零词法声明(经典 script 全局词法环境跨 bundle 共享,顶层同名即整脚本拒载);测试经书挡剥壳求值纯函数区。

const DAY_PRESETS = ['7', '30', '90']
const HOUR_PRESETS = ['24h', '3d', '7d', '15d']
const MINUTE_PRESETS = ['3h', '24h', '3d', '7d']

const HOUR_PRESET_HOURS = { '24h': 24, '3d': 3 * 24, '7d': 7 * 24, '15d': 15 * 24 }
const MINUTE_PRESET_MINUTES = { '3h': 3 * 60, '24h': 24 * 60, '3d': 3 * 24 * 60, '7d': 7 * 24 * 60 }

const DEFAULT_RANGE = '30'
const DEFAULT_HOUR_PRESET = '24h'
const DEFAULT_MINUTE_PRESET = '24h'

// 天视图渲染上限;时/分上限 = 闭区间桶数(hour N+1 槽,minute N/10+1 槽)
const DAY_MAX_SLOTS = 180
const API_PREFIX = '/api/usage-dash/'
const ENDPOINTS = { range: 'range', hours: 'hours', minutes: 'minutes', status: 'status', reset: 'reset', restore: 'restore', pricing: 'pricing' }

// 宿主语义 token 之外的插件本地模型色板容量与哨兵
const GROUP_TOP_COUNT = 5
const OTHER_MODEL = '\u0000other'

const PAD_WIDTH = 2
const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_MINUTE = 60 * 1000

const pad = (value) => String(value).padStart(PAD_WIDTH, '0')
const formatDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

function dayBucket(date) {
  return formatDate(date)
}
function hourBucket(date) {
  return `${formatDate(date)}T${pad(date.getHours())}`
}
function minuteBucket(date) {
  return `${hourBucket(date)}:${pad(date.getMinutes())}`
}

function localDay(offsetDays, now = new Date()) {
  const shifted = new Date(now)
  shifted.setDate(shifted.getDate() + offsetDays)
  return formatDate(shifted)
}

const hourValueOf = (presetId) => HOUR_PRESET_HOURS[presetId]
const minuteValueOf = (presetId) => MINUTE_PRESET_MINUTES[presetId]

function resolveDayRange(presetId, now = new Date()) {
  const days = Number(presetId)
  if (!Number.isInteger(days) || days <= 0) return null
  return { from: localDay(-(days - 1), now), to: formatDate(now) }
}

function resolveHourRange(presetId, now = new Date()) {
  const hours = hourValueOf(presetId)
  if (!hours) return null
  return { from: hourBucket(new Date(now.getTime() - hours * MS_PER_HOUR)), to: hourBucket(now) }
}

// 分钟桶对齐 10 分钟粒度:窗口起点落到桶边界,to 保持原始分钟(闭区间上界)
const MINUTE_BUCKET_SPAN_MINUTES = 10
const MINUTE_BUCKET_SPAN_MS = MINUTE_BUCKET_SPAN_MINUTES * MS_PER_MINUTE

function minuteBucketFloor(ts) {
  return Math.floor(ts / MINUTE_BUCKET_SPAN_MS) * MINUTE_BUCKET_SPAN_MS
}

function resolveMinuteRange(presetId, now = new Date()) {
  const minutes = minuteValueOf(presetId)
  if (!minutes) return null
  const from = minuteBucket(new Date(minuteBucketFloor(now.getTime()) - minutes * MS_PER_MINUTE))
  return { from, to: minuteBucket(now) }
}

function maxSlotsFor(view, presetId) {
  if (view === 'hour') return hourValueOf(presetId) + 1
  if (view === 'minute') return minuteValueOf(presetId) / MINUTE_BUCKET_SPAN_MINUTES + 1
  return DAY_MAX_SLOTS
}

function trimSlots(slots, max) {
  return slots.length > max ? slots.slice(-max) : slots
}

// 时/分挡位表存在同 id(如 '24h'),点数据缓存命中须视图与挡位双匹配,防跨视图误用他端点数据
function pointStatsMatches(cached, view, presetId) {
  return !!cached && cached.view === view && cached.preset === presetId
}

const DEFAULT_ERROR_CODE = 'error'
const DEFAULT_ERROR_MESSAGE = 'usage api error'
const envelopeFailure = (code, message) => ({ ok: false, code, message })

function parseEnvelope(json) {
  if (!json || typeof json !== 'object') return envelopeFailure(DEFAULT_ERROR_CODE, DEFAULT_ERROR_MESSAGE)
  if (json.ok === true) return { ok: true, value: json.value }
  if (json.ok === false) {
    const error = json.error ?? {}
    return envelopeFailure(error.code ?? DEFAULT_ERROR_CODE, error.message ?? DEFAULT_ERROR_MESSAGE)
  }
  return envelopeFailure(DEFAULT_ERROR_CODE, DEFAULT_ERROR_MESSAGE)
}

const MESSAGES_ZH = {
  nav: '使用统计',
  range: '时间范围',
  'rangePreset.7': '7 天',
  'rangePreset.30': '30 天',
  'rangePreset.90': '90 天',
  rangeCustom: '自定义',
  from: '开始日期',
  to: '结束日期',
  refresh: '刷新',
  loading: '正在扫描历史会话。安装插件后首次会全量回扫,数据量大时耗时较久,期间尽量减少操作以免服务变卡',
  tokens: 'Tokens 用量',
  tokensHint: '服务商总口径:未缓存输入 + 输出 + 缓存命中 token',
  sessions: '会话数量',
  requests: '请求数量',
  activeDays: '活跃天数',
  cacheRate: '平均缓存命中率',
  cacheRateHint: '时间段内缓存命中 token 占输入 token 的比例',
  cacheHitRate: '缓存命中率',
  hitRateLegend: '缓存命中率',
  avgSpeed: '平均生成速度',
  speedLegend: '平均生成速度',
  ttftLegend: '首 token 延迟',
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
  viewDay: '天',
  viewHour: '小时',
  viewMinute: '分钟',
  viewGroup: '统计粒度',
  'status.running': '回扫中 {done}/{total}',
  rebuild: '重建',
  rebuildConfirm: '确认重建',
  restore: '回退数据',
  restoreConfirm: '确认回退',
  restoreMissing: '无可用回退点(重建时自动生成)',
  hourTrend: '按小时 Token 趋势',
  minuteTrend: '按分钟 Token 趋势',
  'hourPreset.24h': '24 小时',
  'hourPreset.3d': '3 天',
  'hourPreset.7d': '7 天',
  'hourPreset.15d': '15 天',
  'minutePreset.3h': '3 小时',
  'minutePreset.24h': '24 小时',
  'minutePreset.3d': '3 天',
  'minutePreset.7d': '7 天',
  trendLimitedHour: '数据量过大,仅显示最近 {n} 小时',
  trendLimitedMinute: '数据量过大,仅显示最近 {n} 分钟',
  trendTruncated: '数据量过大,仅显示最近部分',
  recordFailures: '{n} 条记录写入失败',
  skippedSessions: '跳过 {n} 个无法读取的会话',
  skipBreakdown: '宿主拒读 {d} / 存档损坏 {c} / 旧格式 {l} / 其他 {o}——宿主修复后下轮回扫自动补齐',
  anomalyLog: '扫描异常日志',
  logKindSkipped: '跳过会话',
  logKindRecord: '写入失败',
  'stats.counts': '{turns} 轮 · {steps} 步',
  'stats.llm': 'LLM {duration}',
  'stats.toolCall': '工具调用 {duration}',
  'stats.ttftAverage': '首 token 平均 {duration}',
  'stats.tokensPerSecond': '{throughput} tok/s',
  'stats.cacheHit': '缓存命中 {percent}%',
  'stats.tokens': '输入 {input} tok · 输出 {output} tok',
  'turnCostChip': '{cost}',
  'stats.tokensDetail': '总 {total} tok · 输入 {input} tok · 命中缓存 {hit} tok · 未命中缓存 {miss} tok · 输出 {output} tok',
  cachePrecision: '精确缓存命中率',
  cachePrecisionDesc: '在会话底部信息栏以两位小数显示缓存命中率。',
  tokenDetail: '会话 Token 明细',
  tokenDetailDesc: '在会话底部信息栏显示总 Token、命中/未命中缓存与输出明细。',
  costDisplay: '费用显示',
  costDisplayDesc: '在信息栏、趋势悬浮与回合费用芯片中显示按当前费率估算的费用。',
  costTitle: '按当前费率对历史用量估算,精度为小时级',
  costUnpriced: '{n} 个小时桶未计价',
  statsCostTitle: '按当前费率对会话累计 token 估算',
  'stats.cost': '费用 ≈ {cost}',
  turnCostTitle: '单轮用量按当前费率估算',
  turnTokensUnreported: '该提供商未上报此桶',
  pricing: '定价规则',
  pricingUnavailable: '定价规则不可用',
  pricingModel: '模型',
  pricingModelPlaceholder: 'provider/model,段可通配如 */*',
  pricingCurrency: '货币',
  pricingUnit: '每百万 token 定价',
  priceInput: '输入',
  priceOutput: '输出',
  priceCacheRead: '缓存读',
  priceCacheWrite: '缓存写',
  addCondition: '添加条件',
  confirmDelete: '确认删除',
  deleteCondition: '删除条件',
  condKind: '条件类型',
  condDailyWindow: '每日时段',
  condWeekdays: '星期几',
  condMonthDays: '每月号段',
  condDateRange: '日期段',
  condFrom: '从',
  condTo: '至',
  'weekday.0': '日',
  'weekday.1': '一',
  'weekday.2': '二',
  'weekday.3': '三',
  'weekday.4': '四',
  'weekday.5': '五',
  'weekday.6': '六',
  condTime: '需 HH:MM',
  condWeekday: '需 0-6 整数',
  condMonthDay: '需 1-31 整数',
  condDate: '需 YYYY-MM-DD',
  condRange: '结束不得早于起始(两端均含)',
  ruleOrderHint: '附加计费规则从上到下匹配,首个命中生效;全不命中落默认价',
  moveUp: '上移',
  moveDown: '下移',
  addGroup: '添加模型',
  addRule: '添加额外计费规则',
  addDefaultPrice: '添加默认价',
  deleteGroup: '删除模型及其全部计费规则',
  deleteRule: '删除计费规则',
  addCondition: '添加条件',
  defaultPriceHint: '默认价:附加规则全不命中时生效,不设条件',
  save: '保存',
  saved: '已保存',
  required: '必填',
  priceInvalid: '不能为负',
  modelFormat: '需两段 provider/model,段可通配',
  'duration.compactSeconds': '{seconds}秒',
  'duration.compactMinutes': '{minutes}分{seconds}秒',
  'number.thousand': '{value}K',
  'number.million': '{value}M',
}

// en 词典:stats/duration/number 族逐字节取官方 chat 值,其余为本插件自有文案
const MESSAGES_EN = {
  nav: 'Usage',
  range: 'Time range',
  'rangePreset.7': '7 days',
  'rangePreset.30': '30 days',
  'rangePreset.90': '90 days',
  rangeCustom: 'Custom',
  from: 'From',
  to: 'To',
  refresh: 'Refresh',
  loading: 'Scanning past sessions. The first scan after installing runs a full backfill and can take a while on large histories; avoid heavy activity meanwhile to keep the service responsive',
  tokens: 'Token usage',
  tokensHint: 'Provider total: uncached input + output + cache-read tokens',
  sessions: 'Sessions',
  requests: 'Requests',
  activeDays: 'Active days',
  cacheRate: 'Avg cache-hit rate',
  cacheRateHint: 'Cache-hit tokens as a share of input tokens within the range',
  cacheHitRate: 'Cache-hit rate',
  hitRateLegend: 'Cache-hit rate',
  avgSpeed: 'Avg speed',
  speedLegend: 'Avg speed',
  ttftLegend: 'First-token latency',
  topModel: 'Top model',
  topModelHint: 'Ranked by token usage, not call count',
  heatmap: 'Activity heatmap',
  heatLess: 'Less',
  heatMore: 'More',
  dailyTrend: 'Daily token trend',
  trendLimited: 'Showing only the last {n} days',
  modelUsage: 'Model usage',
  other: 'Other',
  total: 'Total',
  percent: 'Share',
  asOf: 'Stats as of',
  empty: 'No usage data in this range yet. Token usage accumulates from when this panel is enabled, and existing sessions are scanned once.',
  viewDay: 'Day',
  viewHour: 'Hour',
  viewMinute: 'Minute',
  viewGroup: 'Granularity',
  'status.running': 'Rescanning {done}/{total}',
  rebuild: 'Rebuild',
  rebuildConfirm: 'Confirm rebuild',
  restore: 'Restore data',
  restoreConfirm: 'Confirm restore',
  restoreMissing: 'No restore point (created automatically on rebuild)',
  hourTrend: 'Hourly token trend',
  minuteTrend: 'Per-minute token trend',
  'hourPreset.24h': '24 hours',
  'hourPreset.3d': '3 days',
  'hourPreset.7d': '7 days',
  'hourPreset.15d': '15 days',
  'minutePreset.3h': '3 hours',
  'minutePreset.24h': '24 hours',
  'minutePreset.3d': '3 days',
  'minutePreset.7d': '7 days',
  trendLimitedHour: 'Too much data, showing only the last {n} hours',
  trendLimitedMinute: 'Too much data, showing only the last {n} minutes',
  trendTruncated: 'Too much data, showing only the latest part',
  recordFailures: '{n} records failed to write',
  skippedSessions: '{n} unreadable sessions skipped',
  skipBreakdown: 'host-refused {d} / corrupt {c} / legacy format {l} / other {o} — auto-retried once the host can read them',
  anomalyLog: 'Scan anomaly log',
  logKindSkipped: 'skipped',
  logKindRecord: 'write failed',
  'stats.counts': '{turns} turns · {steps} steps',
  'stats.llm': 'LLM {duration}',
  'stats.toolCall': 'Tool call {duration}',
  'stats.ttftAverage': 'TTFT avg {duration}',
  'stats.tokensPerSecond': '{throughput} tok/s',
  'stats.cacheHit': 'Cache hit {percent}%',
  'stats.tokens': 'Input {input} tok · Output {output} tok',
  'turnCostChip': '{cost}',
  'stats.tokensDetail': 'Total {total} tok · Input {input} tok · Cache hit {hit} tok · Cache miss {miss} tok · Output {output} tok',
  cachePrecision: 'Precise cache-hit rate',
  cachePrecisionDesc: 'Show the cache-hit rate with two decimals in the session stats line.',
  tokenDetail: 'Session token detail',
  tokenDetailDesc: 'Show total, cache hit/miss and output tokens in the session stats line.',
  costDisplay: 'Cost display',
  costDisplayDesc: 'Show costs estimated at current rates in the stats line, trend tooltips and the turn cost chip.',
  costTitle: 'Estimated at current rates over historical usage, hourly precision',
  costUnpriced: '{n} hour buckets unpriced',
  statsCostTitle: 'Estimated at current rates over session token totals',
  'stats.cost': 'Cost ≈ {cost}',
  turnCostTitle: 'Per-turn usage estimated at current rates',
  turnTokensUnreported: 'Not reported by this provider',
  pricing: 'Pricing rules',
  pricingUnavailable: 'Pricing rules unavailable',
  pricingModel: 'Model',
  pricingModelPlaceholder: 'provider/model, segments may be */*',
  pricingCurrency: 'Currency',
  pricingUnit: 'per million tokens pricing',
  priceInput: 'Input',
  priceOutput: 'Output',
  priceCacheRead: 'Cache read',
  priceCacheWrite: 'Cache write',
  addCondition: 'Add condition',
  confirmDelete: 'Confirm delete',
  deleteCondition: 'Remove condition',
  condKind: 'Condition kind',
  condDailyWindow: 'Daily window',
  condWeekdays: 'Weekdays',
  condMonthDays: 'Month days',
  condDateRange: 'Date range',
  condFrom: 'From',
  condTo: 'To',
  'weekday.0': 'Su',
  'weekday.1': 'Mo',
  'weekday.2': 'Tu',
  'weekday.3': 'We',
  'weekday.4': 'Th',
  'weekday.5': 'Fr',
  'weekday.6': 'Sa',
  condTime: 'Requires HH:MM',
  condWeekday: 'Requires integer 0-6',
  condMonthDay: 'Requires integer 1-31',
  condDate: 'Requires YYYY-MM-DD',
  condRange: 'End must not be before start (both ends inclusive)',
  ruleOrderHint: '附加计费规则从上到下匹配,首个命中生效;全不命中落默认价',
  moveUp: 'Move up',
  moveDown: 'Move down',
  addGroup: 'Add model',
  addRule: 'Add extra pricing rule',
  addDefaultPrice: 'Add default price',
  deleteGroup: 'Delete model and all its pricing rules',
  deleteRule: 'Remove pricing rule',
  addCondition: 'Add condition',
  defaultPriceHint: 'Default price: applies when no extra rule above matches; no conditions',
  save: 'Save',
  saved: 'Saved',
  required: 'Required',
  priceInvalid: 'Must not be negative',
  modelFormat: 'Requires two segments provider/model; segments may be wildcards',
  'duration.compactSeconds': '{seconds}s',
  'duration.compactMinutes': '{minutes}m{seconds}s',
  'number.thousand': '{value}K',
  'number.million': '{value}M',
}

const PLACEHOLDER_PATTERN = /\{(\w+)\}/g

// 纯查表翻译:缺键回退键名,占位 {k} 插值
function translateWith(dict, key, params) {
  const text = dict[key] ?? key
  if (!params) return text
  return text.replace(PLACEHOLDER_PATTERN, (raw, name) => (name in params ? String(params[name]) : raw))
}

// 词典绑定翻译器:与宿主 t 座同构,locale 缺席时的本地回退形态
function createTranslator(dict) {
  return (key, params) => translateWith(dict, key, params)
}

const COMPACT_BASE = 1000
const DECIMAL_DIGITS = 1
function formatTokens(value) {
  return value.toLocaleString('en-US')
}
function formatCompact(value) {
  if (value >= COMPACT_BASE ** 3) return (value / COMPACT_BASE ** 3).toFixed(DECIMAL_DIGITS) + 'B'
  if (value >= COMPACT_BASE ** 2) return (value / COMPACT_BASE ** 2).toFixed(DECIMAL_DIGITS) + 'M'
  if (value >= COMPACT_BASE) return (value / COMPACT_BASE).toFixed(DECIMAL_DIGITS) + 'k'
  return String(value)
}
function formatPercent(value) {
  return (Math.round(value * 10) / 10).toFixed(1) + '%'
}
// tooltip 数值缺席占位
const TOOLTIP_MISSING = '—'
function cacheRate(hit, miss) {
  const total = hit + miss
  return total <= 0 ? null : (hit / total) * 100
}
function cacheRateText(hit, miss) {
  const rate = cacheRate(hit, miss)
  return rate === null ? TOOLTIP_MISSING : formatPercent(rate)
}

// 模型键展示分段与定价/存储口径同源:首个 / 前 vendor 段,余为模型段
function modelNameOf(ref) {
  return splitRequestSegments(ref)[1]
}
function providerOf(ref) {
  return splitRequestSegments(ref)[0]
}

function shortDay(day) {
  const parts = day.split('-')
  return `${Number(parts[1])}/${Number(parts[2])}`
}

const DAY_KEY_LENGTH = 'YYYY-MM-DD'.length
const MIDNIGHT_HOUR = '00'
const MIDNIGHT_TIME = '00:00'
function hourTickLabel(key) {
  const hour = key.slice(DAY_KEY_LENGTH + 1)
  return hour === MIDNIGHT_HOUR ? `${shortDay(key.slice(0, DAY_KEY_LENGTH))} ${hour}:00` : `${hour}:00`
}
function minuteTickLabel(key) {
  const time = key.slice(DAY_KEY_LENGTH + 1)
  return time === MIDNIGHT_TIME ? `${shortDay(key.slice(0, DAY_KEY_LENGTH))} ${time}` : time
}

// 悬浮窗槽标签:完整日期去 T 分隔,小时以 h 后缀标定(避免 i18n 单位问题),分钟保留 HH:MM
function hourSlotLabel(key) {
  return `${key.slice(0, DAY_KEY_LENGTH)} ${key.slice(DAY_KEY_LENGTH + 1)}h`
}

function minuteSlotLabel(key) {
  return `${key.slice(0, DAY_KEY_LENGTH)} ${key.slice(DAY_KEY_LENGTH + 1)}`
}

function isEmptyRange(value) {
  return value.tokens === 0 && value.cacheHit === 0 && value.requests === 0 && value.turns === 0
}

// 日志条目时刻仅显示当日时分秒
function logTimeOf(ms) {
  const date = new Date(ms)
  const part = (value) => String(value).padStart(2, '0')
  return `${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`
}

const toRankedModels = (totals) =>
  [...totals.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens)

// 逐槽 byModel 把非 top 模型并入哨兵桶,原明细留 otherByModel 供 tooltip;模型顺序 = 图例序(哨兵恒最后)
const foldSlotsByTop = (slots, topModels) => {
  const top = new Set(topModels)
  return slots.map((slot) => {
    const byModel = {}
    const otherByModel = {}
    for (const [model, tokens] of Object.entries(slot.byModel)) {
      if (top.has(model)) {
        byModel[model] = (byModel[model] ?? 0) + tokens
        continue
      }
      byModel[OTHER_MODEL] = (byModel[OTHER_MODEL] ?? 0) + tokens
      otherByModel[model] = (otherByModel[model] ?? 0) + tokens
    }
    return { ...slot, byModel, otherByModel }
  })
}

const topWithOther = (ranked) => {
  const models = ranked.slice(0, GROUP_TOP_COUNT)
  if (ranked.length > GROUP_TOP_COUNT) {
    const rest = ranked.slice(GROUP_TOP_COUNT)
    models.push({
      model: OTHER_MODEL,
      tokens: rest.reduce((sum, item) => sum + item.tokens, 0),
      cost: rest.reduce((sum, item) => sum + (item.cost ?? 0), 0),
      items: rest,
    })
  }
  return models
}

function groupStats(stats) {
  const models = topWithOther(stats.models)
  const topModels = models.filter((item) => item.model !== OTHER_MODEL).map((item) => item.model)
  return { models, daily: foldSlotsByTop(stats.daily, topModels) }
}

function groupPointSlots(slots) {
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
const CHART_HEIGHT = 220
const CHART_PAD = { left: 46, right: 65, top: 10, bottom: 26 }
const BAR_WIDTH_RATIO = 0.62
const BAR_MIN_WIDTH = 3
const BAR_MAX_WIDTH = 30
const AXIS_TICK_COUNT = 4
// 速度刻度上限钳底:全零或无速度防除零(速度不设轴,读数走 tooltip)
const SPEED_SCALE_FLOOR = 1
// 首 token 延迟刻度上限钳底(毫秒):全零或无数据防除零(不设轴,读数走 tooltip)
const TTFT_SCALE_FLOOR = 1
// 轴上限留白系数:数据峰不顶满绘图区,顶部留出标注空间
const AXIS_SCALE_HEADROOM = 1.1
// 图例键:折线项与模型项共处同一显隐集合
const LEGEND_KEY_RATE = 'rate'
const LEGEND_KEY_SPEED = 'speed'
const LEGEND_KEY_TTFT = 'ttft'

function niceTicks(max, count) {
  if (max <= 0 || count <= 0) return []
  const raw = max / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / magnitude
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude
  const ticks = []
  for (let value = step; value <= max; value += step) ticks.push(value)
  return ticks
}

// 图例显隐切换:current 为 null 表示全部可见;普通点击单选/再点恢复,
// ctrl 单项切换,隐藏最后一项为无操作(返回原引用)
function legendToggle(current, key, ctrl) {
  if (ctrl) {
    const next = new Set(current ?? [])
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next.size === 0 ? current : next
  }
  const solo = current !== null && current.size === 1 && current.has(key)
  return solo ? null : new Set([key])
}

// 左轴刻度:速度刻度存在时左轴标定速度(tok/s),否则标定 token;
// 刻度值统一换算为绘图区高度占比
function leftAxisTicks(tokenTicks, tokenMax, speedTicks, speedMax) {
  const useSpeed = speedTicks.length > 0
  return (useSpeed ? speedTicks : tokenTicks).map((tick) => ({
    label: formatCompact(tick),
    ratio: tick / (useSpeed ? speedMax : tokenMax),
  }))
}

// 堆叠柱几何:模型序即堆叠序(哨兵最后画柱顶),输出槽分段与左轴刻度;
// maxTotal 按可见模型求和,单选模型时刻度跟随归一
function trendLayout(slots, modelOrder, avail, labelMinPitch) {
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom
  const innerWidth = Math.max(1, avail - CHART_PAD.left - CHART_PAD.right)
  const count = slots.length
  const step = count > 1 ? innerWidth / (count - 1) : innerWidth
  const barWidth = Math.max(BAR_MIN_WIDTH, Math.min(BAR_MAX_WIDTH, step * BAR_WIDTH_RATIO))
  const slotVisibleTotal = (slot) => modelOrder.reduce((sum, model) => sum + (slot.byModel[model] ?? 0), 0)
  const maxTotal = Math.max(1, ...slots.map(slotVisibleTotal))
  // 轴上限 = 数据峰 × 留白系数,柱高分母与左轴刻度分母同源
  const scaleMax = maxTotal * AXIS_SCALE_HEADROOM
  // 可见模型无任何数据时左轴无标定对象,空刻度防钳底值漏成假刻度
  const visibleTotal = slots.reduce((sum, slot) => sum + slotVisibleTotal(slot), 0)
  const bars = slots.map((slot, index) => {
    const centerX = CHART_PAD.left + barWidth / 2 + index * step
    let yBottom = CHART_PAD.top + plotHeight
    const segments = []
    for (const model of modelOrder) {
      const tokens = slot.byModel[model] ?? 0
      if (tokens === 0) continue
      const height = (tokens / scaleMax) * plotHeight
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
    scaleMax,
    ticks: visibleTotal === 0 ? [] : niceTicks(maxTotal, AXIS_TICK_COUNT),
    labelEvery: Math.max(1, Math.ceil(labelMinPitch / step)),
    bars,
  }
}

// 命中率副轴与曲线
const PERCENT_SCALE = 100
const RATE_AXIS_STEPS = 4
const TREND_LINE_WIDTH = 2
const TREND_DOT_RADIUS = 4
const TREND_DOT_RING = 2
const AXIS_RATE_GAP = 8
const BAR_HOVER_GROW = 3

const rateAxisTicks = () =>
  Array.from({ length: RATE_AXIS_STEPS + 1 }, (_, index) => (index / RATE_AXIS_STEPS) * PERCENT_SCALE)

function trendRatePoints(slots, bars, plotHeight) {
  const points = []
  slots.forEach((slot, index) => {
    const rate = cacheRate(slot.cacheHit, slot.cacheMiss)
    if (rate === null) return
    points.push({
      day: slot.day,
      x: bars[index].x,
      y: CHART_PAD.top + plotHeight - (rate / PERCENT_SCALE) * plotHeight,
    })
  })
  return points
}

// 速度曲线点:仅带速度槽产出,高度按刻度上限归一
function trendSpeedPoints(slots, bars, plotHeight, scaleMax) {
  const points = []
  slots.forEach((slot, index) => {
    if (slot.speed === undefined) return
    points.push({
      day: slot.day,
      x: bars[index].x,
      y: CHART_PAD.top + plotHeight - (slot.speed / scaleMax) * plotHeight,
    })
  })
  return points
}

// 首 token 延迟曲线点:仅带 ttft 槽产出,高度按刻度上限归一(毫秒域独立归一)
function trendTtftPoints(slots, bars, plotHeight, scaleMax) {
  const points = []
  slots.forEach((slot, index) => {
    if (slot.ttft === undefined) return
    points.push({
      day: slot.day,
      x: bars[index].x,
      y: CHART_PAD.top + plotHeight - (slot.ttft / scaleMax) * plotHeight,
    })
  })
  return points
}

// Catmull-Rom 转三次贝塞尔:控制点取邻点差六分之一,端点折返
function smoothPath(points) {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return d
}

// donut:circle+stroke-dash 几何,offset 渲染序累加
const DONUT_VIEWBOX_SIZE = 200
const DONUT_CENTER_XY = 100
const DONUT_OUTER_RADIUS = 95
const DONUT_STROKE_WIDTH = 30
const DONUT_ACTIVE_STROKE_GROW = 5
const DONUT_DIM_OPACITY = 0.35
const DONUT_RADIUS = DONUT_OUTER_RADIUS - DONUT_STROKE_WIDTH / 2
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS
const DONUT_TOTAL_FLOOR = 1
const DONUT_CENTER_VALUE_OFFSET = 8
const DONUT_CENTER_LABEL_OFFSET = 26

function donutSegments(models, total) {
  const denom = Math.max(DONUT_TOTAL_FLOOR, total)
  let offset = 0
  return models.map((item) => {
    const dash = (item.tokens / denom) * DONUT_CIRCUMFERENCE
    const segment = { ...item, dash, offset, percent: (item.tokens / denom) * PERCENT_SCALE }
    offset += dash
    return segment
  })
}

// 列表手风琴明细与分段可访问标签
function otherDetailItems(models) {
  const other = models.find((item) => item.model === OTHER_MODEL)
  return other ? other.items ?? [] : []
}

function modelSegmentLabel(name, tokens, percent) {
  return `${name}: ${formatTokens(tokens)} (${formatPercent(percent)})`
}

// 模型平均生成速度文本:官方吞吐口径格式化 + 单位(语言中立);无速度(无时长数据)为空串
function modelSpeedText(speed) {
  if (speed === undefined) return ''
  return `${formatTokensPerSecond(speed)} tok/s`
}

// tooltip 速度行文本:无速度与命中率同款占位符
function speedTipText(speed) {
  return speed === undefined ? TOOLTIP_MISSING : modelSpeedText(speed)
}

// 速度刻度上限:全零或无速度钳底,防除零
function speedScaleMax(slots) {
  return Math.max(SPEED_SCALE_FLOOR, ...slots.map((slot) => slot.speed ?? 0))
}

// 首 token 延迟刻度上限(毫秒):全零或无数据钳底防除零
function ttftScaleMax(slots) {
  return Math.max(TTFT_SCALE_FLOOR, ...slots.map((slot) => slot.ttft ?? 0))
}

// tooltip 首 token 延迟行文本:无 ttft 与命中率同款占位符,有则为官方时长口径
function ttftTipText(ttft, t) {
  return ttft === undefined ? TOOLTIP_MISSING : formatDuration(ttft, t)
}

// 模型首 token 延迟文本:图例标签 + 官方时长口径;无 ttft(无配对数据)为空串
function modelTtftText(ttft, t) {
  if (ttft === undefined) return ''
  return `${t('ttftLegend')} ${formatDuration(ttft, t)}`
}

// 热力图:窗口固定 26 周,与所选范围无关
const HEAT_WEEKS = 26
const HEAT_ROW_COUNT = 7
const HEAT_WINDOW_DAYS = HEAT_WEEKS * HEAT_ROW_COUNT
const HEAT_BASE = 14
const HEAT_GAP = 3
const HEAT_RX = 3
const HEAT_WIDTH_EPSILON = 1
const HEAT_LEVELS = 6
const HEAT_LEVEL_BANDS = 4
const HEAT_EDGE_TRIM = 2

function indexOfDay(day) {
  return (new Date(`${day}T00:00:00`).getDay() + HEAT_ROW_COUNT - 1) % HEAT_ROW_COUNT
}

function daysInRange(from, to) {
  const days = []
  const cursor = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  while (cursor.getTime() <= end.getTime()) {
    days.push(formatDate(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

// 够宽格子连续生长铺满窗口,过窄保最新列裁最早
function heatLayout(width, firstDay) {
  const avail = Math.max(1, width - HEAT_EDGE_TRIM)
  const baseCols = Math.max(1, Math.floor((avail + HEAT_GAP) / (HEAT_BASE + HEAT_GAP)))
  if (baseCols < HEAT_WEEKS || !firstDay) return { size: HEAT_BASE, cols: baseCols }
  const totalWeeks = Math.ceil((HEAT_WINDOW_DAYS + (indexOfDay(firstDay) + 1) % HEAT_ROW_COUNT) / HEAT_ROW_COUNT)
  return { size: Math.max(HEAT_BASE, avail / totalWeeks - HEAT_GAP), cols: HEAT_WEEKS }
}

function heatDisplayDays(allDays, cols) {
  return allDays.slice(-Math.min(cols * HEAT_ROW_COUNT, allDays.length))
}

// 行序位移:indexOfDay 周一为零,+1 取模后周日..周六落行首
function heatGrid(rows, size) {
  const startOffset = (indexOfDay(rows[0].day) + 1) % HEAT_ROW_COUNT
  const weeks = Math.max(1, Math.ceil((rows.length + startOffset) / HEAT_ROW_COUNT))
  const pitch = size + HEAT_GAP
  const cells = rows.map((row, index) => {
    const col = Math.floor((index + startOffset) / HEAT_ROW_COUNT)
    const cellRow = (index + startOffset) % HEAT_ROW_COUNT
    return { ...row, x: HEAT_GAP + col * pitch, y: HEAT_GAP + cellRow * pitch }
  })
  return { weeks, cells, width: weeks * pitch + HEAT_GAP, height: HEAT_ROW_COUNT * pitch + HEAT_GAP }
}

function heatLevel(tokens, max) {
  return tokens === 0 ? 0 : 1 + Math.floor((tokens / max) * HEAT_LEVEL_BANDS)
}

// ChartTip 定位:锚定区装得下贴内顶(趋势图悬停区即绘图区,悬浮窗留在图表内),装不下上翻、再下翻、末了钳边界顶
const TIP_GAP_PX = 8
const TIP_MARGIN_PX = 8

// 回合费用芯片与前置官方芯片(结束时钟)的间距
const TURN_COST_GAP_PX = 8

function tipPlace(anchor, tip, bounds, gap = TIP_GAP_PX, margin = TIP_MARGIN_PX) {
  if (!tip || tip.width <= 0 || tip.height <= 0) return null
  if (!anchor || (anchor.left === 0 && anchor.top === 0 && anchor.right === 0 && anchor.bottom === 0)) return null
  const minX = bounds.left + margin
  const minY = bounds.top + margin
  const maxX = bounds.right - margin
  const maxY = bounds.bottom - margin
  const left = Math.max(minX, Math.min((anchor.left + anchor.right) / 2 - tip.width / 2, maxX - tip.width))
  const inside = anchor.top + gap
  const above = anchor.top - gap - tip.height
  const below = anchor.bottom + gap
  let top
  if (inside + tip.height <= anchor.bottom) top = inside
  else if (above >= minY) top = above
  else if (below + tip.height <= maxY) top = below
  else top = minY
  return { left, top }
}

// ===== 底部信息栏:官方 StatsLine 口径(dsh-client-ui-chat/lib/client.js 同构)+ usp 双开关 =====
const STATS_LINE_STORAGE_KEY = 'dsh-usage-dash:stats-line'
const LOCALE_NS = 'usage-dash'
const STATS_ITEM_SEPARATOR = ' · '
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const NUMBER_ONE_DECIMAL = 10
const NUMBER_COMPACT_INT_THRESHOLD = 100
const PERCENT_TENTH_SCALE = 10
const PERCENT_GAP_DOUBLE_SCALE = 2 * PERCENT_SCALE
const PERCENT_LOSS_BASE = 10
const PERCENT_LOSS_CAP = 4
const PERCENT_LOSS_DEFAULT = 5
const PERCENT_PRECISE_CAP = 99.99
const DURATION_MINUTE_SECONDS = 60
const TPS_INTEGER_THRESHOLD = 10

// 官方 billing 分母:三个互斥的 prompt 侧计费桶
function billedInputTokens(usage) {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

// 官方二分取整:求最大 units 使 hit ≥ (2u-1)q + ceil((2u-1)r/2s),Math.round(hit·scale/D) 的保守复刻
function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
  const scale = (decimalPlaces === 0 ? 1 : PERCENT_TENTH_SCALE) * PERCENT_SCALE
  const doubledScale = scale * 2
  const quotient = Math.floor(denominator / doubledScale)
  const remainder = denominator % doubledScale
  const holds = (candidate) => {
    const doubled = candidate * 2 - 1
    return cacheReadTokens >= doubled * quotient + Math.ceil((doubled * remainder) / doubledScale)
  }
  let low = 0
  let high = scale
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (holds(mid)) low = mid
    else high = mid - 1
  }
  return low
}

function displayPercentUnits(units, decimalPlaces) {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / PERCENT_TENTH_SCALE)
  const tenths = units % PERCENT_TENTH_SCALE
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`
}

// 官方整数百分比:0.5 进位;舍入溢出 100 而仍有 miss 时以 99.x 闭式诚实呈现
function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
  if (promptTokens === 0) return null
  const missed = promptTokens - cacheReadTokens
  if (missed === 0) return '100'
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  const unitsCeiling = decimalPlaces === 0 ? PERCENT_SCALE : PERCENT_SCALE * PERCENT_TENTH_SCALE
  if (roundedUnits < unitsCeiling) return displayPercentUnits(roundedUnits, decimalPlaces)
  let distinguishingPlaces = 1
  let scaledDoubleGap = missed * PERCENT_GAP_DOUBLE_SCALE
  const denominatorTens = Math.floor(promptTokens / PERCENT_TENTH_SCALE)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= PERCENT_TENTH_SCALE
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % PERCENT_TENTH_SCALE
  let roundedLoss = PERCENT_LOSS_DEFAULT
  for (let loss = 1; loss <= PERCENT_LOSS_CAP; loss++) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / PERCENT_TENTH_SCALE)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${PERCENT_LOSS_BASE - roundedLoss}`
}

function cacheHitPercent(usage) {
  return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage), 0)
}

// usp 增强:恒两位小数,有 miss 即 99.99 封顶(镜像官方整数路径的诚实性)
function cacheHitPercentPrecise(usage) {
  const billed = billedInputTokens(usage)
  if (billed === 0) return null
  const missed = usage.uncachedInputTokens + usage.cacheWriteTokens
  if (missed === 0) return '100.00'
  const percent = Math.min(
    Math.round((usage.cacheReadTokens * PERCENT_SCALE * PERCENT_SCALE) / billed) / PERCENT_SCALE,
    PERCENT_PRECISE_CAP,
  )
  return percent.toFixed(2)
}

// 官方 compact 数字族:number.thousand='{value}K'、million='{value}M'(官方同构签名)
function formatTokensCompact(value, t) {
  const scaled = (count) => (count >= NUMBER_COMPACT_INT_THRESHOLD
    ? String(Math.round(count))
    : String(Math.round(count * NUMBER_ONE_DECIMAL) / NUMBER_ONE_DECIMAL))
  if (value < COMPACT_BASE) return String(value)
  if (value < COMPACT_BASE ** 2) return t('number.thousand', { value: scaled(value / COMPACT_BASE) })
  return t('number.million', { value: scaled(value / COMPACT_BASE ** 2) })
}

// 官方时长:60 秒内保留一位小数,以上整秒折分秒(官方同构签名)
function formatDuration(ms, t) {
  const seconds = ms / MS_PER_SECOND
  if (seconds < DURATION_MINUTE_SECONDS) return t('duration.compactSeconds', { seconds: Math.round(seconds * NUMBER_ONE_DECIMAL) / NUMBER_ONE_DECIMAL })
  const whole = Math.round(seconds)
  return t('duration.compactMinutes', { minutes: Math.floor(whole / SECONDS_PER_MINUTE), seconds: whole % SECONDS_PER_MINUTE })
}

// 官方吞吐:钳负值,阈值上取整、下一位小数
function formatTokensPerSecond(tps) {
  const clamped = Math.max(0, tps)
  if (clamped >= TPS_INTEGER_THRESHOLD) return String(Math.round(clamped))
  return String(Math.round(clamped * NUMBER_ONE_DECIMAL) / NUMBER_ONE_DECIMAL)
}

// 官方节点读数:TTFT/decode 仅在对应时间戳齐全时产出,usage 须为非负有限数
function assistantStepReading(node) {
  const timing = node.timing
  const ttftMs = timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
    ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
    : null
  const decodeMs = timing !== undefined && timing.firstTokenTime !== null
    ? Math.max(0, timing.completedTime - timing.firstTokenTime)
    : null
  const outputTokens = typeof node.usage === 'number' && Number.isFinite(node.usage) && node.usage >= 0
    ? node.usage
    : null
  return { ttftMs, decodeMs, outputTokens }
}

// 官方窗口折叠:tool-result 累计工具时长,assistant 计轮次/步数/LLM 时长并聚合读数
function deriveStats(nodes) {
  const turns = new Set()
  const stats = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  for (const node of nodes) {
    if (node.kind === 'tool-result') {
      if (node.callTime !== null) stats.toolMs += Math.max(0, node.time - node.callTime)
      continue
    }
    if (node.kind !== 'assistant') continue
    turns.add(node.turn)
    stats.steps += 1
    const timing = node.timing
    if (timing !== undefined && timing.stepStartTime !== null) {
      stats.llmMs += Math.max(0, timing.completedTime - timing.stepStartTime)
    }
    const reading = assistantStepReading(node)
    if (reading.ttftMs !== null) {
      stats.ttftMs += reading.ttftMs
      stats.ttftSteps += 1
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      stats.decodeMs += reading.decodeMs
      stats.decodeTokens += reading.outputTokens
    }
  }
  stats.turns = turns.size
  return stats
}

// 分组装配:官方 StatsLine 分组序 + usp 双开关(精确命中率/Token 明细)+ 费用开关;
// 费用组在 Token 组后追加:开关关/无用量/价格未加载不渲染,规则已载无命中价显示占位符
function buildStatsGroups(stats, usage, prefs, t, pricingRules = null) {
  const groups = []
  if (stats.steps > 0) {
    groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
    const durations = []
    if (stats.llmMs > 0) durations.push(t('stats.llm', { duration: formatDuration(stats.llmMs, t) }))
    if (stats.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDuration(stats.toolMs, t) }))
    if (durations.length > 0) groups.push(durations.join(STATS_ITEM_SEPARATOR))
    const speeds = []
    if (stats.ttftSteps > 0) speeds.push(t('stats.ttftAverage', { duration: formatDuration(stats.ttftMs / stats.ttftSteps, t) }))
    if (stats.decodeMs > 0) speeds.push(t('stats.tokensPerSecond', {
      throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / MS_PER_SECOND)),
    }))
    if (speeds.length > 0) groups.push(speeds.join(STATS_ITEM_SEPARATOR))
  }
  if (usage !== undefined && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const percent = prefs.cachePrecision ? cacheHitPercentPrecise(usage) : cacheHitPercent(usage)
    if (percent !== null) groups.push(t('stats.cacheHit', { percent }))
    if (prefs.tokenDetail) {
      const billed = billedInputTokens(usage)
      groups.push(t('stats.tokensDetail', {
        total: formatTokensCompact(billed + usage.outputTokens, t),
        input: formatTokensCompact(billed, t),
        hit: formatTokensCompact(usage.cacheReadTokens, t),
        miss: formatTokensCompact(usage.uncachedInputTokens + usage.cacheWriteTokens, t),
        output: formatTokensCompact(usage.outputTokens, t),
      }))
    } else {
      groups.push(t('stats.tokens', {
        input: formatTokensCompact(billedInputTokens(usage), t),
        output: formatTokensCompact(usage.outputTokens, t),
      }))
    }
    const costItem = buildCostItem(usage, pricingRules, prefs, t)
    if (costItem !== null) groups.push(costItem)
  }
  return groups
}

// usp stats-line 偏好状态工厂:storage 注入便于 Node 测试,读写全防御,内存值始终生效
// 默认三开:存储缺键/非法值一律按开,仅显式 false 视为用户关闭
function createStatsLineState(storage) {
  const DEFAULT_PREFS = { cachePrecision: true, tokenDetail: true, costDisplay: true }
  const listeners = new Set()
  const read = () => {
    if (!storage) return { ...DEFAULT_PREFS }
    try {
      const parsed = JSON.parse(storage.getItem(STATS_LINE_STORAGE_KEY))
      if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFS }
      return {
        cachePrecision: parsed.cachePrecision !== false,
        tokenDetail: parsed.tokenDetail !== false,
        costDisplay: parsed.costDisplay !== false,
      }
    } catch {
      return { ...DEFAULT_PREFS }
    }
  }
  let state = read()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch }
      if (storage) {
        try {
          storage.setItem(STATS_LINE_STORAGE_KEY, JSON.stringify(state))
        } catch {
          // 写失败仅丢持久化
        }
      }
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reload() {
      state = read()
      notify()
    },
  }
}


// ===== 定价镜像:官方无此物,宿主 pricing.js 镜像(双实现同源,parity 测试锁定) =====
// 语义逐条对齐宿主模块:本地时区取 Date 本地分量,匹配只读遍历入参规则;
// 零填充与 ISO 日串格式化复用本文件既有同义部件(pad/formatDate)
const UNIT_PER_MILLION = 'perMillion'
const CURRENCIES = ['¥', '$']
const CONDITION_KINDS = ['dailyWindow', 'weekdays', 'monthDays', 'dateRange']
const TOKENS_PER_MILLION = 1000 * 1000

const MODEL_WILDCARD = '*'
const SEGMENT_SEPARATOR = '/'
const PROVIDER_UNSET = 'default'
// 档位权重:vendor 段通配 1 档、model 段通配 2 档,和越小越优先(模型名精确档恒优于供应商精确档)
const VENDOR_WILDCARD_TIER = 1
const MODEL_WILDCARD_TIER = 2
const MINUTES_PER_HOUR = 60

const minutesOfDay = (date) => date.getHours() * MINUTES_PER_HOUR + date.getMinutes()

const toMinutesOfDay = (hhmm) => {
  if (typeof hhmm !== 'string') return Number.NaN
  const [hours, minutes] = hhmm.split(':')
  const h = Number(hours)
  const m = Number(minutes)
  return Number.isFinite(h) && Number.isFinite(m) ? h * MINUTES_PER_HOUR + m : Number.NaN
}

// 所有范围条件统一双侧包含;from>to 跨午夜/跨月环绕;from===to 单点/单日(与宿主 pricing.js 镜像,parity 测试锁定)
function dailyWindowMatches(condition, date) {
  const from = toMinutesOfDay(condition.from)
  const to = toMinutesOfDay(condition.to)
  if (Number.isNaN(from) || Number.isNaN(to)) return false
  const m = minutesOfDay(date)
  if (from <= to) return m >= from && m <= to
  return m >= from || m <= to
}

// days 空数组不成立;0=周日,取 getDay()
function weekdaysMatches(condition, date) {
  const { days } = condition
  return Array.isArray(days) && days.length > 0 && days.includes(date.getDay())
}

// 号段双侧包含;from>to 跨月环绕;from===to 单日,2 月无 31 号自然不触发
function monthDaysMatches(condition, date) {
  const { from, to } = condition
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false
  const d = date.getDate()
  return from <= to ? d >= from && d <= to : d >= from || d <= to
}

// 零填充 YYYY-MM-DD 字典序双侧包含;from>to 配置错误不成立(编辑器校验拦截)
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
function dateRangeMatches(condition, date) {
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
function conditionMatches(condition, date) {
  const matcher = condition && CONDITION_MATCHERS[condition.kind]
  if (!matcher || !(date instanceof Date) || Number.isNaN(date.getTime())) return false
  return matcher(condition, date)
}

// 形状残缺规则跳过:缺 model/price、unit 非 perMillion、conditions 非数组(含缺失)
function isRuleShaped(rule) {
  return !!rule && typeof rule === 'object' && typeof rule.model === 'string'
    && (rule.unit === undefined || rule.unit === UNIT_PER_MILLION)
    && !!rule.price && typeof rule.price === 'object' && !Array.isArray(rule.price)
    && Array.isArray(rule.conditions)
}

// 规则模型键必须两段式:首个 / 前 vendor 段、后模型段(允许含 /),首位斜杠或无斜杠均非法
function splitRuleSegments(pattern) {
  const slash = pattern.indexOf(SEGMENT_SEPARATOR)
  return slash > 0 ? [pattern.slice(0, slash), pattern.slice(slash + SEGMENT_SEPARATOR.length)] : null
}

// 段须非空且不含空白:含空白的模型键永不匹配真实请求
function isTwoSegmentModel(pattern) {
  const segments = splitRuleSegments(pattern)
  return segments !== null && segments.every((segment) => /^\S+$/.test(segment))
}

// 请求侧模型键按同构规则分段,无 / 或首位斜杠时 vendor 段缺省归 default(与存储行口径一致)
function splitRequestSegments(model) {
  return splitRuleSegments(model) ?? [PROVIDER_UNSET, model]
}

// 段级比对:规则段为通配或与请求段相等;两段全过才成立,通配段按各自档位计权
function matchTier(ruleSegments, requestSegments) {
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
function matchPrice(rules, model, timestamp) {
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
function costOf(price, buckets) {
  let raw = 0
  for (const { tokens, price: priceKey } of BUCKET_PRICE_KEYS) {
    raw += toFiniteNumber(buckets?.[tokens]) * toFiniteNumber(price?.[priceKey])
  }
  return raw / TOKENS_PER_MILLION
}

// ===== 费用展示辅助(展示层专用,非镜像) =====
const COST_DECIMALS = 2
const COST_MICRO_DECIMALS = 4
const COST_MICRO_THRESHOLD = 0.01
const COST_PLACEHOLDER = '—'
const THOUSANDS_PATTERN = /(\d)(?=(\d{3})+(?!\d))/g

// 千分位 + 至少两位小数,正值小于 0.01 时四位;货币空串不加符号,「≈」前缀由调用方拼
function formatCost(value, currency) {
  const decimals = value > 0 && value < COST_MICRO_THRESHOLD ? COST_MICRO_DECIMALS : COST_DECIMALS
  const [whole, fraction] = value.toFixed(decimals).split('.')
  return `${currency}${whole.replace(THOUSANDS_PATTERN, '$1,')}.${fraction}`
}

// 全局显示货币:规则表首个非空 currency,所有费用显示点统一取此值(全局价格定位);
// 无则空串即不带符号。数值仍按命中规则单价计算,符号不随命中规则变化
function aggregateCurrencyOf(rules) {
  if (!Array.isArray(rules)) return ''
  const found = rules.find((rule) => typeof rule?.currency === 'string' && rule.currency !== '')
  return found ? found.currency : ''
}

// 投影四桶 → 计价桶形:投影的 uncachedInputTokens 即计价 inputTokens(host 存储行同口径)
const pricingBucketsOf = (usage) => ({
  inputTokens: usage.uncachedInputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
})

// routes 缺席占位:双段通配模型键,仅被 '*/*' 全通配规则命中(供应商与模型全未知)
const MODEL_UNROUTED = '*/*'

// 注入点A 费用组装配:开关关/无用量/价格未加载不渲染;规则已载无命中价显示占位符;
// routes 缺席时 model 取全通配键;时间条件按当前时刻评估(估算口径)
function buildCostItem(usage, rules, prefs, t, now = new Date()) {
  if (!prefs?.costDisplay || !usage || !Array.isArray(rules)) return null
  const model = usage.routes?.[0]?.model ?? MODEL_UNROUTED
  const price = matchPrice(rules, model, now)
  if (!price) return COST_PLACEHOLDER
  return t('stats.cost', { cost: formatCost(costOf(price, pricingBucketsOf(usage)), aggregateCurrencyOf(rules)) })
}

// 历史费用口径标注:估算说明,未计价小时桶计数为正时追加后缀
function costTitleText(t, unpriced) {
  const base = t('costTitle')
  return unpriced > 0 ? `${base},${t('costUnpriced', { n: unpriced })}` : base
}

// ===== 注入点B:回合费用芯片(官方动作行 assistant-actions 槽条目,赞踩/上下文跳转同排) =====
// 排序取上下文插件条目(20)之后,贴近尾部用量/用时芯片一侧
const TURN_COST_CHIP_ORDER = 20 + 10

// messageId 反查:节点表为 chat 节点仓库(values() 可枚举,Map/仓库两态兼容);
// 回合级用量优先取回合位置数据(location.turn.data.get('turn-tail')).tokenUsage(官方 tokenUsage 聚合,
// 分页窗口缺 turn/start 时缺席),回退视图节点 data.closing.usage(末步用量采样,输入侧已含缓存,计费口径同源)
function turnTokenUsageOfMessage(nodes, messageId) {
  const list = nodes && typeof nodes.values === 'function' ? [...nodes.values()] : nodes
  if (!Array.isArray(list)) return null
  for (const node of list) {
    try {
      if (node?.kind !== 'turn-tail') continue
      if (node.data?.closing?.finalNode?.messageId !== messageId) continue
      const turnData = node.location?.turn?.data
      const tail = turnData && typeof turnData.get === 'function' ? turnData.get('turn-tail') : null
      if (tail?.tokenUsage) return tail.tokenUsage
      if (node.data.tokenUsage) return node.data.tokenUsage
      const sampled = node.data?.closing?.usage
      if (!sampled) return null
      return {
        uncachedInputTokens: sampled.inputTokens,
        outputTokens: sampled.outputTokens,
        totalTokens: sampled.totalTokens,
        ...sampled.cacheReadTokens === undefined ? {} : { cacheReadTokens: sampled.cacheReadTokens },
        ...sampled.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: sampled.cacheWriteTokens },
        ...sampled.reasoningTokens === undefined ? {} : { reasoningTokens: sampled.reasoningTokens },
      }
    } catch { /* 单节点形状残缺跳过,扫描继续 */ }
  }
  return null
}

// 计价模型键:routes 首条按官方 messageRoute 分离字段拼两段键,与采集器 refOf 双实现同源
// (官方 source.provider/model 是分离字段,routes[].model 是裸模型名,展示侧才拼 provider),
// 仅 model 用裸名命中 */model 档,双缺回退全通配键;多 route 取首条(单轮估算口径)
const turnModelOf = (tokenUsage) => {
  const route = tokenUsage?.routes?.[0]
  if (!route) return MODEL_UNROUTED
  if (route.provider && route.model) return `${route.provider}/${route.model}`
  return route.model || MODEL_UNROUTED
}

// 可选桶(cacheRead/cacheWrite)仅部分 provider 上报,缺失按 0 计入摘要与费用
const turnReportedBucket = (value) => (value ?? 0)

// 摘要计费输入 = prompt 侧三桶(官方 billing 分母口径),核心桶缺省同按 0 保证降级形态对称
function turnBilledInputTokens(tokenUsage) {
  return turnReportedBucket(tokenUsage.uncachedInputTokens)
    + turnReportedBucket(tokenUsage.cacheReadTokens)
    + turnReportedBucket(tokenUsage.cacheWriteTokens)
}

// 可选桶未上报判定:与取不到价的「—」是两种降级,仅在 title 标注
function turnOptionalUnreported(tokenUsage) {
  return tokenUsage?.cacheReadTokens === undefined || tokenUsage?.cacheWriteTokens === undefined
}

// 芯片计费额:价命中才算,0 元(全零价或全零桶)返回 null 由调用方决定不渲染;价未命中同 null
function turnCostAmountOf(tokenUsage, price) {
  if (!price) return null
  const cost = costOf(price, pricingBucketsOf(tokenUsage))
  return cost > 0 ? cost : null
}

// 芯片文本:仅金额,不带货币前缀文字(官方用量芯片弹窗已有 token 明细)
function buildTurnCostChipText(t, tokenUsage, price, currency) {
  const cost = turnCostAmountOf(tokenUsage, price)
  return t('turnCostChip', { cost: cost === null ? COST_PLACEHOLDER : formatCost(cost, currency) })
}

// 芯片 title:token 摘要 + 估算口径,可选桶未上报时追加标注
function turnCostTitleText(t, tokenUsage) {
  const notes = [
    t('stats.tokens', {
      input: formatTokensCompact(turnBilledInputTokens(tokenUsage), t),
      output: formatTokensCompact(turnReportedBucket(tokenUsage.outputTokens), t),
    }),
    t('turnCostTitle'),
  ]
  if (turnOptionalUnreported(tokenUsage)) notes.push(t('turnTokensUnreported'))
  return notes.join(',')
}

// ===== 定价编辑器纯函数(校验/规整/默认值) =====
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite']
const HHMM_PATTERN = /^\d{1,2}:\d{2}$/
const ISO_DAY_PATTERN_CLIENT = /^\d{4}-\d{2}-\d{2}$/
// 时刻分量界:小时/分钟均双闭
const HOUR_MAX = 23
const MINUTE_MAX = 59
const WEEKDAY_MIN = 0
const WEEKDAY_MAX = 6
const MONTH_DAY_MIN = 1
const MONTH_DAY_MAX = 31
const FULL_DAY_WINDOW = { from: '00:00', to: '23:59' }
const CONDITION_KIND_OPTIONS = ['dailyWindow', 'weekdays', 'monthDays', 'dateRange']
const CONDITION_KIND_LABEL_KEYS = {
  dailyWindow: 'condDailyWindow',
  weekdays: 'condWeekdays',
  monthDays: 'condMonthDays',
  dateRange: 'condDateRange',
}
const WEEKDAY_COUNT = 7

const parseHHMM = (value) => {
  if (typeof value !== 'string' || !HHMM_PATTERN.test(value)) return null
  const [hours, minutes] = value.split(':').map(Number)
  return hours >= 0 && hours <= HOUR_MAX && minutes >= 0 && minutes <= MINUTE_MAX ? value : null
}

const isValidMonthDay = (value) => Number.isInteger(value) && value >= MONTH_DAY_MIN && value <= MONTH_DAY_MAX

const isValidWeekday = (value) => Number.isInteger(value) && value >= WEEKDAY_MIN && value <= WEEKDAY_MAX

// 各条件类型合法默认即填即用:时段全天、周几空、号段全月、日期段当天单日
const defaultCondition = (kind, now = new Date()) => {
  const today = formatDate(now)
  const defaults = {
    dailyWindow: { kind: 'dailyWindow', ...FULL_DAY_WINDOW },
    weekdays: { kind: 'weekdays', days: [] },
    monthDays: { kind: 'monthDays', from: MONTH_DAY_MIN, to: MONTH_DAY_MAX },
    dateRange: { kind: 'dateRange', from: today, to: today },
  }
  return defaults[kind] ? { ...defaults[kind] } : null
}

// 条件字段级校验:路径前缀 + 键 → 错误键;时段/号段倒序为跨午夜/跨月语义;
// 所有范围双侧包含,from===to 单点/单日合法;仅日期段倒序属配置错误(condRange)
const validateCondition = (condition, path, errors) => {
  if (!condition || typeof condition !== 'object') {
    errors.set(path, 'required')
    return
  }
  if (condition.kind === 'dailyWindow') {
    const from = parseHHMM(condition.from)
    const to = parseHHMM(condition.to)
    if (from === null) errors.set(`${path}.from`, condition.from === '' || condition.from == null ? 'required' : 'condTime')
    if (to === null) errors.set(`${path}.to`, condition.to === '' || condition.to == null ? 'required' : 'condTime')
    return
  }
  if (condition.kind === 'weekdays') {
    if (!Array.isArray(condition.days) || !condition.days.every(isValidWeekday)) errors.set(`${path}.days`, 'condWeekday')
    return
  }
  if (condition.kind === 'monthDays') {
    if (!isValidMonthDay(condition.from)) errors.set(`${path}.from`, 'condMonthDay')
    if (!isValidMonthDay(condition.to)) errors.set(`${path}.to`, 'condMonthDay')
    return
  }
  if (condition.kind === 'dateRange') {
    if (typeof condition.from !== 'string' || !ISO_DAY_PATTERN_CLIENT.test(condition.from)) errors.set(`${path}.from`, condition.from === '' || condition.from == null ? 'required' : 'condDate')
    if (typeof condition.to !== 'string' || !ISO_DAY_PATTERN_CLIENT.test(condition.to)) errors.set(`${path}.to`, condition.to === '' || condition.to == null ? 'required' : 'condDate')
    if (errors.has(`${path}.from`) || errors.has(`${path}.to`)) return
    if (condition.from > condition.to) errors.set(path, 'condRange')
  }
}

// POST 前条件规整:输入框字符串值转数字字段;时段/日期段为字符串原样
function coerceConditions(conditions) {
  return conditions.map((condition) => {
    if (condition.kind === 'weekdays') return { ...condition, days: condition.days.map(Number) }
    if (condition.kind === 'monthDays') return { ...condition, from: Number(condition.from), to: Number(condition.to) }
    return condition
  })
}

// 就地校验:字段路径 → 文案键;仅覆盖编辑器可编辑字段(模型/四桶价格/时间条件);模型须两段式
function validatePricingRules(rules) {
  const errors = new Map()
  if (!Array.isArray(rules)) return errors
  rules.forEach((rule, ruleIndex) => {
    if (typeof rule.model !== 'string' || rule.model.trim().length === 0) errors.set(`${ruleIndex}.model`, 'required')
    else if (!isTwoSegmentModel(rule.model)) errors.set(`${ruleIndex}.model`, 'modelFormat')
    PRICE_KEYS.forEach((key) => {
      const value = rule.price?.[key]
      const path = `${ruleIndex}.price.${key}`
      if (value === '' || value === null || value === undefined) errors.set(path, 'required')
      else if (!Number.isFinite(Number(value)) || Number(value) < 0) errors.set(path, 'priceInvalid')
    })
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : []
    conditions.forEach((condition, conditionIndex) => {
      validateCondition(condition, `${ruleIndex}.conditions.${conditionIndex}`, errors)
    })
  })
  return errors
}

// POST 前规整:输入框字符串值转数值;模型已校验确保两段式且无空白,原样提交
function coercePricingRules(rules) {
  return rules.map((rule) => ({
    ...rule,
    price: PRICE_KEYS.reduce((price, key) => ({ ...price, [key]: Number(rule.price[key]) }), {}),
    conditions: coerceConditions(rule.conditions ?? []),
  }))
}

// 服务端规则为纯 JSON,编辑副本深拷贝与缓存脱钩
const copyRules = (rules) => JSON.parse(JSON.stringify(rules))

// 货币为编辑器级全局设置:整表统一,规则内 currency 由切换值派生(wire 形态不变)
const applyCurrencyToRules = (rules, currency) => rules.map((rule) => ({ ...rule, currency }))

// 新增规则默认:空模型 + 承接全局货币 + 四桶零价 + 无条件(恒生效);已有条件整条保留原样
const defaultPricingRule = (currency = CURRENCIES[0]) => ({
  model: '',
  currency,
  price: PRICE_KEYS.reduce((price, key) => ({ ...price, [key]: 0 }), {}),
  conditions: [],
})

const patchItemAt = (array, index, patch) => array.map((item, i) => (i === index ? { ...item, ...patch } : item))

// 编辑器分组视图纯函数:wire 契约(平面数组)不变,组/槽位仅是展示层投影。
// 槽位移动/增删均落回平面数组的对应位置变换,组内相对顺序即匹配优先序。

// 按模型键聚合:组序为首次出现序,槽位保序并携带平面索引(错误路径与移动操作的寻址键)
function groupRulesOf(rules) {
  const groups = new Map()
  ;(rules ?? []).forEach((rule, index) => {
    const key = rule.model
    if (!groups.has(key)) groups.set(key, { model: key, slots: [] })
    groups.get(key).slots.push({ rule, index })
  })
  return [...groups.values()]
}

// 组内划分:末条无条件规则即该模型的默认价(恒兜底,UI 禁条件/排序/删除),其余为附加计费规则。
// 全条件组默认价为 null(UI 提供"添加默认价"入口);多条无条件时末条为默认价,存量数据自然收敛
function partitionGroupOf(group) {
  const last = group.slots[group.slots.length - 1]
  const isDefault = last !== undefined && (last.rule.conditions ?? []).length === 0
  return {
    defaultSlot: isDefault ? last : null,
    extras: isDefault ? group.slots.slice(0, -1) : group.slots,
  }
}

// 槽位跨位移动(splice 语义):同位或越界返回原引用
function moveRuleTo(rules, fromIndex, toIndex) {
  if (!Array.isArray(rules) || fromIndex === toIndex) return rules
  if (fromIndex < 0 || fromIndex >= rules.length || toIndex < 0 || toIndex >= rules.length) return rules
  const moved = [...rules]
  const [item] = moved.splice(fromIndex, 1)
  moved.splice(toIndex, 0, item)
  return moved
}

// 组级改名:仅命中索引集的规则变更 model,其余保持引用不变
function renameRulesAt(rules, indexes, model) {
  const hit = new Set(indexes)
  return rules.map((rule, i) => (hit.has(i) ? { ...rule, model } : rule))
}

// 插入到目标平面位之后(组内添加槽位 = 组内末槽位索引 + 1)
function insertRuleAt(rules, position, rule) {
  return [...rules.slice(0, position + 1), rule, ...rules.slice(position + 1)]
}

// 批量移除(组删除)
function removeRulesAt(rules, indexes) {
  const hit = new Set(indexes)
  return rules.filter((_, i) => !hit.has(i))
}


if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: '@mzzsfy/dsh-usage-dash', factory })

  function factory(require) {
    let React = null
    try {
      React = require('react')
    } catch {
      return { inject: [], apply() {} }
    }
    const { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = React

    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    const h = (type, props, ...children) => React.createElement(type, props ?? null, ...children)
    const cx = (...values) => values.filter(Boolean).join(' ')

    // locale 服务缺席时的回退翻译器(zh 固定);槽组件以 props.t 缺省参数承接宿主响应式 t
    const defaultT = createTranslator(MESSAGES_ZH)

    // stats-line 偏好单例:模块表内同实例,面板偏好卡与底部信息栏订阅互通
    const statsLineState = createStatsLineState(typeof localStorage !== 'undefined' ? localStorage : null)

    // 价格规则内存缓存单例:TTL 内直读,失败回退旧值待下次重试;禁 localStorage 持久化价格
    const PRICING_CACHE_TTL_MS = 5 * 60 * 1000
    const PRICING_SAVED_NOTICE_MS = 3 * 1000
    let cached = null
    const applyPricingValue = (value) => {
      cached = { revision: value.revision, rules: value.rules, fetchedAt: Date.now() }
      return cached
    }

    const requestGet = async (endpoint) => {
      let response
      try {
        response = await fetch(API_PREFIX + endpoint)
      } catch (error) {
        return { ok: false, code: 'network', message: String(error?.message ?? error) }
      }
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return parseEnvelope(json)
    }

    // value 缺形状按失败处理:回退旧值,无旧值为 null(费用显示占位)
    const fetchPricing = async (force = false) => {
      if (!force && cached && Date.now() - cached.fetchedAt < PRICING_CACHE_TTL_MS) return cached
      const result = await requestGet(ENDPOINTS.pricing)
      const value = result.ok ? result.value : null
      if (value && Number.isFinite(value.revision) && Array.isArray(value.rules)) return applyPricingValue(value)
      return cached
    }

    // 交互与尺寸常量
    const STATUS_POLL_FAST_MS = 1000
    const STATUS_POLL_SLOW_MS = 5000
    const REBUILD_CONFIRM_MS = 3000
    // Material Symbols 风格刷新图标路径,currentColor 继承按钮色
    const REFRESH_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>'
    const STATUS_REFRESH_DEBOUNCE_MS = 800
    const FIT_MAX_SIZE = 22
    const FIT_MIN_SIZE = 11
    const FIT_NAME_MAX_SIZE = 20
    const FIT_STEP_SIZE = 0.5
    const FIT_OVERFLOW_TOLERANCE = 1
    const CHART_NOMINAL_WIDTH = 720
    const CHART_WIDTH_EPSILON = 1
    const CHART_BUSY_OPACITY = 0.5
    const LABEL_PITCH_DAY = 46
    const LABEL_PITCH_TIME = 60
    const AXIS_LABEL_GAP = 6
    const AXIS_LABEL_BASELINE = 3
    const X_LABEL_OFFSET = 8
    const PROGRESS_FULL_PERCENT = 100
    const ICON_SIZE = 14
    const ICON_STROKE_WIDTH = 2
    const NOTE_SEPARATOR = ' · '
    const TIP_Z_INDEX = 1100
    const STYLE_ID = 'dsh-usage-dash'
    // 开关视觉常量(规约形态:隐藏 checkbox + track 胶囊 + thumb 圆点)
    const SWITCH_TRACK_WIDTH = 40
    const SWITCH_TRACK_HEIGHT = 22
    const SWITCH_THUMB_SIZE = 18
    const SWITCH_EDGE_INSET = 2
    const SWITCH_THUMB_TRAVEL = SWITCH_TRACK_WIDTH - SWITCH_THUMB_SIZE - SWITCH_EDGE_INSET * 2
    const SWITCH_TRANSITION_MS = 120
    // 遮蔽语义:同 id 同 priority 属注册冲突(注册表抛错),需取更低值压过
    // 同格竞争者;usp 同款接管注册用 -1,本插件取次低值,官方无显式 priority(默认 0)
    const STATS_SLOT_PRIORITY = -2
    const STATS_LINE_TITLE_SEPARATOR = ' | '
    const VIEW_TABS = [
      { id: 'day', labelKey: 'viewDay' },
      { id: 'hour', labelKey: 'viewHour' },
      { id: 'minute', labelKey: 'viewMinute' },
    ]

    const requestPost = async (endpoint, body) => {
      let response
      try {
        response = await fetch(API_PREFIX + endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? '{}' : JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, code: 'network', message: String(error?.message ?? error) }
      }
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return parseEnvelope(json)
    }

    // lucide 同风格简笔图标(纯装饰)
    const ICONS = {
      coins: ['M15.5 9.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z', 'M20.5 13.5a5.5 5.5 0 1 1-7 7'],
      sessions: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z'],
      requests: ['M14 9a2 2 0 0 1-2 2H6l-3 3V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2Z', 'M17 7h2a2 2 0 0 1 2 2v10l-3-3h-5'],
      model: ['M5 5h14v14H5Z', 'M9 9h6v6H9Z', 'M9 2v3', 'M15 2v3', 'M9 19v3', 'M15 19v3', 'M2 9h3', 'M2 15h3', 'M19 9h3', 'M19 15h3'],
      rate: ['M22 12h-4l-3 9L9 3l-3 9H2'],
      days: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'M16 3v4', 'M8 3v4', 'M3 11h18'],
      trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
    }

    function Icon({ paths }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: ICON_SIZE, height: ICON_SIZE, fill: 'none',
        stroke: 'currentColor', strokeWidth: ICON_STROKE_WIDTH,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    // 危险删除按钮:首点进武装态(垃圾桶变"确认删除"文字),再点才执行,超时自动解除
    function DeleteArmedButton({ labelKey, confirmKey, onConfirm, t = defaultT }) {
      const [armed, setArmed] = useState(false)
      const armedTimerRef = useRef(null)
      useEffect(() => () => {
        if (armedTimerRef.current) clearTimeout(armedTimerRef.current)
      }, [])
      const click = () => {
        if (!armed) {
          setArmed(true)
          armedTimerRef.current = setTimeout(() => setArmed(false), REBUILD_CONFIRM_MS)
          return
        }
        if (armedTimerRef.current) clearTimeout(armedTimerRef.current)
        setArmed(false)
        onConfirm()
      }
      return h('button', {
        className: cx('ud-btn ud-btn--text', armed && 'ud-delete-armed'), type: 'button', onClick: click,
        'aria-label': t(labelKey), title: t(labelKey),
      }, armed ? t(confirmKey) : h(Icon, { paths: ICONS.trash }))
    }

    const STYLE_CSS = `
.ud-panel{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary);
--ud-chart-1:color-mix(in srgb,#0576ff 70%,white);--ud-chart-2:color-mix(in srgb,#2f6f37 70%,white);--ud-chart-3:color-mix(in srgb,#c46212 70%,white);--ud-chart-4:color-mix(in srgb,#975bf1 70%,white);--ud-chart-5:color-mix(in srgb,#d34591 70%,white);--ud-chart-other:color-mix(in srgb,#576270 70%,white);
--dsw-heat-0:#ebedf0;--dsw-heat-1:#dbe3ff;--dsw-heat-2:#b7c5ff;--dsw-heat-3:#8ea4ff;--dsw-heat-4:#6884ff;--dsw-heat-5:#4d6bfe;--ud-trend-line:#0576ff;--ud-trend-speed:#0ca678;--ud-trend-ttft:#e8590c}
body[data-ds-dark-theme] .ud-panel{--ud-chart-1:color-mix(in srgb,#0576ff 65%,white);--ud-chart-2:color-mix(in srgb,#2f6f37 65%,white);--ud-chart-3:color-mix(in srgb,#c46212 65%,white);--ud-chart-4:color-mix(in srgb,#975bf1 65%,white);--ud-chart-5:color-mix(in srgb,#d34591 65%,white);--ud-chart-other:color-mix(in srgb,#576270 65%,white);
--dsw-heat-0:#21262d;--dsw-heat-1:#2f4bd0;--dsw-heat-2:#4d6bfe;--dsw-heat-3:#6e8bff;--dsw-heat-4:#93aaff;--dsw-heat-5:#c4d0ff;--ud-trend-line:#4d6bfe;--ud-trend-speed:#2fbf8f;--ud-trend-ttft:#ffa94d}
.ud-toolbar{display:flex;align-items:flex-start;gap:8px}
.ud-toolbar-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 auto;min-width:0}
.ud-group{display:flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.ud-seg-item{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;padding:5px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.ud-seg-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ud-seg-item--on{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.ud-custom-range{display:flex;align-items:center;gap:6px}
.ud-date-input{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:4px 6px}
.ud-custom-sep{color:var(--dsw-alias-label-tertiary)}
.ud-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:5px 14px;font-size:12px;line-height:1;cursor:pointer}
.ud-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ud-btn:disabled{opacity:.5;cursor:default}
.ud-toolbar-side{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto;align-self:stretch}
.ud-toolbar-side .ud-btn--text{display:inline-flex;align-items:center;height:100%}
.ud-icon-btn{padding:0 12px}
.ud-icon{display:inline-flex;align-items:center;justify-content:center}
.ud-btn--text{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);padding:2px 4px}
.ud-delete-armed{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:nowrap}
.ud-error{border:1px solid var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-label);border-radius:8px;padding:8px 12px;font-size:12px}
.ud-loading{color:var(--dsw-alias-label-tertiary);text-align:center;padding:32px 0}
.ud-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:24px 16px;font-size:12px}
.ud-foot{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ud-status{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ud-status-fold{display:inline-flex;align-items:center;justify-content:center;width:28px;height:100%;min-height:28px;border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:6px}
.ud-status-fold:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.ud-status-fold-caret{display:block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;transition:transform .15s ease}
.ud-status-fold[aria-expanded="true"] .ud-status-fold-caret{transform:rotate(180deg)}
.ud-status-track{display:inline-block;width:120px;height:2px;border-radius:1px;background:var(--dsw-alias-border-l1);overflow:hidden}
.ud-status-fill{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}
.ud-status-err{color:var(--dsw-alias-state-error-primary)}
.ud-detail{width:100%;margin-top:4px;display:flex;flex-direction:column;gap:6px}
.ud-detail-foot{display:flex;justify-content:flex-end;align-items:center}
.ud-log{width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;display:flex;flex-direction:column;gap:3px;max-height:200px;overflow-y:auto;font-size:11px;line-height:1.5}
.ud-log-summary{display:flex;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;padding-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ud-log-line{display:flex;gap:8px;align-items:baseline;min-width:0}
.ud-log-time{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);opacity:.7}
.ud-log-kind{flex:none}
.ud-log-err{color:var(--dsw-alias-state-error-primary)}
.ud-log-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ud-cards{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:10px}
@media (max-width:560px){.ud-cards{grid-template-columns:1fr 1fr}}
@media (max-width:380px){.ud-cards{grid-template-columns:1fr}}
.ud-card{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}
.ud-card-head{display:flex;align-items:center;gap:6px}
.ud-card-cost{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ud-card-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.ud-card-label{font-size:13px;color:var(--dsw-alias-label-secondary)}
.ud-card-value{font-size:${FIT_MAX_SIZE}px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.ud-card-lines{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-card-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.ud-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ud-section-title{font-size:15px;font-weight:600}
.ud-trend-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ud-chart-wrap{width:100%;min-width:0}
.ud-chart{display:block;width:100%}
.ud-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1}
.ud-axis{fill:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ud-legend{display:flex;flex-wrap:wrap;gap:4px 12px}
.ud-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;user-select:none;cursor:pointer}
.ud-legend-item--off{opacity:.35}
.ud-legend-item span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-legend-swatch{width:8px;height:8px;border-radius:2px;flex:none}
.ud-heat-wrap{width:100%;min-width:0;overflow:hidden}
.ud-heat{display:block}
.ud-heat-cell{stroke:none}
.ud-heat-l0{fill:var(--dsw-heat-0);background:var(--dsw-heat-0)}
.ud-heat-l1{fill:var(--dsw-heat-1);background:var(--dsw-heat-1)}
.ud-heat-l2{fill:var(--dsw-heat-2);background:var(--dsw-heat-2)}
.ud-heat-l3{fill:var(--dsw-heat-3);background:var(--dsw-heat-3)}
.ud-heat-l4{fill:var(--dsw-heat-4);background:var(--dsw-heat-4)}
.ud-heat-l5{fill:var(--dsw-heat-5);background:var(--dsw-heat-5)}
.ud-heat-legend{display:inline-flex;align-items:center;gap:${HEAT_GAP}px;margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ud-heat-legend i{display:inline-block;width:${HEAT_BASE}px;height:${HEAT_BASE}px;border-radius:${HEAT_RX}px;flex:none}
.ud-tip{position:fixed;z-index:${TIP_Z_INDEX};visibility:hidden;pointer-events:none;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 4px 12px var(--dsw-alias-bg-mask-2);color:var(--dsw-alias-label-primary);font-size:13px;padding:8px 10px}
.ud-tip-title{font-weight:600}
.ud-tip-row{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ud-tip-row--sub{padding-left:12px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ud-tip-breakdown{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:6px;padding-top:6px}
.ud-axis-rate{fill:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ud-bar{transform-box:fill-box;transform-origin:center}
.ud-bar-hit{fill:transparent;pointer-events:all}
.ud-trend{stroke:var(--ud-trend-line);opacity:.9;fill:none;pointer-events:none}
.ud-trend--speed{stroke:var(--ud-trend-speed)}
.ud-trend--ttft{stroke:var(--ud-trend-ttft)}
.ud-trend-dot{fill:var(--ud-trend-line);stroke:var(--dsw-alias-bg-layer-1);stroke-width:${TREND_DOT_RING}px;pointer-events:none}
.ud-trend-dot--speed{fill:var(--ud-trend-speed)}
.ud-trend-dot--ttft{fill:var(--ud-trend-ttft)}
.ud-legend-swatch--line{height:2px;border-radius:1px;background:var(--ud-trend-line)}
.ud-legend-swatch--line--speed{background:var(--ud-trend-speed)}
.ud-legend-swatch--line--ttft{background:var(--ud-trend-ttft)}
.ud-model-usage{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px}
.ud-donut-wrap{flex:0 0 auto}
.ud-donut-seg{cursor:pointer;outline:none;transition:stroke-width .12s ease}
.ud-donut-seg--dim{opacity:${DONUT_DIM_OPACITY}}
.ud-donut-center{font-size:18px;font-weight:600;fill:var(--dsw-alias-label-primary)}
.ud-donut-label{font-size:11px;fill:var(--dsw-alias-label-tertiary)}
.ud-models{flex:1 1 260px;min-width:240px;display:flex;flex-direction:column}
.ud-model-row{display:flex;align-items:center;gap:8px;min-height:44px;padding:2px 4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ud-model-row--expand{cursor:pointer}
.ud-model-row--expand:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ud-model-swatch{width:10px;height:10px;border-radius:2px;flex:none}
.ud-model-id{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.ud-model-name{font-size:13px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-model-provider{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ud-model-values{display:flex;flex-direction:column;align-items:flex-end;gap:1px;font-variant-numeric:tabular-nums;flex:none}
.ud-model-tokens{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ud-model-pct{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ud-model-cost{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ud-model-toggle{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:2px 6px;font-size:14px;line-height:1;transition:transform .2s ease}
.ud-model-toggle[aria-expanded="true"]{transform:rotate(90deg)}
.ud-model-toggle:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);border-radius:4px}
.ud-model-other{display:grid;grid-template-rows:0fr;transition:grid-template-rows .25s ease}
.ud-model-other--open{grid-template-rows:1fr}
.ud-model-other-list{overflow:hidden;min-height:0}
.ud-model-row--sub{min-height:0;padding:4px 4px 4px 28px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);border-bottom:none}
.ud-switch{display:inline-flex;align-items:center;cursor:pointer}
.ud-switch input[type="checkbox"] { position:absolute; opacity:0; width:1px; height:1px; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); }
.ud-switch__track{position:relative;width:${SWITCH_TRACK_WIDTH}px;height:${SWITCH_TRACK_HEIGHT}px;border-radius:999px;box-sizing:border-box;flex:none;background:var(--dsw-alias-border-l2);transition:background ${SWITCH_TRANSITION_MS}ms var(--ds-ease-in-out)}
.ud-switch__thumb{position:absolute;top:${SWITCH_EDGE_INSET}px;left:${SWITCH_EDGE_INSET}px;width:${SWITCH_THUMB_SIZE}px;height:${SWITCH_THUMB_SIZE}px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform ${SWITCH_TRANSITION_MS}ms var(--ds-ease-in-out)}
.ud-switch:not(:has(input[type="checkbox"]:disabled)):hover .ud-switch__track{background:color-mix(in srgb,var(--dsw-alias-border-l2) 85%,var(--dsw-alias-label-tertiary))}
.ud-switch input[type="checkbox"]:checked + .ud-switch__track{background:var(--dsw-alias-state-business-primary)}
.ud-switch input[type="checkbox"]:checked + .ud-switch__track .ud-switch__thumb{transform:translateX(${SWITCH_THUMB_TRAVEL}px)}
.ud-switch input[type="checkbox"]:focus-visible + .ud-switch__track{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.ud-switch input[type="checkbox"]:disabled + .ud-switch__track{opacity:.45;cursor:default}
.ud-pref-group{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px 16px}
.ud-pref-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.ud-pref-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-pref-title{font-size:13px;color:var(--dsw-alias-label-primary)}
.ud-pref-desc{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ud-rule{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px}
.ud-rule-group{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px}
.ud-rule-group-head{display:flex;align-items:flex-end;gap:8px}
.ud-rule-group-head .ud-field{flex:1}
.ud-rule-group-slots{display:flex;flex-direction:column;gap:8px}
.ud-rule-group-slots .ud-rule{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 40%,transparent)}
.ud-rule-default{border-style:dashed}
.ud-slot-head{display:flex;align-items:flex-end;gap:8px}
.ud-slot-head .ud-price-grid{flex:1}
.ud-rule-head{display:flex;align-items:flex-end;gap:8px}
.ud-rule-head .ud-field{flex:1}
.ud-rule-cond{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ud-rule-conds{display:flex;flex-direction:column;gap:6px}
.ud-cond{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
/* specificity 须高于 .ud-input 的 width:100%,否则类型下拉撑满整行把字段区挤到下一行 */
.ud-cond .ud-cond-kind{width:auto;min-width:88px;flex:0 0 auto}
.ud-cond-fields{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0}
.ud-cond-fields .ud-field{flex-direction:row;align-items:center;gap:4px;flex:0 1 auto}
.ud-cond-fields .ud-input{width:auto}
.ud-cond-add{display:flex;gap:6px;flex-wrap:wrap}
.ud-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.ud-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ud-field-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}
.ud-input{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:4px 6px;min-width:0;width:100%;box-sizing:border-box}
.ud-price-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.ud-price-grid .ud-input{text-align:right}
.ud-price-input{position:relative;display:block}
.ud-price-input .ud-input{padding-left:20px}
.ud-price-currency{position:absolute;left:7px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.ud-unit-note{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ud-pricing-actions{display:flex;align-items:center;gap:8px}
.ud-rule-add{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;cursor:pointer}
.ud-rule-add:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ud-statsline-root{text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;width:100%;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0 auto;display:block;overflow:hidden}
.ud-statsline-sep{color:var(--dsw-alias-separator-primary);margin:0 10px}
/* 芯片 portal 至动作行末尾,历史轮悬停/焦点显隐随父级 data-actions-reveal,无需自绘规则 */
.ud-turn-cost{font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:${TURN_COST_GAP_PX}px}
`

    function ensureStyle(document) {
      if (document.querySelector(`style[data-plugin="${STYLE_ID}"]`)) return
      const element = document.createElement('style')
      element.setAttribute('data-plugin', STYLE_ID)
      element.textContent = STYLE_CSS
      document.head.appendChild(element)
    }

    const fitFontSize = (element, maxSize = FIT_MAX_SIZE, minSize = FIT_MIN_SIZE) => {
      let size = maxSize
      element.style.fontSize = `${size}px`
      while (element.scrollWidth > element.clientWidth + FIT_OVERFLOW_TOLERANCE && size > minSize) {
        size -= FIT_STEP_SIZE
        element.style.fontSize = `${size}px`
      }
    }

    function FitText({ children, className = 'ud-card-value', maxSize = FIT_MAX_SIZE, minSize = FIT_MIN_SIZE }) {
      const ref = useRef(null)
      useLayoutEffect(() => {
        fitFontSize(ref.current, maxSize, minSize)
      }, [children, maxSize, minSize])
      useEffect(() => {
        const element = ref.current
        let lastWidth = element.clientWidth
        const observer = new ResizeObserver(() => {
          const width = element.clientWidth
          if (width === lastWidth) return
          lastWidth = width
          fitFontSize(element, maxSize, minSize)
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [maxSize, minSize])
      return h('div', { className, ref }, children)
    }

    function Card({ icon, label, hint, head, children }) {
      const lines = Array.isArray(children) ? children : [children]
      return h('div', { className: 'ud-card', title: hint },
        h('div', { className: 'ud-card-head' },
          h('span', { className: 'ud-card-icon' }, h(Icon, { paths: icon })),
          h('span', { className: 'ud-card-label' }, label),
          head ?? null),
        ...lines)
    }

    function StatCards({ stats, costCurrency = '', t = defaultT }) {
      return h('div', { className: 'ud-cards' },
        h(Card, { key: 'tokens', icon: ICONS.coins, label: t('tokens'), hint: t('tokensHint'),
          head: stats.cost !== undefined
            ? h('span', {
                className: 'ud-card-cost',
                title: costTitleText(t, stats.unpriced ?? 0),
              }, `≈ ${formatCost(stats.cost, costCurrency)}`)
            : null },
          h(FitText, null, formatTokens(stats.tokens))),
        h(Card, { key: 'turns', icon: ICONS.sessions, label: t('sessions') },
          h(FitText, null, String(stats.turns))),
        h(Card, { key: 'requests', icon: ICONS.requests, label: t('requests') },
          h(FitText, null, String(stats.requests))),
        h(Card, { key: 'model', icon: ICONS.model, label: t('topModel'), hint: t('topModelHint') },
          stats.topModel
            ? h(FitText, { className: 'ud-card-name', maxSize: FIT_NAME_MAX_SIZE },
                `${providerOf(stats.topModel)} / ${modelNameOf(stats.topModel)}`)
            : h('div', { className: 'ud-card-value' }, '—')),
        h(Card, { key: 'cache', icon: ICONS.rate, label: t('cacheRate'), hint: t('cacheRateHint') },
          h(FitText, null, cacheRateText(stats.cacheHit, stats.cacheMiss))),
        h(Card, { key: 'days', icon: ICONS.days, label: t('activeDays') },
          h(FitText, null, String(stats.activeDays))))
    }

    function Legend({ models, colorFor, speedEnabled = false, ttftEnabled = false, isVisible, onItem, t = defaultT }) {
      const itemProps = (key) => ({
        className: cx('ud-legend-item', isVisible && !isVisible(key) && 'ud-legend-item--off'),
        onClick: onItem ? (event) => onItem(key, event.ctrlKey || event.metaKey) : undefined,
        role: onItem ? 'button' : undefined,
      })
      return h('div', { className: 'ud-legend' },
        models.map((item) => h('span', { key: item.model, title: item.model === OTHER_MODEL ? t('other') : item.model, ...itemProps(item.model) },
          h('i', { className: 'ud-legend-swatch', style: { background: colorFor(item.model) } }),
          h('span', null, item.model === OTHER_MODEL ? t('other') : item.model))),
        h('span', { key: 'hit-rate', title: t('hitRateLegend'), ...itemProps(LEGEND_KEY_RATE) },
          h('i', { className: 'ud-legend-swatch ud-legend-swatch--line' }),
          h('span', null, t('hitRateLegend'))),
        speedEnabled ? h('span', { key: 'speed', title: t('speedLegend'), ...itemProps(LEGEND_KEY_SPEED) },
          h('i', { className: 'ud-legend-swatch ud-legend-swatch--line ud-legend-swatch--line--speed' }),
          h('span', null, t('speedLegend'))) : null,
        ttftEnabled ? h('span', { key: 'ttft', title: t('ttftLegend'), ...itemProps(LEGEND_KEY_TTFT) },
          h('i', { className: 'ud-legend-swatch ud-legend-swatch--line ud-legend-swatch--line--ttft' }),
          h('span', null, t('ttftLegend'))) : null)
    }

    const colorForModel = (models) => (model) => {
      if (model === OTHER_MODEL) return 'var(--ud-chart-other)'
      const slot = models.findIndex((item) => item.model === model)
      const rank = Math.min(slot < 0 ? 0 : slot, GROUP_TOP_COUNT - 1) + 1
      return `var(--ud-chart-${rank})`
    }

    function TrendChart({ title, notes, slots, modelOrder, colorFor, labelFor, slotLabelFor, labelMinPitch, busy, legendModels, panelRef, costCurrency = '', costEnabled = false, t = defaultT }) {
      const wrapRef = useRef(null)
      const [avail, setAvail] = useState(CHART_NOMINAL_WIDTH)
      const [hover, setHover] = useState(null)
      // 图例显隐:null = 全部可见;键集 = 模型项与折线项(rate/speed)
      const [visibleKeys, setVisibleKeys] = useState(null)
      // prefs 仅用于 hover tooltip 的费用显隐,经 ref 读取:开关切换不触发本组件重渲染,
      // 避免宿主设置弹窗滚动锚定被重渲染扰动而跳变
      const prefsRef = useRef(statsLineState.get())
      useEffect(() => statsLineState.subscribe(() => { prefsRef.current = statsLineState.get() }), [])
      useEffect(() => {
        const element = wrapRef.current
        const observer = new ResizeObserver((entries) => {
          const width = entries[0].contentRect.width
          setAvail((prev) => (Math.abs(prev - width) < CHART_WIDTH_EPSILON ? prev : width))
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])
      const hasSpeed = slots.some((slot) => slot.speed !== undefined)
      const hasTtft = slots.some((slot) => slot.ttft !== undefined)
      const visibleSet = visibleKeys ?? new Set([
        ...modelOrder, LEGEND_KEY_RATE,
        ...(hasSpeed ? [LEGEND_KEY_SPEED] : []),
        ...(hasTtft ? [LEGEND_KEY_TTFT] : []),
      ])
      const visibleModels = modelOrder.filter((model) => visibleSet.has(model))
      const showRate = visibleSet.has(LEGEND_KEY_RATE)
      const showSpeed = hasSpeed && visibleSet.has(LEGEND_KEY_SPEED)
      const showTtft = hasTtft && visibleSet.has(LEGEND_KEY_TTFT)
      const layout = trendLayout(slots, visibleModels, avail, labelMinPitch)
      const plotRight = CHART_PAD.left + (slots.length - 1) * layout.step + layout.barWidth
      const ratePoints = trendRatePoints(slots, layout.bars, layout.plotHeight)
      const speedMax = speedScaleMax(slots)
      const speedAxisMax = speedMax * AXIS_SCALE_HEADROOM
      const speedPoints = showSpeed ? trendSpeedPoints(slots, layout.bars, layout.plotHeight, speedAxisMax) : []
      const ttftMax = ttftScaleMax(slots)
      const ttftAxisMax = ttftMax * AXIS_SCALE_HEADROOM
      const ttftPoints = showTtft ? trendTtftPoints(slots, layout.bars, layout.plotHeight, ttftAxisMax) : []
      // 左轴标定:可见柱有数据标 token;无柱数据且速度线可见标速度(tok/s);否则空
      // (ttft 不设轴,读数走 tooltip,毫秒域与速度轴不同单位不混轴)
      const speedAxisTicks = layout.ticks.length === 0 && showSpeed ? niceTicks(speedMax, AXIS_TICK_COUNT) : []
      const yTicks = leftAxisTicks(layout.ticks, layout.scaleMax, speedAxisTicks, speedAxisMax)
      const hoverSlot = hover ? slots[hover.index] : null
      const hoverRatePoint = showRate && hoverSlot ? ratePoints.find((point) => point.day === hoverSlot.day) : null
      const hoverSpeedPoint = hoverSlot ? speedPoints.find((point) => point.day === hoverSlot.day) : null
      const hoverTtftPoint = hoverSlot ? ttftPoints.find((point) => point.day === hoverSlot.day) : null
      const pick = (index) => (event) => setHover({ index, anchor: event.currentTarget })
      const clear = () => setHover(null)
      const otherEntries = hoverSlot
        ? Object.entries(hoverSlot.otherByModel ?? {}).sort((a, b) => b[1] - a[1])
        : []
      return h('div', { className: 'ud-section' },
        h('div', { className: 'ud-section-head' },
          h('span', { className: 'ud-section-title' }, title),
          notes.length > 0 ? h('span', { className: 'ud-trend-note' }, notes.join(NOTE_SEPARATOR)) : null),
        h('div', { className: 'ud-chart-wrap', ref: wrapRef, style: busy ? { opacity: CHART_BUSY_OPACITY } : undefined },
          h('svg', {
            className: 'ud-chart', viewBox: `0 0 ${avail} ${CHART_HEIGHT}`, width: '100%', role: 'img',
            'aria-label': title, onMouseLeave: clear,
          },
            yTicks.map((tick) => {
              const y = CHART_PAD.top + layout.plotHeight - tick.ratio * layout.plotHeight
              return h('g', { key: tick.label },
                h('line', { className: 'ud-grid', x1: CHART_PAD.left, x2: plotRight, y1: y, y2: y }),
                h('text', { className: 'ud-axis', x: CHART_PAD.left - AXIS_LABEL_GAP, y: y + AXIS_LABEL_BASELINE, textAnchor: 'end' }, tick.label))
            }),
            speedAxisTicks.length > 0
              ? h('text', { className: 'ud-axis', x: CHART_PAD.left - AXIS_LABEL_GAP, y: CHART_PAD.top + AXIS_LABEL_BASELINE, textAnchor: 'end' }, 'tok/s')
              : null,
            (showRate ? rateAxisTicks() : []).map((tick) => {
              const y = CHART_PAD.top + layout.plotHeight - (tick / PERCENT_SCALE) * layout.plotHeight
              return h('text', {
                key: `rate-${tick}`, className: 'ud-axis-rate',
                x: plotRight + AXIS_RATE_GAP, y: y + AXIS_LABEL_BASELINE,
              }, String(tick))
            }),
            layout.bars.flatMap((bar, barIndex) => bar.segments.map((segment) => h('rect', {
              key: `${bar.key}/${segment.model}`, className: 'ud-bar',
              x: bar.x - layout.barWidth / 2, y: segment.y, width: layout.barWidth, height: segment.height,
              fill: colorFor(segment.model),
              style: hover?.index === barIndex
                ? { transform: `scaleX(${(layout.barWidth + BAR_HOVER_GROW) / layout.barWidth})` }
                : undefined,
            }))),
            slots.map((slot, index) => (index % layout.labelEvery === 0 || index === slots.length - 1)
              ? h('text', { key: slot.day, className: 'ud-axis', x: layout.bars[index].x, y: CHART_HEIGHT - X_LABEL_OFFSET, textAnchor: 'middle' }, labelFor(slot.day))
              : null),
            showRate ? h('path', {
              className: 'ud-trend', d: smoothPath(ratePoints),
              strokeWidth: TREND_LINE_WIDTH, strokeLinejoin: 'round', strokeLinecap: 'round',
            }) : null,
            showSpeed ? h('path', {
              className: cx('ud-trend', 'ud-trend--speed'), d: smoothPath(speedPoints),
              strokeWidth: TREND_LINE_WIDTH, strokeLinejoin: 'round', strokeLinecap: 'round',
            }) : null,
            showTtft ? h('path', {
              className: cx('ud-trend', 'ud-trend--ttft'), d: smoothPath(ttftPoints),
              strokeWidth: TREND_LINE_WIDTH, strokeLinejoin: 'round', strokeLinecap: 'round',
            }) : null,
            hoverRatePoint
              ? h('circle', { className: 'ud-trend-dot', cx: hoverRatePoint.x, cy: hoverRatePoint.y, r: TREND_DOT_RADIUS })
              : null,
            hoverSpeedPoint
              ? h('circle', { className: cx('ud-trend-dot', 'ud-trend-dot--speed'), cx: hoverSpeedPoint.x, cy: hoverSpeedPoint.y, r: TREND_DOT_RADIUS })
              : null,
            hoverTtftPoint
              ? h('circle', { className: cx('ud-trend-dot', 'ud-trend-dot--ttft'), cx: hoverTtftPoint.x, cy: hoverTtftPoint.y, r: TREND_DOT_RADIUS })
              : null,
            slots.map((slot, index) => h('rect', {
              key: `hit-${slot.day}`, className: 'ud-bar-hit',
              x: layout.bars[index].x - layout.step / 2, y: CHART_PAD.top, width: layout.step, height: layout.plotHeight,
              onMouseEnter: pick(index), onFocus: pick(index), onMouseLeave: clear, onBlur: clear,
            })))),
        h(Legend, {
          models: legendModels, colorFor, speedEnabled: hasSpeed, ttftEnabled: hasTtft,
          isVisible: (key) => visibleSet.has(key),
          onItem: (key, ctrl) => setVisibleKeys(legendToggle(visibleKeys, key, ctrl)),
        }),
        h(ChartTip, { anchor: hover ? hover.anchor : null, panelRef },
          hoverSlot
            ? [
                h('div', { key: 'title', className: 'ud-tip-title' }, slotLabelFor ? slotLabelFor(hoverSlot.day) : hoverSlot.day),
                h('div', { key: 'total', className: 'ud-tip-row' }, `${t('total')}: ${formatTokens(hoverSlot.total)}`),
                ...legendModels.filter((item) => visibleSet.has(item.model)).map((item) => h('div', { key: `m-${item.model}`, className: 'ud-tip-row' },
                  h('i', { className: 'ud-legend-swatch', style: { background: colorFor(item.model) } }),
                  `${item.model === OTHER_MODEL ? t('other') : item.model}: ${formatTokens(hoverSlot.byModel[item.model] ?? 0)}`)),
                ...(visibleSet.has(OTHER_MODEL) ? otherEntries.map(([model, tokens]) => h('div', { key: `om-${model}`, className: 'ud-tip-row ud-tip-row--sub' },
                  `${model}: ${formatTokens(tokens)}`)) : []),
                showRate ? h('div', { key: 'rate', className: 'ud-tip-row' }, `${t('cacheHitRate')}: ${cacheRateText(hoverSlot.cacheHit, hoverSlot.cacheMiss)}`) : null,
                showSpeed ? h('div', { key: 'speed', className: 'ud-tip-row' }, `${t('avgSpeed')}: ${speedTipText(hoverSlot.speed)}`) : null,
                showTtft ? h('div', { key: 'ttft', className: 'ud-tip-row' }, `${t('ttftLegend')}: ${ttftTipText(hoverSlot.ttft, t)}`) : null,
                costEnabled && prefsRef.current.costDisplay && hoverSlot.cost !== undefined
                  ? h('div', { key: 'cost', className: 'ud-tip-row' }, `≈ ${formatCost(hoverSlot.cost, costCurrency)}`)
                  : null,
              ]
            : null))
    }

    // 浮层 tooltip:portal 到 body,模块表缺失时降级面板内 fixed
    function ChartTip({ anchor, panelRef, children }) {
      const tipRef = useRef(null)
      const [pos, setPos] = useState(null)
      const place = useCallback(() => {
        const tip = tipRef.current
        if (!tip) return
        const panel = panelRef ? panelRef.current : null
        const bounds = panel
          ? panel.getBoundingClientRect()
          : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        const next = tipPlace(
          anchor ? anchor.getBoundingClientRect() : null,
          { width: tip.offsetWidth, height: tip.offsetHeight },
          bounds,
        )
        setPos((prev) => (prev && next && prev.left === next.left && prev.top === next.top ? prev : next))
      }, [anchor, panelRef])
      useLayoutEffect(() => {
        place()
      }, [place])
      useEffect(() => {
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        const observer = new ResizeObserver(() => place())
        if (tipRef.current) observer.observe(tipRef.current)
        if (panelRef && panelRef.current) observer.observe(panelRef.current)
        return () => {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
          observer.disconnect()
        }
      }, [place])
      const element = h('div', {
        className: 'ud-tip',
        ref: tipRef,
        style: {
          left: pos ? pos.left : 0,
          top: pos ? pos.top : 0,
          visibility: pos && anchor ? 'visible' : 'hidden',
        },
      }, anchor ? children : null)
      return createPortal && typeof document !== 'undefined' && document.body
        ? createPortal(element, document.body)
        : element
    }

    function HeatSection({ days, panelRef, t = defaultT }) {
      const wrapRef = useRef(null)
      const [width, setWidth] = useState(0)
      const [hover, setHover] = useState(null)
      useEffect(() => {
        const element = wrapRef.current
        const observer = new ResizeObserver((entries) => {
          const next = entries[0].contentRect.width
          setWidth((prev) => (Math.abs(prev - next) < HEAT_WIDTH_EPSILON ? prev : next))
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])
      const geom = width > 0 && days ? heatLayout(width, days[0].day) : null
      const display = geom ? heatDisplayDays(days, geom.cols) : null
      const grid = display ? heatGrid(display, geom.size) : null
      const peak = display ? Math.max(1, ...display.map((slot) => slot.tokens)) : 1
      const pick = (cell) => (event) => setHover({ ...cell, anchor: event.currentTarget })
      const clear = () => setHover(null)
      return h('div', { className: 'ud-section' },
        h('div', { className: 'ud-section-head' },
          h('span', { className: 'ud-section-title' }, t('heatmap')),
          h('div', { className: 'ud-heat-legend' },
            h('span', null, t('heatLess')),
            Array.from({ length: HEAT_LEVELS - 1 }, (_, index) => h('i', {
              key: index,
              className: `ud-heat-l${index + 1}`,
              style: geom ? { width: geom.size, height: geom.size } : undefined,
            })),
            h('span', null, t('heatMore')))),
        h('div', { className: 'ud-heat-wrap', ref: wrapRef },
          grid
            ? h('svg', { className: 'ud-heat', width: grid.width, height: grid.height, role: 'img', 'aria-label': t('heatmap') },
                grid.cells.map((cell) => {
                  const level = heatLevel(cell.tokens, peak)
                  return h('rect', {
                    key: cell.day,
                    className: `ud-heat-cell ud-heat-l${level}`,
                    x: cell.x, y: cell.y, width: geom.size, height: geom.size, rx: HEAT_RX,
                    'aria-hidden': level === 0,
                    onMouseEnter: pick(cell), onFocus: pick(cell),
                    onMouseLeave: clear, onBlur: clear,
                  })
                }))
            : null),
        h(ChartTip, { anchor: hover ? hover.anchor : null, panelRef },
          hover
            ? [
                h('div', { key: 'title', className: 'ud-tip-title' }, hover.day),
                h('div', { key: 'tokens', className: 'ud-tip-row' }, `${t('tokens')}: ${formatTokens(hover.tokens)}`),
                h('div', { key: 'requests', className: 'ud-tip-row' }, `${t('requests')}: ${hover.requests}`),
                h('div', { key: 'rate', className: 'ud-tip-row' }, `${t('cacheHitRate')}: ${cacheRateText(hover.cacheHit, hover.cacheMiss)}`),
              ]
            : null))
    }

    // 模型用量:donut + 列表,恒按天口径,不随视图切换
    function ModelUsage({ models, colorFor, panelRef, costCurrency = '', t = defaultT }) {
      const [hover, setHover] = useState(null)
      const [tip, setTip] = useState(null)
      const [expandedOther, setExpandedOther] = useState(false)
      const total = Math.max(DONUT_TOTAL_FLOOR, models.reduce((sum, item) => sum + item.tokens, 0))
      const segments = donutSegments(models, total)
      const displayName = (model) => (model === OTHER_MODEL ? t('other') : model)
      const pick = (model) => (event) => {
        setHover(model)
        setTip({ model, anchor: event.currentTarget })
      }
      const clear = () => {
        setHover(null)
        setTip(null)
      }
      const toggleOther = () => setExpandedOther((value) => !value)
      const tipSegment = tip ? segments.find((segment) => segment.model === tip.model) : null
      return h('div', { className: 'ud-section' },
        h('div', { className: 'ud-section-head' },
          h('span', { className: 'ud-section-title' }, t('modelUsage'))),
        h('div', { className: 'ud-model-usage' },
          h('svg', {
            className: 'ud-donut-wrap', viewBox: `0 0 ${DONUT_VIEWBOX_SIZE} ${DONUT_VIEWBOX_SIZE}`,
            width: DONUT_VIEWBOX_SIZE, height: DONUT_VIEWBOX_SIZE,
          },
            h('circle', {
              className: 'ud-donut-track', cx: DONUT_CENTER_XY, cy: DONUT_CENTER_XY, r: DONUT_RADIUS,
              fill: 'none', strokeWidth: DONUT_STROKE_WIDTH, stroke: 'var(--dsw-alias-bg-mask-1)',
            }),
            segments.map((segment) => h('circle', {
              key: segment.model,
              className: cx('ud-donut-seg', hover && hover !== segment.model && 'ud-donut-seg--dim'),
              cx: DONUT_CENTER_XY, cy: DONUT_CENTER_XY, r: DONUT_RADIUS, fill: 'none',
              stroke: colorFor(segment.model),
              strokeWidth: hover === segment.model ? DONUT_STROKE_WIDTH + DONUT_ACTIVE_STROKE_GROW : DONUT_STROKE_WIDTH,
              strokeDasharray: `${segment.dash} ${DONUT_CIRCUMFERENCE - segment.dash}`,
              strokeDashoffset: -segment.offset,
              transform: `rotate(-90 ${DONUT_CENTER_XY} ${DONUT_CENTER_XY})`,
              tabIndex: 0, role: 'button',
              'aria-label': modelSegmentLabel(displayName(segment.model), segment.tokens, segment.percent),
              onMouseEnter: pick(segment.model), onFocus: pick(segment.model),
              onMouseLeave: clear, onBlur: clear,
            })),
            h('text', { className: 'ud-donut-center', x: DONUT_CENTER_XY, y: DONUT_CENTER_XY + DONUT_CENTER_VALUE_OFFSET, textAnchor: 'middle', 'aria-hidden': true }, formatCompact(total)),
            h('text', { className: 'ud-donut-label', x: DONUT_CENTER_XY, y: DONUT_CENTER_XY + DONUT_CENTER_LABEL_OFFSET, textAnchor: 'middle', 'aria-hidden': true }, t('tokens'))),
          h('div', { className: 'ud-models' },
            models.map((item) => {
              const isOther = item.model === OTHER_MODEL
              const speedText = modelSpeedText(item.speed)
              const ttftText = modelTtftText(item.ttft, t)
              return h(React.Fragment, { key: item.model },
                h('div', {
                  className: cx('ud-model-row', isOther && 'ud-model-row--expand'),
                  onClick: isOther ? toggleOther : undefined,
                  onMouseEnter: () => setHover(item.model),
                  onMouseLeave: clear,
                },
                  h('i', { className: 'ud-model-swatch', style: { background: colorFor(item.model) } }),
                  h('div', { className: 'ud-model-id' },
                    h('span', { className: 'ud-model-name' }, displayName(item.model)),
                    isOther ? null : h('span', { className: 'ud-model-provider' }, providerOf(item.model))),
                  isOther
                    ? h('button', {
                        className: 'ud-model-toggle', 'aria-expanded': expandedOther, 'aria-label': t('other'),
                        onClick: (event) => {
                          event.stopPropagation()
                          toggleOther()
                        },
                      }, '›')
                    : null,
                  h('div', { className: 'ud-model-values' },
                    h('span', { className: 'ud-model-tokens' }, formatTokens(item.tokens)),
                    h('span', { className: 'ud-model-pct' },
                      item.cost !== undefined ? h('span', { className: 'ud-model-cost' }, `≈ ${formatCost(item.cost, costCurrency)} · `) : null,
                      formatPercent((item.tokens / total) * PERCENT_SCALE),
                      speedText ? ` · ${speedText}` : null,
                      ttftText ? ` · ${ttftText}` : null))),
                isOther
                  ? h('div', { className: cx('ud-model-other', expandedOther && 'ud-model-other--open') },
                      h('div', { className: 'ud-model-other-list' },
                        otherDetailItems(models).map((detail) => h('div', {
                          key: detail.model, className: 'ud-model-row ud-model-row--sub',
                          onMouseEnter: () => setHover(OTHER_MODEL), onMouseLeave: clear,
                        },
                          h('span', { className: 'ud-model-name' }, detail.model),
                          h('div', { className: 'ud-model-values' },
                            h('span', { className: 'ud-model-tokens' }, formatTokens(detail.tokens)))))))
                  : null)
            }))),
        h(ChartTip, { anchor: tip ? tip.anchor : null, panelRef },
          tipSegment
            ? [
                h('div', { key: 'title', className: 'ud-tip-title' }, displayName(tipSegment.model)),
                h('div', { key: 'tokens', className: 'ud-tip-row' }, `${t('total')}: ${formatTokens(tipSegment.tokens)}`),
                h('div', { key: 'pct', className: 'ud-tip-row' }, `${t('percent')}: ${formatPercent(tipSegment.percent)}`),
                tipSegment.model === OTHER_MODEL && (tipSegment.items ?? []).length > 0
                  ? h('div', { key: 'breakdown', className: 'ud-tip-breakdown' },
                      tipSegment.items.map((detail) => h('div', { key: detail.model, className: 'ud-tip-row ud-tip-row--sub' },
                        h('i', { className: 'ud-legend-swatch', style: { background: 'var(--ud-chart-other)' } }),
                        `${detail.model}: ${formatTokens(detail.tokens)}`)))
                  : null,
              ]
            : null))
    }

    // 规约形态开关:原生 checkbox 保语义并视觉隐藏,track/thumb 呈现选中态
    function Switch({ checked, onChange, disabled, describedbyId }) {
      return h('label', { className: 'ud-switch' },
        h('input', {
          type: 'checkbox',
          checked,
          disabled,
          'aria-describedby': describedbyId,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'ud-switch__track' },
          h('span', { className: 'ud-switch__thumb' })))
    }

    // 底部信息栏接管:与官方 StatsLine 同 id 'stats' 的槽条目,双开关控制增强项
    // 语言切换经槽的 locale 座以新 t 引用驱动 memo 重渲染
    const StatsLineEnhanced = React.memo(function StatsLineEnhanced({ useChat, useProjection, t = defaultT }) {
      if (typeof useProjection !== 'function' || typeof useChat !== 'function') return null
      const usage = useProjection('tokenUsage')
      const projected = useProjection('sessionStats')
      const settledNodes = useChat((state) => state.legacy.nodes)
      const stats = useMemo(() => projected ?? deriveStats(settledNodes ?? []), [projected, settledNodes])
      const [prefs, setPrefs] = useState(() => statsLineState.get())
      useEffect(() => statsLineState.subscribe(() => setPrefs(statsLineState.get())), [])
      // 价格异步首帧可能未回:回包经状态刷新补渲染,未回期间费用组不渲染
      const [pricingRules, setPricingRules] = useState(null)
      useEffect(() => {
        let alive = true
        fetchPricing().then((value) => {
          if (alive && value) setPricingRules(value.rules)
        })
        return () => { alive = false }
      }, [])
      const groups = buildStatsGroups(stats, usage, prefs, t, pricingRules)
      const costItem = buildCostItem(usage, pricingRules, prefs, t)
      const entries = groups.map((text) => ({ text }))
      if (costItem !== null && groups[groups.length - 1] === costItem) {
        entries[entries.length - 1] = { text: costItem, title: t('statsCostTitle') }
      }
      const rootRef = useRef(null)
      const [truncated, setTruncated] = useState(false)
      useLayoutEffect(() => {
        const element = rootRef.current
        if (!element) return undefined
        const measure = () => setTruncated(element.scrollWidth > element.clientWidth)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [groups])
      if (entries.length === 0) return null
      return h('div', {
        className: 'ud-statsline-root',
        ref: rootRef,
        title: truncated ? entries.map((entry) => entry.text).join(STATS_LINE_TITLE_SEPARATOR) : undefined,
      }, entries.map((entry, index) => h(React.Fragment, { key: index },
        index > 0 && h('span', { className: 'ud-statsline-sep', 'aria-hidden': true }, '|'),
        entry.title ? h('span', { title: entry.title }, entry.text) : entry.text)))
    })

    // 注入点B 组件:回合费用芯片,官方动作行内渲染(复制与分支图标之间,赞踩/上下文跳转同排);
    // 受费用显示开关;价格异步首帧未回不渲染,回包后补渲染;显隐节奏随官方 data-actions-reveal
    // 官方槽容器固定在用量/用时芯片之前,末位排布由 SlotTailPortal 移交实现
    const CostChip = React.memo(function CostChip({ messageId, useChat, t = defaultT }) {
      if (typeof useChat !== 'function') return null
      const chatNodes = useChat((state) => (state && typeof state === 'object') ? state.nodes : undefined)
      const [prefs, setPrefs] = useState(() => statsLineState.get())
      useEffect(() => statsLineState.subscribe(() => setPrefs(statsLineState.get())), [])
      const [pricingRules, setPricingRules] = useState(null)
      useEffect(() => {
        let alive = true
        fetchPricing().then((value) => {
          if (alive && value) setPricingRules(value.rules)
        })
        return () => { alive = false }
      }, [])
      const matched = typeof messageId === 'string' && messageId !== ''
        ? turnTokenUsageOfMessage(chatNodes, messageId)
        : null
      const price = matched && prefs.costDisplay && pricingRules !== null
        ? matchPrice(pricingRules, turnModelOf(matched), new Date())
        : null
      // 0 元(全零价/全零桶)与价未命中同不渲染,无占位符
      const cost = matched && price ? turnCostAmountOf(matched, price) : null
      const chip = cost === null ? null : h('span', { className: 'ud-turn-cost', title: turnCostTitleText(t, matched) },
        t('turnCostChip', { cost: formatCost(cost, aggregateCurrencyOf(pricingRules)) }))
      return h(SlotTailPortal, null, chip)
    })

    // 槽内容末位移交:锚点藏于槽容器内,portal 目标取槽容器(display:contents)的父级即官方动作行 div,
    // portal 子树 append 到动作行末尾(官方用量/用时芯片与结束时钟之后);portal 缺席降级锚点原位
    function SlotTailPortal({ children }) {
      const anchorRef = useRef(null)
      const [container, setContainer] = useState(null)
      useEffect(() => {
        const anchor = anchorRef.current
        const slotHost = anchor?.closest('[data-slot="conversation.chat.assistant-actions"]') ?? anchor?.parentElement
        setContainer(slotHost?.parentElement ?? null)
      }, [])
      const ported = container && createPortal ? createPortal(children, container) : null
      return h('span', { ref: anchorRef, style: ported ? { display: 'none' } : undefined }, ported ?? children)
    }

    // 偏好卡行:说明文案承担 aria-describedby 目标
    function StatsLineOptionRow({ labelKey, descKey, checked, onToggle, t = defaultT }) {
      const describeId = React.useId()
      return h('div', { className: 'ud-pref-row' },
        h('div', { className: 'ud-pref-text' },
          h('span', { className: 'ud-pref-title' }, t(labelKey)),
          h('span', { className: 'ud-pref-desc', id: describeId }, t(descKey))),
        h(Switch, { checked, onChange: onToggle, describedbyId: describeId }))
    }

    // 偏好卡:与底部信息栏同 store 实例,改动即时互通
    function StatsLineOptions({ t = defaultT }) {
      const [prefs, setPrefs] = useState(() => statsLineState.get())
      useEffect(() => statsLineState.subscribe(() => setPrefs(statsLineState.get())), [])
      return h('div', { className: 'ud-pref-group' },
        h(StatsLineOptionRow, {
          labelKey: 'cachePrecision',
          descKey: 'cachePrecisionDesc',
          checked: prefs.cachePrecision,
          onToggle: (value) => statsLineState.set({ cachePrecision: value }),
          t,
        }),
        h(StatsLineOptionRow, {
          labelKey: 'tokenDetail',
          descKey: 'tokenDetailDesc',
          checked: prefs.tokenDetail,
          onToggle: (value) => statsLineState.set({ tokenDetail: value }),
          t,
        }),
        h(StatsLineOptionRow, {
          labelKey: 'costDisplay',
          descKey: 'costDisplayDesc',
          checked: prefs.costDisplay,
          onToggle: (value) => statsLineState.set({ costDisplay: value }),
          t,
        }))
    }

    // 定价规则编辑器:货币为编辑器级全局设置(标题右侧切换,整表统一,不逐模型设置);
    // 每规则可挂多条时间条件(时段/周几/号段/日期段),全部条件命中才生效;打开面板时经 fetchPricing 初始化,未保存离开即弃
    const PRICING_STATE_READY = 'ready'
    const PRICING_STATE_UNAVAILABLE = 'unavailable'

    // 价格四桶 grid:默认价槽与附加规则卡共用;错误路径按规则平面索引寻址
    function PricingPriceGrid({ rule, currency, errors, pathPrefix, t, onPricePatch }) {
      const errorTextOf = (path) => {
        const key = errors.get(path)
        return key ? h('span', { className: 'ud-field-error' }, t(key)) : null
      }
      const priceField = (key, labelKey) => h('label', { key, className: 'ud-field' },
        h('span', { className: 'ud-field-label' }, t(labelKey)),
        h('span', { className: 'ud-price-input' },
          h('span', { className: 'ud-price-currency', 'aria-hidden': 'true' }, currency),
          h('input', {
            type: 'number', className: 'ud-input', min: 0, step: 'any',
            value: rule.price?.[key] ?? '',
            onChange: (event) => onPricePatch({ price: { ...rule.price, [key]: event.target.value } }),
          })),
        errorTextOf(`${pathPrefix}price.${key}`))
      return h('div', { className: 'ud-price-grid' },
        priceField('input', 'priceInput'),
        priceField('output', 'priceOutput'),
        priceField('cacheRead', 'priceCacheRead'),
        priceField('cacheWrite', 'priceCacheWrite'))
    }

    // 附加计费规则卡:头行 = 价格四桶 + 上移/下移/删除;下方为条件组合区(组内从上到下首个命中者生效)。
    // 默认价在组内独立成槽,附加规则不再承担兜底语义
    function PricingExtraRuleCard({ rule, currency, errors, pathPrefix, t, onPatch, onRemove, onMove, canMoveUp, canMoveDown }) {
      const errorTextOf = (path) => {
        const key = errors.get(path)
        return key ? h('span', { className: 'ud-field-error' }, t(key)) : null
      }
      const patchConditions = (conditions) => onPatch({ conditions })
      const patchConditionAt = (conditionIndex, patch) => patchConditions(patchItemAt(rule.conditions, conditionIndex, patch))
      const removeConditionAt = (conditionIndex) => patchConditions(rule.conditions.filter((_, i) => i !== conditionIndex))
      const conditionRow = (condition, conditionIndex) => {
        const condPath = `${pathPrefix}conditions.${conditionIndex}`
        const patchCondition = (patch) => patchConditionAt(conditionIndex, patch)
        const textInput = (field, type, labelKey) => h('label', { key: field, className: 'ud-field' },
          h('span', { className: 'ud-field-label' }, t(labelKey)),
          h('input', {
            type, className: 'ud-input', value: condition[field] ?? '',
            onChange: (event) => patchCondition({ [field]: event.target.value }),
          }),
          errorTextOf(`${condPath}.${field}`))
        // 号段 from/to 同域 1~31(双闭),统一上限
        const numberInput = (field, labelKey) => h('label', { key: field, className: 'ud-field' },
          h('span', { className: 'ud-field-label' }, t(labelKey)),
          h('input', {
            type: 'number', className: 'ud-input', min: MONTH_DAY_MIN,
            max: MONTH_DAY_MAX, step: 1,
            value: condition[field] ?? '',
            onChange: (event) => patchCondition({ [field]: event.target.value }),
          }),
          errorTextOf(`${condPath}.${field}`))
        // 周几 pill 仅 weekdays 条件才构造:其余类型无 days 字段,提前求值会使渲染崩溃白屏
        const weekdaysPills = () => h('div', { className: 'ud-group', role: 'group', 'aria-label': t('condWeekdays') },
          Array.from({ length: WEEKDAY_COUNT }, (_, day) => {
            const active = (condition.days ?? []).includes(day)
            return h('button', {
              key: day, type: 'button',
              className: cx('ud-seg-item', active && 'ud-seg-item--on'),
              'aria-pressed': active,
              onClick: () => patchCondition({
                days: active ? condition.days.filter((value) => value !== day) : [...(condition.days ?? []), day],
              }),
            }, t(`weekday.${day}`))
          }))
        const fields = {
          dailyWindow: [textInput('from', 'time', 'condFrom'), textInput('to', 'time', 'condTo')],
          weekdays: [weekdaysPills()],
          monthDays: [numberInput('from', 'condFrom'), numberInput('to', 'condTo')],
          dateRange: [textInput('from', 'date', 'condFrom'), textInput('to', 'date', 'condTo')],
        }
        return h('div', { key: conditionIndex, className: 'ud-cond' },
          h('select', {
            className: 'ud-input ud-cond-kind', value: condition.kind, 'aria-label': t('condKind'),
            onChange: (event) => patchCondition(defaultCondition(event.target.value)),
          }, CONDITION_KIND_OPTIONS.map((kind) => h('option', { key: kind, value: kind }, t(CONDITION_KIND_LABEL_KEYS[kind])))),
          h('div', { className: 'ud-cond-fields' }, ...(fields[condition.kind] ?? [])),
          errorTextOf(condPath),
          h('button', {
            className: 'ud-btn ud-btn--text', type: 'button', onClick: () => removeConditionAt(conditionIndex),
            'aria-label': t('deleteCondition'), title: t('deleteCondition'),
          }, '×'))
      }
      return h('div', { className: 'ud-rule' },
        h('div', { className: 'ud-slot-head' },
          h(PricingPriceGrid, {
            rule, currency, errors, pathPrefix, t,
            onPricePatch: (part) => onPatch(part),
          }),
          canMoveUp ? h('button', {
            className: 'ud-btn ud-btn--text', type: 'button', onClick: () => onMove(-1),
            'aria-label': t('moveUp'), title: t('moveUp'),
          }, '↑') : null,
          canMoveDown ? h('button', {
            className: 'ud-btn ud-btn--text', type: 'button', onClick: () => onMove(1),
            'aria-label': t('moveDown'), title: t('moveDown'),
          }, '↓') : null,
          h(DeleteArmedButton, { labelKey: 'deleteRule', confirmKey: 'confirmDelete', onConfirm: onRemove, t })),
        h('div', { className: 'ud-rule-conds' },
          (rule.conditions ?? []).map((condition, conditionIndex) => conditionRow(condition, conditionIndex)),
          h('div', { className: 'ud-cond-add' },
            h('button', {
              type: 'button', className: 'ud-btn ud-btn--text',
              onClick: () => patchConditions([...(rule.conditions ?? []), defaultCondition(CONDITION_KIND_OPTIONS[0])]),
            }, `+${t('addCondition')}`))))
    }

    // 模型组卡:组头 = 模型键输入(整组一次改名)+ 删除整组;组内 = 默认价槽(禁条件/排序/删除,恒兜底)
    // + 附加计费规则列表(从上到下首个命中生效,全不命中落默认价)。
    // 组件 key 由调用方锚定首槽位平面索引,改名引发的重新聚合不会丢焦点
    function PricingModelGroup({ group, currency, errors, t, onModelChange, onGroupRemove, onSlotPatch, onSlotRemove, onSlotMove, onSlotAdd }) {
      const modelError = group.slots.map((slot) => errors.get(`${slot.index}.model`)).find(Boolean)
      const { defaultSlot, extras } = partitionGroupOf(group)
      // 新附加规则插到默认价平面位之前(无默认价则组末),保证默认价恒居组末
      const insertPosition = defaultSlot ? defaultSlot.index - 1 : group.slots[group.slots.length - 1].index
      return h('div', { className: 'ud-rule-group' },
        h('div', { className: 'ud-rule-group-head' },
          h('label', { className: 'ud-field' },
            h('span', { className: 'ud-field-label' }, t('pricingModel')),
            h('input', {
              type: 'text', className: 'ud-input', value: group.model,
              placeholder: t('pricingModelPlaceholder'),
              onChange: (event) => onModelChange(event.target.value),
            }),
            modelError ? h('span', { className: 'ud-field-error' }, t(modelError)) : null),
          h(DeleteArmedButton, { labelKey: 'deleteGroup', confirmKey: 'confirmDelete', onConfirm: onGroupRemove, t })),
        h('div', { className: 'ud-rule-group-slots' },
          defaultSlot ? h('div', { className: 'ud-rule ud-rule-default' },
            h('div', { className: 'ud-slot-head' },
              h(PricingPriceGrid, {
                rule: defaultSlot.rule, currency, errors,
                pathPrefix: `${defaultSlot.index}.`, t,
                onPricePatch: (part) => onSlotPatch(defaultSlot.index, part),
              })),
            h('span', { className: 'ud-rule-cond' }, t('defaultPriceHint'))) : null,
          extras.map((slot, position) => h(PricingExtraRuleCard, {
            key: slot.index,
            rule: slot.rule,
            currency,
            errors,
            pathPrefix: `${slot.index}.`,
            t,
            onPatch: (part) => onSlotPatch(slot.index, part),
            onRemove: () => onSlotRemove(slot.index),
            onMove: (delta) => onSlotMove(slot.index, extras[position + delta].index),
            canMoveUp: position > 0,
            canMoveDown: position < extras.length - 1,
          }))),
        h('button', {
          className: 'ud-rule-add', type: 'button',
          onClick: () => onSlotAdd(insertPosition, group.model),
        }, defaultSlot ? t('addRule') : t('addDefaultPrice')))
    }

    function PricingEditor({ t = defaultT }) {
      const [phase, setPhase] = useState(null)
      const [currency, setCurrency] = useState(CURRENCIES[0])
      const [rules, setRules] = useState(null)
      const [errors, setErrors] = useState(() => new Map())
      const [saveError, setSaveError] = useState('')
      const [saving, setSaving] = useState(false)
      const [saved, setSaved] = useState(false)
      const savedTimerRef = useRef(null)

      useEffect(() => {
        let alive = true
        fetchPricing().then((value) => {
          if (!alive) return
          if (!value) {
            setPhase(PRICING_STATE_UNAVAILABLE)
            return
          }
          // 打开即按首个非空货币归一显示(无非空则回落首档),整表状态与全局货币恒一致
          const loaded = copyRules(value.rules)
          const unified = aggregateCurrencyOf(loaded) || CURRENCIES[0]
          setCurrency(unified)
          setRules(applyCurrencyToRules(loaded, unified))
          setPhase(PRICING_STATE_READY)
        })
        return () => { alive = false }
      }, [])

      useEffect(() => () => {
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      }, [])

      const save = async () => {
        const found = validatePricingRules(rules)
        setErrors(found)
        setSaved(false)
        if (found.size > 0) return
        setSaving(true)
        const result = await requestPost(ENDPOINTS.pricing, { rules: coercePricingRules(rules) })
        setSaving(false)
        if (!result.ok) {
          setSaveError(result.message)
          return
        }
        // 保存即生效:响应 value 直接覆盖缓存,编辑副本同步为服务端规整后的规则
        applyPricingValue(result.value)
        setSaveError('')
        setErrors(new Map())
        setRules(copyRules(result.value.rules))
        setSaved(true)
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setSaved(false), PRICING_SAVED_NOTICE_MS)
      }

      if (phase === PRICING_STATE_UNAVAILABLE) {
        return h('div', { className: 'ud-pref-group' },
          h('span', { className: 'ud-pref-title' }, t('pricing')),
          h('div', { className: 'ud-empty' }, t('pricingUnavailable')))
      }
      if (phase !== PRICING_STATE_READY) return null

      return h('div', { className: 'ud-pref-group' },
        h('div', { className: 'ud-pref-row' },
          h('div', { className: 'ud-pref-text' },
            h('span', { className: 'ud-pref-title' }, t('pricing')),
            saved ? h('span', { className: 'ud-pref-desc' }, t('saved')) : null),
          h('div', { className: 'ud-pricing-actions' },
            h('span', { className: 'ud-unit-note' }, t('pricingUnit')),
            h('div', { className: 'ud-group', role: 'group', 'aria-label': t('pricingCurrency') },
              CURRENCIES.map((symbol) => h('button', {
                key: symbol, type: 'button',
                className: cx('ud-seg-item', currency === symbol && 'ud-seg-item--on'),
                'aria-pressed': currency === symbol,
                onClick: () => {
                  setCurrency(symbol)
                  setRules((prev) => applyCurrencyToRules(prev, symbol))
                },
              }, symbol))),
            h('button', { className: 'ud-btn', type: 'button', disabled: saving, onClick: save }, t('save')))),
        saveError ? h('div', { className: 'ud-error' }, saveError) : null,
        h('span', { className: 'ud-rule-cond' }, t('ruleOrderHint')),
        groupRulesOf(rules).map((group) => h(PricingModelGroup, {
          // key 锚定首槽位平面索引:改名重聚合不重建组件,输入焦点不丢
          key: String(group.slots[0].index),
          group,
          currency,
          errors,
          t,
          onModelChange: (model) => setRules((prev) => renameRulesAt(prev, group.slots.map((slot) => slot.index), model)),
          onGroupRemove: () => setRules((prev) => removeRulesAt(prev, group.slots.map((slot) => slot.index))),
          onSlotPatch: (index, part) => setRules((prev) => patchItemAt(prev, index, part)),
          onSlotRemove: (index) => setRules((prev) => prev.filter((_, i) => i !== index)),
          onSlotMove: (fromIndex, toIndex) => setRules((prev) => moveRuleTo(prev, fromIndex, toIndex)),
          onSlotAdd: (position, model) => setRules((prev) => insertRuleAt(prev, position, {
            ...defaultPricingRule(currency),
            model,
            // 附加规则默认带全天时段条件:默认价已独立成槽,附加规则应以可编辑条件呈现
            conditions: [defaultCondition(CONDITION_KIND_OPTIONS[0])],
          })),
        })),
        h('button', {
          className: 'ud-rule-add', type: 'button',
          onClick: () => setRules((prev) => [...prev, defaultPricingRule(currency)]),
        }, t('addGroup')))
    }

    // 扫描异常日志入口:仅箭头标识,明细在展开的日志块中展示
    function AnomalyChip({ open, onToggle, t = defaultT }) {
      return h('button', {
        type: 'button', className: 'ud-status-fold', 'aria-expanded': open,
        'aria-label': t('anomalyLog'), title: t('anomalyLog'),
        onClick: onToggle,
      },
      h('span', { className: 'ud-status-fold-caret', 'aria-hidden': 'true' }))
    }

    // 回扫进度与采集错误是运行状态,常显;异常明细走日志块
    function StatusRow({ status, t = defaultT }) {
      if (!status) return null
      const running = status.running === true
      if (!running && !status.error) return null
      const progress = running && status.total > 0
        ? Math.min(PROGRESS_FULL_PERCENT, (status.done / status.total) * PROGRESS_FULL_PERCENT)
        : 0
      return h('div', { className: 'ud-status' },
        running
          ? h(React.Fragment, null,
              h('span', null, t('status.running', { done: status.done, total: status.total })),
              h('span', { className: 'ud-status-track' },
                h('span', { className: 'ud-status-fill', style: { width: `${progress}%` } })))
          : null,
        status.error ? h('span', { className: 'ud-status-err' }, status.error) : null)
    }

    // 展开后的异常日志块:汇总计数即明细条数(单一事实源),逐条展示(时间/类型/内容);
    // skipped 细分归因(宿主拒读/损坏/旧格式)挂在汇总行 title,供跨宿主边界诊断
    function AnomalyLog({ status, t = defaultT }) {
      const lines = status.log ?? []
      if (lines.length === 0) return null
      const breakdown = status.skippedBreakdown ?? {}
      const breakdownText = t('skipBreakdown', {
        d: breakdown.descriptor ?? 0,
        c: breakdown.corrupt ?? 0,
        l: breakdown.legacy ?? 0,
        o: breakdown.other ?? 0,
      })
      return h('div', { className: 'ud-log' },
        h('div', { className: 'ud-log-summary' },
          (status.skippedSessions ?? 0) > 0
            ? h('span', { title: breakdownText }, t('skippedSessions', { n: status.skippedSessions }))
            : null,
          (status.recordFailures ?? 0) > 0
            ? h('span', { className: 'ud-status-err' }, t('recordFailures', { n: status.recordFailures }))
            : null),
        lines.map((entry, index) => h('div', { className: 'ud-log-line', key: index },
          h('span', { className: 'ud-log-time' }, logTimeOf(entry.time)),
          h('span', { className: cx('ud-log-kind', entry.kind === 'record' && 'ud-log-err') },
            entry.kind === 'record' ? t('logKindRecord') : t('logKindSkipped')),
          h('span', { className: 'ud-log-detail', title: entry.detail }, entry.detail))))
    }

    function RebuildButton({ machineRef, busy, onError, t = defaultT }) {
      const [armed, setArmed] = useState(false)
      const armedTimerRef = useRef(null)

      useEffect(() => () => {
        if (armedTimerRef.current) clearTimeout(armedTimerRef.current)
      }, [])

      const rebuild = async () => {
        if (!armed) {
          setArmed(true)
          armedTimerRef.current = setTimeout(() => setArmed(false), REBUILD_CONFIRM_MS)
          return
        }
        setArmed(false)
        const result = await requestPost(ENDPOINTS.reset)
        if (!result.ok) {
          onError(result.message)
          return
        }
        machineRef.current?.restart()
      }

      return h('button', { className: 'ud-btn ud-btn--text', disabled: busy, onClick: rebuild },
        armed ? t('rebuildConfirm') : t('rebuild'))
    }

    // 回退按钮:仅当存在重建快照(status.backup.available)时可点;
    // 恢复动作本身也会被重新快照覆盖,回退链不断
    function RestoreButton({ machineRef, busy, backup, onError, t = defaultT }) {
      const [armed, setArmed] = useState(false)
      const armedTimerRef = useRef(null)

      useEffect(() => () => {
        if (armedTimerRef.current) clearTimeout(armedTimerRef.current)
      }, [])

      if (!backup?.available) {
        return h('button', { className: 'ud-btn ud-btn--text', disabled: true, title: t('restoreMissing') },
          t('restore'))
      }

      const restore = async () => {
        if (!armed) {
          setArmed(true)
          armedTimerRef.current = setTimeout(() => setArmed(false), REBUILD_CONFIRM_MS)
          return
        }
        setArmed(false)
        const result = await requestPost(ENDPOINTS.restore)
        if (!result.ok) {
          onError(result.message)
          return
        }
        machineRef.current?.restart()
      }

      return h('button', { className: 'ud-btn ud-btn--text', disabled: busy, onClick: restore },
        armed ? t('restoreConfirm') : t('restore'))
    }

    const viewLabel = (t, id) => (id === 'day' ? t('viewDay') : id === 'hour' ? t('viewHour') : t('viewMinute'))
    const trendTitle = (t, id) => (id === 'day' ? t('dailyTrend') : id === 'hour' ? t('hourTrend') : t('minuteTrend'))
    const trendLimitedText = (t, id, count) => (id === 'day'
      ? t('trendLimited', { n: count })
      : id === 'hour' ? t('trendLimitedHour', { n: count }) : t('trendLimitedMinute', { n: count }))
    const presetLabel = (t, view, id) => t(`${view === 'hour' ? 'hourPreset' : 'minutePreset'}.${id}`)
    const tickLabelFor = (view) => (view === 'day' ? shortDay : view === 'hour' ? hourTickLabel : minuteTickLabel)
    const slotLabelFor = (view) => (view === 'hour' ? hourSlotLabel : view === 'minute' ? minuteSlotLabel : (day) => day)

    function UsageDashPanel({ t = defaultT }) {
      const [view, setView] = useState('day')
      const [range, setRange] = useState(DEFAULT_RANGE)
      const [customFrom, setCustomFrom] = useState('')
      const [customTo, setCustomTo] = useState('')
      const [stats, setStats] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [hourPreset, setHourPreset] = useState(DEFAULT_HOUR_PRESET)
      const [minutePreset, setMinutePreset] = useState(DEFAULT_MINUTE_PRESET)
      const [pointStats, setPointStats] = useState(null)
      const [pointStatus, setPointStatus] = useState('idle')
      const [fetchTick, setFetchTick] = useState(0)
      const [status, setStatus] = useState(null)
      const [detailsOpen, setDetailsOpen] = useState(false)
      const statusMachineRef = useRef(null)
      const generationRef = useRef(0)
      const pointGenerationRef = useRef(0)
      const heatGenerationRef = useRef(0)
      const panelRef = useRef(null)
      const [heatDays, setHeatDays] = useState(null)
      // 费用展示货币来源:价格规则异步首帧未回时空串即不带符号
      const [pricingRules, setPricingRules] = useState(null)

      useEffect(() => {
        let alive = true
        fetchPricing().then((value) => {
          if (alive && value) setPricingRules(value.rules)
        })
        return () => { alive = false }
      }, [])

      const costCurrency = aggregateCurrencyOf(pricingRules)

      // 热力图独立请求:与所选范围无关,失败静默留空,过期响应丢弃
      useEffect(() => {
        const generation = ++heatGenerationRef.current
        const request = { from: localDay(-(HEAT_WINDOW_DAYS - 1)), to: localDay(0) }
        requestPost(ENDPOINTS.range, request).then((result) => {
          if (heatGenerationRef.current !== generation || !result.ok) return
          const byDay = new Map(result.value.daily.map((slot) => [slot.day, slot]))
          setHeatDays(daysInRange(request.from, request.to).map((day) => {
            const slot = byDay.get(day)
            return {
              day,
              tokens: slot ? slot.total : 0,
              requests: slot ? slot.requests : 0,
              cacheHit: slot ? slot.cacheHit : 0,
              cacheMiss: slot ? slot.cacheMiss : 0,
            }
          }))
        })
      }, [])

      const load = useCallback(async () => {
        const request = range === 'custom'
          ? { from: customFrom, to: customTo }
          : resolveDayRange(range, new Date())
        if (!request || !request.from || !request.to) return
        const generation = ++generationRef.current
        setLoading(true)
        const result = await requestPost(ENDPOINTS.range, request)
        if (generationRef.current !== generation) return
        setLoading(false)
        if (!result.ok) {
          setError(result.message)
          return
        }
        setError('')
        setStats(result.value)
      }, [range, customFrom, customTo])

      useEffect(() => {
        load()
      }, [load])

      const presetId = view === 'hour' ? hourPreset : view === 'minute' ? minutePreset : null

      useEffect(() => {
        if (view === 'day') return
        if (pointStatsMatches(pointStats, view, presetId)) return
        const request = view === 'hour'
          ? resolveHourRange(presetId, new Date())
          : resolveMinuteRange(presetId, new Date())
        const generation = ++pointGenerationRef.current
        setPointStatus('loading')
        requestPost(view === 'hour' ? ENDPOINTS.hours : ENDPOINTS.minutes, request).then((result) => {
          if (pointGenerationRef.current !== generation) return
          if (!result.ok) {
            setPointStatus('error')
            setError(result.message)
            return
          }
          setError('')
          setPointStatus('ok')
          setPointStats({ view, preset: presetId, value: result.value })
        })
      }, [view, presetId, fetchTick])

      const refreshPoints = useCallback(() => {
        setPointStats(null)
        setFetchTick((value) => value + 1)
      }, [])

      const refreshLatestRef = useRef(null)
      refreshLatestRef.current = () => {
        load()
        if (view !== 'day') refreshPoints()
      }
      const refreshTimerRef = useRef(null)
      const scheduleRefresh = useMemo(() => () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(() => refreshLatestRef.current(), STATUS_REFRESH_DEBOUNCE_MS)
      }, [])
      useEffect(() => () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      }, [])

      const refresh = () => {
        setError('')
        if (view === 'day') load()
        else refreshPoints()
      }

      // 回扫状态轮询:运行中快轮,推进时联动数据刷新;restart 供重建按钮重置基线快轮
      useEffect(() => {
        let timer = null
        let alive = true
        let baseDone = null
        const schedule = (delay) => {
          if (!alive) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(tick, delay)
        }
        const tick = async () => {
          timer = null
          const result = await requestPost(ENDPOINTS.status)
          if (!alive) return
          if (!result.ok) {
            schedule(STATUS_POLL_SLOW_MS)
            return
          }
          const value = result.value
          setStatus(value)
          if (value.running) {
            if (baseDone === null || value.done < baseDone) baseDone = value.done
            else if (value.done > baseDone) {
              baseDone = value.done
              scheduleRefresh()
            }
            schedule(STATUS_POLL_FAST_MS)
          }
        }
        tick()
        statusMachineRef.current = { restart: () => { baseDone = 0; schedule(STATUS_POLL_FAST_MS) } }
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          statusMachineRef.current = null
        }
      }, [])

      const grouped = useMemo(() => (stats ? groupStats(stats) : null), [stats])
      const pointView = pointStatsMatches(pointStats, view, presetId) ? pointStats.value : null
      const pointGrouped = useMemo(() => (pointView ? groupPointSlots(pointView.daily) : null), [pointView])
      const colorFor = useMemo(() => colorForModel(stats ? stats.models : []), [stats])

      const pointActive = view !== 'day'
      const trendSource = pointActive
        ? (pointGrouped ? { slots: pointGrouped.daily, models: pointGrouped.models, value: pointView } : null)
        : (grouped ? { slots: grouped.daily, models: grouped.models, value: stats } : null)
      const maxSlots = pointActive ? maxSlotsFor(view, presetId) : DAY_MAX_SLOTS
      const trimmedSlots = trendSource ? trimSlots(trendSource.slots, maxSlots) : null
      const notes = []
      if (trendSource && trendSource.slots.length > trimmedSlots.length) notes.push(trendLimitedText(t, view, trimmedSlots.length))
      if (trendSource?.value?.truncated) notes.push(t('trendTruncated'))

      const busy = pointActive ? pointStatus === 'loading' : loading
      const loadingVisible = pointActive ? pointStatus === 'loading' && !pointView : loading && !stats
      const emptyVisible = !error && (pointActive ? pointView && isEmptyRange(pointView) : stats && isEmptyRange(stats))

      return h('div', { className: 'ud-panel', ref: panelRef },
        h('div', { className: 'ud-toolbar' },
          h('div', { className: 'ud-toolbar-main' },
            h('div', { className: 'ud-group', role: 'group', 'aria-label': t('viewGroup') },
              VIEW_TABS.map((tab) => h('button', {
                key: tab.id,
                className: cx('ud-seg-item', view === tab.id && 'ud-seg-item--on'),
                'aria-pressed': view === tab.id,
                onClick: () => setView(tab.id),
              }, viewLabel(t, tab.id)))),
            pointActive
              ? h('div', { className: 'ud-group', role: 'group', 'aria-label': t('range') },
                  (view === 'hour' ? HOUR_PRESETS : MINUTE_PRESETS).map((id) => h('button', {
                    key: id,
                    className: cx('ud-seg-item', presetId === id && 'ud-seg-item--on'),
                    'aria-pressed': presetId === id,
                    onClick: () => (view === 'hour' ? setHourPreset(id) : setMinutePreset(id)),
                  }, presetLabel(t, view, id))))
              : h(React.Fragment, null,
                  h('div', { className: 'ud-group', role: 'group', 'aria-label': t('range') },
                    DAY_PRESETS.map((id) => h('button', {
                      key: id,
                      className: cx('ud-seg-item', range === id && 'ud-seg-item--on'),
                      'aria-pressed': range === id,
                      onClick: () => setRange(id),
                    }, t(`rangePreset.${id}`))),
                    h('button', {
                      className: cx('ud-seg-item', range === 'custom' && 'ud-seg-item--on'),
                      'aria-pressed': range === 'custom',
                      onClick: () => setRange('custom'),
                    }, t('rangeCustom'))),
                  range === 'custom'
                    ? h('div', { className: 'ud-custom-range' },
                        h('input', {
                          type: 'date', className: 'ud-date-input', 'aria-label': t('from'),
                          value: customFrom, max: customTo || undefined,
                          onChange: (event) => setCustomFrom(event.target.value),
                        }),
                        h('span', { className: 'ud-custom-sep' }, '–'),
                        h('input', {
                          type: 'date', className: 'ud-date-input', 'aria-label': t('to'),
                          value: customTo, min: customFrom || undefined, max: dayBucket(new Date()),
                          onChange: (event) => setCustomTo(event.target.value),
                        }))
                    : null)),
          h('div', { className: 'ud-toolbar-side' },
            h(AnomalyChip, { open: detailsOpen, onToggle: () => setDetailsOpen((v) => !v), t }),
            h('button', {
              className: 'ud-btn ud-btn--text ud-icon-btn', 'aria-label': t('refresh'), title: t('refresh'),
              disabled: busy, onClick: refresh,
            }, h('span', { className: 'ud-icon', dangerouslySetInnerHTML: { __html: REFRESH_ICON_SVG } })))),
        h(StatusRow, { status, t }),
        detailsOpen
          ? h('div', { className: 'ud-detail' },
              h(AnomalyLog, { status, t }),
              h('div', { className: 'ud-detail-foot' },
                h(RebuildButton, { machineRef: statusMachineRef, busy: status?.running === true, onError: setError, t }),
                h(RestoreButton, { machineRef: statusMachineRef, busy: status?.running === true, backup: status?.backup, onError: setError, t })))
          : null,
        error ? h('div', { className: 'ud-error' }, error) : null,
        loadingVisible ? h('div', { className: 'ud-loading' }, `${t('loading')}…`) : null,
        stats ? h(StatCards, { key: 'cards', stats, costCurrency, t }) : null,
        // 活跃热力图仅按天视图展示:热力图口径为日桶,时/分视图无对应语义
        view === 'day' ? h(HeatSection, { key: 'heat', days: heatDays, panelRef, t }) : null,
        trimmedSlots
          ? h(TrendChart, {
              key: 'trend',
              title: trendTitle(t, view),
              notes,
              slots: trimmedSlots,
              modelOrder: trendSource.models.map((item) => item.model),
              colorFor,
              labelFor: tickLabelFor(view),
              slotLabelFor: slotLabelFor(view),
              labelMinPitch: pointActive ? LABEL_PITCH_TIME : LABEL_PITCH_DAY,
              busy,
              legendModels: trendSource.models,
              panelRef,
              costCurrency,
              costEnabled: view === 'day',
              t,
            })
          : null,
        grouped ? h(ModelUsage, { key: 'models', models: grouped.models, colorFor, panelRef, costCurrency, t }) : null,
        stats?.to ? h('div', { className: 'ud-foot' }, `${t('asOf')} ${stats.to}`) : null,
        emptyVisible ? h('div', { className: 'ud-empty' }, t('empty')) : null,
        h(StatsLineOptions, { key: 'prefs', t }),
        h(PricingEditor, { key: 'pricing', t }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyle(document)
        // locale 座随槽声明,语言切换经新 t 引用驱动重渲染;旧宿主无 locale 服务时由 cordis 门控整体未激活
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }), 'usage-dash: dictionaries')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'usage-dash', order: 45, label: () => ctx.locale.bind(LOCALE_NS)('nav'), locale: LOCALE_NS },
            UsageDashPanel,
          ))
        // 两段式接管官方 stats 格:宿主缺该插槽时注册抛错即禁用本功能
        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'stats', order: 0, priority: STATS_SLOT_PRIORITY, locale: LOCALE_NS },
              StatsLineEnhanced,
            ))
        } catch (error) {
          console.warn('[usage-dash] 底部信息栏未注册(宿主无 conversation.composer.dock 插槽)', error)
        }
        // 注入点B:回合费用芯片走官方动作行槽,回合结束随 messageId 出现;旧宿主无该插槽仅告警禁用
        try {
          ctx.slots.inject('conversation.chat.assistant-actions', () =>
            ctx.slots.register(
              { name: 'conversation.chat.assistant-actions', id: 'usage-dash-turn-cost', order: TURN_COST_CHIP_ORDER, locale: LOCALE_NS },
              CostChip,
            ))
        } catch (error) {
          console.warn('[usage-dash] 回合费用芯片未注册(宿主无 conversation.chat.assistant-actions 插槽)', error)
        }
        // 跨实例同步:其他实例写开关经 storage 事件触发重读(同实例写入不触发该事件)
        window.addEventListener('storage', (event) => {
          if (event.key === STATS_LINE_STORAGE_KEY) statsLineState.reload()
        })
      },
    }
  }
}
})()