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
const DEFAULT_MINUTE_PRESET = '3h'

// 天视图渲染上限;时/分上限 = 闭区间桶数(hour N+1 槽,minute N/10+1 槽)
const DAY_MAX_SLOTS = 180
const API_PREFIX = '/api/usage-dash/'
const ENDPOINTS = { range: 'range', hours: 'hours', minutes: 'minutes', status: 'status', reset: 'reset', restore: 'restore', pricing: 'pricing' }
// 成本控制端点名:四模块共用一张表,各模块只取自己需要的键,避免并行改动同一常量
const COST_ENDPOINTS = {
  summary: 'summary',
  budget: 'budget',
  cycle: 'cycle',
  sentinel: 'sentinel',
  sentinelAck: 'sentinel/ack',
  whatif: 'whatif',
  features: 'features',
}

// 模型免折叠上限:条目不超它全展示,超过才折叠为 top(上限-1)+Other
const GROUP_UNFOLDED_MAX = 5
const OTHER_MODEL = '\u0000other'

const PAD_WIDTH = 2
const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_MINUTE = 60 * 1000

const pad = (value) => String(value).padStart(PAD_WIDTH, '0')

// 桶键日历以宿主时区为准:服务端 status 下发 IANA timeZone,客户端按同一时区
// 生成 from/to;缺省(旧宿主/首帧未取到)回落浏览器本地时区。formatter 缓存,
// 非法时区退回本地,避免旧浏览器抛错拖垮面板。
const zoneFormatters = new Map()
function zonedParts(date, timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    }
  }
  let formatter = zoneFormatters.get(timeZone)
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
    } catch {
      formatter = null
    }
    zoneFormatters.set(timeZone, formatter)
  }
  if (formatter === null) return zonedParts(date, undefined)
  const parts = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute }
}
const formatDayParts = (parts) => `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
const formatDate = (date, timeZone) => formatDayParts(zonedParts(date, timeZone))

function dayBucket(date, timeZone) {
  return formatDate(date, timeZone)
}
function hourBucket(date, timeZone) {
  const parts = zonedParts(date, timeZone)
  return `${formatDayParts(parts)}T${pad(parts.hour)}`
}
function minuteBucket(date, timeZone) {
  const parts = zonedParts(date, timeZone)
  return `${formatDayParts(parts)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

// 纯日历日推进:不经过 Date 的本地时区/夏令时,跨月跨年由 UTC 分量进位
function shiftDayKey(day, offsetDays) {
  const [year, month, date] = day.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, date + offsetDays))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

function localDay(offsetDays, now = new Date(), timeZone) {
  return shiftDayKey(formatDate(now, timeZone), offsetDays)
}

const hourValueOf = (presetId) => HOUR_PRESET_HOURS[presetId]
const minuteValueOf = (presetId) => MINUTE_PRESET_MINUTES[presetId]

function resolveDayRange(presetId, now = new Date(), timeZone) {
  const days = Number(presetId)
  if (!Number.isInteger(days) || days <= 0) return null
  return { from: localDay(-(days - 1), now, timeZone), to: formatDate(now, timeZone) }
}

// 墙钟毫秒:把目标时区下的日历分量装进 UTC 纪元,后续按分量推进/取整,
// 不受运行环境时区与夏令时影响。桶键是墙钟语义,加减小时按分量推进。
const wallMillisecondsOf = (parts) => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
const formatWallHour = (ms) => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}`
}
const formatWallMinute = (ms) => {
  const date = new Date(ms)
  return `${formatWallHour(ms)}:${pad(date.getUTCMinutes())}`
}

function resolveHourRange(presetId, now = new Date(), timeZone) {
  const hours = hourValueOf(presetId)
  if (!hours) return null
  // 闭区间槽数 = 墙钟小时跨度 + 1;起点按墙钟回推,保证 15d 挡恒为 N*24+1 槽
  const wallNow = wallMillisecondsOf(zonedParts(now, timeZone))
  return { from: formatWallHour(wallNow - hours * MS_PER_HOUR), to: formatWallHour(wallNow) }
}

// 分钟桶对齐 10 分钟粒度:窗口起点落到桶边界,to 保持原始分钟(闭区间上界)
const MINUTE_BUCKET_SPAN_MINUTES = 10
const MINUTE_BUCKET_SPAN_MS = MINUTE_BUCKET_SPAN_MINUTES * MS_PER_MINUTE

// 分钟桶起点按本地墙钟向下取整,与 store/minuteKey 同口径:偏移非整十分钟的
// 时区(尼泊尔 +5:45)里按 UTC 纪元取整会得到 :45 这类非桶分钟,请求被服务端拒绝
function minuteBucketFloor(ts, offsetMinutes = new Date(ts).getTimezoneOffset()) {
  const offsetMs = offsetMinutes * MS_PER_MINUTE
  return Math.floor((ts - offsetMs) / MINUTE_BUCKET_SPAN_MS) * MINUTE_BUCKET_SPAN_MS + offsetMs
}

function resolveMinuteRange(presetId, now = new Date(), timeZone) {
  const minutes = minuteValueOf(presetId)
  if (!minutes) return null
  const wallNow = wallMillisecondsOf(zonedParts(now, timeZone))
  const from = Math.floor(wallNow / MINUTE_BUCKET_SPAN_MS) * MINUTE_BUCKET_SPAN_MS
  return { from: formatWallMinute(from - minutes * MS_PER_MINUTE), to: formatWallMinute(wallNow) }
}

// 自定义挡 id 与时/分自定义跨度上限(与数据保留期一致:小时桶固定 15 天,分钟桶上限 7 天)
const CUSTOM_RANGE_ID = 'custom'
const HOUR_CUSTOM_MAX_HOURS = 15 * 24
const MINUTE_CUSTOM_MAX_MINUTES = 7 * 24 * 60
// 选中自定义挡且无历史输入时的预填窗口
const POINT_CUSTOM_DEFAULT_HOURS = 24

const DATETIME_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

// datetime-local 输入值解析为本地时刻,形态或日历非法(13 月/2 月 30 日/回卷)返回 null
function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null
  const match = DATETIME_INPUT_PATTERN.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1)
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0)]
  const date = new Date(...parts)
  const components = [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]
  // 数字分量构造对超界值静默回卷,逐分量回读比对拦截
  const legal = parts.slice(0, 5).every((part, index) => components[index] === part)
  return legal ? date : null
}

// datetime-local 输入值是宿主墙钟:解析后只取日历分量装进墙钟毫秒,
// 避免用浏览器本地时区的绝对毫秒做跨时区运算
const wallMillisecondsOfDateTime = (date) => Date.UTC(
  date.getFullYear(),
  date.getMonth(),
  date.getDate(),
  date.getHours(),
  date.getMinutes(),
)

const formatDateTimeInput = (date, timeZone) => minuteBucket(date, timeZone)

// 小时自定义范围:两端归一到所在小时桶(闭区间),跨度超保留期按墙钟钳起点
function resolveHourCustomRange(fromValue, toValue) {
  const from = parseLocalDateTime(fromValue)
  const to = parseLocalDateTime(toValue)
  if (!from || !to || from.getTime() > to.getTime()) return null
  const fromWall = wallMillisecondsOfDateTime(from)
  const toWall = wallMillisecondsOfDateTime(to)
  const clampedFrom = toWall - fromWall > HOUR_CUSTOM_MAX_HOURS * MS_PER_HOUR
    ? toWall - HOUR_CUSTOM_MAX_HOURS * MS_PER_HOUR
    : fromWall
  return { from: formatWallHour(clampedFrom), to: formatWallHour(toWall) }
}

// 分钟自定义范围:from 对齐 10 分钟桶边界,to 保持原始分钟(闭区间上界),跨度超保留期钳起点
function resolveMinuteCustomRange(fromValue, toValue) {
  const from = parseLocalDateTime(fromValue)
  const to = parseLocalDateTime(toValue)
  if (!from || !to || from.getTime() > to.getTime()) return null
  const fromWall = wallMillisecondsOfDateTime(from)
  const toWall = wallMillisecondsOfDateTime(to)
  const floor = (ms) => Math.floor(ms / MINUTE_BUCKET_SPAN_MS) * MINUTE_BUCKET_SPAN_MS
  const clampedFrom = Math.max(
    floor(fromWall),
    floor(toWall) - MINUTE_CUSTOM_MAX_MINUTES * MS_PER_MINUTE,
  )
  return { from: formatWallMinute(clampedFrom), to: formatWallMinute(toWall) }
}

// 时/分查询请求与缓存键:预设挡键为挡位 id,自定义挡键含归一后桶串(范围变化即换键防误命中)。
// 缓存命中还须匹配宿主时区:同一挡位 id 在浏览器/宿主不同日历时请求范围不同,
// 只用 id 命中会把旧时区的点数当新时区数据显示
function resolvePointQuery(view, preset, customFrom, customTo, now = new Date(), timeZone) {
  const withZone = (range, key) => ({ request: range, key, timeZone: timeZone ?? null })
  if (view === 'hour') {
    if (preset === CUSTOM_RANGE_ID) {
      const range = resolveHourCustomRange(customFrom, customTo)
      return range ? withZone(range, `${CUSTOM_RANGE_ID}:${range.from}:${range.to}`) : null
    }
    return withZone(resolveHourRange(preset, now, timeZone), preset)
  }
  if (view === 'minute') {
    if (preset === CUSTOM_RANGE_ID) {
      const range = resolveMinuteCustomRange(customFrom, customTo)
      return range ? withZone(range, `${CUSTOM_RANGE_ID}:${range.from}:${range.to}`) : null
    }
    return withZone(resolveMinuteRange(preset, now, timeZone), preset)
  }
  return null
}

function maxSlotsFor(view, presetId) {
  if (view === 'hour') return (presetId === CUSTOM_RANGE_ID ? HOUR_CUSTOM_MAX_HOURS : hourValueOf(presetId)) + 1
  if (view === 'minute') {
    return (presetId === CUSTOM_RANGE_ID ? MINUTE_CUSTOM_MAX_MINUTES : minuteValueOf(presetId)) / MINUTE_BUCKET_SPAN_MINUTES + 1
  }
  return DAY_MAX_SLOTS
}

function trimSlots(slots, max) {
  return slots.length > max ? slots.slice(-max) : slots
}

// 时/分挡位表存在同 id(如 '24h'),点数据缓存命中须视图、挡位与时区三重匹配,
// 防跨视图/跨日历误用他端点数据
function pointStatsMatches(cached, view, presetId, timeZone) {
  return !!cached && cached.view === view && cached.preset === presetId && cached.timeZone === timeZone
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

// —— 成本控制四模块的文案、样式与 UI 门控:并行开发时各模块只改自己这一块 ——
// 词条经展开并入主词典,样式经插值并入 STYLE_CSS,主词典与主样式保持不动。
const WHATIF_MESSAGES_ZH = {
  'whatif.title': '省钱沙盘',
  'whatif.description': '假设换个模型、提高缓存命中、把用量挪到低价时段,按当前定价重新算一遍要花多少钱。只算不改配置',
  'whatif.suggestionCount': '{n} 条建议',
  'whatif.noPricing': '先配置定价规则',
  'whatif.noPricingHint': '省钱沙盘需要定价规则才能估算金额,请先在上方定价规则中配置模型价格。',
  'whatif.days': '统计范围',
  'whatif.days.30': '30 天',
  'whatif.days.90': '90 天',
  'whatif.targetModel': '目标模型',
  'whatif.targetModelPlaceholder': 'provider/model',
  'whatif.targetModelHint': '填 服务商/模型,如 deepseek/deepseek-chat',
  'whatif.invalidModel': '需两段 provider/model,段可通配',
  'whatif.loading': '正在计算…',
  'whatif.rulesLoading': '正在加载定价规则…',
  'whatif.empty': '所选范围暂无用量',
  'whatif.error': '沙盘计算失败',
  'whatif.costFlow': '基线 {baseline} → 场景 {scenario}',
  'whatif.detail.targetModel': '目标 {model}',
  'whatif.detail.hitRate': '目标命中率 {rate}%',
  'whatif.detail.shift': '移动 {ratio}% 用量',
  'whatif.scenario.modelSwap': '全部换成目标模型',
  'whatif.scenario.cacheLeverage': '缓存命中率提升',
  'whatif.scenario.offpeakShift': '用量移到低价时段',
  'whatif.reason.empty': '暂无用量',
  'whatif.reason.unpricedModels': '缺少 {models} 的定价',
  'whatif.reason.targetModelRequired': '请填写目标模型',
  'whatif.reason.targetModelUnpriced': '目标模型没有定价规则',
  'whatif.reason.offpeakUnpriced': '缺少 {model} 的差异时段定价',
  'whatif.reason.offpeakNoDifferential': '没有可用的差异时段价格',
}
const GUARD_MESSAGES_ZH = {
  guard: '成本护栏',
  guardSectionDesc: '每次模型请求前按预算判定放行、降级或拦截',
  guardEnable: '启用成本护栏',
  guardEnableDesc: '超限时按档位动作处理,拦截发生在请求发出之前',
  guardDailyLimitHint: '每天最多允许花多少钱;0 表示这一档不限制',
  guardMonthlyLimitHint: '每个计费周期最多允许花多少钱;0 表示这一档不限制',
  guardActionHint: '用超之后怎么办:提示只发通知;降级改用降级目标模型;拦截直接拒绝请求',
  guardWarnRatioHint: '花到额度的这个百分比时先提醒一次;填 1-99 的数值',
  guardDailyLimit: '日限额',
  guardMonthlyLimit: '周期限额',
  guardDailyAction: '每日超限动作',
  guardMonthlyAction: '周期超限动作',
  guardActionWarn: '提示',
  guardActionDegrade: '降级',
  guardActionBlock: '拦截',
  guardDegradeModel: '降级目标模型',
  guardDegradeModelHint: '两段式 服务商/模型,留空则降级退化为提示',
  guardWarnRatio: '预警阈值',
  guardNotify: '超限通知',
  guardNotifyDesc: '触发限额时提醒一次',
  guardSave: '保存',
  guardSaving: '保存中…',
  guardSaved: '已保存',
  guardSaveFailed: '保存失败',
  guardUnavailable: '预算设置不可用',
  guardInvalidLimit: '请输入不小于 0 的数字',
  guardInvalidPercent: '请输入 0 到 100 之间的数字',
  guardStateOk: '正常',
  guardStateWarn: '预警',
  guardStateDanger: '已熔断',
  guardStateOff: '已关闭',
  guardSpentDaily: '今日 {spent} / {limit}',
  guardSpentMonthly: '本周期 {spent} / {limit}',
  guardRemaining: '剩余 {value}',
  guardEta: '预计 {hours} 小时后触顶',
  guardEtaNone: '暂无触顶预估',
  guardNoLimit: '未配置限额',
  guardNoStatus: '暂无预算状态',
}
const SENTINEL_MESSAGES_ZH = {
  sentinelTitle: '异常哨兵',
  sentinelDesc: '以同星期历史为基线,识别费用燃烧、缓存命中率骤降、模型漂移与静默燃烧',
  sentinelEventCount: '{n} 条异常',
  sentinelEnabled: '启用异常哨兵',
  sentinelEnabledDesc: '关闭后停止检测,已有事件保留在列表中',
  whatifEnable: '启用省钱沙盘',
  whatifEnableDesc: '打开后按当前定价模拟三种省钱场景,只读不写',
  dockEnable: '输入区常驻读数',
  dockEnableDesc: '在输入框工具行显示今日花费与预算额度',
  featureOff: '已关闭',
  featureDisabledHint: '功能未启用,打开上方开关后生效',
  guardNotEnabled: '未启用,不拦截请求',
  sentinelBurnMultiplier: '燃烧阈值(倍)',
  sentinelBurnMultiplierDesc: '最近 30 分钟的花费,比过去同星期同一时段的高水位(95% 分位)高出多少倍就报警。2 倍 = 花得比平时快一倍',
  sentinelCacheDrop: '缓存下降(百分点)',
  sentinelCacheDropDesc: '最近 1 小时的缓存命中率,比历史正常水平低了多少个百分点就报警。缓存没命中等于同样的活花更多钱',
  sentinelQuietBurn: '静默分钟',
  sentinelQuietBurnDesc: '没有新输入却还在计费超过多少分钟就报警,用来抓卡住空转的任务',
  sentinelEmpty: '暂无异常',
  sentinelLoading: '加载中…',
  sentinelRefresh: '刷新',
  sentinelAck: '忽略',
  sentinelBaselineInsufficient: '基线数据不足:目前 {days} 天,至少需要 7 天。哨兵暂不产出事件。',
  sentinelNoPricing: '尚未配置定价规则,无法计算费用基线,哨兵暂不产出事件。',
  sentinelDisabled: '异常哨兵已关闭。',
  sentinelUnavailable: '用量存储尚未就绪,哨兵暂不产出事件。',
  sentinelError: '哨兵状态读取失败,请稍后重试。',
  sentinelBaselineReady: '基线 {days} 天,同日 p95 {p95}',
  sentinelEvidenceBurn: '近 {window} 分钟 {cost},同星期 p95 {p95},倍率 {multiplier}×',
  sentinelEvidenceCache: '近 {window} 分钟命中率 {recent}%,基线 {baseline}%,下降 {drop} 个百分点',
  sentinelEvidenceModel: '近 {window} 小时主用 {current}({currentShare}%),基线主用 {baseline}({baselineShare}%)',
  sentinelEvidenceQuiet: '静默 {idle} 分钟,窗口内 {cost};口径:{basis}',
  'sentinelKind.burn-spike': '费用燃烧突增',
  'sentinelKind.cache-drop': '缓存命中率骤降',
  'sentinelKind.model-drift': '主用模型漂移',
  'sentinelKind.quiet-burn': '静默燃烧',
  'sentinelSuggestion.burn-spike': '核对最近请求与定价规则,确认是否为预期内的批量任务',
  'sentinelSuggestion.cache-drop': '检查最近请求的提示词前缀是否变化,或模型缓存策略是否调整',
  'sentinelSuggestion.model-drift': '确认新模型是否为预期切换;若非预期,检查默认模型与降级配置',
  'sentinelSuggestion.quiet-burn': '确认后台任务是否仍在运行;如非预期,结束该会话或任务',
  'sentinelLevel.info': '提示',
  'sentinelLevel.warn': '警告',
  'sentinelLevel.danger': '严重',
  'sentinelBasis.last-input': '最近用户输入',
  'sentinelBasis.request-window-approx': '最近 30 分钟请求近似',
}
const HUD_MESSAGES_ZH = {
  hudTitle: '用量摘要',
  hudSubtitle: '今日与本周期实时花费,按当前定价规则估算',
  hudToday: '今日',
  hudMonth: '本周期',
  hudRate: '当前速率',
  hudCacheHit: '缓存命中率',
  hudTokens: '{n} tokens',
  hudRequests: '{n} 次请求',
  hudNoPricing: '未配置定价规则,费用不可用',
  hudLoading: '正在读取用量摘要',
  hudError: '摘要读取失败,下个刷新周期重试',
  hudBudgetTitle: '预算',
  hudDailyLimit: '日限额',
  hudMonthlyLimit: '周期限额',
  hudRemaining: '剩余 {value}',
  hudEtaHours: '约 {hours}h',
  hudEtaDays: '约 {days} 天',
  hudEtaMinutes: '约 {minutes} 分钟',
  hudEtaNone: '暂不可估',
  hudSparkTitle: '近 24 小时费用',
  hudDisplayTitle: '显示',
  hudSparkEmpty: '近 24 小时暂无费用数据',
  hudActionWarn: '接近限额',
  hudActionDegrade: '已降级',
  hudActionBlock: '已拦截',
  hudTipTodayDesc: '今天 0 点到现在的花费,按定价规则估算',
  hudTipMonthDesc: '当前计费周期起点到现在的累计花费',
  hudTipRateDesc: '最近三个完整 10 分钟桶的花费折算成每小时的速度,用来预估额度什么时候用完',
  hudTipCacheDesc: '命中缓存的输入 token 占比。缓存读取比正常输入便宜,命中率越高越省钱',
  hudTipExact: '精确值',
  cycleLabel: '计费周期',
  cycleKindCalendar: '自然月',
  cycleKindMonthly: '每月账单日',
  cycleKindRolling: '滚动天数',
  cycleStartDay: '账单日(每月第几天)',
  cycleDays: '周期天数',
  cycleSaveFailed: '计费周期保存失败',
  cycleInvalidValue: '请输入 {min}-{max} 之间的整数',
  featureToggleFailed: '开关保存失败,宿主设置服务可能不可用',
  hudTipToday: '今日花费',
  hudTipMonth: '本周期花费',
  hudTipRate: '近期速率',
  hudTipTodayTokens: '今日 tokens',
  hudTipMonthTokens: '本周期 tokens',
  hudTipCostSection: '费用',
  hudTipBudgetSection: '{scope}额度(护栏限额)',
  hudTipLimit: '已用 / 总额',
  hudTipLimitScope: '{scope}口径:已用金额 / 该档限额,进度条按占比填充',
  hudTipRemaining: '剩余可用',
  hudTipEta: '按当前速率可再用',
  hudTipExplain: '费用 = 每次请求的 tokens 乘以定价规则里的单价,是估算值;速率取最近三个完整 10 分钟桶折算。额度就是护栏卡里填的限额,用完之后的动作(提示 / 降级 / 拦截)由该卡决定。读数最多每 30 秒刷新一次。',
  hudTipNoPricing: '还没配定价规则,所以只能显示 token 用量。到设置页「使用统计 → 定价规则」填上单价就能看到金额。',
}
const WHATIF_MESSAGES_EN = {
  'whatif.title': 'Savings sandbox',
  'whatif.description': 'Assume a different model, a higher cache-hit rate, or shifting usage to cheaper hours, then re-price it with your current rules. Calculation only, nothing is changed',
  'whatif.suggestionCount': '{n} suggestions',
  'whatif.noPricing': 'Configure pricing first',
  'whatif.noPricingHint': 'The savings sandbox needs pricing rules to estimate costs. Configure model prices in the pricing section above first.',
  'whatif.days': 'Range',
  'whatif.days.30': '30 days',
  'whatif.days.90': '90 days',
  'whatif.targetModel': 'Target model',
  'whatif.targetModelPlaceholder': 'provider/model',
  'whatif.targetModelHint': 'Use provider/model, e.g. deepseek/deepseek-chat',
  'whatif.invalidModel': 'Requires two segments provider/model; segments may be wildcards',
  'whatif.loading': 'Calculating…',
  'whatif.rulesLoading': 'Loading pricing rules…',
  'whatif.empty': 'No usage in the selected range',
  'whatif.error': 'Sandbox calculation failed',
  'whatif.costFlow': 'Baseline {baseline} → scenario {scenario}',
  'whatif.detail.targetModel': 'Target {model}',
  'whatif.detail.hitRate': 'Target hit rate {rate}%',
  'whatif.detail.shift': 'Shift {ratio}% of usage',
  'whatif.scenario.modelSwap': 'Swap all to target model',
  'whatif.scenario.cacheLeverage': 'Raise cache hit rate',
  'whatif.scenario.offpeakShift': 'Move usage to off-peak',
  'whatif.reason.empty': 'No usage',
  'whatif.reason.unpricedModels': 'Missing pricing for {models}',
  'whatif.reason.targetModelRequired': 'Enter a target model',
  'whatif.reason.targetModelUnpriced': 'Target model has no pricing rule',
  'whatif.reason.offpeakUnpriced': 'Missing off-peak pricing for {model}',
  'whatif.reason.offpeakNoDifferential': 'No differential time price available',
}
const GUARD_MESSAGES_EN = {
  guard: 'Cost guard',
  guardSectionDesc: 'Decide allow, degrade, or block before every model request',
  guardEnable: 'Enable cost guard',
  guardEnableDesc: 'Over-limit actions apply per scope; blocking happens before the request leaves',
  guardDailyLimitHint: 'Most you allow per day; 0 means no limit for this scope',
  guardMonthlyLimitHint: 'Most you allow per billing cycle; 0 means no limit for this scope',
  guardActionHint: 'What happens past the limit: warn only notifies; degrade switches to the target model; block rejects the request',
  guardWarnRatioHint: 'Send one reminder at this share of the limit; enter a value between 1 and 99',
  guardDailyLimit: 'Daily limit',
  guardMonthlyLimit: 'Cycle limit',
  guardDailyAction: 'Daily over-limit action',
  guardMonthlyAction: 'Cycle over-limit action',
  guardActionWarn: 'Notify',
  guardActionDegrade: 'Degrade',
  guardActionBlock: 'Block',
  guardDegradeModel: 'Degrade target model',
  guardDegradeModelHint: 'Two-segment provider/model; leave empty to keep degrade as a notice',
  guardWarnRatio: 'Warn threshold',
  guardNotify: 'Over-limit notice',
  guardNotifyDesc: 'Send one notice when a limit is hit',
  guardSave: 'Save',
  guardSaving: 'Saving…',
  guardSaved: 'Saved',
  guardSaveFailed: 'Save failed',
  guardUnavailable: 'Budget settings unavailable',
  guardInvalidLimit: 'Enter a number no less than 0',
  guardInvalidPercent: 'Enter a number between 0 and 100',
  guardStateOk: 'OK',
  guardStateWarn: 'Warning',
  guardStateDanger: 'Tripped',
  guardStateOff: 'Off',
  guardSpentDaily: 'Today {spent} / {limit}',
  guardSpentMonthly: 'This cycle {spent} / {limit}',
  guardRemaining: '{value} left',
  guardEta: 'Hits the limit in about {hours}h',
  guardEtaNone: 'No ETA yet',
  guardNoLimit: 'No limit configured',
  guardNoStatus: 'No budget status yet',
}
const SENTINEL_MESSAGES_EN = {
  sentinelTitle: 'Anomaly sentinel',
  sentinelDesc: 'Detects burn spikes, cache-hit drops, model drift and quiet burn against same-weekday history',
  sentinelEventCount: '{n} anomalies',
  sentinelEnabled: 'Enable anomaly sentinel',
  sentinelEnabledDesc: 'Stops detection when disabled; existing events stay in the list',
  whatifEnable: 'Enable cost what-if',
  whatifEnableDesc: 'Simulates three savings scenarios at current pricing; read-only',
  dockEnable: 'Inline cost readout',
  dockEnableDesc: 'Shows today spend and budget in the composer toolbar',
  featureOff: 'Off',
  featureDisabledHint: 'Not enabled — turn on the switch above',
  guardNotEnabled: 'Off; requests are not intercepted',
  sentinelBurnMultiplier: 'Burn threshold (x)',
  sentinelBurnMultiplierDesc: 'How many times the recent 30-minute spend may exceed its high-water mark (95th percentile) for the same weekday and hour before alerting. 2x means spending twice as fast as usual',
  sentinelCacheDrop: 'Cache drop (points)',
  sentinelCacheDropDesc: 'How many points the last hour cache-hit rate may fall below its historical normal before alerting. Misses mean the same work costs more',
  sentinelQuietBurn: 'Quiet minutes',
  sentinelQuietBurnDesc: 'Alert when billing keeps running this many minutes without new input, to catch stuck tasks',
  sentinelEmpty: 'No anomalies',
  sentinelLoading: 'Loading…',
  sentinelRefresh: 'Refresh',
  sentinelAck: 'Ignore',
  sentinelBaselineInsufficient: 'Baseline is insufficient: {days} days collected, at least 7 required. No events are emitted.',
  sentinelNoPricing: 'No pricing rules configured; cost baseline is unavailable and no events are emitted.',
  sentinelDisabled: 'Anomaly sentinel is disabled.',
  sentinelUnavailable: 'Usage storage is not ready; no events are emitted.',
  sentinelError: 'Failed to read sentinel status, retry later.',
  sentinelBaselineReady: 'Baseline {days} days, same-weekday p95 {p95}',
  sentinelEvidenceBurn: 'Last {window} min {cost}, same-weekday p95 {p95}, multiplier {multiplier}x',
  sentinelEvidenceCache: 'Last {window} min hit rate {recent}%, baseline {baseline}%, down {drop} points',
  sentinelEvidenceModel: 'Last {window}h top model {current} ({currentShare}%), baseline {baseline} ({baselineShare}%)',
  sentinelEvidenceQuiet: 'Quiet for {idle} min, window cost {cost}; basis: {basis}',
  'sentinelKind.burn-spike': 'Cost burn spike',
  'sentinelKind.cache-drop': 'Cache-hit drop',
  'sentinelKind.model-drift': 'Top-model drift',
  'sentinelKind.quiet-burn': 'Quiet burn',
  'sentinelSuggestion.burn-spike': 'Review the recent requests and pricing rules; confirm the batch is expected',
  'sentinelSuggestion.cache-drop': 'Check whether prompt prefixes changed or the model cache policy was adjusted',
  'sentinelSuggestion.model-drift': 'Confirm the new model switch is intended; otherwise check the default and degrade model settings',
  'sentinelSuggestion.quiet-burn': 'Check whether the background task is still running; stop the session or task if unexpected',
  'sentinelLevel.info': 'Info',
  'sentinelLevel.warn': 'Warning',
  'sentinelLevel.danger': 'Critical',
  'sentinelBasis.last-input': 'last user input',
  'sentinelBasis.request-window-approx': 'recent 30-minute requests approximation',
}
const HUD_MESSAGES_EN = {
  hudTitle: 'Usage summary',
  hudSubtitle: 'Today and cycle-to-date spend at current pricing',
  hudToday: 'Today',
  hudMonth: 'This cycle',
  hudRate: 'Current rate',
  hudCacheHit: 'Cache-hit rate',
  hudTokens: '{n} tokens',
  hudRequests: '{n} requests',
  hudNoPricing: 'No pricing rules configured; costs unavailable',
  hudLoading: 'Loading usage summary',
  hudError: 'Failed to load the summary; retrying next refresh',
  hudBudgetTitle: 'Budget',
  hudDailyLimit: 'Daily limit',
  hudMonthlyLimit: 'Cycle limit',
  hudRemaining: '{value} left',
  hudEtaHours: '~{hours}h',
  hudEtaDays: '~{days}d',
  hudEtaMinutes: '~{minutes} min',
  hudEtaNone: 'not yet',
  hudSparkTitle: 'Spend, last 24 hours',
  hudDisplayTitle: 'Display',
  hudSparkEmpty: 'No spend in the last 24 hours',
  hudActionWarn: 'Near limit',
  hudActionDegrade: 'Degraded',
  hudActionBlock: 'Blocked',
  hudTipTodayDesc: 'Spend since 00:00 today, estimated from your pricing rules',
  hudTipMonthDesc: 'Accumulated spend since the current billing cycle started',
  hudTipRateDesc: 'The last three complete 10-minute buckets projected to an hourly rate; used to estimate when the budget runs out',
  hudTipCacheDesc: 'Share of input tokens served from cache. Cache reads are cheaper than normal input, so a higher rate costs less',
  hudTipExact: 'Exact',
  cycleLabel: 'Billing cycle',
  cycleKindCalendar: 'Calendar month',
  cycleKindMonthly: 'Monthly billing day',
  cycleKindRolling: 'Rolling days',
  cycleStartDay: 'Billing day (day of month)',
  cycleDays: 'Cycle length (days)',
  cycleSaveFailed: 'Failed to save billing cycle',
  cycleInvalidValue: 'Enter an integer between {min} and {max}',
  featureToggleFailed: 'Failed to save the switch; the settings service may be unavailable',
  hudTipToday: 'Today',
  hudTipMonth: 'This cycle',
  hudTipRate: 'Recent rate',
  hudTipTodayTokens: 'Today tokens',
  hudTipMonthTokens: 'Cycle tokens',
  hudTipCostSection: 'Cost',
  hudTipBudgetSection: '{scope} budget (guard limit)',
  hudTipLimit: 'Used / limit',
  hudTipLimitScope: '{scope} scope: spent / limit, the bar fills by ratio',
  hudTipRemaining: 'Remaining',
  hudTipEta: 'Lasts about',
  hudTipExplain: 'Cost = tokens per request times the unit prices in your pricing rules, so it is an estimate. The rate projects the last three complete 10-minute buckets to an hourly figure. The budget is the limit you filled in the guard card; what happens past it (warn / degrade / block) is up to that card. The readout refreshes at most every 30 seconds.',
  hudTipNoPricing: 'No pricing rules yet, so only token counts are shown. Add unit prices under Settings → Usage → Pricing rules to see money.',
}
const WHATIF_CSS = `
.ud-whatif-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.ud-whatif-field{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.ud-whatif-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ud-whatif-input{width:200px;height:32px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px}
.ud-whatif-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ud-whatif-input:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px;border-color:var(--dsw-alias-state-business-primary)}
.ud-whatif-input--invalid{border-color:var(--dsw-alias-state-error-primary)}
.ud-whatif-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-whatif-error-text{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.ud-whatif-list{display:flex;flex-direction:column;gap:8px}
.ud-whatif-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
.ud-whatif-name{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap}
.ud-whatif-detail{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);min-width:0;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ud-whatif-flow{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ud-whatif-delta{font-size:12px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.ud-whatif-delta--save{color:var(--dsw-alias-state-success-primary)}
.ud-whatif-delta--cost{color:var(--dsw-alias-state-error-primary)}
.ud-whatif-unavailable{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ud-whatif-loading{padding:8px 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
@media (max-width:560px){.ud-whatif-input{width:100%}.ud-whatif-field{flex:1 1 100%}.ud-whatif-flow,.ud-whatif-unavailable{margin-left:0;width:100%}}
`
const GUARD_CSS = `
.ud-guard-block{display:flex;flex-direction:column;gap:12px}
.ud-guard-status{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ud-guard-status-item{white-space:nowrap}
.ud-guard-badge{flex:none;padding:0 6px;border-radius:999px;font-size:11px;line-height:16px;font-weight:600}
.ud-guard-badge--ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.ud-guard-badge--warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.ud-guard-badge--danger{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.ud-guard-badge--off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.ud-guard-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ud-guard-amount{display:flex;align-items:center;gap:6px;min-width:0}
.ud-guard-amount .ud-input{flex:1 1 auto;min-width:0}
.ud-guard-unit{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-guard-select{height:26px;padding:0 4px}
.ud-guard-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-guard-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.ud-guard-actions .ud-btn--text{display:inline-flex;align-items:center;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}
@media (hover:hover){.ud-guard-actions .ud-btn--text:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.ud-guard-actions .ud-btn--text:disabled{opacity:.5;cursor:default}
.ud-guard-saved{font-size:11px;line-height:16px;color:var(--dsw-alias-state-success-primary)}
@media (max-width:720px){.ud-guard-grid{grid-template-columns:minmax(0,1fr)}}
`
// 与 host sentinel.js 的默认阈值同源;客户端只作首帧回退,持久化仍走宿主 settings
const SENTINEL_DEFAULT_CONFIG = { burnMultiplier: 3, cacheDropPoints: 20, quietBurnMinutes: 20 }
// 四模块开关镜像:与宿主 features 契约同源,默认全关
const FEATURE_KEYS = ['whatif', 'guard', 'sentinel', 'dock']
const FEATURES_DEFAULT = Object.fromEntries(FEATURE_KEYS.map((key) => [key, false]))
const SENTINEL_CSS = `
.ud-sentinel-block{display:flex;flex-direction:column;gap:8px}
.ud-sentinel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:4px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ud-sentinel-head-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-sentinel-head-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ud-sentinel-head-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-sentinel-thresholds{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.ud-sentinel-threshold{display:flex;flex-direction:column;gap:4px;min-width:0}
.ud-sentinel-threshold-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-sentinel-threshold .ud-input{font-size:12px}
.ud-sentinel-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-sentinel-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:8px 0}
.ud-sentinel-events{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.ud-sentinel-event{display:flex;flex-direction:column;gap:4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:8px 12px}
.ud-sentinel-event-head{display:flex;align-items:center;gap:8px;min-width:0}
.ud-sentinel-time{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ud-sentinel-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-sentinel-level{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;white-space:nowrap}
.ud-sentinel-level--info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.ud-sentinel-level--warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.ud-sentinel-level--danger{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.ud-sentinel-evidence{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ud-sentinel-suggestion{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ud-sentinel-event-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.ud-sentinel-ack{flex:none}
`
const HUD_CSS = `
.ud-hud{display:flex;flex-direction:column;gap:16px;flex:1;min-height:0;box-sizing:border-box;padding:24px;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ud-hud--embedded{flex:none;min-height:auto;padding:0;overflow:visible;background:none}
.ud-hud-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.ud-cycle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.ud-cycle-label{color:var(--dsw-alias-label-tertiary)}
.ud-cycle-kind{max-width:140px}
.ud-cycle-num{width:88px}
.ud-cycle-range{font-variant-numeric:tabular-nums}
.ud-cycle-error{color:var(--dsw-alias-state-error-primary)}
.ud-hud--embedded .ud-hud-cards{grid-template-columns:repeat(2,minmax(0,1fr))}
.ud-hud--embedded .ud-hud-section{padding:0;border:0;background:none}
.ud-hud-card{display:flex;flex-direction:column;gap:4px;min-width:0;padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.ud-hud-card-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-hud-card-value{font-size:14px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ud-hud-card-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ud-hud-section{display:flex;flex-direction:column;gap:8px;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.ud-hud-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;line-height:20px;font-weight:600}
.ud-hud-badge{padding:2px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);font-size:11px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.ud-hud-badge--warn{color:var(--dsw-alias-state-warn-primary)}
.ud-hud-badge--danger{color:var(--dsw-alias-state-error-primary)}
.ud-hud-budget-row{display:flex;flex-direction:column;gap:4px}
.ud-hud-budget-line{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.ud-hud-budget-value{font-variant-numeric:tabular-nums}
.ud-hud-budget-track{height:6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);overflow:hidden}
.ud-hud-budget-fill{height:100%;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-success-primary)}
.ud-hud-budget-fill--warn{background:var(--dsw-alias-state-warn-primary)}
.ud-hud-budget-fill--danger{background:var(--dsw-alias-state-error-primary)}
.ud-hud-budget-meta{display:flex;justify-content:space-between;gap:12px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ud-hud-spark-wrap{display:flex;flex-direction:column;gap:4px}
.ud-hud-spark{display:block;width:100%;height:56px}
.ud-hud-spark-line{fill:none;stroke:var(--dsw-alias-state-business-primary);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.ud-hud-spark-area{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);stroke:none}
.ud-hud-spark-axis{display:flex;justify-content:space-between;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-hud-note,.ud-hud-empty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ud-hud-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.ud-hud-dock{display:inline-flex;min-width:0;max-width:100%}
.ud-hud-dock-button{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:24px;padding:0 8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}
.ud-hud-dock-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.ud-hud-dock:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.ud-hud-dock-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.ud-hud-dock-dot--warn{background:var(--dsw-alias-state-warn-primary)}
.ud-hud-dock-dot--danger{background:var(--dsw-alias-state-error-primary)}

@media (max-width:900px){.ud-hud-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:640px){.ud-hud:not(.ud-hud--embedded){padding:16px}.ud-hud-cards,.ud-hud--embedded .ud-hud-cards{grid-template-columns:minmax(0,1fr)}}
`

const MESSAGES_ZH = {
  nav: '使用统计',
  range: '时间范围',
  'rangePreset.7': '7 天',
  'rangePreset.30': '30 天',
  'rangePreset.90': '90 天',
  rangeCustom: '自定义',
  from: '开始',
  to: '结束',
  refresh: '刷新',
  loading: '正在扫描历史会话。安装插件后首次会全量回扫,数据量大时耗时较久,期间尽量减少操作以免服务变卡',
  tokens: 'Tokens 用量',
  tokensHint: '服务商总口径:未缓存输入 + 输出 + 缓存命中 token',
  sessions: '会话数量',
  sessionsHint: '时间窗口内产生过用量的真实会话数,不含子 agent 会话',
  requests: '请求数量',
  activeDays: '活跃天数',
  cacheRate: '平均缓存命中率',
  cacheRateHint: '时间段内缓存命中 token 占输入 token 的比例',
  cacheHitRate: '缓存命中率',
  hitRateLegend: '缓存命中率',
  avgSpeed: '平均生成速度',
  speedLegend: '平均生成速度',
  ttftLegend: '首 token 延迟',
  avgPrice: '均价',
  topModel: '最常用模型',
  topModelHint: '按 token 用量排序,非调用次数',
  heatmap: '活跃热力图',
  heatLess: '较少',
  heatMore: '较多',
  dailyTrend: '按天 Token 趋势',
  trendLimited: '仅显示最近 {n} 天',
  dailyCostTrend: '按天金额趋势',
  hourCostTrend: '按小时金额趋势',
  minuteCostTrend: '按分钟金额趋势',
  costTrend: '金额',
  modelUsage: '模型用量',
  modelCache: '缓存',
  modelInput: '输入',
  modelOutput: '输出',
  other: '其他',
  total: '总用量',
  selectedTotal: '所选用量',
  totalCost: '估算费用',
  selectedCost: '所选估算费用',
  slotMetrics: '时段整体指标',
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
  'stats.inputTotal': '输入合计（含缓存）',
  'stats.missTotal': '未命中合计（含缓存写入）',
  'stats.tokens': '输入 {input} tok · 输出 {output} tok',
  'turnCostChip': '{cost}',
  cachePrecision: '精确缓存命中率',
  cachePrecisionDesc: '将官方用量胶囊及弹窗中的命中率显示为两位小数。',
  recentSpeed: '最近输出速度',
  recentSpeedDesc: '在官方「用时与速度」弹窗中追加最近 {n} 条回复消息的平均输出速度。',
  recentTtft: '最近首 token 平均',
  requestDetails: '最近请求详情',
  requestDetailsDesc: '在官方用时弹窗中增加最近首 token 平均行与查看详情入口;关闭时不注入任何内容。',
  secondsUnit: '秒',
  requestDetailsEntry: '查看最近请求详情',
  requestDetailsTitle: '最近请求详情',
  requestDetailsSubtitle: '当前会话 · 最近 {n} 条',
  requestCurrent: '当前请求',
  requestInfo: '请求',
  requestGenerating: '生成中',
  requestWaitingFirst: '等待首 token',
  requestCompleted: '完成',
  requestTime: '时间',
  requestStatus: '状态',
  requestModel: '模型',
  requestFirstToken: '首字',
  requestFirstDelay: '首字延迟',
  requestSpeed: '速度',
  requestOutput: '输出',
  requestTotalTokens: '总 Token',
  requestTokenSection: 'Token',
  requestEstimate: '预估',
  requestMean: '均 {n} 条',
  requestMeanTokens: '平均 Token',
  requestMeanCost: '平均预估',
  requestTurnStep: '轮次 / 步骤',
  requestAttemptsCount: '尝试次数',
  requestEmpty: '还没有完成的请求',
  requestAttempts: '第 {turn} 轮 / 第 {step} 步 · 尝试 {attempts} 次',
  requestStartedAt: '开始',
  requestFirstAt: '首字时刻',
  requestCompletedAt: '完成',
  requestDecode: '生成时长',
  requestUncachedInput: '未缓存输入',
  requestCacheRead: '缓存读',
  requestCacheWrite: '缓存写',
  requestInputTotal: '输入合计',
  requestCacheHit: '缓存命中率',
  requestCost: '费用',
  requestCostInput: '输入费用',
  requestCostCacheRead: '缓存读费用',
  requestCostCacheWrite: '缓存写费用',
  requestCostOutput: '输出费用',
  requestRule: '规则',
  requestPriceTime: '计价时点',
  requestUnpriced: '未配置该模型价格',
  requestPartialUnpriced: '{n} 条未定价',
  requestClose: '关闭',
  requestExpand: '展开明细',
  requestCollapse: '收起明细',
  requestElapsed: '已 {duration}',
  requestLiveEstimate: '生成中估算',
  requestCostHint: '按当前定价规则估算,不代表账单',
  requestUnavailable: '本会话暂无请求指标',
  requestTotal: '合计',
  requestPrice: '价格',
  requestCurrentTag: '当前',
  settingsSection: '显示与增强',
  settingsSectionDesc: '官方弹窗补全与费用显示开关',
  sectionDesc: '按模型与时点估算费用，定价规则与快照试算都在这里',
  displayGroup: '显示补全',
  displayGroupDesc: '官方用量与费用显示',
  recentGroup: '最近请求',
  recentGroupDesc: '统一控制最近输出速度与请求详情,关闭时全部子项停用',
  pricingSectionDesc: '按模型与时段估算费用',
  settingsOnCount: '已开启 {n} 项',
  pricingRuleCount: '{n} 条规则',
  pricingNotConfigured: '未配置',
  replaceSpeed: '替换默认速度',
  replaceSpeedDesc: '开启后用最近输出速度替换官方用时胶囊上的平均输出速度,关闭则保留官方读数。',
  replaceSpeedReading: '最近{speed}',
  tokenDetail: '会话 Token 明细',
  tokenDetailDesc: '在官方 Token 用量弹窗末尾追加含缓存输入合计；存在缓存写入时追加未命中合计。',
  costDisplay: '费用显示',
  costDisplayDesc: '在信息栏、趋势悬浮与回合费用芯片中显示按当前费率估算的费用。',
  costTitle: '按当前费率对历史用量估算,精度为小时级',
  costUnpriced: '{n} 个小时桶未计价',
  statsCostTitle: '按当前费率对会话累计 token 估算',
  'stats.cost': '费用 ≈ {cost}',
  costPanelTitle: '费用估算明细',
  costPanelOpen: '查看费用估算明细',
  costSelfLabel: '当期会话',
  costWithSubagentsLabel: '含子代理',
  costSelfSection: '当期会话明细',
  costSubagentSection: '子代理明细',
  costSelfEmpty: '本会话暂无用量',
  costSubagentEmpty: '暂无子代理用量',
  costSubagentUnavailable: '宿主未提供会话列表,无法统计子代理',
  costSelfFallback: '投影缺席,按当前模型整体估算',
  costUnpricedModels: '{n} 个模型未定价',
  costUnpricedSubagentModels: '{n} 个子代理模型未定价',
  costSubagentMissing: '{n} 个子代理未取到用量',
  costSelfUnpriced: '当前模型未定价,按占位符显示',
  costPanelNote: '估算值,不构成账单;每模型按最新用量时刻匹配单价',
  subagentUsage: '子代理用量',
  subagentUsageEntry: '查看 {n} 个子代理明细',
  subagentUsageTitle: '子代理明细',
  subagentUsageSubtitle: '当前会话 · {n} 个子代理',
  subagentUsageEmpty: '暂无子代理',
  subagentColTitle: '子代理',
  subagentColModel: '模型',
  subagentColInput: '未缓存输入',
  subagentColOutput: '输出',
  subagentColCacheRead: '缓存读取',
  subagentColCacheWrite: '缓存写入',
  subagentColTotal: '合计 Token',
  subagentColCost: '费用',
  subagentTotal: '合计',
  subagentMissingRow: '未取到用量',
  subagentSummaryOnly: '仅摘要',
  subagentMissing: '{n} 个子代理未取到用量',
  subagentUnpriced: '{n} 个模型未定价',
  subagentClose: '关闭',
  cost: '费用',
  turnCostTitle: '单轮用量按当前费率估算',
  turnTokensUnreported: '该提供商未上报此桶',
  pricing: '定价规则',
  pricingUnavailable: '定价规则不可用',
  'pricing.retry': '重新加载定价',
  'pricing.reset': '清空定价',
  'pricing.confirmReset': '确认永久清空定价',
  'pricing.views': '定价视图',
  'pricing.models': '模型',
  'pricing.rules': '规则',
  'pricing.tabModels': '模型视图',
  'pricing.tabRules': '规则视图',
  'pricing.editRule': '编辑规则',
  'pricing.createRule': '新增规则',
  'pricing.backToList': '返回规则列表',
  'pricing.cancel': '取消',
  'pricing.now': '此刻',
  'pricing.snapshot': '所选快照',
  'pricing.localSnapshot': '估算时点（{zone}）',
  'pricing.localZone': '本地时间',
  'pricing.providerSlash': '平台模式不能包含斜杠。请在型号字段输入带斜杠的型号。',
  'pricing.duplicateDefault': '同一范围只能有一条无条件规则。',
  'pricing.loading': '正在加载定价规则…',
  'pricing.backNow': '回到此刻',
  'pricing.search': '搜索平台或型号',
  'pricing.searchPlaceholder': '也可输入完整的 平台/型号 试算',
  'pricing.estimated': '快照估算花费',
  'pricing.priced': '已定价组合',
  'pricing.fallback': '默认价计费',
  'pricing.noObserved': '当前统计范围内暂无已观察到的模型。',
  'pricing.noSearchResults': '暂无匹配的已观察模型。',
  'pricing.previousModels': '上一页型号',
  'pricing.nextModels': '下一页型号',
  'pricing.configure': '配置定价',
  'pricing.modelCount': '{n} 个型号',
  'pricing.probe': '未观察到的型号 · 试算',
  'pricing.unpriced': '未定价',
  'pricing.unpricedCount': '{n} 个已观察到的组合未定价',
  'pricing.noMatch': '此时点没有规则为该组合计价。',
  'pricing.active': '生效',
  'pricing.inactive': '不生效',
  'pricing.unconditional': '无条件',
  'pricing.conditions': '生效条件',
  'pricing.conditionsHint': '所有条件均满足时生效',
  'pricing.showOthers': '显示其他 {n} 条规则',
  'pricing.hideOthers': '收起其他规则',
  'pricing.withStar': '通配规则',
  'pricing.withoutStar': '精确规则',
  'pricing.globalFallback': '全局默认价',
  'pricing.conflict': '同优先级冲突',
  'pricing.billing': '计费 {n}',
  'pricing.taken': '被接管 {n}',
  'pricing.ruleModels': '规则 {rule} 的型号',
  'pricing.ruleModelsKinds': '型号清单类型',
  'pricing.no.billing': '此时点没有计费型号。',
  'pricing.no.taken': '此时点没有被接管的型号。',
  'pricing.takenBy': '由 {rule} 计费',
  'pricing.takeoverDetail': '{rule} 接管 {n} 个组合',
  'pricing.ruleEstimate': '快照估算 {cost} · {tokens} token',
  'pricing.tree': '看规则树',
  'pricing.jump': '跳到模型',
  'pricing.close': '关闭',
  'pricing.fallbackRequired': '填写无条件的全局默认价（*/*）后再保存。',
  'pricing.disable': '停用定价',
  'pricing.disableHint': '停用将清空全部规则，定价不再生效',
  'pricing.confirmDisable': '确认清空定价草稿',
  'pricing.invalidResponse': '保存失败，定价响应无效。',
  'pricing.validationSummary': '请检查标出的定价字段。',
  'pricing.providerPattern': '平台模式',
  'pricing.modelPattern': '型号模式',
  'pricing.helpLabel': '匹配规则说明',
  'pricing.help': '先比较平台，再比较型号。每段精确优先，其次是带 * 的模式（更长优先；同长度按前缀、后缀、中缀），最后才是单独的 *。条件必须全部成立，同档条件多者优先，仍并列时按规则编号选择第一条。每段最多一个 *，可匹配零个或多个字符。',
  'pricing.batch': '批量套用',
  'pricing.batchTitle': '批量套用价格',
  'pricing.batchTargets': '精确型号',
  'pricing.batchHint': '保留来源规则的平台模式。每行一个型号，也可用逗号分隔。已有同范围的规则会跳过。',
  'pricing.batchEmpty': '输入型号后预览计费。',
  'pricing.batchInvalid': '请输入不含 * 或空白的精确型号。',
  'pricing.batchInvalidSource': '请先修正来源规则的价格、模式或条件。',
  'pricing.batchStatus': '此快照将新增 {added} 条规则，跳过 {skipped} 条。',
  'pricing.batchSkip': '已有同范围规则，跳过',
  'pricing.batchUnobserved': '当前范围内暂无用量',
  'pricing.batchConditionsOff': '此快照没有符合条件的组合',
  'pricing.batchCancel': '取消',
  'pricing.batchConfirm': '添加到草稿',
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
  condSummaryDailyWindow: '{from}–{to}',
  condSummaryMonthDays: '每月 {from}–{to} 日',
  condSummaryDateRange: '{from} 至 {to}',
  condFrom: '从',
  condTo: '至',
  'weekday.0': '日',
  'weekday.1': '一',
  'weekday.2': '二',
  'weekday.3': '三',
  'weekday.4': '四',
  'weekday.5': '五',
  'weekday.6': '六',
  condTime: '需 24 小时制时刻 HH:MM(时:分,如 09:30)',
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
  defaultPriceHint: '默认价:附加规则全不命中时生效,不设条件',
  save: '保存',
  saved: '已保存',
  required: '必填',
  priceInvalid: '不能为负',
  modelFormat: '需两段 provider/model,段可通配',
  'duration.compactSeconds': '{seconds}秒',
  'duration.compactMinutes': '{minutes}分{seconds}秒',
  ...WHATIF_MESSAGES_ZH,
  ...GUARD_MESSAGES_ZH,
  ...SENTINEL_MESSAGES_ZH,
  ...HUD_MESSAGES_ZH,
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
  sessionsHint: 'Distinct real sessions with usage in the range; subagent sessions excluded',
  requests: 'Requests',
  activeDays: 'Active days',
  cacheRate: 'Avg cache-hit rate',
  cacheRateHint: 'Cache-hit tokens as a share of input tokens within the range',
  cacheHitRate: 'Cache-hit rate',
  hitRateLegend: 'Cache-hit rate',
  avgSpeed: 'Avg speed',
  speedLegend: 'Avg speed',
  ttftLegend: 'First-token latency',
  avgPrice: 'Avg price',
  topModel: 'Top model',
  topModelHint: 'Ranked by token usage, not call count',
  heatmap: 'Activity heatmap',
  heatLess: 'Less',
  heatMore: 'More',
  dailyTrend: 'Daily token trend',
  trendLimited: 'Showing only the last {n} days',
  dailyCostTrend: 'Daily cost trend',
  hourCostTrend: 'Hourly cost trend',
  minuteCostTrend: 'Per-minute cost trend',
  costTrend: 'Cost',
  modelUsage: 'Model usage',
  modelCache: 'Cache',
  modelInput: 'Input',
  modelOutput: 'Output',
  other: 'Other',
  total: 'Total',
  selectedTotal: 'Selected usage',
  totalCost: 'Estimated cost',
  selectedCost: 'Selected estimated cost',
  slotMetrics: 'Overall interval metrics',
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
  'stats.inputTotal': 'Total input (including cache)',
  'stats.missTotal': 'Total cache miss (including writes)',
  'stats.tokens': 'Input {input} tok · Output {output} tok',
  'turnCostChip': '{cost}',
  cachePrecision: 'Precise cache-hit rate',
  cachePrecisionDesc: 'Show two decimals in the official usage pill and Token usage dialog.',
  recentSpeed: 'Recent output speed',
  recentSpeedDesc: 'Append the average output speed of the latest {n} replies to the official time-and-speed dialog.',
  recentTtft: 'Recent average TTFT',
  requestDetails: 'Recent request details',
  requestDetailsDesc: 'Add a recent average TTFT row and a details entry to the official time dialog; nothing is injected while off.',
  secondsUnit: 's',
  requestDetailsEntry: 'View recent request details',
  requestDetailsTitle: 'Recent request details',
  requestDetailsSubtitle: 'Current session · last {n}',
  requestCurrent: 'Current request',
  requestInfo: 'Request',
  requestGenerating: 'Generating',
  requestWaitingFirst: 'Waiting for first token',
  requestCompleted: 'Completed',
  requestTime: 'Time',
  requestStatus: 'Status',
  requestModel: 'Model',
  requestFirstToken: 'TTFT',
  requestFirstDelay: 'TTFT',
  requestSpeed: 'Speed',
  requestOutput: 'Output',
  requestTotalTokens: 'Total tokens',
  requestTokenSection: 'Token',
  requestEstimate: 'Est.',
  requestMean: 'Avg {n}',
  requestMeanTokens: 'Avg tokens',
  requestMeanCost: 'Avg est.',
  requestTurnStep: 'Turn / step',
  requestAttemptsCount: 'Attempts',
  requestEmpty: 'No completed requests yet',
  requestAttempts: 'Turn {turn} / step {step} · {attempts} attempts',
  requestStartedAt: 'Started',
  requestFirstAt: 'First token at',
  requestCompletedAt: 'Completed',
  requestDecode: 'Decode time',
  requestUncachedInput: 'Uncached input',
  requestCacheRead: 'Cache read',
  requestCacheWrite: 'Cache write',
  requestInputTotal: 'Input total',
  requestCacheHit: 'Cache hit',
  requestCost: 'Cost',
  requestCostInput: 'Input cost',
  requestCostCacheRead: 'Cache read cost',
  requestCostCacheWrite: 'Cache write cost',
  requestCostOutput: 'Output cost',
  requestRule: 'Rule',
  requestPriceTime: 'Priced at',
  requestUnpriced: 'No price configured for this model',
  requestPartialUnpriced: '{n} unpriced',
  requestClose: 'Close',
  requestExpand: 'Expand details',
  requestCollapse: 'Collapse details',
  requestElapsed: '{duration} elapsed',
  requestLiveEstimate: 'Live estimate',
  requestCostHint: 'Estimated from current pricing rules, not a bill',
  requestUnavailable: 'No request metrics in this session',
  requestTotal: 'Total',
  requestPrice: 'Price',
  requestCurrentTag: 'Current',
  settingsSection: 'Display & enhancements',
  settingsSectionDesc: 'Official dialog additions and cost display',
  sectionDesc: 'Estimates cost per model and point in time; pricing rules and snapshot probes live here',
  displayGroup: 'Display additions',
  displayGroupDesc: 'Official usage and cost display',
  recentGroup: 'Recent requests',
  recentGroupDesc: 'Controls recent output speed and request details together; turning it off disables all sub-options.',
  pricingSectionDesc: 'Estimate costs by model and time',
  settingsOnCount: '{n} enabled',
  pricingRuleCount: '{n} rules',
  pricingNotConfigured: 'Not configured',
  replaceSpeed: 'Replace default speed',
  replaceSpeedDesc: 'Replace the average output speed on the official time pill with the recent output speed; off keeps the official reading.',
  replaceSpeedReading: 'Recent {speed}',
  tokenDetail: 'Session token detail',
  tokenDetailDesc: 'Append total input including cache to the official Token usage dialog; add total cache misses when cache writes exist.',
  costDisplay: 'Cost display',
  costDisplayDesc: 'Show costs estimated at current rates in the stats line, trend tooltips and the turn cost chip.',
  costTitle: 'Estimated at current rates over historical usage, hourly precision',
  costUnpriced: '{n} hour buckets unpriced',
  statsCostTitle: 'Estimated at current rates over session token totals',
  'stats.cost': 'Cost ≈ {cost}',
  costPanelTitle: 'Cost estimate breakdown',
  costPanelOpen: 'Show the cost estimate breakdown',
  costSelfLabel: 'This session',
  costWithSubagentsLabel: 'Including subagents',
  costSelfSection: 'This session detail',
  costSubagentSection: 'Subagent detail',
  costSelfEmpty: 'No usage in this session',
  costSubagentEmpty: 'No subagent usage',
  costSubagentUnavailable: 'Session list unavailable; subagents are not counted',
  costSelfFallback: 'Projection missing; estimated on the current model totals',
  costUnpricedModels: '{n} models unpriced',
  costUnpricedSubagentModels: '{n} subagent models unpriced',
  costSubagentMissing: '{n} subagents without usage data',
  costSelfUnpriced: 'Current model has no matching price',
  costPanelNote: 'Estimate, not a bill; each model matched at its latest usage time',
  subagentUsage: 'Subagent usage',
  subagentUsageEntry: 'View {n} subagent detail',
  subagentUsageTitle: 'Subagent detail',
  subagentUsageSubtitle: 'Current session · {n} subagents',
  subagentUsageEmpty: 'No subagents',
  subagentColTitle: 'Subagent',
  subagentColModel: 'Model',
  subagentColInput: 'Uncached input',
  subagentColOutput: 'Output',
  subagentColCacheRead: 'Cache read',
  subagentColCacheWrite: 'Cache write',
  subagentColTotal: 'Total tokens',
  subagentColCost: 'Cost',
  subagentTotal: 'Total',
  subagentMissingRow: 'No usage data',
  subagentSummaryOnly: 'Summary only',
  subagentMissing: '{n} subagents without usage data',
  subagentUnpriced: '{n} models unpriced',
  subagentClose: 'Close',
  cost: 'Cost',
  turnCostTitle: 'Per-turn usage estimated at current rates',
  turnTokensUnreported: 'Not reported by this provider',
  pricing: 'Pricing rules',
  pricingUnavailable: 'Pricing rules unavailable',
  'pricing.retry': 'Reload pricing',
  'pricing.reset': 'Clear pricing',
  'pricing.confirmReset': 'Confirm permanent clearing',
  'pricing.views': 'Pricing views',
  'pricing.models': 'Models',
  'pricing.rules': 'Rules',
  'pricing.tabModels': 'Model view',
  'pricing.tabRules': 'Rules view',
  'pricing.editRule': 'Edit rule',
  'pricing.createRule': 'New rule',
  'pricing.backToList': 'Back to rules',
  'pricing.cancel': 'Cancel',
  'pricing.now': 'Now',
  'pricing.snapshot': 'Selected snapshot',
  'pricing.localSnapshot': 'Estimate at ({zone})',
  'pricing.localZone': 'local time',
  'pricing.providerSlash': 'Provider patterns cannot contain a slash. Enter model names containing slashes in the model field.',
  'pricing.duplicateDefault': 'Only one unconditional rule is allowed per scope.',
  'pricing.loading': 'Loading pricing rules…',
  'pricing.backNow': 'Back to now',
  'pricing.search': 'Find a provider or model',
  'pricing.searchPlaceholder': 'Enter a full provider/model to test its price',
  'pricing.estimated': 'Snapshot cost estimate',
  'pricing.priced': 'Priced combinations',
  'pricing.fallback': 'Fallback billing',
  'pricing.noObserved': 'No models were observed in this usage range.',
  'pricing.noSearchResults': 'No observed models match the search.',
  'pricing.previousModels': 'Previous models',
  'pricing.nextModels': 'Next models',
  'pricing.configure': 'Configure pricing',
  'pricing.modelCount': '{n} models',
  'pricing.probe': 'Unobserved model · price check',
  'pricing.unpriced': 'Unpriced',
  'pricing.unpricedCount': '{n} observed combinations are unpriced',
  'pricing.noMatch': 'No rule prices this combination at the selected time.',
  'pricing.active': 'Active',
  'pricing.inactive': 'Inactive',
  'pricing.unconditional': 'Unconditional',
  'pricing.conditions': 'Conditions',
  'pricing.conditionsHint': 'All conditions must match',
  'pricing.showOthers': 'Show {n} other rules',
  'pricing.hideOthers': 'Hide other rules',
  'pricing.withStar': 'Wildcard rules',
  'pricing.withoutStar': 'Exact rules',
  'pricing.globalFallback': 'Global fallback',
  'pricing.conflict': 'Equal-priority conflict',
  'pricing.billing': 'Billing {n}',
  'pricing.taken': 'Overridden {n}',
  'pricing.ruleModels': 'Models for rule {rule}',
  'pricing.ruleModelsKinds': 'Model list types',
  'pricing.no.billing': 'No models are billed by this rule at the selected time.',
  'pricing.no.taken': 'No models are overridden at the selected time.',
  'pricing.takenBy': 'Billed by {rule}',
  'pricing.takeoverDetail': '{rule} takes over {n} combinations',
  'pricing.ruleEstimate': 'Snapshot estimate {cost} · {tokens} tokens',
  'pricing.tree': 'View rule tree',
  'pricing.jump': 'Go to model',
  'pricing.close': 'Close',
  'pricing.fallbackRequired': 'Enter an unconditional global fallback (*/*) before saving.',
  'pricing.disable': 'Disable pricing',
  'pricing.disableHint': 'Disabling will clear all rules and turn pricing off',
  'pricing.confirmDisable': 'Confirm clearing pricing draft',
  'pricing.invalidResponse': 'Save failed because the pricing response was invalid.',
  'pricing.validationSummary': 'Review the highlighted pricing fields.',
  'pricing.providerPattern': 'Provider pattern',
  'pricing.modelPattern': 'Model pattern',
  'pricing.helpLabel': 'Matching syntax and priority',
  'pricing.help': 'Compare the provider first, then the model. In each segment, exact comes first, then patterns with * (longer first; for equal lengths, prefix, suffix, then infix), then a lone *. All conditions must match. More conditions take priority on a tie. Remaining ties go to the first rule by number. Each segment accepts at most one *, which matches zero or more characters.',
  'pricing.batch': 'Apply in bulk',
  'pricing.batchTitle': 'Apply prices in bulk',
  'pricing.batchTargets': 'Exact model names',
  'pricing.batchHint': 'Keeps the source rule’s provider pattern. Enter one model per line or separate with commas. Rules with the same scope are skipped.',
  'pricing.batchEmpty': 'Enter models to preview their pricing.',
  'pricing.batchInvalid': 'Enter exact model names without * or spaces.',
  'pricing.batchInvalidSource': 'Correct the source rule’s prices, patterns, or conditions first.',
  'pricing.batchStatus': 'At this snapshot, {added} rules will be added and {skipped} skipped.',
  'pricing.batchSkip': 'Same scope already exists; skipped',
  'pricing.batchUnobserved': 'No usage in this range',
  'pricing.batchConditionsOff': 'No matching conditions at this snapshot',
  'pricing.batchCancel': 'Cancel',
  'pricing.batchConfirm': 'Add to draft',
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
  condSummaryDailyWindow: '{from}–{to}',
  condSummaryMonthDays: 'Day {from}–{to}',
  condSummaryDateRange: '{from} to {to}',
  condFrom: 'From',
  condTo: 'To',
  'weekday.0': 'Su',
  'weekday.1': 'Mo',
  'weekday.2': 'Tu',
  'weekday.3': 'We',
  'weekday.4': 'Th',
  'weekday.5': 'Fr',
  'weekday.6': 'Sa',
  condTime: 'Requires 24-hour HH:MM time (hours:minutes, e.g. 09:30)',
  condWeekday: 'Requires integer 0-6',
  condMonthDay: 'Requires integer 1-31',
  condDate: 'Requires YYYY-MM-DD',
  condRange: 'End must not be before start (both ends inclusive)',
  ruleOrderHint: 'Extra billing rules match top to bottom; first match wins; if none match, the default price applies',
  moveUp: 'Move up',
  moveDown: 'Move down',
  addGroup: 'Add model',
  addRule: 'Add extra pricing rule',
  addDefaultPrice: 'Add default price',
  deleteGroup: 'Delete model and all its pricing rules',
  deleteRule: 'Remove pricing rule',
  defaultPriceHint: 'Default price: applies when no extra rule above matches; no conditions',
  save: 'Save',
  saved: 'Saved',
  required: 'Required',
  priceInvalid: 'Must not be negative',
  modelFormat: 'Requires two segments provider/model; segments may be wildcards',
  'duration.compactSeconds': '{seconds}s',
  'duration.compactMinutes': '{minutes}m{seconds}s',
  ...WHATIF_MESSAGES_EN,
  ...GUARD_MESSAGES_EN,
  ...SENTINEL_MESSAGES_EN,
  ...HUD_MESSAGES_EN,
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

// 逐槽把非 top 模型并入哨兵桶,token 与费用双度量同折,原明细留 otherByModel/otherCostByModel 供
// tooltip;模型顺序 = 图例序(哨兵恒最后)
const foldMetricByTop = (entries, top) => {
  const kept = {}
  const other = {}
  for (const [model, value] of Object.entries(entries)) {
    if (top.has(model)) {
      kept[model] = (kept[model] ?? 0) + value
      continue
    }
    kept[OTHER_MODEL] = (kept[OTHER_MODEL] ?? 0) + value
    other[model] = (other[model] ?? 0) + value
  }
  return { kept, other }
}

const foldSlotsByTop = (slots, topModels) => {
  const top = new Set(topModels)
  return slots.map((slot) => {
    const tokens = foldMetricByTop(slot.byModel, top)
    const costs = foldMetricByTop(slot.costByModel ?? {}, top)
    return {
      ...slot,
      byModel: tokens.kept,
      otherByModel: tokens.other,
      byCostModel: costs.kept,
      otherCostByModel: costs.other,
    }
  })
}

// 金额槽投影:total/byModel/otherByModel 切换为费用口径(调用方保证费用字段在场)
const costSlotsOf = (slots) => slots.map((slot) => ({
  ...slot,
  total: slot.cost ?? 0,
  byModel: slot.byCostModel ?? {},
  otherByModel: slot.otherCostByModel ?? {},
}))

// 金额视图派生:存在正计价槽才可用(零计价规则/未配价的金额图全零有误导),
// 开关开且可用才投影金额口径,否则原槽透传(引用不变)
const moneyViewOf = (slots, costView) => {
  const costReady = !!slots && slots.some((slot) => slot.cost > 0)
  const money = costView && costReady
  return { costReady, money, chartSlots: money ? costSlotsOf(slots) : slots }
}

const topWithOther = (ranked) => {
  const folded = ranked.length > GROUP_UNFOLDED_MAX
  const models = ranked.slice(0, folded ? GROUP_UNFOLDED_MAX - 1 : GROUP_UNFOLDED_MAX)
  if (folded) {
    const rest = ranked.slice(models.length)
    // 四桶与费用同源条件挂载:输入条目无该字段(旧形数据/未配价)时哨兵同样不带,防零值假数据
    models.push({
      model: OTHER_MODEL,
      tokens: rest.reduce((sum, item) => sum + item.tokens, 0),
      ...(rest.some(hasTokenBuckets) ? { ...bucketSumsOf(rest) } : {}),
      ...(rest.some((item) => item.cost !== undefined) ? { cost: rest.reduce((sum, item) => sum + (item.cost ?? 0), 0) } : {}),
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

// 聚合展示区(统计卡/模型用量/统计截至)数据源:随视图联动——天视图用 range 聚合,时/分视图
// (预设与自定义挡)用点端点聚合,字段同形;点数据未回为 null,调用方判空不渲染
const cardsStatsOf = (view, stats, pointView) => (view === 'day' ? stats : pointView)

// 模型用量列表:天视图用预折叠分组,时/分视图折叠点窗口模型(超上限折叠 top(上限-1)+other),点数据未回为 null
const usageModelsOf = (view, grouped, pointView) => (
  view === 'day' ? grouped?.models ?? null : pointView ? topWithOther(pointView.models) : null
)

// 趋势图视口常量
const CHART_HEIGHT = 220
// 左轴留白按最长刻度(三位整数 + 两位小数,七字符)预留,避免首位越出 SVG 视口被裁
const CHART_PAD = { left: 54, right: 65, top: 10, bottom: 26 }
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
// 金额刻度下限:仅防零值退化,亚分峰值不参与轴标定失真
const COST_TOTAL_FLOOR = 0.0001
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

// 图例显隐切换:current 为当前实际生效集;普通点击单选/再点恢复,
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

// 左轴刻度:速度刻度存在时左轴标定速度(tok/s),否则标定柱度量(token 或金额,格式化由调用方注入);
// 刻度值统一换算为绘图区高度占比
function leftAxisTicks(tokenTicks, tokenMax, speedTicks, speedMax, format = formatTokensCompact) {
  const useSpeed = speedTicks.length > 0
  return (useSpeed ? speedTicks : tokenTicks).map((tick) => ({
    label: (useSpeed ? formatTokensCompact : format)(tick),
    ratio: tick / (useSpeed ? speedMax : tokenMax),
  }))
}

// 堆叠柱几何:模型序即堆叠序(哨兵最后画柱顶),输出槽分段与左轴刻度;
// maxTotal 按可见模型求和,单选模型时刻度跟随归一;totalFloor 为量纲下限(token 个位数/金额亚分)
function trendLayout(slots, modelOrder, avail, labelMinPitch, totalFloor = 1) {
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom
  const innerWidth = Math.max(1, avail - CHART_PAD.left - CHART_PAD.right)
  const count = slots.length
  const step = count > 1 ? innerWidth / (count - 1) : innerWidth
  const barWidth = Math.max(BAR_MIN_WIDTH, Math.min(BAR_MAX_WIDTH, step * BAR_WIDTH_RATIO))
  const slotVisibleTotal = (slot) => modelOrder.reduce((sum, model) => sum + (slot.byModel[model] ?? 0), 0)
  const maxTotal = Math.max(totalFloor, ...slots.map(slotVisibleTotal))
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
const TREND_LINE_GAP_SLOTS = 1.5
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

// Catmull-Rom 转三次贝塞尔:控制点取邻点差六分之一,端点折返;相邻点间距超 maxGap 折线断开成新段(稀疏槽防长弧跨越)
function smoothPath(points, maxGap = Number.POSITIVE_INFINITY) {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    if (p2.x - p1.x > maxGap) {
      d += ` M ${p2.x} ${p2.y}`
      continue
    }
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

// 语言中立短时长:60 秒内一位小数秒,以上整秒折分秒(模型列表 meta 行用,禁本地化)
function formatDurationShort(ms) {
  const seconds = ms / MS_PER_SECOND
  if (seconds < DURATION_MINUTE_SECONDS) return `${Math.round(seconds * NUMBER_ONE_DECIMAL) / NUMBER_ONE_DECIMAL}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / SECONDS_PER_MINUTE)}m${whole % SECONDS_PER_MINUTE}s`
}

// 模型首 token 延迟短文本:语言中立;无 ttft(无配对数据)为空串
function modelTtftText(ttft) {
  if (ttft === undefined) return ''
  return `TTFT ${formatDurationShort(ttft)}`
}

// 模型条目四桶齐备判定:生产端同源恒齐,旧形数据缺桶即视为不可渲染
const hasTokenBuckets = (item) => TOKEN_BUCKET_KEYS.every((key) => typeof item?.[key] === 'number')

// 逐桶求和:按共享桶键列表产出四桶聚合形态
const bucketSumsOf = (items) => Object.fromEntries(TOKEN_BUCKET_KEYS.map((key) => [
  key,
  items.reduce((sum, item) => sum + (item[key] ?? 0), 0),
]))

// 模型输入输出占比构成:缓存/输入/输出 三段各占该模型 token 总量百分比(缓存=读+写,
// 三段合计恒 100%);四桶缺失(旧数据)或零总量为空串
function modelIoPercentText(item, t) {
  if (!hasTokenBuckets(item) || !(item.tokens > 0)) return ''
  const share = (value) => formatPercent((value / item.tokens) * PERCENT_SCALE)
  return `${t('modelCache')} ${share(item.cacheReadTokens + item.cacheWriteTokens)} · ${t('modelInput')} ${share(item.inputTokens)} · ${t('modelOutput')} ${share(item.outputTokens)}`
}

// 趋势 tooltip 内容门:全零槽(无任何用量)不渲染 tooltip
const hasTipContent = (hoverSlot) => Boolean(hoverSlot) && hoverSlot.total > 0

// 折叠提醒判定:折叠层内有异常日志条目或写入失败即值得提醒
const hasAnomalyNews = (status) => !!status
  && ((status.log?.length ?? 0) > 0 || (status.recordFailures ?? 0) > 0)

// 趋势折线默认显隐集:模型全显 + 速度线(有数据时);缓存命中率与首 token 延迟默认隐藏,
// 图例切换后以组件内键集接管(不持久化)
const trendDefaultVisibleKeys = (modelOrder, hasSpeed) => new Set([
  ...modelOrder,
  ...(hasSpeed ? [LEGEND_KEY_SPEED] : []),
])

// 趋势 tooltip 模型行数据:主行 = 可见且当前时段有用量的模型;OTHER 子行 = OTHER 可见
// 且当前时段有用量的其余模型明细,按 tokens 降序由本函数保证
const tipModelEntries = (hoverSlot, visibleSet) => {
  if (!hasTipContent(hoverSlot)) return { main: [], other: [] }
  const main = Object.entries(hoverSlot.byModel)
    .filter(([model, tokens]) => visibleSet.has(model) && tokens > 0)
    .map(([model, tokens]) => ({ model, tokens }))
  const other = visibleSet.has(OTHER_MODEL)
    ? Object.entries(hoverSlot.otherByModel ?? {}).filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1])
    : []
  return { main, other }
}

// 悬浮合计与柱形共用可见模型集合,其他子项仅展开、不重复求和。
// 费用仅统计可见且已定价的模型:全部未定价时保持 undefined,不冒充实测零价。
const visibleTipSlot = (slot, visibleModels) => slot ? {
  ...slot,
  total: visibleModels.reduce((sum, model) => sum + (slot.byModel[model] ?? 0), 0),
  cost: (() => {
    if (slot.cost === undefined) return undefined
    const priced = visibleModels.filter((model) => slot.byCostModel?.[model] !== undefined)
    return priced.length === 0 ? undefined : priced.reduce((sum, model) => sum + slot.byCostModel[model], 0)
  })(),
} : null

// 趋势 tooltip 槽级均价:槽费用折每百万 token 单价;无槽或无有效费用(含零值)为 null
const tipAvgPriceText = (hoverSlot, currency) => (
  hoverSlot ? avgPriceText(hoverSlot.cost, hoverSlot.total, currency) || null : null
)

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

// 热力图悬浮读数:token 走带单位缩写(量级一眼可读),请求数同口径千分位;费用行随偏好显隐
function heatTipRows(cell, t, costDisplay, costCurrency) {
  return [
    { key: 'tokens', label: t('tokens'), value: formatTokensCompact(cell.tokens) },
    { key: 'requests', label: t('requests'), value: formatTokens(cell.requests) },
    { key: 'rate', label: t('cacheHitRate'), value: cacheRateText(cell.cacheHit, cell.cacheMiss) },
    ...(costDisplay && cell.cost > 0
      ? [{ key: 'cost', label: t('cost'), value: `≈ ${formatCost(cell.cost, costCurrency)}` }]
      : []),
  ]
}

// 悬浮定位:鼠标事件跟随指针(右下偏移,越界换侧),键盘聚焦回落元素矩形(上方优先)。
// 两种锚点共用夹取与箭头贴边逻辑。
const TIP_GAP_PX = 8
const TIP_POINTER_OFFSET_PX = 14
const TIP_MARGIN_PX = 8
const TIP_ARROW_MIN_INSET_PX = 12
const TIP_SIDE_TOP = 'top'
const TIP_SIDE_BOTTOM = 'bottom'

// 回合费用芯片与前置官方芯片(结束时钟)的间距
const TURN_COST_GAP_PX = 8

const clampValue = (value, min, max) => Math.max(min, Math.min(value, max))

function tipAnchorRect(event) {
  const element = event?.currentTarget ?? event?.target
  if (!element || typeof element.getBoundingClientRect !== 'function') return null
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

// 鼠标与指针事件带坐标时按指针锚定,键盘与程序触发改为元素矩形
function tipAnchor(event) {
  if (!event) return null
  const { clientX, clientY } = event
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) return { kind: 'point', x: clientX, y: clientY }
  const rect = tipAnchorRect(event)
  return rect ? { kind: 'rect', ...rect } : null
}

// 提示尺寸与视口已知时算出 fixed 坐标:指针锚点走右下偏移,矩形锚点上方优先,两者都越界翻转再夹取,
// 箭头贴边夹在圆角内
function tipPlacement(anchor, tipSize, bounds, options = {}) {
  if (!anchor || !tipSize) return null
  if (!(tipSize.width > 0) || !(tipSize.height > 0)) return null
  const gap = options.gap ?? TIP_GAP_PX
  const margin = options.margin ?? TIP_MARGIN_PX
  const minLeft = bounds.left + margin
  const maxLeft = Math.max(minLeft, bounds.right - margin - tipSize.width)
  const minTop = bounds.top + margin
  const maxTop = Math.max(minTop, bounds.bottom - margin - tipSize.height)
  const arrowInset = Math.min(TIP_ARROW_MIN_INSET_PX, tipSize.width / 2)
  if (anchor.kind === 'point') {
    const offset = options.offset ?? TIP_POINTER_OFFSET_PX
    const rightLeft = anchor.x + offset
    const leftLeft = anchor.x - offset - tipSize.width
    const belowTop = anchor.y + offset
    const aboveTop = anchor.y - offset - tipSize.height
    const left = rightLeft + tipSize.width <= bounds.right - margin
      ? rightLeft
      : clampValue(leftLeft, minLeft, maxLeft)
    const side = belowTop + tipSize.height <= bounds.bottom - margin ? TIP_SIDE_BOTTOM : TIP_SIDE_TOP
    const top = clampValue(side === TIP_SIDE_BOTTOM ? belowTop : aboveTop, minTop, maxTop)
    // 指针在提示外侧,箭头无从指向锚点,跟随模式不画箭头
    return { left, top, side, arrowX: null }
  }
  if (!(anchor.width > 0) || !(anchor.height > 0)) return null
  const centerX = anchor.left + anchor.width / 2
  const left = clampValue(centerX - tipSize.width / 2, minLeft, maxLeft)
  const aboveTop = anchor.top - gap - tipSize.height
  const belowTop = anchor.top + anchor.height + gap
  const aboveFits = aboveTop >= minTop
  const belowFits = belowTop <= maxTop
  let side = options.prefer ?? TIP_SIDE_TOP
  if (side === TIP_SIDE_TOP && !aboveFits) side = TIP_SIDE_BOTTOM
  else if (side === TIP_SIDE_BOTTOM && !belowFits) side = TIP_SIDE_TOP
  // 两侧都放不下:取空间更大的一侧,再由夹取进边界
  if (!aboveFits && !belowFits) {
    side = (anchor.top - bounds.top) >= (bounds.bottom - (anchor.top + anchor.height))
      ? TIP_SIDE_TOP
      : TIP_SIDE_BOTTOM
  }
  const top = clampValue(side === TIP_SIDE_TOP ? aboveTop : belowTop, minTop, maxTop)
  const arrowX = clampValue(centerX - left, arrowInset, tipSize.width - arrowInset)
  return { left, top, side, arrowX }
}

// ===== 底部信息栏(append 模式):官方 pill 数据后追加增强项 =====
// 偏好存宿主 settings:命名空间即 profile entry id,字段由 host SETTINGS_SCHEMA 的 statsLine 承载
const STATS_LINE_SETTINGS_NAMESPACE = 'usage-dash'
const STATS_LINE_FIELD = 'statsLine'
// 出厂默认值:与宿主 src/index.js 的 STATS_LINE_DEFAULTS 逐项同源,parity 测试守护
const STATS_LINE_DEFAULT_PREFS = {
  cachePrecision: true,
  tokenDetail: true,
  costDisplay: true,
  recentSpeed: true,
  replaceSpeed: false,
  requestDetails: false,
}

// 最近请求组:总开关由成员派生,开时统一拉起两个主功能,关时连带清掉替换子项。
const recentGroupOnOf = (prefs) => !!(prefs?.recentSpeed || prefs?.requestDetails)
const recentGroupPatchOf = (on) => on
  ? { recentSpeed: true, requestDetails: true }
  : { recentSpeed: false, replaceSpeed: false, requestDetails: false }
const LOCALE_NS = 'usage-dash'
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const NUMBER_ONE_DECIMAL = 10
const NUMBER_COMPACT_INT_THRESHOLD = 100
const PERCENT_PRECISE_CAP = 99.99
const DURATION_MINUTE_SECONDS = 60
const TPS_INTEGER_THRESHOLD = 10
// 最近输出速度取样的消息条数:窗口分页只保留近期事件,口径落在"当下能读到的最新几条"
const RECENT_SPEED_STEPS = 10
// 读数行的宿主挂载点:官方「用时与速度」胶囊与其弹窗明细;输出速度是该明细的最后一行
const SPEED_DIALOG_STAT = 'activity'
const SPEED_DIALOG_SELECTOR = '[data-session-stats-details]'
// 读数行自述标记:portal 落在宿主明细里,靠属性把自家 dt/dd 与官方行区分并归位
const SPEED_ROW_ATTRIBUTE = 'data-ud-speed-detail="recentSpeed"'
const TEXT_NODE = 3
// 会话投影键:宿主按会话推送,wire 只带加权读数与窗口步数
const RECENT_SPEED_PROJECTION = 'usageDashRecentSpeed'
const RECENT_REQUESTS_PROJECTION = 'usageDashRecentRequests'

// 官方 billing 分母:三个互斥的 prompt 侧计费桶
function billedInputTokens(usage) {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
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

// 带单位的 token 一律三位整数 + 两位小数(123.12K / 812.53M / 134.10B / 12.00T / 1.50Q),
// 单位最多到 B 上两级;四舍五入到 1000.00 时进位,不出现 1000.00K 这种形态
const COMPACT_UNITS = [
  { suffix: 'K', base: COMPACT_BASE },
  { suffix: 'M', base: COMPACT_BASE ** 2 },
  { suffix: 'B', base: COMPACT_BASE ** 3 },
  { suffix: 'T', base: COMPACT_BASE ** 4 },
  { suffix: 'Q', base: COMPACT_BASE ** 5 },
]
const COMPACT_HEAD_MIN = 100
const COMPACT_HEAD_MAX = COMPACT_BASE
const COMPACT_DECIMALS = 2
const COMPACT_SCALE = 10 ** COMPACT_DECIMALS
// 最高档钳制值:三位整数 + 两位小数的展示上限
const COMPACT_MAX_DISPLAY = COMPACT_HEAD_MAX - 1 / COMPACT_SCALE
const roundCompact = (count) => Math.round(count * COMPACT_SCALE) / COMPACT_SCALE

function formatTokensCompact(value) {
  const count = Number.isFinite(value) ? value : 0
  const abs = Math.abs(count)
  if (abs < COMPACT_BASE) return String(count)
  const sign = count < 0 ? '-' : ''
  let index = 0
  for (let candidate = COMPACT_UNITS.length - 1; candidate > 0; candidate -= 1) {
    if (abs >= COMPACT_UNITS[candidate].base * COMPACT_HEAD_MIN) {
      index = candidate
      break
    }
  }
  let scaled = roundCompact(abs / COMPACT_UNITS[index].base)
  if (scaled >= COMPACT_HEAD_MAX && index < COMPACT_UNITS.length - 1) {
    index += 1
    scaled = roundCompact(abs / COMPACT_UNITS[index].base)
  }
  // Q 是最高档:再往上已经没有单位可进,钳在三位整数内免得撑破读数宽度
  if (scaled >= COMPACT_HEAD_MAX) return `${sign}${COMPACT_MAX_DISPLAY.toFixed(COMPACT_DECIMALS)}${COMPACT_UNITS[index].suffix}`
  return `${sign}${scaled.toFixed(COMPACT_DECIMALS)}${COMPACT_UNITS[index].suffix}`
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

// ===== 最近输出速度:当前窗口最近若干助手步骤的生成吞吐 =====
// 单步耗时优先取 decode 口径(完成 - 首 token),与宿主 sessionStats 的 decode 定义一致;
// 客户端节点实测常不记录首 token(流被服务端聚合),此时回退到端到端(完成 - 步骤启动)
function stepSpanMs(timing) {
  if (timing === undefined || timing === null) return null
  const completed = timing.completedTime
  if (!Number.isFinite(completed)) return null
  const anchor = Number.isFinite(timing.firstTokenTime)
    ? timing.firstTokenTime
    : Number.isFinite(timing.stepStartTime) ? timing.stepStartTime : null
  if (anchor === null) return null
  return Math.max(0, completed - anchor)
}

// 单步读数:分子口径同宿主 usageOutputTokens(零输出合法,只添分母);timing 或 usage 缺失的步骤不出读数
function stepSpeedReading(node) {
  const outputTokens = node?.usage?.outputTokens
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens < 0) return null
  const ms = stepSpanMs(node?.timing)
  return ms === null ? null : { tokens: outputTokens, ms }
}

// 最近 limit 个可读数步骤的加权平均速度 = 总输出 token / 总 decode 秒;
// 窗口节点按序排列,自尾向前取样;无读数(或时长合计为零)返回 null 供渲染层省略该行
function recentSpeedOf(nodes, limit = RECENT_SPEED_STEPS) {
  if (nodes === null || typeof nodes !== 'object' || !(limit > 0)) return null
  const list = typeof nodes.values === 'function' ? [...nodes.values()] : typeof nodes[Symbol.iterator] === 'function' ? [...nodes] : null
  if (list === null) return null
  let tokens = 0
  let decodeMs = 0
  let taken = 0
  for (let index = list.length - 1; index >= 0 && taken < limit; index -= 1) {
    const reading = stepSpeedReading(list[index])
    if (reading === null) continue
    tokens += reading.tokens
    decodeMs += reading.ms
    taken += 1
  }
  return decodeMs > 0 ? tokens / (decodeMs / MS_PER_SECOND) : null
}

// 官方统计弹窗定位:胶囊展开且同名弹窗恰好一个时交付该弹窗,其余情况交 null;
// 关闭/重开/换会话都会重建弹窗节点,观察器按引用变化重新交付;onUpdate 每次 DOM 变更后
// 收到当前目标,用于校正官方后续追加行造成的行序漂移
function observeStatDialog(anchor, document, Observer, onTarget, stat, dialogSelector, onUpdate) {
  let current = null
  const update = () => {
    const pill = anchor?.closest('[data-slot="conversation.composer.dock"]')?.querySelector(`[data-composer-stat="${stat}"]`)
    const button = pill?.querySelector('button')
    const dialogs = document.querySelectorAll(dialogSelector)
    const next = button?.getAttribute('aria-expanded') === 'true' && dialogs.length === 1 ? dialogs[0] : null
    if (next !== current) {
      current = next
      onTarget(next)
    }
    if (onUpdate) onUpdate(next)
    observer.takeRecords()
  }
  const observer = new Observer(update)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  update()
  return () => observer.disconnect()
}

// 详情入口不依赖自身 dock 节点,直接跟随官方 activity 胶囊的展开态;
// anchor 用于把查询限定在当前会话的 dock,避免多窗格时读到别的窗格按钮
function observeActivityStatDialog(anchor, document, Observer, onTarget) {
  let current = null
  const update = () => {
    const pill = anchor?.closest('[data-slot="conversation.composer.dock"]')?.querySelector('[data-composer-stat="activity"]')
    const button = pill?.querySelector('button')
    const dialogs = document.querySelectorAll(SPEED_DIALOG_SELECTOR)
    const next = button?.getAttribute('aria-expanded') === 'true' && dialogs.length === 1 ? dialogs[0] : null
    if (next !== current) {
      current = next
      onTarget(next)
    }
    observer.takeRecords()
  }
  const observer = new Observer(update)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  update()
  return () => observer.disconnect()
}

// 读数行归位:官方弹窗后续追加行会排在 portal 节点之后,这里把读数行搬回明细末尾
function keepSpeedRowLast(list) {
  if (!list || typeof list.querySelector !== 'function') return false
  const dt = list.querySelector(`dt[${SPEED_ROW_ATTRIBUTE}]`)
  const dd = list.querySelector(`dd[${SPEED_ROW_ATTRIBUTE}]`)
  if (!dt || !dd || dt.nextElementSibling !== dd) return false
  if (list.lastElementChild === dd) return false
  list.append(dt, dd)
  return true
}

const RECENT_TTFT_ATTRIBUTE = 'data-ud-recent-ttft'
const REQUEST_DETAILS_ENTRY_ATTRIBUTE = 'data-ud-request-entry'

const childListOf = (element) => (element?.children ? [...element.children] : [])

function findOfficialTtft(list) {
  const children = childListOf(list)
  for (let index = 0; index < children.length; index += 1) {
    const dt = children[index]
    if (dt.tagName !== 'DT' || dt.hasAttribute(RECENT_TTFT_ATTRIBUTE)) continue
    if (!String(dt.textContent ?? '').includes('TTFT')) continue
    const dd = children[index + 1]
    if (dd?.tagName === 'DD') return { dt, dd }
  }
  return null
}

function removeMarkedPair(list, attribute) {
  for (const child of childListOf(list)) {
    if (child.hasAttribute(attribute)) child.remove()
  }
}

// 最近首 token 平均行:只跟随官方 TTFT 行,找不到或没有有效值就不注入;重复同步复用同一对节点
function syncRecentTtftRow(list, { label, value, unit }) {
  if (!list?.children) return false
  const official = findOfficialTtft(list)
  if (!official || !Number.isFinite(value)) {
    removeMarkedPair(list, RECENT_TTFT_ATTRIBUTE)
    return false
  }
  const current = childListOf(list).filter((child) => child.hasAttribute(RECENT_TTFT_ATTRIBUTE))
  let dt = current.find((child) => child.tagName === 'DT')
  let dd = current.find((child) => child.tagName === 'DD')
  if (!dt || !dd) {
    if (dt) dt.remove()
    if (dd) dd.remove()
    dt = list.ownerDocument.createElement('dt')
    dd = list.ownerDocument.createElement('dd')
    dt.setAttribute(RECENT_TTFT_ATTRIBUTE, 'label')
    dd.setAttribute(RECENT_TTFT_ATTRIBUTE, 'value')
    const reference = official.dd.nextSibling
    list.insertBefore(dt, reference)
    list.insertBefore(dd, reference)
  }
  dt.textContent = label
  dd.textContent = `${value}${unit}`
  return true
}

// 详情入口:挂在官方明细之后;enabled 为假时清掉旧按钮,避免无数据残留
function syncRequestDetailsEntry(list, { label, onOpen, enabled = true }, document = list?.ownerDocument) {
  const parent = list?.parentElement
  if (!parent) return null
  const existing = childListOf(parent).find((child) => child.hasAttribute(REQUEST_DETAILS_ENTRY_ATTRIBUTE))
  if (!enabled) {
    existing?.remove()
    return null
  }
  const button = existing ?? document.createElement('button')
  if (!existing) {
    button.setAttribute(REQUEST_DETAILS_ENTRY_ATTRIBUTE, 'entry')
    button.setAttribute('type', 'button')
    button.setAttribute('aria-haspopup', 'dialog')
    button.className = 'ud-request-entry'
    button.__udOpen = onOpen
    button.addEventListener('click', () => button.__udOpen?.())
    parent.insertBefore(button, list.nextSibling)
  }
  button.__udOpen = onOpen
  button.textContent = label
  return button
}

function clearRequestDetailsExtras(target) {
  if (!target?.children) return
  removeMarkedPair(target, RECENT_TTFT_ATTRIBUTE)
  const parent = target.parentElement
  if (!parent) return
  for (const child of childListOf(parent)) {
    if (child.hasAttribute(REQUEST_DETAILS_ENTRY_ATTRIBUTE)) child.remove()
  }
}

// 官方弹窗重渲染会清掉手工节点,观察器只负责补回并保持唯一;目标关闭时由 effect 清理
function observeRequestDetailsExtras(target, document, Observer, options) {
  if (!target?.children) return undefined
  const apply = () => {
    syncRecentTtftRow(target, { label: options.ttftLabel, value: options.ttftValue, unit: options.unit })
    syncRequestDetailsEntry(target, {
      label: options.entryLabel,
      onOpen: options.onOpen,
      enabled: options.enabled,
    })
    observer.takeRecords()
  }
  const observer = new Observer(apply)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  apply()
  return () => {
    observer.disconnect()
    clearRequestDetailsExtras(target)
  }
}

// 胶囊速度文本改写:只替换「数值 + 每秒单位」片段,保留轮/步前缀与分隔;单位随宿主语言
// (tok/s、jetons/s、ток/с),text 为 null 时原样返回,便于调用方以同一入口表达"不启用"
const SPEED_READING_PATTERN = /[\d.]+ \S*?\/(?:s|с)/
// 目标读数已在尾部时不再替换:带「最近」前缀的值若被观察器再次命中,会无限叠加前缀
function speedReadingApplied(text, value) {
  if (text === value) return true
  if (!text.endsWith(value)) return false
  const before = text[text.length - value.length - 1]
  return before === undefined || !/[\d.]/.test(before)
}
function rewriteSpeedText(text, value) {
  if (typeof text !== 'string' || value === null) return text
  if (speedReadingApplied(text, value)) return text
  return SPEED_READING_PATTERN.test(text) ? text.replace(SPEED_READING_PATTERN, value) : text
}

// 宿主胶囊的文本节点可能挂在 span 任意层(紧凑模式没有 button),按子树收集统一处理
function textNodesOf(element) {
  const found = []
  const walk = (node) => {
    for (const child of node?.childNodes ?? []) {
      if (child.nodeType === TEXT_NODE) found.push(child)
      else walk(child)
    }
  }
  walk(element)
  return found
}

// 官方用时胶囊的速度读数原位改写:只替换读数片段,轮/步前缀与官方节点保留;
// text 为 null 时停止改写,卸载时只还原仍由本次改写持有的值
function observeSpeedCapsule(anchor, document, Observer, text) {
  const changes = new Map()
  const patch = (node, key, read, write) => {
    const before = read()
    if (typeof before !== 'string') return
    const after = rewriteSpeedText(before, text)
    if (after === before) return
    let fields = changes.get(node)
    if (!fields) changes.set(node, fields = new Map())
    fields.set(key, { before, after, read, write })
    write(after)
  }
  const releaseChanged = (records) => {
    for (const record of records) {
      const fields = changes.get(record.target)
      if (record.type === 'characterData') fields?.delete('text')
      if (record.type === 'attributes' && record.attributeName === 'aria-label') fields?.delete('aria')
    }
    for (const [node, fields] of changes) if (fields.size === 0 || !document.contains(node)) changes.delete(node)
  }
  const update = (records = []) => {
    releaseChanged(records)
    const pill = anchor?.closest('[data-slot="conversation.composer.dock"]')?.querySelector('[data-composer-stat="activity"]')
    // 紧凑模式只有不可展开的 span 胶囊,没有 aria-label 可同步
    const button = pill?.querySelector('button')
    for (const node of textNodesOf(pill)) patch(node, 'text', () => node.nodeValue, (value) => { node.nodeValue = value })
    if (button) patch(button, 'aria', () => button.getAttribute('aria-label'), (value) => button.setAttribute('aria-label', value))
    observer.takeRecords()
  }
  const observer = new Observer(update)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] })
  update()
  return () => {
    releaseChanged(observer.takeRecords())
    observer.disconnect()
    for (const fields of changes.values()) for (const change of fields.values()) {
      if (change.read() === change.after) change.write(change.before)
    }
  }
}

function buildUsageDialogRows(usage, prefs, t) {
  if (!usage || billedInputTokens(usage) === 0) return []
  const rows = []
  if (prefs.tokenDetail) {
    rows.push({ key: 'input', label: t('stats.inputTotal'), value: `${formatTokens(billedInputTokens(usage))} tok` })
    if (usage.cacheWriteTokens > 0) rows.push({ key: 'miss', label: t('stats.missTotal'), value: `${formatTokens(usage.uncachedInputTokens + usage.cacheWriteTokens)} tok` })
  }
  return rows
}

// 仅改写百分比文本，保留官方节点与事件；卸载时只还原仍由本次增强持有的值。
function observeUsageDialog(anchor, document, Observer, onTarget, percent) {
  let current
  const changes = new Map()
  const patch = (node, key, read, write) => {
    const before = read()
    if (typeof before !== 'string') return
    const after = before.replace(/\d+(?:\.\d+)?%/g, `${percent}%`)
    if (after === before) return
    let fields = changes.get(node)
    if (!fields) changes.set(node, fields = new Map())
    fields.set(key, { before, after, read, write })
    write(after)
  }
  const patchText = (element) => {
    if (!element || percent === null) return
    const walker = document.createTreeWalker(element, 4)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const textNode = node
      patch(textNode, 'text', () => textNode.nodeValue, (value) => { textNode.nodeValue = value })
    }
  }
  const releaseChanged = (records) => {
    for (const record of records) {
      const fields = changes.get(record.target)
      if (record.type === 'characterData') fields?.delete('text')
      if (record.type === 'attributes' && record.attributeName === 'aria-label') fields?.delete('aria')
    }
    for (const [node, fields] of changes) if (fields.size === 0 || !document.contains(node)) changes.delete(node)
  }
  const update = (records = []) => {
    releaseChanged(records)
    const pill = anchor?.closest('[data-slot="conversation.composer.dock"]')?.querySelector('[data-composer-stat="usage"]')
    const button = pill?.querySelector('button')
    patchText(pill)
    if (button && percent !== null) patch(button, 'aria', () => button.getAttribute('aria-label'), (value) => button.setAttribute('aria-label', value))
    const dialogs = document.querySelectorAll('[data-session-stats-usage]')
    const next = button?.getAttribute('aria-expanded') === 'true' && dialogs.length === 1 ? dialogs[0] : null
    patchText(next?.querySelector('dd'))
    observer.takeRecords()
    if (next !== current) { current = next; onTarget(next) }
  }
  const observer = new Observer(update)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-label'] })
  update()
  return () => {
    releaseChanged(observer.takeRecords())
    observer.disconnect()
    for (const fields of changes.values()) for (const change of fields.values()) {
      if (change.read() === change.after) change.write(change.before)
    }
  }
}

// stats-line 偏好状态工厂:宿主 settings 投影(configForms.get)注入便于 Node 测试
// 展示增强默认开;替换官方读数与最近请求详情属额外注入,缺键按关。写入先乐观更新,宿主拒绝或异常时回读宿主快照回滚
function createStatsLineState(form) {
  const KEYS = Object.keys(STATS_LINE_DEFAULT_PREFS)
  const normalize = (value) => ({
    cachePrecision: value?.cachePrecision !== false,
    tokenDetail: value?.tokenDetail !== false,
    costDisplay: value?.costDisplay !== false,
    recentSpeed: value?.recentSpeed !== false,
    replaceSpeed: value?.replaceSpeed === true,
    requestDetails: value?.requestDetails === true,
  })
  const read = () => {
    try {
      return normalize(form?.getSnapshot?.()?.value?.[STATS_LINE_FIELD])
    } catch {
      return { ...STATS_LINE_DEFAULT_PREFS }
    }
  }
  const same = (left, right) => KEYS.every((key) => left[key] === right[key])
  let state = read()
  const listeners = new Set()
  let offForm = null
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const adopt = () => {
    const next = read()
    if (same(next, state)) return
    state = next
    notify()
  }
  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...patch }
      if (same(next, state)) return
      state = next
      notify()
      if (!form) return
      const ops = Object.entries(patch).map(([field, value]) => ({ op: 'set', path: [STATS_LINE_FIELD, field], value }))
      let pending
      try {
        pending = form.mutate(ops)
      } catch (error) {
        console.warn('[usage-dash] 底部信息栏偏好写入异常', error)
        adopt()
        return
      }
      Promise.resolve(pending).then((accepted) => {
        if (accepted === false) {
          console.warn('[usage-dash] 底部信息栏偏好写入未生效')
          adopt()
        }
      }, (error) => {
        console.warn('[usage-dash] 底部信息栏偏好写入异常', error)
        adopt()
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      if (offForm === null && form && typeof form.subscribe === 'function') {
        offForm = form.subscribe(adopt)
        adopt()
      } else if (listeners.size > 1) {
        // 已有订阅者时,晚挂载的组件不会触发 adopt;立即回放当前投影,避免停在缺省值
        listener()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && offForm !== null) {
          offForm()
          offForm = null
        }
      }
    },
    reload: adopt,
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
const SEGMENT_EXACT = 0
const SEGMENT_PREFIX = 1
const SEGMENT_SUFFIX = 2
const SEGMENT_INFIX = 3
const SEGMENT_ANY = 4
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
  if (!condition || typeof condition.kind !== 'string' || !Object.hasOwn(CONDITION_MATCHERS, condition.kind)
    || !(date instanceof Date) || Number.isNaN(date.getTime())) return false
  return CONDITION_MATCHERS[condition.kind](condition, date)
}

// 形状残缺规则跳过:缺 model/price、unit 非 perMillion、conditions 非数组(缺失视为无条件)
function isRuleShaped(rule) {
  return !!rule && typeof rule === 'object' && typeof rule.model === 'string'
    && (rule.unit === undefined || rule.unit === UNIT_PER_MILLION)
    && !!rule.price && typeof rule.price === 'object' && !Array.isArray(rule.price)
    && (rule.conditions === undefined || rule.conditions === null || Array.isArray(rule.conditions))
}

// 规则以首个斜杠分段,其后的斜杠属于型号。
function splitRuleSegments(pattern) {
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

const isTwoSegmentModel = (pattern) => compilePricingModel(pattern) !== null

// 请求侧无斜杠或首位斜杠时沿用缺省供应商。
const splitRequestSegments = (model) => splitRuleSegments(model) ?? [PROVIDER_UNSET, model]

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

const resolvePricingRule = (rules, model, timestamp) => {
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

function matchPriceRule(rules, model, timestamp) {
  const rule = selectPricingRule(rules, model, timestamp)
  return rule === null ? null : { rule, price: rule.price }
}

function matchPrice(rules, model, timestamp) {
  return selectPricingRule(rules, model, timestamp)?.price ?? null
}

const BUCKET_PRICE_KEYS = [
  { tokens: 'inputTokens', price: 'input' },
  { tokens: 'outputTokens', price: 'output' },
  { tokens: 'cacheReadTokens', price: 'cacheRead' },
  { tokens: 'cacheWriteTokens', price: 'cacheWrite' },
]

const BUCKET_LABEL_KEYS = {
  inputTokens: 'requestUncachedInput',
  outputTokens: 'requestOutput',
  cacheReadTokens: 'requestCacheRead',
  cacheWriteTokens: 'requestCacheWrite',
}

// 展示侧四桶键单一来源:模型分组求和与齐备判定共用,禁止各处手工复制键名
const TOKEN_BUCKET_KEYS = BUCKET_PRICE_KEYS.map(({ tokens }) => tokens)

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
const COST_APPROX = '≈'
// 单价原值展示的保留位数:覆盖到十亿分之一美元级,再小已无实际定价意义
const UNIT_PRICE_DECIMALS = 6
const THOUSANDS_PATTERN = /(\d)(?=(\d{3})+(?!\d))/g

// 千分位 + 至少 decimals 位小数,正值小于 10^-decimals 时小数位 +2;
// 货币非字符串(存量规则可能缺省或为 null)按无符号处理,「≈」前缀由调用方拼
function formatCost(value, currency, decimals = COST_DECIMALS) {
  const symbol = typeof currency === 'string' ? currency : ''
  const microThreshold = 10 ** -decimals
  const used = value > 0 && value < microThreshold ? decimals + (COST_MICRO_DECIMALS - COST_DECIMALS) : decimals
  const [whole, fraction] = value.toFixed(used).split('.')
  return `${symbol}${whole.replace(THOUSANDS_PATTERN, '$1,')}.${fraction}`
}

const COST_CENT_SCALE = 100
const COST_MICRO_SCALE = COST_CENT_SCALE * COST_CENT_SCALE

// 金额轴紧凑读数:千以上 k/M 一位小数,分上取两位内,分下四位(微观阈值与 formatCost 同源)
function formatCostCompact(value, currency) {
  if (value >= COMPACT_BASE ** 2) return `${currency}${(value / COMPACT_BASE ** 2).toFixed(DECIMAL_DIGITS)}M`
  if (value >= COMPACT_BASE) return `${currency}${(value / COMPACT_BASE).toFixed(DECIMAL_DIGITS)}k`
  if (value >= COST_MICRO_THRESHOLD) return `${currency}${Math.round(value * COST_CENT_SCALE) / COST_CENT_SCALE}`
  return `${currency}${Math.round(value * COST_MICRO_SCALE) / COST_MICRO_SCALE}`
}

// 模型均价:费用折算每百万 token 单价;无费用(cost 恒正数才有效,0 视为未配价)或零 token 无均价
const AVG_PRICE_DECIMALS = 3
function avgPriceText(cost, tokens, currency) {
  if (!(cost > 0) || !(tokens > 0)) return ''
  return `${formatCost(cost / (tokens / TOKENS_PER_MILLION), currency, AVG_PRICE_DECIMALS)}/M`
}

// 全局显示货币:规则表首个非空 currency,所有费用显示点统一取此值(全局价格定位);
// 无则空串即不带符号。数值仍按命中规则单价计算,符号不随命中规则变化
function aggregateCurrencyOf(rules) {  if (!Array.isArray(rules)) return ''
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

// 最近请求行的展示值:投影只存原始四桶,价格与速度在渲染时派生
const REQUEST_NUMBER_DECIMALS = 1
const REQUEST_TTFT_SECONDS_SCALE = 10 ** REQUEST_NUMBER_DECIMALS
const RECENT_TTFT_AVERAGE_STEPS = 10
// 毫秒级事件时间下,短 decode 窗口会把单次吞吐放大到无意义量级;低于该窗口不作为速度样本
const REQUEST_SPEED_MIN_DECODE_MS = MS_PER_SECOND / 10
const REQUEST_TOKEN_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

function requestTotalTokens(row) {
  const usage = row?.usage
  if (!usage) return null
  return REQUEST_TOKEN_KEYS.reduce((sum, key) => sum + toFiniteNumber(usage[key]), 0)
}

function hasRequestSpeedSample(row) {
  return Boolean(row?.usage) && Number.isFinite(row.decodeMs) && row.decodeMs >= REQUEST_SPEED_MIN_DECODE_MS
}

function requestDecodeSpeed(row) {
  if (!hasRequestSpeedSample(row)) return null
  return toFiniteNumber(row.usage.outputTokens) / (row.decodeMs / MS_PER_SECOND)
}

function requestCostOf(row, rules) {
  const usage = row?.usage
  if (!usage) return null
  const matched = matchPriceRule(rules, row?.model, row?.startedAt)
  if (!matched) return null
  return {
    total: costOf(matched.price, pricingBucketsOf(usage)),
    price: matched.price,
    rule: matched.rule,
  }
}

function formatRequestCost(value, currency, partial = false) {
  if (!Number.isFinite(value)) return COST_PLACEHOLDER
  const decimals = value > 0 && value < COST_MICRO_THRESHOLD ? COST_MICRO_DECIMALS : COST_DECIMALS
  return `${partial ? '≥' : '≈'}${formatCost(value, currency, decimals)}`
}

function requestTtftAverageSeconds(rows) {
  if (!Array.isArray(rows)) return null
  const values = rows
    .slice(-RECENT_TTFT_AVERAGE_STEPS)
    .map((row) => row?.ttftMs)
    .filter((value) => Number.isFinite(value) && value >= 0)
  if (values.length === 0) return null
  const averageMs = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.round((averageMs / MS_PER_SECOND) * REQUEST_TTFT_SECONDS_SCALE) / REQUEST_TTFT_SECONDS_SCALE
}

function summarizeRequests(rows, rules) {
  const list = Array.isArray(rows) ? rows : []
  let ttftTotal = 0
  let ttftCount = 0
  let outputTokens = 0
  let outputCount = 0
  let decodeMs = 0
  let tokenTotal = 0
  let tokenCount = 0
  let costTotal = 0
  let pricedCount = 0
  for (const row of list) {
    if (Number.isFinite(row?.ttftMs) && row.ttftMs >= 0) {
      ttftTotal += row.ttftMs
      ttftCount += 1
    }
    if (hasRequestSpeedSample(row)) {
      outputTokens += toFiniteNumber(row.usage.outputTokens)
      outputCount += 1
      decodeMs += row.decodeMs
    }
    const total = requestTotalTokens(row)
    if (total !== null) {
      tokenTotal += total
      tokenCount += 1
    }
    const priced = requestCostOf(row, rules)
    if (priced) {
      costTotal += priced.total
      pricedCount += 1
    }
  }
  return {
    count: list.length,
    ttftMs: ttftCount > 0 ? ttftTotal / ttftCount : null,
    speed: decodeMs > 0 ? outputTokens / (decodeMs / MS_PER_SECOND) : null,
    outputTokens: outputCount > 0 ? outputTokens / outputCount : null,
    totalTokens: tokenCount > 0 ? tokenTotal / tokenCount : null,
    cost: pricedCount > 0 ? costTotal / pricedCount : null,
    pricedCount,
    unpricedCount: list.length - pricedCount,
  }
}

function formatRequestRowModel(model) {
  if (typeof model !== 'string' || model === '') return COST_PLACEHOLDER
  const slash = model.indexOf(SEGMENT_SEPARATOR)
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model
}

const formatClock = (time) => {
  const date = new Date(time)
  return Number.isNaN(date.getTime())
    ? COST_PLACEHOLDER
    : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const bucketCostOf = (price, key, tokens) =>
  toFiniteNumber(tokens) * toFiniteNumber(price?.[key]) / TOKENS_PER_MILLION

function cacheHitRateOf(usage) {
  if (!usage) return null
  const billedInput = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return billedInput > 0 ? (usage.cacheReadTokens / billedInput) * 100 : null
}

// routes 缺席占位:双段通配模型键,仅被 '*/*' 全通配规则命中(供应商与模型全未知)
const MODEL_UNROUTED = '*/*'
// 宿主投影键:底栏按小时/模型取数,不能只靠 tokenUsage 四桶猜模型
const MODEL_USAGE_PROJECTION = 'usageDashModelUsage'

// 投影桶是否有用量:没有用量的空桶不参与计价
function usageBucketsUsed(buckets) {
  return (buckets?.uncachedInputTokens ?? 0) + (buckets?.outputTokens ?? 0)
    + (buckets?.cacheReadTokens ?? 0) + (buckets?.cacheWriteTokens ?? 0) > 0
}

// 小时桶按模型聚合:同一模型的多个小时桶四桶相加,时段只决定命中哪条规则。
// 宿主小时投影的桶名与计价桶名不同:uncachedInputTokens 对应 inputTokens。
// 聚合一经映射后与 costOf 共用 BUCKET_PRICE_KEYS,不再维护第二套计价键。
const PROJECTION_TOKEN_KEYS = [
  { from: 'uncachedInputTokens', to: 'inputTokens' },
  { from: 'outputTokens', to: 'outputTokens' },
  { from: 'cacheReadTokens', to: 'cacheReadTokens' },
  { from: 'cacheWriteTokens', to: 'cacheWriteTokens' },
]

function aggregateHoursOf(hours) {
  const byModel = new Map()
  for (const entry of Array.isArray(hours) ? hours : []) {
    if (!entry || !Number.isFinite(entry.time) || typeof entry.model !== 'string') continue
    if (!usageBucketsUsed(entry)) continue
    let acc = byModel.get(entry.model)
    if (acc === undefined) {
      acc = {
        model: entry.model,
        time: entry.time,
        buckets: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
      byModel.set(entry.model, acc)
    }
    for (const { from, to } of PROJECTION_TOKEN_KEYS) acc.buckets[to] += toFiniteNumber(entry[from])
    if (entry.time > acc.time) acc.time = entry.time
  }
  return [...byModel.values()].sort((left, right) => left.model.localeCompare(right.model))
}

function sumBucketsOf(models) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const { buckets } of models) for (const tokens of TOKEN_BUCKET_KEYS) total[tokens] += toFiniteNumber(buckets[tokens])
  return total
}

const bucketTotalOf = (buckets) =>
  TOKEN_BUCKET_KEYS.reduce((sum, tokens) => sum + toFiniteNumber(buckets?.[tokens]), 0)

function modelCostBreakdownOf(hours, rules) {
  const rows = []
  const unpricedModels = []
  let total = 0
  for (const acc of aggregateHoursOf(hours)) {
    const matched = matchPriceRule(rules, acc.model, new Date(acc.time))
    if (!matched) {
      unpricedModels.push(acc.model)
      continue
    }
    const cost = costOf(matched.price, acc.buckets)
    total += cost
    rows.push({ key: acc.model, model: acc.model, time: acc.time, price: matched.price, rule: matched.rule, buckets: acc.buckets, cost })
  }
  return { rows, total, unpricedModels }
}

// 当期会话:有小时投影按模型聚合,否则单路由兜底。决策只在这里,底栏文本与展开面板同源
function selfCostBreakdownOf(usage, modelUsage, rules, now) {
  const hours = Array.isArray(modelUsage?.hours) ? modelUsage.hours : []
  if (hours.length > 0) {
    const aggregated = modelCostBreakdownOf(hours, rules)
    if (aggregated.rows.length > 0 || aggregated.unpricedModels.length > 0) {
      return { ...aggregated, unpricedSession: false, fallback: false }
    }
  }
  const single = singleRouteCostBreakdownOf(usage, rules, now)
  return {
    rows: single.rows,
    total: single.total,
    unpricedModels: single.unpricedModels,
    unpricedSession: single.unpricedSession,
    fallback: true,
  }
}

// 底栏会话费用:优先按宿主投影的小时/模型桶按模型聚合;投影缺席(旧宿主/注册失败)
// 才回退到 routes 与单个 now,仍不伪造全局价。
function buildSessionCostItem(usage, modelUsage, rules, prefs, t, now = new Date()) {
  // 未配置规则时不显示费用项:占位符留给「有规则但当前模型未定价」的可见提示
  if (!prefs?.costDisplay || !usage || !Array.isArray(rules) || rules.length === 0) return null
  const breakdown = selfCostBreakdownOf(usage, modelUsage, rules, now)
  return {
    text: breakdown.rows.length > 0
      ? t('stats.cost', { cost: formatCost(breakdown.total, aggregateCurrencyOf(rules)) })
      : COST_PLACEHOLDER,
    unpriced: breakdown.unpricedModels.length,
  }
}

// ===== 费用展开面板数据面:当期会话与子代理两档 =====
// 子会话判定沿用宿主口径:origin='subagent' 才是子代理;普通 fork 同样带 parentId,
// 单独出现不判子会话。遍历按 visited 防环,孤儿(父行不在表内)自然不可达。
const SUBAGENT_ORIGIN = 'subagent'
const MODEL_USAGE_HOURS = 'hours'

function subagentDescendantIds(byId, rootId) {
  if (!byId || typeof byId !== 'object' || typeof rootId !== 'string') return []
  const childrenOf = new Map()
  for (const [id, row] of Object.entries(byId)) {
    if (!row || row.origin !== SUBAGENT_ORIGIN || typeof row.parentId !== 'string') continue
    const siblings = childrenOf.get(row.parentId)
    if (siblings) siblings.push(id)
    else childrenOf.set(row.parentId, [id])
  }
  const found = []
  const visited = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found.sort()
}

// 子代理小时桶:合并所有后代子代理的投影(展开时向宿主拉取),无小时数据的子代理单独计数。
// 不再逐子代理拆行 —— 子代理档只按模型聚合一次
function subagentHoursOf(byId, rootId, projectionsBySession) {
  const hours = []
  let missing = 0
  for (const id of subagentDescendantIds(byId, rootId)) {
    const values = { ...(byId[id]?.projectionValues ?? {}), ...(projectionsBySession?.[id]?.values ?? {}) }
    const list = values[MODEL_USAGE_PROJECTION]?.[MODEL_USAGE_HOURS]
    if (Array.isArray(list) && list.length > 0) hours.push(...list)
    else missing += 1
  }
  return { hours, missing }
}

// 子代理费用:所有子代理小时桶合并后按模型聚合,每模型一次;取不到小时数据的只计数
function subagentCostBreakdownOf(byId, rootId, projectionsBySession, rules) {
  const { hours, missing } = subagentHoursOf(byId, rootId, projectionsBySession)
  return { ...modelCostBreakdownOf(hours, rules), missing }
}

// 子代理明细(二级页):每个子代理一行,模型与费用来自小时投影;只有 tokenUsage 摘要时
// 给四桶与总量但标注仅摘要,两样都没有的计入 missing
function subagentDetailOf(byId, rootId, projectionsBySession, rules) {
  const rows = []
  let totalTokens = 0
  let total = 0
  let unpriced = 0
  let missing = 0
  for (const id of subagentDescendantIds(byId, rootId)) {
    const entry = byId[id] ?? {}
    const values = { ...(entry.projectionValues ?? {}), ...(projectionsBySession?.[id]?.values ?? {}) }
    const hours = values[MODEL_USAGE_PROJECTION]?.[MODEL_USAGE_HOURS]
    const usage = values.tokenUsage ?? null
    const models = Array.isArray(hours) ? aggregateHoursOf(hours) : []
    const hasHours = models.length > 0
    const priced = hasHours ? modelCostBreakdownOf(hours, rules) : null
    const title = typeof entry.displayTitle === 'string' && entry.displayTitle !== '' ? entry.displayTitle : id
    if (!hasHours && !usageBucketsUsed(usage)) {
      missing += 1
      rows.push({ key: id, title, model: null, buckets: null, tokens: null, cost: null, unpricedModels: 0, summaryOnly: false, missing: true })
      continue
    }
    const buckets = hasHours ? sumBucketsOf(models) : pricingBucketsOf(usage)
    const tokens = bucketTotalOf(buckets)
    totalTokens += tokens
    if (priced !== null) {
      total += priced.total
      unpriced += priced.unpricedModels.length
    }
    rows.push({
      key: id,
      title,
      model: hasHours ? models.map((model) => model.model).join(' + ') : null,
      buckets,
      tokens,
      cost: priced === null ? null : priced.total,
      unpricedModels: priced === null ? 0 : priced.unpricedModels.length,
      summaryOnly: !hasHours,
      missing: false,
    })
  }
  return { rows, totalTokens, total, unpriced, missing }
}

// 子代理明细视图:列宽与文案在数据层定稿,组件只做 DOM 映射
function subagentUsageViewOf(detail, t, currency) {
  const formatBucket = (value) => (value === null || value === undefined ? COST_PLACEHOLDER : formatTokens(value))
  const rows = detail.rows.map((row) => ({
    key: row.key,
    title: row.title,
    model: row.model ?? COST_PLACEHOLDER,
    input: formatBucket(row.buckets?.inputTokens),
    output: formatBucket(row.buckets?.outputTokens),
    cacheRead: formatBucket(row.buckets?.cacheReadTokens),
    cacheWrite: formatBucket(row.buckets?.cacheWriteTokens),
    total: row.tokens === null ? COST_PLACEHOLDER : formatBucket(row.tokens),
    amount: row.cost === null ? COST_PLACEHOLDER : formatPanelCost(row.cost, currency),
    note: row.missing ? t('subagentMissingRow') : row.summaryOnly ? t('subagentSummaryOnly') : null,
  }))
  const footnotes = []
  if (detail.missing > 0) footnotes.push(t('subagentMissing', { n: detail.missing }))
  if (detail.unpriced > 0) footnotes.push(t('subagentUnpriced', { n: detail.unpriced }))
  return {
    title: t('subagentUsageTitle'),
    subtitle: t('subagentUsageSubtitle', { n: detail.rows.length }),
    rows,
    empty: detail.rows.length === 0 ? t('subagentUsageEmpty') : null,
    totals: {
      tokens: formatTokens(detail.totalTokens),
      amount: detail.total > 0 ? `${COST_APPROX} ${formatPanelCost(detail.total, currency)}` : COST_PLACEHOLDER,
    },
    footnotes,
  }
}

function costTotalsOf(selfBreakdown, subagentBreakdown) {
  const self = Number.isFinite(selfBreakdown?.total) ? selfBreakdown.total : 0
  const subagents = Number.isFinite(subagentBreakdown?.total) ? subagentBreakdown.total : 0
  return { self, subagents, combined: self + subagents }
}

// 展开面板视图:全部金额与公式串在此定稿,组件只做 DOM 映射;行表达式按计价同序
// (输入 / 输出 / 缓存读 / 缓存写),四项全列以便核对为零的桶。
// 单价按原值展示:至少两位小数,超过两位时保留原精度(最多 6 位去尾零),
// 否则展示精度会把表达式手算结果带偏
function formatUnitPrice(value, currency) {
  const price = toFiniteNumber(value)
  const trimmed = String(Number(price.toFixed(UNIT_PRICE_DECIMALS)))
  const decimals = trimmed.includes('.') ? trimmed.split('.')[1].length : 0
  return `${currency}${decimals >= 2 ? trimmed : price.toFixed(2)}`
}

function costExpressionOf(buckets, price, currency) {
  return BUCKET_PRICE_KEYS
    .map(({ tokens, price: priceKey }) => `${formatTokens(toFiniteNumber(buckets?.[tokens]))}×${formatUnitPrice(price?.[priceKey], currency)}`)
    .join(' + ')
}

// 条件摘要:多分支规则命中哪条由 conditions 决定,提示里必须带上,否则同样的模型会出现多个单价
function conditionSummaryOf(condition, t) {
  if (!condition || typeof condition !== 'object') return ''
  if (condition.kind === 'dailyWindow') return t('condSummaryDailyWindow', { from: condition.from, to: condition.to })
  if (condition.kind === 'weekdays') {
    const days = Array.isArray(condition.days) ? condition.days.map((day) => t(`weekday.${day}`)).join('、') : ''
    return `${t('condWeekdays')} ${days}`
  }
  if (condition.kind === 'monthDays') return t('condSummaryMonthDays', { from: condition.from, to: condition.to })
  if (condition.kind === 'dateRange') return t('condSummaryDateRange', { from: condition.from, to: condition.to })
  return ''
}

// 公式项:面板显示缩写 token,悬浮说明给完整 token、单价、该项金额与命中规则(含条件)
function costExpressionTermsOf(buckets, price, rule, currency, t) {
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions.map((condition) => conditionSummaryOf(condition, t)).filter(Boolean) : []
  const ruleText = typeof rule?.model === 'string'
    ? `${rule.model}${conditions.length > 0 ? ` · ${conditions.join('、')}` : ''}`
    : ''
  return BUCKET_PRICE_KEYS.map(({ tokens, price: priceKey }) => {
    const count = toFiniteNumber(buckets?.[tokens])
    const unit = toFiniteNumber(price?.[priceKey])
    const amount = count * unit / TOKENS_PER_MILLION
    return {
      key: tokens,
      label: t(BUCKET_LABEL_KEYS[tokens]),
      short: `${formatTokensCompact(count)}×${formatUnitPrice(unit, currency)}`,
      detail: `${formatTokens(count)} × ${formatUnitPrice(unit, currency)}/M = ${formatPanelCost(amount, currency)}`,
      rule: ruleText,
    }
  })
}

// 面板金额:四位小数保证多模型行与合计可手算复核;更小的值退到单价精度,避免显示成零
const PANEL_COST_DECIMALS = 4

function formatPanelCost(value, currency) {
  const cost = toFiniteNumber(value)
  const digits = cost !== 0 && Math.abs(cost) < 10 ** -PANEL_COST_DECIMALS ? UNIT_PRICE_DECIMALS : PANEL_COST_DECIMALS
  return `${currency}${cost.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function costPanelRowOf(row, currency, t) {
  return {
    key: row.key,
    model: row.model,
    amount: formatPanelCost(row.cost, currency),
    expression: costExpressionOf(row.buckets, row.price, currency),
    terms: costExpressionTermsOf(row.buckets, row.price, row.rule, currency, t),
  }
}

// 单档合计:无已计价行时给占位符,不把「未配置/未定价」显示成零元
const costTotalText = (section, currency) =>
  (section.rows.length > 0 ? `${COST_APPROX} ${formatPanelCost(section.total, currency)}` : COST_PLACEHOLDER)

function costPanelViewOf(model, t, options = {}) {
  const currency = model.currency
  const unavailable = options.subagentsAvailable === false
  const self = {
    key: 'self',
    title: t('costSelfSection'),
    note: model.fallback ? t('costSelfFallback') : null,
    empty: model.self.rows.length === 0 ? t('costSelfEmpty') : null,
    rows: model.self.rows.map((row) => costPanelRowOf(row, currency, t)),
  }
  const subs = {
    key: 'subagents',
    title: t('costSubagentSection'),
    note: null,
    // 有未定价/未取到用量的子代理时脚注已说明,不再同时说「暂无子代理用量」
    empty: unavailable
      ? t('costSubagentUnavailable')
      : model.subs.rows.length === 0 && model.subs.missing === 0 && model.subs.unpricedModels.length === 0
        ? t('costSubagentEmpty')
        : null,
    rows: unavailable ? [] : model.subs.rows.map((row) => costPanelRowOf(row, currency, t)),
  }
  const totals = [{ key: 'self', label: t('costSelfLabel'), value: costTotalText(model.self, currency) }]
  if (!unavailable) {
    const combined = { rows: [...model.self.rows, ...model.subs.rows], total: model.totals.combined }
    totals.push({ key: 'subagents', label: t('costWithSubagentsLabel'), value: costTotalText(combined, currency) })
  }
  const footnotes = [t('costPanelNote')]
  if (model.self.unpricedModels.length > 0) footnotes.push(t('costUnpricedModels', { n: model.self.unpricedModels.length }))
  if (model.self.unpricedSession) footnotes.push(t('costSelfUnpriced'))
  if (!unavailable && model.subs.unpricedModels.length > 0) footnotes.push(t('costUnpricedSubagentModels', { n: model.subs.unpricedModels.length }))
  if (!unavailable && model.subs.missing > 0) footnotes.push(t('costSubagentMissing', { n: model.subs.missing }))
  return {
    title: t('costPanelTitle'),
    totals,
    sections: [self, subs],
    footnotes,
  }
}
// 单路由兜底:没有小时桶,未定价是「当前模型整体无价」而非某个模型缺价,单独标记
function singleRouteCostBreakdownOf(usage, rules, now) {
  const route = usage?.routes?.[0]
  if (!route || !route.model) return { rows: [], total: 0, unpricedModels: [], unpricedSession: false }
  const model = turnModelOf(usage)
  const price = matchPrice(rules, model, now)
  if (!price) return { rows: [], total: 0, unpricedModels: [], unpricedSession: true }
  const buckets = pricingBucketsOf(usage)
  const cost = costOf(price, buckets)
  return {
    rows: [{ key: model, model, time: null, price, buckets, cost }],
    total: cost,
    unpricedModels: [],
    unpricedSession: false,
  }
}

// 展开面板模型:两档金额一律由计价函数产出,展示层不再算钱;fallback 标记主会话走了单路由兜底
function costPanelModelOf({ usage, modelUsage, rules, subagentHours = [], subagentMissing = 0, now }) {
  const at = now instanceof Date ? now : new Date(now ?? Date.now())
  const self = selfCostBreakdownOf(usage, modelUsage, rules, at)
  const subs = { ...modelCostBreakdownOf(subagentHours, rules), missing: subagentMissing }
  return {
    currency: aggregateCurrencyOf(rules),
    fallback: self.fallback,
    self: { rows: self.rows, total: self.total, unpricedModels: self.unpricedModels, unpricedSession: self.unpricedSession },
    subs: { rows: subs.rows, total: subs.total, unpricedModels: subs.unpricedModels, missing: subs.missing },
    totals: costTotalsOf(self, subs),
  }
}

// 历史费用口径标注:估算说明,未计价小时桶计数为正时追加后缀
function costTitleText(t, unpriced) {
  const base = t('costTitle')
  return unpriced > 0 ? `${base},${t('costUnpriced', { n: unpriced })}` : base
}

// 会话底栏费用口径标注:投影按模型聚合计价,未计价按模型计数
function sessionCostTitleText(t, unpriced) {
  const base = t('statsCostTitle')
  return unpriced > 0 ? `${base},${t('costUnpricedModels', { n: unpriced })}` : base
}

// ===== 注入点B:回合费用芯片(官方动作行 assistant-actions 槽条目,赞踩/上下文跳转同排) =====
// 排序取上下文插件条目(20)之后,贴近尾部用量/用时芯片一侧
const TURN_COST_CHIP_ORDER = 20 + 10

// messageId 反查:节点表为 chat 节点仓库(values() 可枚举,Map/仓库两态兼容);
// 回合级用量优先取回合位置数据(location.turn.data.get('turn-tail')).tokenUsage(官方 tokenUsage 聚合,
// 分页窗口缺 turn/start 时缺席),回退视图节点 data.closing.usage(末步用量采样,输入侧已含缓存,计费口径同源)
// 索引缓存:键取节点集数组身份 —— 官方 chat store 实例身份跨回合恒定,values() 返回的缓存数组
// 随节点集更替换新引用:未变时全芯片共享一次扫描,新增回合节点经 values() 换引用自动失效重建
// (按 store 实例为键会让新节点永远查不到旧索引,表现为回合费用芯片刷新后才出现);
// Map/迭代器形态(测试兼容)仍按容器为键
const TURN_USAGE_INDEX_CACHE = new WeakMap()

function turnUsageIndexOf(nodes) {
  const source = nodes && typeof nodes.values === 'function' ? nodes.values() : nodes
  const snapshotForm = Array.isArray(source)
  const cacheKey = snapshotForm ? source : nodes
  let index = TURN_USAGE_INDEX_CACHE.get(cacheKey)
  if (index !== undefined) return index
  index = new Map()
  const list = snapshotForm ? source : typeof source?.[Symbol.iterator] === 'function' ? [...source] : source
  if (Array.isArray(list)) {
    for (const node of list) {
      try {
        if (node?.kind !== 'turn-tail') continue
        const messageId = node.data?.closing?.finalNode?.messageId
        if (typeof messageId !== 'string' || index.has(messageId)) continue
        index.set(messageId, node)
      } catch { /* 单节点形状残缺跳过 */ }
    }
  }
  TURN_USAGE_INDEX_CACHE.set(cacheKey, index)
  return index
}

function turnTokenUsageOfMessage(nodes, messageId) {
  // 非对象(含 null/undefined)直接 null:WeakMap 键要求对象,展开校验收进索引构建,
  // 每份节点集只物化一次节点序列
  if (nodes === null || typeof nodes !== 'object') return null
  const node = turnUsageIndexOf(nodes).get(messageId)
  if (node === undefined) return null
  try {
    const turnData = node.location?.turn?.data
    const tail = turnData && typeof turnData.get === 'function' ? turnData.get('turn-tail') : null
    if (tail?.tokenUsage) return tail.tokenUsage
    if (node.data.tokenUsage) return node.data.tokenUsage
    return usageSourceBuckets(node.data?.closing?.usage ?? null)
  } catch { /* 单节点形状残缺跳过,语义同扫描容错 */ }
  return null
}

// messageId 反查用量源:返回仓库内既有引用(官方聚合 tokenUsage → 视图节点 tokenUsage → closing.usage 采样),
// 引用恒定直至该回合数据被替换;全缺返回 null。供 useChat selector 使用 ——
// selector 必须返回稳定引用(useSyncExternalStore 以 Object.is 比对快照),返回新建对象会造成无限渲染;
// 采样形态(字段名差异)由 usageSourceBuckets 在渲染层归一
function turnUsageSourceOfMessage(nodes, messageId) {
  if (nodes === null || typeof nodes !== 'object') return null
  const node = turnUsageIndexOf(nodes).get(messageId)
  if (node === undefined) return null
  try {
    const turnData = node.location?.turn?.data
    const tail = turnData && typeof turnData.get === 'function' ? turnData.get('turn-tail') : null
    return tail?.tokenUsage ?? node.data.tokenUsage ?? node.data?.closing?.usage ?? null
  } catch { /* 单节点形状残缺跳过,语义同扫描容错 */ }
  return null
}

// 回合结束时刻:时间条件应按历史回合发生的时刻匹配,而不是芯片首次渲染的时刻
function turnTimeOfMessage(nodes, messageId) {
  if (nodes === null || typeof nodes !== 'object') return null
  const node = turnUsageIndexOf(nodes).get(messageId)
  if (node === undefined) return null
  const time = node?.data?.time ?? node?.time
  return Number.isFinite(time) ? time : null
}

// 用量源 → 聚合桶形态:closing.usage 采样字段名不同(inputTokens 即 uncached 口径,实测 total-input=output 恒等),
// 聚合形态(已带 uncachedInputTokens)原样直通保持引用
function usageSourceBuckets(source) {
  if (!source || source.uncachedInputTokens !== undefined) return source
  if (source.inputTokens === undefined) return null
  return {
    uncachedInputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    totalTokens: source.totalTokens,
    ...source.cacheReadTokens === undefined ? {} : { cacheReadTokens: source.cacheReadTokens },
    ...source.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: source.cacheWriteTokens },
    ...source.reasoningTokens === undefined ? {} : { reasoningTokens: source.reasoningTokens },
  }
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
      input: formatTokensCompact(turnBilledInputTokens(tokenUsage)),
      output: formatTokensCompact(turnReportedBucket(tokenUsage.outputTokens)),
    }),
    t('turnCostTitle'),
  ]
  if (turnOptionalUnreported(tokenUsage)) notes.push(t('turnTokensUnreported'))
  return notes.join(',')
}

// ===== 定价编辑器纯函数(校验/规整/默认值) =====
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite']
const HHMM_PATTERN = /^\d{1,2}:\d{2}$/
const HHMM_PLACEHOLDER = 'HH:MM'
const ISO_DAY_PATTERN_CLIENT = /^\d{4}-\d{2}-\d{2}$/
// 时刻分量界:小时/分钟均双闭
const HOUR_MAX = 23
const MINUTE_MAX = 59
const WEEKDAY_MIN = 0
const WEEKDAY_MAX = 6
const MONTH_DAY_MIN = 1
const MONTH_DAY_MAX = 31
const FULL_DAY_WINDOW = { from: '00:00', to: '23:59' }
// HH:MM 输入框内联宽(size 属性字符数):占位符容量 + 光标余量,配合 .ud-cond-fields 的 width:auto
const HHMM_INPUT_SIZE = HHMM_PLACEHOLDER.length + 2
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

// HH:MM 输入净化:自绘文本框永不出现秒段。成型仅限两种形态——纯数字满四位补冒号(连续键入/纯数字秒串粘贴),
// 带冒号三段时刻截取前两段(带秒串粘贴自愈);其余形态(中间插字/杂串)原样放行交保存校验显式报错,防静默重排出错误合法时刻
const HHMM_INPUT_DIGITS = 4
const HHMM_PURE_DIGITS_PATTERN = /^\d+$/
const HHMM_SECONDS_TAIL_PATTERN = /:\d{2}$/
const HHMM_THREE_SEGMENT_PATTERN = /^\d{1,2}:\d{2}:\d{2}$/
const FULLWIDTH_DIGIT_PATTERN = /[０-９]/g
const FULLWIDTH_COLON = '：'
const FULLWIDTH_ZERO = '０'.codePointAt(0)
const normalizeHHMMInput = (raw) => {
  if (typeof raw !== 'string') return ''
  const half = raw.replace(FULLWIDTH_DIGIT_PATTERN, (char) => String(char.codePointAt(0) - FULLWIDTH_ZERO)).replaceAll(FULLWIDTH_COLON, ':')
  if (HHMM_PURE_DIGITS_PATTERN.test(half) && half.length >= HHMM_INPUT_DIGITS) {
    return `${half.slice(0, 2)}:${half.slice(2, 4)}`
  }
  if (HHMM_THREE_SEGMENT_PATTERN.test(half)) {
    return half.replace(HHMM_SECONDS_TAIL_PATTERN, '')
  }
  return half
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

// 只去除同模型后续无条件规则,保留其余原序,避免归一改变不同模式间的平局结果。
const normalizePricingRules = (rules) => {
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

// 货币为编辑器级全局设置:整表统一,规则内 currency 由切换值派生(wire 形态不变)
const applyCurrencyToRules = (rules, currency) => rules.map((rule) => ({ ...rule, currency }))

// 新增规则默认:空模型 + 承接全局货币 + 四桶零价 + 无条件(恒生效);已有条件整条保留原样
const defaultPricingRule = (currency = CURRENCIES[0], model = '') => ({
  model,
  currency,
  price: PRICE_KEYS.reduce((price, key) => ({ ...price, [key]: 0 }), {}),
  conditions: [],
})

// 编辑器加载:归一后若无 */* 默认价,补一条未配置的全局槽;synthetic 标记供保存时剔除
const ensureGlobalDefault = (rules, currency) => {
  const hasGlobalFallback = rules.some((rule) => rule.model === MODEL_UNROUTED
    && (rule.conditions ?? []).length === 0)
  if (hasGlobalFallback) return { rules, synthetic: false }
  // 已有 */* 条件规则但缺默认价时也补默认槽,保证全局兜底组永远可编辑
  return {
    rules: [...rules, defaultPricingRule(currency, MODEL_UNROUTED)],
    synthetic: true,
  }
}

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

// 组内划分:首条无条件规则即该模型的实际默认价(与匹配器同档取表内首条一致),
// UI 禁条件/排序/删除;其余为附加计费规则。归一只删除同模式后续无条件副本、不重排,
// 因此渲染层按「组内首条无条件」取槽,与计费胜者同口径。
// 草稿行与已发布行的身份键:草稿是副本,统计表按内容而非对象引用对应
const ruleStatsKey = (rule) => `${rule.model}\u0000${JSON.stringify(rule.conditions ?? [])}`

function partitionGroupOf(group) {
  const fallbackIndex = group.slots.findIndex((slot) => (slot.rule.conditions ?? []).length === 0)
  if (fallbackIndex < 0) return { defaultSlot: null, extras: group.slots }
  return {
    defaultSlot: group.slots[fallbackIndex],
    extras: group.slots.filter((_, index) => index !== fallbackIndex),
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

  // 导航分区图标:表盘(dash 概念);键覆盖中英分区名 + 市场短名,语言切换下声明不漂移
  const NAV_ICON = { '使用统计': 'gauge', 'Usage': 'gauge', 'dsh-usage-dash': 'gauge' }
  if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
  else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
  else window.__navicIconQueue = [NAV_ICON]

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

    // stats-line 偏好单例:模块表内同实例,面板偏好卡与底部信息栏订阅互通;
    // apply 时注入宿主 settings 投影,服务未就绪前以默认值渲染
    let statsLineState = createStatsLineState(null)
    // client 会话服务:展开面板时按会话拉取投影(子代理小时投影不进列表行 summary),缺席则只走摘要口径
    let sessionsClient = null
    // 容器引用留作服务晚注册时的回填入口
    let clientCtx = null

    // 价格规则内存缓存单例:TTL 内直读,失败回退旧值待下次重试;禁 localStorage 持久化价格
    const PRICING_CACHE_TTL_MS = 5 * 60 * 1000
    const PRICING_SAVED_NOTICE_MS = 3 * 1000
    let cached = null
    let pricingFlight = null
    // 最近一次取价失败原因:transport(请求失败或存储降级 503)与 invalid(回包结构非法)后果不同,
    // 只有后者才值得提供清空自救,前者重载即可,不能让瞬时失败诱导删表
    let pricingFailure = null
    const pricingListeners = new Set()
    // 只校验渲染所需的结构。旧规则允许进入编辑页修正其模式、时刻或日期。
    const validStoredCondition = (condition) => {
      if (!CONDITION_KINDS.includes(condition?.kind)) return false
      if (condition.kind === 'weekdays') return Array.isArray(condition.days) && condition.days.every(isValidWeekday)
      if (condition.kind === 'monthDays') return Number.isInteger(condition.from) && Number.isInteger(condition.to)
      return typeof condition.from === 'string' && typeof condition.to === 'string'
    }
    const validPricing = (value) => value && Number.isFinite(value.revision) && Array.isArray(value.rules)
      && value.rules.every((rule) => isRuleShaped(rule)
        && (rule.currency == null || CURRENCIES.includes(rule.currency))
        && PRICE_KEYS.every((key) => Number.isFinite(rule.price[key]) && rule.price[key] >= 0)
        && (rule.conditions ?? []).every(validStoredCondition))
    const applyPricingValue = (value, mutation = false) => {
      if (!validPricing(value) || (cached && value.revision < cached.revision)) return cached
      // 成功写入即恢复健康,后续不可用态不会误沿用旧的失败原因
      pricingFailure = null
      const refresh = mutation || (cached !== null && value.revision !== cached.revision)
      cached = { revision: value.revision, rules: value.rules, fetchedAt: Date.now() }
      for (const listener of pricingListeners) listener(cached, refresh)
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

    // value 缺形状按失败处理:回退旧值,无旧值为 null(费用显示占位);失败原因留给编辑器区分处理
    const fetchPricing = async (force = false) => {
      if (!force && cached && Date.now() - cached.fetchedAt < PRICING_CACHE_TTL_MS) return cached
      if (!pricingFlight) {
        pricingFlight = (async () => {
          const result = await requestGet(ENDPOINTS.pricing)
          if (!result.ok) {
            pricingFailure = 'transport'
            return cached
          }
          if (!validPricing(result.value)) {
            pricingFailure = 'invalid'
            return cached
          }
          pricingFailure = null
          return applyPricingValue(result.value)
        })().finally(() => { pricingFlight = null })
      }
      return pricingFlight
    }

    function usePricing() {
      const [value, setValue] = useState(cached)
      const [tick, setTick] = useState(0)
      useEffect(() => {
        const listener = (next, refresh) => {
          setValue(next)
          if (refresh) setTick(previous => previous + 1)
        }
        pricingListeners.add(listener)
        if (cached) listener(cached, false)
        void fetchPricing()
        return () => pricingListeners.delete(listener)
      }, [])
      return { rules: value?.rules ?? null, tick }
    }

    // 交互与尺寸常量
    const STATUS_POLL_FAST_MS = 1000
    // 状态轮询失败退避:一次 502/401/宿主重启不能让轮询永久断链;
    // 指数续排到上限,成功即复位。空闲态失败只允许有限次,避免后台永远重试
    const STATUS_POLL_RETRY_BASE_MS = 5000
    const STATUS_POLL_RETRY_MAX_MS = 60 * 1000
    const STATUS_POLL_IDLE_FAILURE_LIMIT = 3
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
    const MODAL_Z_INDEX = 1200
    // 与注册 id 同源:既作样式查重键,又作 data-plugin 标记值,短名会使自身 rebuilt 删不到旧样式
    const STYLE_ID = '@mzzsfy/dsh-usage-dash'
    // 开关视觉常量(规约形态:隐藏 checkbox + track 胶囊 + thumb 圆点;尺寸全仓统一 34×19/13)
    const SWITCH_TRACK_WIDTH = 34
    const SWITCH_TRACK_HEIGHT = 19
    const SWITCH_THUMB_SIZE = 13
    const SWITCH_EDGE_INSET = 3
    const SWITCH_THUMB_TRAVEL = SWITCH_TRACK_WIDTH - SWITCH_THUMB_SIZE - SWITCH_EDGE_INSET * 2
    const SWITCH_TRANSITION_MS = 120
    // 最近请求详情表格列宽:首列同时容纳展开箭头与两位序号,表宽下限取列宽总和,窄屏横向滚动而不是压扁列宽
    const REQUEST_TABLE_COLUMNS = ['64px', '72px', '72px', '132px', '64px', '84px', '72px', '88px', '88px']
    const REQUEST_TABLE_MIN_WIDTH = REQUEST_TABLE_COLUMNS.reduce((total, width) => total + Number.parseFloat(width), 0)
    // 遮蔽语义:同 id 同 priority 属注册冲突(注册表抛错),需取更低值压过
    // 同格竞争者;usp 同款接管注册用 -1,本插件取次低值,官方无显式 priority(默认 0)
    const STATS_SLOT_PRIORITY = -2
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
      clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 7v5l3 2'],
      days: ['M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', 'M16 3v4', 'M8 3v4', 'M3 11h18'],
      trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
      close: ['M18 6 6 18', 'M6 6l12 12'],
      chevron: ['m9 18 6-6-6-6'],
      search: ['M16.5 10.5a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z', 'm15 15 4.5 4.5'],
      plus: ['M12 5v14', 'M5 12h14'],
      edit: ['m14 6 4 4', 'm5 15 10-10a2.8 2.8 0 0 1 4 4L9 19l-5 1 1-5Z'],
      rules: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
    }

    function Icon({ paths }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: ICON_SIZE, height: ICON_SIZE, fill: 'none',
        stroke: 'currentColor', strokeWidth: ICON_STROKE_WIDTH,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    // 危险删除按钮:首点进武装态(垃圾桶变"确认删除"文字),再点才执行,超时自动解除
    function DeleteArmedButton({ labelKey, confirmKey, onConfirm, showLabel = false, tone = 'default', t = defaultT }) {
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
        className: cx('ud-btn ud-btn--text', tone === 'danger' && 'ud-btn--danger-text', armed && 'ud-delete-armed'), type: 'button', onClick: click,
        'aria-label': t(labelKey), title: t(labelKey),
      }, armed ? t(confirmKey) : showLabel ? t(labelKey) : h(Icon, { paths: ICONS.trash }))
    }

    const STYLE_CSS = `
/* 图表区分色:主色与热力图梯度挂业务蓝派生(brand-primary 在宿主新版主题为单色黑白,不可作数据色);
   speed/ttft 用 success/warn 语义槽,亮暗随宿主别名自动适配 */
.ud-panel{display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);
--ud-chart-1:var(--dsw-alias-state-business-primary);--ud-chart-2:var(--dsw-alias-state-success-primary);--ud-chart-3:var(--dsw-alias-state-warn-primary);--ud-chart-4:hsl(262 84% 65%);--ud-chart-5:hsl(329 85% 55%);--ud-chart-other:var(--dsw-alias-label-tertiary);
--ud-heat-0:color-mix(in srgb, var(--dsw-alias-label-tertiary) 12%, transparent);--ud-heat-1:color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);--ud-heat-2:color-mix(in srgb, var(--dsw-alias-state-business-primary) 36%, transparent);--ud-heat-3:color-mix(in srgb, var(--dsw-alias-state-business-primary) 54%, transparent);--ud-heat-4:color-mix(in srgb, var(--dsw-alias-state-business-primary) 74%, transparent);--ud-heat-5:var(--dsw-alias-state-business-primary);--ud-trend-line:var(--dsw-alias-state-business-primary);--ud-trend-speed:var(--dsw-alias-state-success-primary);--ud-trend-ttft:var(--dsw-alias-state-warn-primary);
--ud-bg-overlay:var(--dsw-alias-bg-layer-2);--ud-border:var(--dsw-alias-border-l2);--ud-border-strong:var(--dsw-alias-border-l3);--ud-text:var(--dsw-alias-label-primary);--ud-text-sub:var(--dsw-alias-label-secondary);--ud-text-dim:var(--dsw-alias-label-tertiary);--ud-accent:var(--dsw-alias-state-business-primary);--ud-hover-bg:var(--dsw-alias-interactive-bg-hover);--ud-shadow-lv3:var(--dsw-shadow-lv3);--ud-radius-md:var(--dsw-radius-md);--ud-radius-sm:var(--dsw-radius-sm);--ud-card:var(--dsw-alias-bg-layer-1);--ud-card-border:var(--dsw-alias-border-l2)}
.ud-section-page-head{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-section-page-title{margin:0;font-size:18px;line-height:26px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ud-section-page-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.ud-toolbar{display:flex;align-items:flex-start;gap:12px}
.ud-toolbar-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 auto;min-width:0}
.ud-group{display:flex;align-items:center;gap:2px;padding:3px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.ud-seg-item{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;padding:0 12px;height:28px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}
.ud-seg-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ud-seg-item--on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}
.ud-custom-range{display:flex;align-items:center;gap:6px}
.ud-date-input{border:1px solid var(--ud-border-strong);border-radius:var(--dsw-radius-sm);background:var(--ud-card);color:var(--dsw-alias-label-primary);font-size:13px;padding:0 10px;height:32px;box-sizing:border-box}
.ud-custom-sep{color:var(--dsw-alias-label-tertiary)}
.ud-btn{border:1px solid var(--ud-border-strong);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:0 14px;height:32px;font-size:14px;line-height:1;cursor:pointer;transition:background .15s,color .15s}
.ud-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ud-btn:disabled{opacity:.5;cursor:not-allowed}
.ud-toolbar-side{display:flex;align-items:center;gap:8px;flex:none;margin-left:auto;align-self:stretch}
.ud-toolbar-side .ud-btn--text{display:inline-flex;align-items:center;height:100%}
.ud-icon-btn{padding:0 12px}
.ud-icon{display:inline-flex;align-items:center;justify-content:center}
.ud-btn--text{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);padding:2px 4px}
.ud-delete-armed,.ud-delete-armed:hover{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);font-size:12px;white-space:nowrap}
.ud-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-label);border-radius:var(--dsw-radius-sm);padding:8px 12px;font-size:13px;line-height:20px}
.ud-loading{display:flex;flex-direction:column;gap:8px;padding:24px 0}
.ud-loading::before,.ud-loading::after{content:"";display:block;height:14px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-skeleton)}
.ud-loading::after{width:60%}.ud-empty{border:.5px solid var(--ud-card-border);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);text-align:center;padding:24px 16px;font-size:14px;line-height:22px;background:var(--ud-card)}
.ud-foot{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ud-status{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ud-status-fold{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:100%;min-height:28px;border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-sm)}
.ud-status-fold:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.ud-status-fold-caret{display:block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;transition:transform .15s ease}
.ud-status-fold[aria-expanded="true"] .ud-status-fold-caret{transform:rotate(180deg)}
.ud-status-fold-dot{position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}
.ud-status-track{display:inline-block;width:120px;height:2px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden}
.ud-status-fill{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}
.ud-status-err{color:var(--dsw-alias-state-error-primary)}
.ud-detail{width:100%;margin-top:4px;display:flex;flex-direction:column;gap:6px}
.ud-detail-foot{display:flex;justify-content:flex-end;align-items:center}
.ud-log{width:100%;border:.5px solid var(--ud-card-border);border-radius:var(--dsw-radius-sm);background:var(--ud-card);padding:8px 10px;display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;font-size:11px;line-height:1.5}
.ud-log-summary{display:flex;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;padding-bottom:4px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ud-log-line{display:flex;gap:8px;align-items:baseline;min-width:0}
.ud-log-time{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);opacity:.7}
.ud-log-kind{flex:none}
.ud-log-err{color:var(--dsw-alias-state-error-primary)}
.ud-log-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ud-cards{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:12px}
@media (max-width:560px){.ud-cards{grid-template-columns:1fr 1fr}}
@media (max-width:380px){.ud-cards{grid-template-columns:1fr}}
.ud-card{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--ud-card-border);border-radius:var(--dsw-radius-md);background:var(--ud-card);padding:12px 14px;min-width:0}
.ud-card-head{display:flex;align-items:center;gap:6px}
.ud-card-cost{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ud-card-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.ud-card-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.ud-card-value{font-size:${FIT_MAX_SIZE}px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.ud-card-lines{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-card-name{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-section{display:flex;flex-direction:column;gap:12px;min-width:0}
.ud-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ud-section-title{font-size:16px;font-weight:600;line-height:24px}
.ud-trend-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ud-trend-metric{display:inline-flex;align-items:center;gap:6px;margin-left:auto}
.ud-trend-metric-label{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ud-chart-wrap{width:100%;min-width:0}
.ud-chart-empty{border:.5px dashed var(--ud-card-border);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);text-align:center;padding:32px 16px;font-size:13px;line-height:20px}
.ud-chart{display:block;width:100%}
.ud-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1}
.ud-axis{fill:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ud-legend{display:flex;flex-wrap:wrap;gap:4px 12px}
.ud-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;user-select:none;cursor:pointer}
.ud-legend-item--off{opacity:.35}
.ud-legend-item--on{background:var(--ud-hover-bg);border-radius:var(--dsw-radius-sm)}
.ud-legend-item span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-legend-swatch{width:8px;height:8px;border-radius:2px;flex:none}
.ud-heat-wrap{width:100%;min-width:0;overflow:hidden}
.ud-heat{display:block;max-width:100%;height:auto}
.ud-heat-cell{stroke:none}
.ud-heat-cell--on{stroke:var(--ud-accent);stroke-width:1.5}
.ud-heat-l0{fill:var(--ud-heat-0);background:var(--ud-heat-0)}
.ud-heat-l1{fill:var(--ud-heat-1);background:var(--ud-heat-1)}
.ud-heat-l2{fill:var(--ud-heat-2);background:var(--ud-heat-2)}
.ud-heat-l3{fill:var(--ud-heat-3);background:var(--ud-heat-3)}
.ud-heat-l4{fill:var(--ud-heat-4);background:var(--ud-heat-4)}
.ud-heat-l5{fill:var(--ud-heat-5);background:var(--ud-heat-5)}
.ud-heat-legend{display:inline-flex;align-items:center;gap:${HEAT_GAP}px;margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ud-heat-legend i{display:inline-block;width:${HEAT_BASE}px;height:${HEAT_BASE}px;border-radius:${HEAT_RX}px;flex:none}
.ud-tip{position:fixed;z-index:${TIP_Z_INDEX};pointer-events:none;box-sizing:border-box;border:1px solid var(--ud-border);border-radius:var(--dsw-radius-md);background:var(--ud-bg-overlay);box-shadow:var(--ud-shadow-lv3);color:var(--ud-text);font-size:12px;line-height:1.5;padding:10px 12px;max-width:min(420px,calc(100vw - 24px));max-height:60vh;overflow:auto;font-variant-numeric:tabular-nums;opacity:0;transition:opacity .12s ease-out;
--ud-bg-overlay:var(--dsw-alias-bg-layer-2);--ud-border:var(--dsw-alias-border-l2);--ud-text:var(--dsw-alias-label-primary);--ud-text-sub:var(--dsw-alias-label-secondary);--ud-text-dim:var(--dsw-alias-label-tertiary);--ud-accent:var(--dsw-alias-state-business-primary);--ud-shadow-lv3:var(--dsw-shadow-lv3);--ud-radius-md:var(--dsw-radius-md);--ud-radius-sm:var(--dsw-radius-sm)}
.ud-tip--on{opacity:1}
@media (prefers-reduced-motion: reduce){.ud-tip{transition:none}}
.ud-tip-arrow{position:absolute;width:8px;height:8px;background:var(--ud-bg-overlay);border:1px solid var(--ud-border);transform:rotate(45deg);pointer-events:none}
.ud-tip-arrow--top{bottom:-5px;border-top:0;border-left:0}
.ud-tip-arrow--bottom{top:-5px;border-bottom:0;border-right:0}
.ud-tip-title{font-weight:600;font-size:12px;color:var(--ud-text);margin-bottom:8px}
.ud-tip-text{color:var(--ud-text-sub);line-height:1.6;max-width:360px}
.ud-tip-section{display:flex;flex-direction:column;gap:2px}
.ud-tip-section+.ud-tip-section{margin-top:8px;padding-top:8px;border-top:1px solid var(--ud-border)}
.ud-tip-section-title{font-size:11px;color:var(--ud-text-dim);margin-bottom:2px}
.ud-tip-grid{display:grid;grid-template-columns:auto minmax(88px,auto);column-gap:16px;row-gap:2px}
.ud-tip-item{display:contents}
.ud-tip-item--sub .ud-tip-label{padding-left:14px;color:var(--ud-text-dim)}
.ud-tip-item--sub .ud-tip-value{color:var(--ud-text-dim)}
.ud-tip-label{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--ud-text-sub);white-space:normal;overflow-wrap:anywhere}
.ud-tip-value{text-align:right;color:var(--ud-text);white-space:nowrap}
.ud-tip-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.6;color:var(--ud-text-sub)}
.ud-tip-row--sub{padding-left:14px;color:var(--ud-text-dim);font-size:11px}
.ud-tip-breakdown{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--ud-border);margin-top:8px;padding-top:8px}
.ud-axis-rate{fill:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.ud-bar{transform-box:fill-box;transform-origin:center;transition:opacity .12s ease-out}
.ud-bar--dim{opacity:.25}
.ud-bar-hit{fill:transparent;pointer-events:all}
.ud-trend{stroke:var(--ud-trend-line);opacity:.9;fill:none;pointer-events:none}
.ud-trend--speed{stroke:var(--ud-trend-speed)}
.ud-trend--ttft{stroke:var(--ud-trend-ttft)}
.ud-trend-dot{fill:var(--ud-trend-line);stroke:var(--dsw-alias-bg-layer-1);stroke-width:${TREND_DOT_RING}px;pointer-events:none}
.ud-trend-dot--speed{fill:var(--ud-trend-speed)}
.ud-trend-dot--ttft{fill:var(--ud-trend-ttft)}
.ud-legend-swatch--line{height:2px;border-radius:999px;background:var(--ud-trend-line)}
.ud-legend-swatch--line--speed{background:var(--ud-trend-speed)}
.ud-legend-swatch--line--ttft{background:var(--ud-trend-ttft)}
.ud-model-usage{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px}
.ud-donut-wrap{flex:0 0 auto}
.ud-donut-seg{cursor:pointer;outline:none;transition:stroke-width .12s ease}
.ud-donut-seg--dim{opacity:${DONUT_DIM_OPACITY}}
.ud-donut-center{font-size:18px;font-weight:600;fill:var(--dsw-alias-label-primary)}
.ud-donut-label{font-size:11px;fill:var(--dsw-alias-label-tertiary)}
.ud-models{flex:1 1 260px;min-width:240px;display:flex;flex-direction:column}
.ud-model-row{display:flex;align-items:center;gap:8px;min-height:46px;padding:1px 4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ud-model-row--expand{cursor:pointer}
.ud-model-row--expand:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ud-model-swatch{width:10px;height:10px;border-radius:2px;flex:none}
.ud-model-id{display:flex;flex-direction:column;min-width:0;flex:1}
.ud-model-name{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-model-provider{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-model-values{display:flex;flex-direction:column;align-items:flex-end;font-variant-numeric:tabular-nums;flex:none}
.ud-model-tokens{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ud-model-io{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ud-model-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ud-model-toggle{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:2px 6px;font-size:14px;line-height:1;transition:transform .2s ease}
.ud-model-toggle[aria-expanded="true"]{transform:rotate(90deg)}
.ud-model-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.ud-model-other{display:grid;grid-template-rows:0fr;transition:grid-template-rows .25s ease}
.ud-model-other--open{grid-template-rows:1fr}
.ud-model-other-list{overflow:hidden;min-height:0}
.ud-model-row--sub{min-height:0;padding:4px 4px 4px 28px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);border-bottom:none}
.ud-switch{display:inline-flex;align-items:center;cursor:pointer;position:relative}
/* 透明覆盖 label 而非几何隐藏:聚焦位置即点击位置,防聚焦 scroll-into-view 连锁滚动嵌套滚动容器(弹窗导航被滚走整屏空白) */
.ud-switch input[type="checkbox"] { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; }
.ud-switch__track{position:relative;width:${SWITCH_TRACK_WIDTH}px;height:${SWITCH_TRACK_HEIGHT}px;border-radius:999px;box-sizing:border-box;flex:none;background:var(--dsw-alias-bg-module-platform);transition:background ${SWITCH_TRANSITION_MS}ms var(--ds-ease-in-out)}
.ud-switch__thumb{position:absolute;top:${SWITCH_EDGE_INSET}px;left:${SWITCH_EDGE_INSET}px;width:${SWITCH_THUMB_SIZE}px;height:${SWITCH_THUMB_SIZE}px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform ${SWITCH_TRANSITION_MS}ms var(--ds-ease-in-out)}
.ud-switch:not(:has(input[type="checkbox"]:disabled)):hover .ud-switch__track{background:color-mix(in srgb,var(--dsw-alias-bg-module-platform) 88%,var(--dsw-alias-label-primary))}
.ud-switch input[type="checkbox"]:checked + .ud-switch__track{background:var(--dsw-alias-brand-primary)}
.ud-switch input[type="checkbox"]:checked + .ud-switch__track .ud-switch__thumb{transform:translateX(${SWITCH_THUMB_TRAVEL}px)}
.ud-switch input[type="checkbox"]:focus-visible + .ud-switch__track{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.ud-switch input[type="checkbox"]:disabled + .ud-switch__track{opacity:.45;cursor:default}
.ud-settings-stack{display:flex;flex-direction:column;gap:16px}
.ud-fold{border:.5px solid var(--ud-card-border);border-radius:var(--dsw-radius-md);background:var(--ud-card);overflow:hidden}
.ud-fold-head{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;box-sizing:border-box;padding:12px 16px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.ud-fold-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ud-fold-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.ud-fold-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-fold-title{font-size:14px;line-height:22px;font-weight:600}
.ud-fold-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ud-fold-side{display:flex;align-items:center;gap:8px;flex:none}
.ud-fold-summary{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ud-fold-caret{display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.ud-fold-caret svg{display:block;width:14px;height:14px}
.ud-fold--open>.ud-fold-head .ud-fold-caret{transform:rotate(90deg)}
.ud-fold-body{padding:12px 16px 16px;border-top:.5px solid var(--dsw-alias-border-l2)}
.ud-fold-body[hidden]{display:none}
.ud-pref-group{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:12px 16px}
.ud-pref-group + .ud-pref-group{margin-top:8px}
.ud-pref-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:4px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ud-pref-group-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-pref-group-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ud-pref-group-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-pref-group--recent{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);border-color:var(--dsw-alias-border-l2)}
.ud-pref-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:28px}
.ud-pref-row--disabled .ud-pref-text{opacity:.55}
.ud-pref-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-pref-title{font-size:13px;color:var(--dsw-alias-label-primary)}
.ud-pref-desc{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ud-pricing-fields{display:grid;gap:12px}
.ud-pricing-fieldset{display:grid;gap:8px;min-width:0;padding-top:12px;border-top:.5px solid var(--ud-card-border)}
.ud-pricing-fieldset h4{margin:0;font-size:14px;line-height:22px;font-weight:600}
.ud-rule-conds{display:grid;gap:8px;min-width:0}
.ud-cond{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 0}
.ud-cond+.ud-cond{border-top:.5px solid var(--ud-card-border);padding-top:12px}
/* specificity 须高于 .ud-input 的 width:100%,否则类型下拉撑满整行把字段区挤到下一行 */
.ud-cond .ud-cond-kind{width:auto;min-width:88px;flex:0 0 auto}
.ud-cond-fields{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0}
.ud-cond-fields .ud-field{flex-direction:row;align-items:center;gap:4px;flex:0 1 auto}
.ud-cond-fields .ud-input{width:auto;max-width:100%}
.ud-pricing-weekdays{max-width:100%;flex-wrap:wrap}
.ud-pricing-weekdays .ud-seg-item{min-width:30px;padding:0 6px}
.ud-cond .ud-pricing-icon{margin-inline-start:auto}
.ud-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.ud-field-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.ud-field-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}
.ud-input{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;min-height:36px;padding:4px 8px;min-width:0;width:100%;box-sizing:border-box}
.ud-price-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.ud-price-grid .ud-input{font-variant-numeric:tabular-nums}
.ud-unit-note{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ud-pricing-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ud-pricing-board,.ud-pricing-stack{display:grid;gap:12px;min-width:0}
.ud-pricing-board [hidden]{display:none!important}
.ud-pricing-toolbar,.ud-pricing-line,.ud-pricing-clock{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ud-pricing-search{display:flex;gap:8px;align-items:end;min-width:0}
.ud-pricing-search .ud-field{flex:1}
.ud-pricing-search .ud-pricing-clock-group{margin-block-end:4px}
.ud-pricing-search-input{position:relative;display:flex;align-items:center;min-width:0}
.ud-pricing-search-input>svg{position:absolute;inset-inline-start:10px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.ud-pricing-search-input .ud-input{padding-inline-start:32px}
.ud-pricing-clock-group{flex:none}
.ud-pricing-toolbar>.ud-pricing-clock-group{margin-inline-start:auto}
.ud-pricing-board .ud-pricing-clock-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm)}
.ud-pricing-clock-toggle svg{width:15px;height:15px}
.ud-pricing-board .ud-pricing-clock-toggle:is([aria-expanded=true],.ud-pricing-clock-toggle--active){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}

.ud-pricing-toolbar>.ud-group{border-radius:var(--dsw-radius-sm)}
.ud-pricing-toolbar .ud-seg-item{height:30px}
.ud-pricing-create{display:inline-flex;align-items:center;gap:6px}
.ud-pricing-clock{padding:0 0 12px;border-bottom:.5px solid var(--ud-card-border);align-items:end}
.ud-pricing-clock .ud-field{flex:1 1 168px}
.ud-pricing-clock .ud-input{max-width:100%}
.ud-pricing-board :is(button,input,select,textarea,summary,[tabindex]):focus-visible,.ud-pricing-dialog :is(button,input,select,textarea,summary,[tabindex]):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.ud-pricing-board .ud-input,.ud-pricing-dialog .ud-input{min-height:36px}
.ud-pricing-pattern{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;flex:1;min-width:0}
.ud-pricing-pattern .ud-field-error{grid-column:1/-1}
.ud-pricing-board{container:ud-pricing / inline-size}
.ud-pricing-toolrow{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap}
.ud-pricing-actions{margin-inline-start:auto}
.ud-pricing-actions>.ud-group,.ud-pricing-weekdays{padding:2px;border-radius:var(--dsw-radius-sm)}
.ud-pricing-actions>.ud-group{flex:none}
.ud-pricing-platforms{display:grid;gap:12px;min-width:0}
.ud-pricing-empty{border:.5px solid var(--ud-card-border);border-radius:var(--dsw-radius-md);background:var(--ud-card);min-width:0}
.ud-pricing-rules{min-width:0;--ud-rule-blue:var(--dsw-alias-state-business-primary);--ud-rule-gutter:calc(60px + var(--ud-rule-index));border-width:1px;border-color:color-mix(in srgb,var(--ud-rule-blue) 18%,var(--ud-card-border));background:var(--ud-card)}
.ud-pricing-group{--ud-rule-mark:var(--ud-rule-blue);padding:0 12px 8px}
.ud-pricing-group--wild{--ud-rule-mark:color-mix(in srgb,var(--ud-rule-blue) 65%,var(--ud-card))}
.ud-pricing-group+.ud-pricing-group{border-top:.5px solid color-mix(in srgb,var(--ud-rule-blue) 10%,var(--ud-card-border))}
.ud-pricing-group-head{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;padding:14px 8px 4px}
.ud-pricing-group-head .ud-fold-summary{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ud-pricing-rule,.ud-pricing-model{min-width:0}
.ud-pricing-rule+.ud-pricing-rule,.ud-pricing-model+.ud-pricing-model{border-top:.5px solid var(--ud-card-border)}
.ud-pricing-rules .ud-pricing-rule+.ud-pricing-rule{border-top-color:color-mix(in srgb,var(--ud-rule-blue) 6%,var(--ud-card-border))}
.ud-pricing-rule-bar{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:0 4px;padding-inline-end:4px}
.ud-pricing-rule--open .ud-pricing-rule-caret{color:var(--dsw-alias-label-secondary)}
.ud-pricing-row[aria-expanded=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-radius:var(--dsw-radius-sm)}
.ud-pricing-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px 12px;text-align:center}
.ud-pricing-empty-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.ud-pricing-rule-head,.ud-pricing-row{width:100%;min-width:0;min-height:46px;padding:6px 8px;border:0;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer;border-radius:var(--dsw-radius-sm)}
.ud-pricing-rule-head:hover,.ud-pricing-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ud-pricing-rules .ud-pricing-rule-head:hover{background:color-mix(in srgb,var(--ud-rule-blue) 5%,transparent)}
.ud-pricing-board .ud-pricing-rule-head:focus-visible{outline-offset:-2px}
.ud-pricing-rule-no{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.ud-pricing-row-name{line-height:22px;min-width:0;overflow-wrap:anywhere}
.ud-pricing-rule-head{display:grid;grid-template-columns:14px 8px var(--ud-rule-index) minmax(0,1fr);column-gap:6px;align-content:center;align-items:baseline}
.ud-pricing-rule-head .ud-pricing-rule-caret{align-self:start;margin-block-start:4px}
.ud-pricing-rule-swatch{width:8px;height:8px;border-radius:3px;flex:none;align-self:start;margin-block-start:7px;background:var(--ud-rule-mark)}
.ud-pricing-rule-head .ud-pricing-rule-no{white-space:nowrap}
.ud-pricing-row-name>.ud-pricing-note,.ud-pricing-row-name>.ud-pricing-chip{margin-inline-start:8px}
.ud-pricing-board .ud-model-name{white-space:normal;overflow-wrap:anywhere;line-height:22px}
.ud-pricing-board .ud-model-provider{white-space:normal;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ud-pricing-row .ud-model-values{max-width:48%;min-width:0;flex:0 1 auto;text-align:end}
.ud-pricing-row .ud-model-tokens{overflow-wrap:anywhere}
.ud-pricing-rule-caret{display:flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s}
.ud-pricing-rule-caret svg{display:block;width:14px;height:14px}
.ud-pricing-rule-head[aria-expanded=true] .ud-pricing-rule-caret{transform:rotate(90deg)}
.ud-btn--danger-text{height:32px;padding:0 8px;color:var(--dsw-alias-state-error-primary)}
.ud-btn--danger-text:not(:disabled):not(.ud-delete-armed):hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.ud-btn--danger-text.ud-delete-armed,.ud-btn--danger-text.ud-delete-armed:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.ud-pricing-rule-tags{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-inline-start:auto}
.ud-pricing-rule-tags .ud-pricing-icon{color:var(--dsw-alias-label-secondary)}
.ud-pricing-danger-zone{justify-content:space-between;gap:12px;padding:8px 12px 8px 20px;border-top:.5px solid var(--ud-card-border)}
.ud-pricing-danger-hint{min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ud-pricing-danger-zone .ud-btn--danger-text{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;margin-inline-start:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.ud-pricing-danger-zone .ud-btn--danger-text::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:none}
.ud-pricing-danger-zone .ud-btn--danger-text:not(:disabled):not(.ud-delete-armed):hover{background:var(--dsw-alias-interactive-bg-hover-danger);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 24%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.ud-pricing-danger-zone .ud-btn--danger-text.ud-delete-armed,.ud-pricing-danger-zone .ud-btn--danger-text.ud-delete-armed:hover{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.ud-pricing-danger-zone .ud-btn--danger-text.ud-delete-armed::before{display:none}
.ud-pricing-form-head{display:grid;gap:8px;min-width:0}
.ud-pricing-form-head .ud-btn--text{color:var(--dsw-alias-label-secondary)}
.ud-pricing-board .ud-pricing-form-head h3{font-size:16px;line-height:24px;font-weight:600}
.ud-pricing-form-foot>.ud-pricing-line:empty{display:none}
.ud-pricing-icon{display:inline-grid;place-items:center;width:28px;height:28px;flex:none}
.ud-pricing-board h3,.ud-pricing-board p,.ud-pricing-dialog h3,.ud-pricing-dialog p{margin:0}
.ud-pricing-board h3,.ud-pricing-dialog h3{font-size:14px;line-height:22px}
.ud-pricing-board code,.ud-pricing-dialog code{font-family:var(--ds-font-family-code);overflow-wrap:anywhere;min-width:0}
.ud-pricing-summary,.ud-pricing-prices{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0}
.ud-pricing-summary .ud-card{gap:4px;padding:10px 12px}
.ud-pricing-summary .ud-card-icon{flex:none}
.ud-pricing-summary .ud-card-label{overflow-wrap:anywhere}
.ud-pricing-summary .ud-card-value{text-overflow:ellipsis}
.ud-pricing-prices dt,.ud-pricing-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ud-pricing-prices dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ud-pricing-row[aria-expanded=true] .ud-pricing-rule-caret{transform:rotate(90deg)}
.ud-pricing-provider>.ud-fold-head:focus-visible{outline-offset:-2px}
.ud-pricing-provider>.ud-fold-body{padding:4px 12px 8px}
.ud-pricing-provider .ud-fold-title{overflow-wrap:anywhere}
.ud-pricing-pages{justify-content:flex-end;padding-block-start:8px}
.ud-pricing-chip{display:inline-flex;align-items:center;height:20px;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:0 6px;font-size:11px;line-height:18px;white-space:nowrap}
.ud-pricing-chip--button{display:inline-flex;align-items:center;gap:4px;min-height:28px;height:auto;padding:0 4px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;font:inherit;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ud-pricing-chip-dot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.ud-pricing-chip--billing{color:var(--dsw-alias-label-primary);font-weight:600}
.ud-pricing-chip--billing .ud-pricing-chip-dot{background:var(--ud-rule-blue)}
.ud-pricing-chip--taken .ud-pricing-chip-dot{background:var(--dsw-alias-state-warn-primary)}
.ud-pricing-chip--button:not(:disabled):hover{background:color-mix(in srgb,var(--ud-rule-blue) 8%,transparent);border-color:color-mix(in srgb,var(--ud-rule-blue) 30%,transparent);color:var(--dsw-alias-label-primary)}
.ud-pricing-chip--taken:not(:disabled):hover{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent)}
.ud-pricing-chip--button:disabled{opacity:.5;cursor:not-allowed}
.ud-pricing-warn{color:var(--dsw-alias-state-warn-primary)}
.ud-pricing-tree{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);padding:8px 12px;margin:4px 0}
.ud-pricing-tree ul,.ud-pricing-dialog-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ud-pricing-tree-row{display:grid;gap:6px;padding:4px 0}
.ud-pricing-tree-row+.ud-pricing-tree-row{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}
.ud-pricing-tree-title{font-size:14px;overflow-wrap:anywhere}
.ud-pricing-tree-row--winner .ud-pricing-tree-title{font-weight:600}
.ud-pricing-rule-detail{display:grid;gap:8px;padding:0 4px 12px calc(var(--ud-rule-gutter) - 12px)}
.ud-pricing-rule-rate{display:grid;gap:8px;padding:12px;border:1px solid color-mix(in srgb,var(--ud-rule-blue) 16%,transparent);border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--ud-rule-blue) 4%,var(--ud-card))}
.ud-pricing-rule-unit{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.ud-pricing-rule-unit::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--ud-rule-mark);flex:none}
.ud-pricing-rule-meta{display:grid;gap:4px;padding-inline:12px}
.ud-pricing-rule-meta ul{display:flex;flex-wrap:wrap;gap:4px 12px;list-style:none;margin:0;padding:0}
.ud-pricing-rule-rate .ud-pricing-prices dd{font-size:20px;line-height:28px;font-weight:600}
.ud-pricing-prices dd{font-size:13px;font-weight:500;line-height:20px}
.ud-pricing-dialog{box-sizing:border-box;width:min(480px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3);font-size:14px;line-height:22px}
.ud-pricing-dialog[open],.ud-pricing-dialog form{display:grid;gap:12px}
.ud-pricing-dialog::backdrop{background:var(--dsw-alias-bg-mask-1)}
.ud-pricing-dialog-list li{padding:8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
.ud-pricing-dialog button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary)}
.ud-pricing-confirm{justify-content:flex-end}
.ud-btn--primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.ud-btn--primary:not(:disabled):hover{border-color:var(--dsw-alias-button-primary-hover);background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-bg-base)}
.ud-pricing-help{width:fit-content;color:var(--dsw-alias-label-secondary);text-decoration:underline dotted;cursor:help;font-size:12px}
@container ud-pricing (max-width:440px){
  .ud-price-grid,.ud-pricing-summary,.ud-pricing-prices{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ud-cond{display:grid;grid-template-columns:minmax(0,1fr) auto}
  .ud-cond-kind{justify-self:start}
  .ud-cond-fields,.ud-cond>.ud-field-error{grid-column:1/-1}
  .ud-cond .ud-pricing-icon{grid-column:2;grid-row:1}
}
@container ud-pricing (max-width:380px){
  .ud-pricing-rule-bar{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:480px){.ud-pricing-dialog .ud-pricing-prices{grid-template-columns:repeat(2,minmax(0,1fr))}}
/* dock 内并列条目:官方 pill 满宽不动,空间不足时高收缩因子让自身先收缩(min-width:0 配合 ellipsis),挤压力不转嫁官方 */
.ud-statsline-root{--ud-dock-gap:0px;text-align:center;max-width:var(--dsh-chat-content-width);box-sizing:border-box;flex:0 999 auto;min-width:0;padding:0;font-size:var(--dsh-content-font-size-secondary);line-height:calc(20px + var(--dsh-content-font-delta-secondary));color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0;margin-left:calc(0px - var(--ud-dock-gap));text-indent:var(--ud-dock-gap);display:block;overflow:hidden}
/* 费用条目可点击:按钮形态复位,只保留官方胶囊的排版与截断 */
.ud-cost-trigger{display:inline-block;vertical-align:baseline;max-width:100%;margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;line-height:inherit;text-align:inherit;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ud-cost-trigger:hover{color:var(--dsw-alias-label-secondary)}
.ud-cost-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm)}
/* 展开面板:固定定位由脚本夹取,视觉与统一提示同一套语义色与尺寸标尺 */
.ud-cost-panel{position:fixed;z-index:${TIP_Z_INDEX};box-sizing:border-box;width:min(420px,calc(100vw - 24px));max-height:60vh;overflow:auto;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
/* 打开即脚本聚焦容器:不给非交互容器画焦点环,键盘进入时才显示 */
.ud-cost-panel:focus{outline:none}
.ud-cost-panel:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.ud-cost-inner{display:flex;flex-direction:column;gap:10px;min-width:0}
.ud-cost-head{display:flex;align-items:center;gap:8px}
.ud-cost-title{font-size:13px;font-weight:600;line-height:20px;letter-spacing:.01em}
.ud-cost-totals{display:flex;flex-direction:column;gap:4px;padding:2px 2px 10px}
.ud-cost-total{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.ud-cost-total-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.ud-cost-total-value{font-variant-numeric:tabular-nums;font-weight:600;font-size:16px;line-height:24px}
.ud-cost-section{display:flex;flex-direction:column;gap:6px;min-width:0;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.ud-cost-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
.ud-cost-section-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-cost-empty{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-cost-row{display:flex;flex-direction:column;gap:3px;min-width:0;padding:2px 0}
.ud-cost-row + .ud-cost-row{padding-top:8px;border-top:.5px dashed var(--dsw-alias-border-l1)}
.ud-cost-row-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.ud-cost-row-model{font-weight:500;min-width:0;overflow-wrap:anywhere}
.ud-cost-row-amount{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;flex:none}
.ud-cost-row-expr{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.ud-cost-term{position:relative;cursor:help;border-bottom:.5px dotted var(--dsw-alias-border-l1)}
.ud-cost-term:hover,.ud-cost-term:focus-visible{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-tertiary);outline:none}
.ud-cost-term-tip{display:none;position:absolute;z-index:2;bottom:calc(100% + 6px);left:0;min-width:220px;max-width:300px;padding:7px 9px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;white-space:normal;text-align:left;pointer-events:none}
.ud-cost-term:hover .ud-cost-term-tip,.ud-cost-term:focus-visible .ud-cost-term-tip{display:flex;flex-direction:column;gap:1px}
.ud-cost-term-tip-label{font-weight:600}
.ud-cost-term-tip-rule{color:var(--dsw-alias-label-tertiary)}
.ud-cost-term:nth-child(n+3) .ud-cost-term-tip{left:auto;right:0}
.ud-cost-foot{display:flex;flex-direction:column;gap:3px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
/* 芯片 portal 至动作行末尾,历史轮悬停/焦点显隐随父级 data-actions-reveal,无需自绘规则 */
.ud-turn-cost{font-size:var(--dsh-content-font-size-secondary);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:${TURN_COST_GAP_PX}px}
/* 官方用时弹窗入口:按钮挂在 dl 之后,不参与 dl 的 dt/dd 语义 */
.ud-request-anchor{display:none}
.ud-request-entry{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;border:0;border-top:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;line-height:18px;padding:8px 0 2px;margin-top:8px;text-align:left;cursor:pointer}
.ud-request-entry:hover{color:var(--dsw-alias-button-primary-hover)}
.ud-request-entry:focus-visible,.ud-request-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.ud-request-entry::after{content:"›";font-size:16px;line-height:16px}
.ud-request-backdrop{position:fixed;inset:0;z-index:${MODAL_Z_INDEX};display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.ud-request-modal{width:min(840px,100%);max-height:min(80vh,780px);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.ud-request-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 20px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.ud-request-head-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.ud-request-title{font-size:14px;line-height:22px;font-weight:600}
.ud-request-subtitle{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-request-close{display:grid;place-items:center;width:28px;height:28px;flex:none;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ud-request-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ud-request-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:12px 20px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.ud-request-metric{display:flex;flex-direction:column;gap:2px;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.ud-request-metric-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-request-metric-value{font-size:14px;line-height:20px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ud-request-table-wrap{overflow:auto;min-height:0}
.ud-request-table{width:100%;min-width:${REQUEST_TABLE_MIN_WIDTH}px;border-collapse:collapse;table-layout:fixed}
.ud-request-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary);text-align:left;padding:8px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}
.ud-request-table td{padding:8px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:middle;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ud-request-table th:first-child,.ud-request-table td:first-child{padding-left:20px}
.ud-request-table th:last-child,.ud-request-table td:last-child{padding-right:20px}
.ud-request-row{cursor:pointer}
.ud-request-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.ud-request-row:hover td{background:var(--dsw-alias-interactive-bg-hover)}
.ud-request-row--live td{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent)}
.ud-request-row--open td{background:var(--dsw-alias-bg-layer-2)}
.ud-request-time{color:var(--dsw-alias-label-secondary)}
.ud-request-status{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary)}
.ud-request-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.ud-request-dot--live{background:var(--dsw-alias-state-business-primary);animation:ud-request-pulse 1.2s ease-in-out infinite}
@keyframes ud-request-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.ud-request-live-note{display:block;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.ud-request-number{text-align:right}
.ud-request-price{text-align:right;color:var(--dsw-alias-label-secondary)}
.ud-request-model{max-width:150px;color:var(--dsw-alias-label-secondary)}
.ud-request-chevron{display:inline-block;width:12px;color:var(--dsw-alias-label-tertiary);transition:transform .15s}
.ud-request-row--open .ud-request-chevron{transform:rotate(90deg)}
.ud-request-expanded td{padding:0;background:var(--dsw-alias-bg-layer-2)}
.ud-request-detail{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px;padding:16px 20px;align-items:start}
.ud-request-detail-col{display:flex;flex-direction:column;gap:16px;min-width:0}
.ud-request-detail-section{display:flex;flex-direction:column;gap:4px;min-width:0}
.ud-request-detail-title{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.ud-request-detail-line{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;min-width:0}
.ud-request-detail-line span:first-child{color:var(--dsw-alias-label-tertiary);flex:none}
.ud-request-detail-line span:last-child{text-align:right;overflow-wrap:anywhere;min-width:0}
.ud-request-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 20px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}
.ud-request-empty{padding:24px 20px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.ud-subagent-entry{display:inline-flex;align-items:center;gap:4px;margin:0;padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;line-height:inherit;cursor:pointer;text-align:left}
.ud-subagent-entry:hover{text-decoration:underline}
.ud-subagent-entry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm)}
.ud-subagent-modal{width:min(920px,100%)}
.ud-subagent-table{min-width:900px}
.ud-subagent-table th:first-child,.ud-subagent-table td:first-child{width:auto}
.ud-subagent-name{overflow:hidden;text-overflow:ellipsis}
.ud-subagent-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.ud-request-current-tag{font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary)}
@media (max-width:640px){.ud-request-backdrop{padding:12px}.ud-request-modal{max-height:88vh}.ud-request-summary{grid-template-columns:repeat(2,minmax(0,1fr));padding:10px 16px}.ud-request-head{padding:12px 16px 10px}.ud-request-detail{grid-template-columns:1fr;padding:12px 16px;position:sticky;left:0;width:calc(100vw - 48px);box-sizing:border-box}.ud-request-table th:first-child,.ud-request-table td:first-child{padding-left:16px}.ud-request-table th:last-child,.ud-request-table td:last-child{padding-right:16px}}
@media (prefers-reduced-motion:reduce){.ud-request-dot--live{animation:none}.ud-request-chevron{transition:none}}
${WHATIF_CSS}
${GUARD_CSS}
${SENTINEL_CSS}
${HUD_CSS}
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

    // 信息性悬浮的唯一入口:包装任意元素,悬停/聚焦显示自绘提示,替代原生 title。
    // 提示内容经 aria-describedby 关联到触发元素,读屏在聚焦时能念到,不只有鼠标能看
    function HintText({ text, title, sections, className, tag = 'span', innerRef, tabIndex, children }) {
      const tipId = React.useId()
      const [anchor, setAnchor] = useState(null)
      const hasTip = Boolean(text || title || (sections && sections.length > 0))
      const show = hasTip ? (event) => setAnchor(tipAnchorRect(event)) : undefined
      const hide = hasTip ? () => setAnchor(null) : undefined
      const props = {
        className,
        ref: innerRef,
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
        tabIndex: tabIndex ?? (hasTip ? 0 : undefined),
        'aria-describedby': hasTip ? tipId : undefined,
      }
      return h(tag, props, [
        children,
        hasTip ? h(Tooltip, { key: 'tip', anchor }, anchor ? h(TipBody, { id: tipId, text, title, sections }) : null) : null,
      ])
    }

    function Card({ icon, label, hint, head, children }) {
      const lines = Array.isArray(children) ? children : [children]
      return h(HintText, { text: hint, tag: 'div', className: 'ud-card' }, [
        h('div', { key: 'head', className: 'ud-card-head' },
          h('span', { className: 'ud-card-icon' }, h(Icon, { paths: icon })),
          h('span', { className: 'ud-card-label' }, label),
          head ?? null),
        ...lines,
      ])
    }

    function StatCards({ stats, costCurrency = '', t = defaultT }) {
      return h('div', { className: 'ud-cards' },
        h(Card, { key: 'tokens', icon: ICONS.coins, label: t('tokens'), hint: `${t('tokensHint')} · ${formatTokens(stats.tokens)} tok`,
          head: stats.cost !== undefined
            ? h(HintText, {
                className: 'ud-card-cost',
                text: costTitleText(t, stats.unpriced ?? 0),
              }, `≈ ${formatCost(stats.cost, costCurrency)}`)
            : null },
          h(FitText, null, formatTokensCompact(stats.tokens))),
        h(Card, { key: 'sessions', icon: ICONS.sessions, label: t('sessions'), hint: t('sessionsHint') },
          h(FitText, null, String(stats.sessions ?? 0))),
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

    function Legend({ models, colorFor, speedEnabled = false, ttftEnabled = false, isVisible, onItem, onHoverModel, activeModel, t = defaultT }) {
      const itemProps = (key) => ({
        className: cx('ud-legend-item', isVisible && !isVisible(key) && 'ud-legend-item--off',
          activeModel && activeModel === key && 'ud-legend-item--on'),
        onClick: onItem ? (event) => onItem(key, event.ctrlKey || event.metaKey) : undefined,
        onMouseEnter: onHoverModel && models.some((item) => item.model === key) ? () => onHoverModel(key) : undefined,
        onMouseLeave: onHoverModel && models.some((item) => item.model === key) ? () => onHoverModel(null) : undefined,
        role: onItem ? 'button' : undefined,
      })
      return h('div', { className: 'ud-legend' },
        models.map((item) => h('span', { key: item.model, ...itemProps(item.model) },
          h('i', { className: 'ud-legend-swatch', style: { background: colorFor(item.model) } }),
          h('span', null, item.model === OTHER_MODEL ? t('other') : item.model))),
        h('span', { key: 'hit-rate', ...itemProps(LEGEND_KEY_RATE) },
          h('i', { className: 'ud-legend-swatch ud-legend-swatch--line' }),
          h('span', null, t('hitRateLegend'))),
        speedEnabled ? h('span', { key: 'speed', ...itemProps(LEGEND_KEY_SPEED) },
          h('i', { className: 'ud-legend-swatch ud-legend-swatch--line ud-legend-swatch--line--speed' }),
          h('span', null, t('speedLegend'))) : null,
        ttftEnabled ? h('span', { key: 'ttft', ...itemProps(LEGEND_KEY_TTFT) },
          h('i', { className: 'ud-legend-swatch ud-legend-swatch--line ud-legend-swatch--line--ttft' }),
          h('span', null, t('ttftLegend'))) : null)
    }

    const colorForModel = (models) => (model) => {
      if (model === OTHER_MODEL) return 'var(--ud-chart-other)'
      const slot = models.findIndex((item) => item.model === model)
      const rank = Math.min(slot < 0 ? 0 : slot, GROUP_UNFOLDED_MAX - 1) + 1
      return `var(--ud-chart-${rank})`
    }

    function TrendChart({ title, notes, slots, tipSlots, modelOrder, colorFor, labelFor, slotLabelFor, labelMinPitch, busy, legendModels, costCurrency = '', money = false, costAvailable = false, onMetricToggle, activeModel = null, onHoverModel, t = defaultT }) {
      const metricId = React.useId()
      const wrapRef = useRef(null)
      const [avail, setAvail] = useState(CHART_NOMINAL_WIDTH)
      const [hover, setHover] = useState(null)
      // 图例显隐:null = 默认集(trendDefaultVisibleKeys);切换以实际生效集为基线展开为键集
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
      const availableKeys = new Set([
        ...modelOrder, LEGEND_KEY_RATE,
        ...(hasSpeed ? [LEGEND_KEY_SPEED] : []),
        ...(hasTtft ? [LEGEND_KEY_TTFT] : []),
      ])
      const selectedKeys = visibleKeys && new Set([...visibleKeys].filter((key) => availableKeys.has(key)))
      if (selectedKeys && selectedKeys.size !== visibleKeys.size) {
        setVisibleKeys(selectedKeys.size ? selectedKeys : null)
      }
      const visibleSet = selectedKeys?.size ? selectedKeys : trendDefaultVisibleKeys(modelOrder, hasSpeed)
      const visibleModels = modelOrder.filter((model) => visibleSet.has(model))
      const showRate = visibleSet.has(LEGEND_KEY_RATE)
      const showSpeed = hasSpeed && visibleSet.has(LEGEND_KEY_SPEED)
      const showTtft = hasTtft && visibleSet.has(LEGEND_KEY_TTFT)
      const layout = trendLayout(slots, visibleModels, avail, labelMinPitch, money ? COST_TOTAL_FLOOR : 1)
      const plotRight = CHART_PAD.left + (slots.length - 1) * layout.step + layout.barWidth
      const ratePoints = trendRatePoints(slots, layout.bars, layout.plotHeight)
      const speedMax = speedScaleMax(slots)
      const speedAxisMax = speedMax * AXIS_SCALE_HEADROOM
      const speedPoints = showSpeed ? trendSpeedPoints(slots, layout.bars, layout.plotHeight, speedAxisMax) : []
      const ttftMax = ttftScaleMax(slots)
      const ttftAxisMax = ttftMax * AXIS_SCALE_HEADROOM
      const ttftPoints = showTtft ? trendTtftPoints(slots, layout.bars, layout.plotHeight, ttftAxisMax) : []
      // 全零时段不画空坐标系:柱段与指标线都为空即整段无数据,用空态说明替代
      const hasBars = layout.bars.some((bar) => bar.segments.length > 0) || (showRate && ratePoints.length > 0) || speedPoints.length > 0 || ttftPoints.length > 0
      // 左轴标定:可见柱有数据标 token;无柱数据且速度线可见标速度(tok/s);否则空
      // (ttft 不设轴,读数走 tooltip,毫秒域与速度轴不同单位不混轴)
      const speedAxisTicks = layout.ticks.length === 0 && showSpeed ? niceTicks(speedMax, AXIS_TICK_COUNT) : []
      // 金额视图左轴走紧凑金额读数,速度接管时仍为 tok/s 紧凑读数
      const yTicks = leftAxisTicks(layout.ticks, layout.scaleMax, speedAxisTicks, speedAxisMax,
        money ? (value) => formatCostCompact(value, costCurrency) : formatTokensCompact)
      const hoverSlot = hover ? tipSlots.find((slot) => slot.day === hover.day) : null
      const selectedSlot = visibleTipSlot(hoverSlot, visibleModels)
      const tipEntries = tipModelEntries(selectedSlot, visibleSet)
      const hasModels = tipEntries.main.length > 0
      const tipRate = showRate && hoverSlot && cacheRate(hoverSlot.cacheHit, hoverSlot.cacheMiss) !== null
      const tipSpeed = showSpeed && hoverSlot?.speed !== undefined
      const tipTtft = showTtft && hoverSlot?.ttft !== undefined
      const hasMetrics = tipRate || tipSpeed || tipTtft
      const hasTip = hasModels || hasMetrics
      const filtered = visibleModels.length < modelOrder.length
      const formatTipValue = money
        ? (value) => value === undefined ? COST_PLACEHOLDER : `≈ ${formatCost(value, costCurrency)}`
        : (value) => `${formatTokens(value)} tok`
      const tipTotalLabel = t(money ? (filtered ? 'selectedCost' : 'totalCost') : (filtered ? 'selectedTotal' : 'total'))
      const hoverRatePoint = showRate && hoverSlot ? ratePoints.find((point) => point.day === hoverSlot.day) : null
      const hoverSpeedPoint = hoverSlot ? speedPoints.find((point) => point.day === hoverSlot.day) : null
      const hoverTtftPoint = hoverSlot ? ttftPoints.find((point) => point.day === hoverSlot.day) : null
      const pick = (index) => (event) => setHover({ day: slots[index].day, anchor: tipAnchor(event) })
      const clear = () => setHover(null)
      const showCost = hasModels && (money || prefsRef.current.costDisplay) && selectedSlot.cost !== undefined
      const avgPrice = showCost ? tipAvgPriceText(selectedSlot, costCurrency) : null
      const otherEntries = money ? [...tipEntries.other].sort(([a], [b]) => (hoverSlot.otherCostByModel?.[b] ?? 0) - (hoverSlot.otherCostByModel?.[a] ?? 0)) : tipEntries.other
      return h('div', { className: 'ud-section' },
        h('div', { className: 'ud-section-head' },
          h('span', { className: 'ud-section-title' }, title),
          notes.length > 0 ? h('span', { className: 'ud-trend-note' }, notes.join(NOTE_SEPARATOR)) : null,
          costAvailable ? h('span', { className: 'ud-trend-metric' },
            h('span', { className: 'ud-trend-metric-label', id: metricId }, t('costTrend')),
            h(Switch, { checked: money, onChange: onMetricToggle, describedbyId: metricId, labelledById: metricId })) : null),
        h('div', { className: 'ud-chart-wrap', ref: wrapRef, style: busy ? { opacity: CHART_BUSY_OPACITY } : undefined },
          hasBars ? h('svg', {
            className: 'ud-chart', viewBox: `0 0 ${avail} ${CHART_HEIGHT}`, width: '100%', role: 'img',
            'aria-label': title, onMouseLeave: clear,
          },
            yTicks.map((tick, tickIndex) => {
              const y = CHART_PAD.top + layout.plotHeight - tick.ratio * layout.plotHeight
              return h('g', { key: tickIndex },
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
            layout.bars.flatMap((bar) => bar.segments.map((segment) => h('rect', {
              key: `${bar.key}/${segment.model}`,
              x: bar.x - layout.barWidth / 2, y: segment.y, width: layout.barWidth, height: segment.height,
              fill: colorFor(segment.model),
              className: cx('ud-bar', activeModel && activeModel !== segment.model && 'ud-bar--dim'),
              style: hover?.day === bar.key
                ? { transform: `scaleX(${(layout.barWidth + BAR_HOVER_GROW) / layout.barWidth})` }
                : undefined,
            }))),
            slots.map((slot, index) => (index % layout.labelEvery === 0 || index === slots.length - 1)
              ? h('text', { key: slot.day, className: 'ud-axis', x: layout.bars[index].x, y: CHART_HEIGHT - X_LABEL_OFFSET, textAnchor: 'middle' }, labelFor(slot.day))
              : null),
            showRate ? h('path', {
              className: 'ud-trend', d: smoothPath(ratePoints, layout.step * TREND_LINE_GAP_SLOTS),
              strokeWidth: TREND_LINE_WIDTH, strokeLinejoin: 'round', strokeLinecap: 'round',
            }) : null,
            showSpeed ? h('path', {
              className: cx('ud-trend', 'ud-trend--speed'), d: smoothPath(speedPoints, layout.step * TREND_LINE_GAP_SLOTS),
              strokeWidth: TREND_LINE_WIDTH, strokeLinejoin: 'round', strokeLinecap: 'round',
            }) : null,
            showTtft ? h('path', {
              className: cx('ud-trend', 'ud-trend--ttft'), d: smoothPath(ttftPoints, layout.step * TREND_LINE_GAP_SLOTS),
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
            }))) : h('div', { className: 'ud-chart-empty' }, t('empty'))),
        h(Legend, {
          models: legendModels, colorFor, speedEnabled: hasSpeed, ttftEnabled: hasTtft,
          isVisible: (key) => visibleSet.has(key),
          onItem: (key, ctrl) => setVisibleKeys(legendToggle(visibleSet, key, ctrl)),
          onHoverModel, activeModel,
        }),
        h(Tooltip, { anchor: hasTip ? hover.anchor : null },
          hasTip
            ? h(TipBody, {
                title: slotLabelFor ? slotLabelFor(hoverSlot.day) : hoverSlot.day,
                sections: [
                  {
                    key: 'models',
                    rows: [
                      ...(hasModels
                        ? [{
                            key: 'total',
                            label: tipTotalLabel,
                            value: formatTipValue(money ? selectedSlot.cost : selectedSlot.total),
                          }]
                        : []),
                      ...tipEntries.main.map((row) => ({
                        key: `m-${row.model}`,
                        label: row.model === OTHER_MODEL ? t('other') : row.model,
                        value: formatTipValue(money ? hoverSlot.byCostModel?.[row.model] : row.tokens),
                        swatch: colorFor(row.model),
                      })),
                      ...otherEntries.map(([model, tokens]) => ({
                        key: `om-${model}`,
                        label: model,
                        value: formatTipValue(money ? hoverSlot.otherCostByModel?.[model] : tokens),
                        sub: true,
                      })),
                      ...(showCost && !money
                        ? [{ key: 'cost', label: t('cost'), value: `≈ ${formatCost(selectedSlot.cost, costCurrency)}` }]
                        : []),
                      ...(avgPrice ? [{ key: 'avg-price', label: t('avgPrice'), value: avgPrice }] : []),
                    ],
                  },
                  {
                    key: 'metrics',
                    label: t('slotMetrics'),
                    rows: [
                      ...(tipRate ? [{ key: 'rate', label: t('cacheHitRate'), value: cacheRateText(hoverSlot.cacheHit, hoverSlot.cacheMiss) }] : []),
                      ...(tipSpeed ? [{ key: 'speed', label: t('avgSpeed'), value: speedTipText(hoverSlot.speed) }] : []),
                      ...(tipTtft ? [{ key: 'ttft', label: t('ttftLegend'), value: ttftTipText(hoverSlot.ttft, t) }] : []),
                    ],
                  },
                ].filter((section) => section.rows.length > 0),
              })
            : null))
    }

    // 统一悬浮:锚点由消费方给(指针或元素矩形)、进入/退出延迟、portal 到 body。
    // 内容由消费方给 TipBody,组件只负责定位与显隐。
    const TIP_SHOW_DELAY_MS = 80
    const TIP_HIDE_DELAY_MS = 60

    function Tooltip({ anchor, children }) {
      const tipRef = useRef(null)
      const [pos, setPos] = useState(null)
      const [shown, setShown] = useState(false)
      const hasContent = children != null && (!Array.isArray(children) || children.length > 0)
      const active = Boolean(anchor && hasContent)
      const pointerMode = anchor?.kind === 'point'
      useEffect(() => {
        const timer = setTimeout(() => setShown(active), active ? TIP_SHOW_DELAY_MS : TIP_HIDE_DELAY_MS)
        return () => clearTimeout(timer)
      }, [active])
      const placeAt = useCallback((at) => {
        const tip = tipRef.current
        if (!tip || !at) return
        // 面板存在时以面板为夹取边界,提示不飘出弹窗;底栏/芯片等弹出面板外时用视口
        const panel = typeof document === 'undefined' ? null : document.querySelector('.ud-panel')
        const panelRect = panel ? panel.getBoundingClientRect() : null
        const bounds = panelRect && panelRect.width > 0
          ? panelRect
          : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        const next = tipPlacement(at, { width: tip.offsetWidth, height: tip.offsetHeight }, bounds)
        setPos((prev) => (prev && next && prev.left === next.left && prev.top === next.top
          && prev.side === next.side && prev.arrowX === next.arrowX ? prev : next))
      }, [])
      const place = useCallback(() => placeAt(anchor), [placeAt, anchor])
      useLayoutEffect(() => {
        place()
      }, [place, shown])
      // 指针模式由 mousemove 直接定位:同一元素内移动也跟手,且每帧只提交一次位置
      useEffect(() => {
        if (!pointerMode) return undefined
        const onMove = (event) => placeAt({ kind: 'point', x: event.clientX, y: event.clientY })
        window.addEventListener('mousemove', onMove)
        return () => window.removeEventListener('mousemove', onMove)
      }, [pointerMode, placeAt])
      useEffect(() => {
        if (!anchor) return undefined
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        const observer = new ResizeObserver(() => place())
        if (tipRef.current) observer.observe(tipRef.current)
        return () => {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
          observer.disconnect()
        }
      }, [place, anchor])
      const visible = shown && pos !== null && active
      const box = h('div', {
        className: cx('ud-tip', visible && 'ud-tip--on'),
        ref: tipRef,
        style: { left: pos ? pos.left : 0, top: pos ? pos.top : 0 },
      }, [
        active ? children : null,
        visible && pos.arrowX !== null
          ? h('i', { key: 'arrow', className: `ud-tip-arrow ud-tip-arrow--${pos.side}`, style: { left: pos.arrowX } })
          : null,
      ])
      return createPortal && typeof document !== 'undefined' && document.body
        ? createPortal(box, document.body)
        : box
    }

    // 提示内容模型:标题 + 段落说明 + 分区 + 两列(标签左、数值右),子项弱化,色块沿用图例圆点
    const TipBody = React.memo(function TipBody({ id, title, text, sections }) {
      return h('div', { className: 'ud-tip-body', id, role: 'tooltip' },
        title ? h('div', { className: 'ud-tip-title' }, title) : null,
        text ? h('div', { className: 'ud-tip-text' }, text) : null,
        (sections ?? []).map((section, index) => h('div', {
          key: section.key ?? index,
          className: 'ud-tip-section',
        },
          section.label ? h('div', { className: 'ud-tip-section-title' }, section.label) : null,
          h('div', { className: 'ud-tip-grid' },
            section.rows.map((row) => h('div', {
              key: row.key,
              className: cx('ud-tip-item', row.sub && 'ud-tip-item--sub'),
            },
              h('span', { className: 'ud-tip-label' },
                row.swatch ? h('i', { className: 'ud-legend-swatch', style: { background: row.swatch } }) : null,
                row.label),
              h('span', { className: 'ud-tip-value' }, row.value)))))))
    })

    function HeatSection({ days, costCurrency = '', t = defaultT }) {
      const wrapRef = useRef(null)
      const [width, setWidth] = useState(0)
      const [hover, setHover] = useState(null)
      // 费用行显隐随「费用显示」偏好,经 ref 读取:开关切换不触发本组件重渲染
      const prefsRef = useRef(statsLineState.get())
      useEffect(() => statsLineState.subscribe(() => { prefsRef.current = statsLineState.get() }), [])
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
      const pick = (cell) => (event) => setHover({ ...cell, anchor: tipAnchor(event) })
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
                    className: `ud-heat-cell ud-heat-l${level}${hover && hover.day === cell.day ? ' ud-heat-cell--on' : ''}`,
                    x: cell.x, y: cell.y, width: geom.size, height: geom.size, rx: HEAT_RX,
                    'aria-hidden': level === 0,
                    onMouseEnter: pick(cell), onFocus: pick(cell),
                    onMouseLeave: clear, onBlur: clear,
                  })
                }))
            : null),
        h(Tooltip, { anchor: hover ? hover.anchor : null },
          hover
            ? h(TipBody, {
                title: hover.day,
                sections: [{
                  key: 'main',
                  rows: heatTipRows(hover, t, prefsRef.current.costDisplay, costCurrency),
                }],
              })
            : null))
    }

    // 模型用量:donut + 列表,恒按天口径,不随视图切换
    function ModelUsage({ models, colorFor, costCurrency = '', t = defaultT, onHoverModel }) {
      const [hover, setHover] = useState(null)
      const [tip, setTip] = useState(null)
      const [expandedOther, setExpandedOther] = useState(false)
      const total = Math.max(DONUT_TOTAL_FLOOR, models.reduce((sum, item) => sum + item.tokens, 0))
      const segments = donutSegments(models, total)
      const displayName = (model) => (model === OTHER_MODEL ? t('other') : model)
      const pick = (model) => (event) => {
        setHover(model)
        setTip({ model, anchor: tipAnchor(event) })
        if (onHoverModel) onHoverModel(model)
      }
      const clear = () => {
        setHover(null)
        setTip(null)
        if (onHoverModel) onHoverModel(null)
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
            h('text', { className: 'ud-donut-center', x: DONUT_CENTER_XY, y: DONUT_CENTER_XY + DONUT_CENTER_VALUE_OFFSET, textAnchor: 'middle', 'aria-hidden': true },
              formatTokensCompact(total),
              h('title', null, `${formatTokens(total)} tok`)),
            h('text', { className: 'ud-donut-label', x: DONUT_CENTER_XY, y: DONUT_CENTER_XY + DONUT_CENTER_LABEL_OFFSET, textAnchor: 'middle', 'aria-hidden': true }, t('tokens'))),
          h('div', { className: 'ud-models' },
            models.map((item) => {
              const isOther = item.model === OTHER_MODEL
              const speedText = modelSpeedText(item.speed)
              const ttftText = modelTtftText(item.ttft)
              const ioText = modelIoPercentText(item, t)
              const avgText = avgPriceText(item.cost, item.tokens, costCurrency)
              const percentText = formatPercent((item.tokens / total) * PERCENT_SCALE)
              const tokensText = `${formatTokensCompact(item.tokens)} (${percentText})`
              const costText = item.cost !== undefined ? `≈ ${formatCost(item.cost, costCurrency)}` : null
              const metaParts = [
                avgText,
                ttftText,
                speedText,
              ].filter(Boolean)
              return h(React.Fragment, { key: item.model },
                h('div', {
                  className: cx('ud-model-row', isOther && 'ud-model-row--expand'),
                  onClick: isOther ? toggleOther : undefined,
                  onMouseEnter: () => { setHover(item.model); if (onHoverModel) onHoverModel(item.model) },
                  onMouseLeave: clear,
                },
                  h('i', { className: 'ud-model-swatch', style: { background: colorFor(item.model) } }),
                  h('div', { className: 'ud-model-id' },
                    isOther
                      ? h('span', { className: 'ud-model-name' }, displayName(item.model))
                      : [
                          h('span', { className: 'ud-model-provider' }, providerOf(item.model)),
                          h('span', { className: 'ud-model-name' }, modelNameOf(item.model)),
                        ]),
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
                    h(HintText, { className: 'ud-model-tokens', text: `${formatTokens(item.tokens)} (${percentText})` }, costText ? `${tokensText} · ${costText}` : tokensText),
                    ioText ? h('span', { className: 'ud-model-io' }, ioText) : null,
                    h('span', { className: 'ud-model-meta' }, metaParts.join(' · ')))),
                isOther
                  ? h('div', { className: cx('ud-model-other', expandedOther && 'ud-model-other--open') },
                      h('div', { className: 'ud-model-other-list' },
                        otherDetailItems(models).map((detail) => h('div', {
                          key: detail.model, className: 'ud-model-row ud-model-row--sub',
                          onMouseEnter: () => { setHover(OTHER_MODEL); if (onHoverModel) onHoverModel(OTHER_MODEL) }, onMouseLeave: clear,
                        },
                          h('span', { className: 'ud-model-name' }, detail.model),
                          h('div', { className: 'ud-model-values' },
                            h(HintText, { className: 'ud-model-tokens', text: `${formatTokens(detail.tokens)} tok` }, formatTokensCompact(detail.tokens)))))))
                  : null)
            }))),
        h(Tooltip, { anchor: tip ? tip.anchor : null },
          tipSegment
            ? h(TipBody, {
                title: displayName(tipSegment.model),
                sections: [
                  {
                    key: 'main',
                    rows: [
                      { key: 'tokens', label: t('total'), value: formatTokens(tipSegment.tokens) },
                      { key: 'pct', label: t('percent'), value: formatPercent(tipSegment.percent) },
                    ],
                  },
                  {
                    key: 'buckets',
                    rows: hasTokenBuckets(tipSegment)
                      ? [
                          { key: 'input', label: t('priceInput'), value: formatTokens(tipSegment.inputTokens) },
                          { key: 'cacheRead', label: t('priceCacheRead'), value: formatTokens(tipSegment.cacheReadTokens) },
                          { key: 'cacheWrite', label: t('priceCacheWrite'), value: formatTokens(tipSegment.cacheWriteTokens) },
                          { key: 'output', label: t('priceOutput'), value: formatTokens(tipSegment.outputTokens) },
                        ]
                      : [],
                  },
                  {
                    key: 'items',
                    rows: tipSegment.model === OTHER_MODEL
                      ? (tipSegment.items ?? []).map((detail) => ({
                          key: detail.model,
                          label: detail.model,
                          value: formatTokens(detail.tokens),
                          sub: true,
                          swatch: 'var(--ud-chart-other)',
                        }))
                      : [],
                  },
                ].filter((section) => section.rows.length > 0),
              })
            : null))
    }

    // 规约形态开关:原生 checkbox 保语义并视觉隐藏,track/thumb 呈现选中态
    function Switch({ checked, onChange, disabled, describedbyId, labelledById }) {
      return h('label', { className: 'ud-switch' },
        h('input', {
          type: 'checkbox',
          checked,
          disabled,
          'aria-describedby': describedbyId,
          'aria-labelledby': labelledById,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'ud-switch__track' },
          h('span', { className: 'ud-switch__thumb' })))
    }

    function useUsageDialogTarget(anchorRef, percent) {
      const [target, setTarget] = useState(null)
      useEffect(() => observeUsageDialog(anchorRef.current, document, MutationObserver, setTarget, percent), [percent])
      return target
    }

    // 最近输出速度的挂载点:官方「用时与速度」弹窗,读数行落在输出速度之后;
    // 统计开关关闭时不装观察器,避免为未启用的功能付全文档监听
    function useSpeedDialogTarget(anchorRef, enabled) {
      const [target, setTarget] = useState(null)
      useEffect(() => {
        if (!enabled) {
          setTarget(null)
          return undefined
        }
        return observeStatDialog(anchorRef.current, document, MutationObserver, setTarget, SPEED_DIALOG_STAT, SPEED_DIALOG_SELECTOR, keepSpeedRowLast)
      }, [enabled])
      return enabled ? target : null
    }

    // 胶囊读数替换:仅当开关开启且有读数时接管,关闭或读数消失即还原官方文本
    function useSpeedCapsulePatch(anchorRef, text) {
      useEffect(() => {
        if (text === null) return undefined
        return observeSpeedCapsule(anchorRef.current, document, MutationObserver, text)
      }, [text])
    }

    function useRecentRequestsDialog(enabled, anchorRef) {
      const [target, setTarget] = useState(null)
      useEffect(() => {
        if (!enabled) {
          setTarget(null)
          return undefined
        }
        return observeActivityStatDialog(anchorRef.current, document, MutationObserver, setTarget)
      }, [enabled])
      return enabled ? target : null
    }

    const requestCostText = (value, currency, partial = false) => formatRequestCost(value, currency, partial)
    const requestSpeedText = (value) => (Number.isFinite(value) ? `${formatTokensPerSecond(value)} tok/s` : COST_PLACEHOLDER)
    const requestDurationText = (value, t) => (Number.isFinite(value) ? formatDuration(value, t) : COST_PLACEHOLDER)
    const requestTokenText = (value) => (Number.isFinite(value) ? formatTokens(value) : COST_PLACEHOLDER)

    function requestDetailLine(label, value) {
      return h('div', { className: 'ud-request-detail-line', key: label },
        h('span', null, label),
        h('span', null, value))
    }

    function requestDetailSection(title, lines, key) {
      return h('div', { className: 'ud-request-detail-section', key },
        h('div', { className: 'ud-request-detail-title' }, title),
        lines)
    }

    function RequestDetailsModal({ view, rules, t = defaultT, onClose }) {
      const rows = Array.isArray(view?.rows) ? [...view.rows].reverse() : []
      const current = view?.open ?? null
      const [expanded, setExpanded] = useState(null)
      const [now, setNow] = useState(() => Date.now())
      const modalRef = useRef(null)
      const closeRef = useRef(null)
      const closeRefValue = useRef(onClose)
      closeRefValue.current = onClose
      const summary = summarizeRequests(rows, rules)
      const currency = aggregateCurrencyOf(rules)
      const visibleCount = rows.length + (current ? 1 : 0)

      useEffect(() => {
        const previous = document.activeElement
        const previousOverflow = document.body.style.overflow
        // 官方弹层在独立 portal 且层级接近,打开详情时临时隐藏,避免两层弹窗叠在一起
        const sourcePanel = document.querySelector('[data-session-stats-details]')?.parentElement
        const previousVisibility = sourcePanel?.style.visibility
        if (sourcePanel) sourcePanel.style.visibility = 'hidden'
        document.body.style.overflow = 'hidden'
        closeRef.current?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeRefValue.current?.()
            return
          }
          if (event.key !== 'Tab' || !modalRef.current) return
          const focusable = [...modalRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter((node) => !node.disabled && node.offsetParent !== null)
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = previousOverflow
          if (sourcePanel) {
            if (previousVisibility === undefined) sourcePanel.style.removeProperty('visibility')
            else sourcePanel.style.visibility = previousVisibility
          }
          if (previous?.isConnected) previous.focus()
          else document.querySelector('[data-composer-stat="activity"] button')?.focus?.()
        }
      }, [])

      useEffect(() => {
        if (!current) return undefined
        const timer = setInterval(() => setNow(Date.now()), MS_PER_SECOND)
        return () => clearInterval(timer)
      }, [current?.turn, current?.step])

      const currentUsage = current?.usage ?? null
      const currentTotal = currentUsage ? currentUsage.uncachedInputTokens + currentUsage.outputTokens + currentUsage.cacheReadTokens + currentUsage.cacheWriteTokens : null
      const currentFirst = current?.firstTokenTime ?? null
      const currentTtft = currentFirst === null ? null : Math.max(0, currentFirst - current.startTime)
      const currentDecode = currentFirst === null ? null : Math.max(0, now - currentFirst)
      const currentSpeed = currentUsage && currentDecode !== null && currentDecode > 0
        ? currentUsage.outputTokens / (currentDecode / MS_PER_SECOND)
        : null
      const currentCost = currentUsage && current
        ? requestCostOf({
            startedAt: current.startTime,
            model: current.model,
            usage: currentUsage,
          }, rules)
        : null

      const liveRow = current
        ? h('tr', { className: 'ud-request-row ud-request-row--live' },
            h('td', null, h('span', { className: 'ud-request-dot ud-request-dot--live', 'aria-hidden': true })),
            h('td', null, h('span', { className: 'ud-request-time' }, formatClock(current.startTime))),
            h('td', null,
              h('span', { className: 'ud-request-status' }, t('requestGenerating')),
              h('span', { className: 'ud-request-live-note' }, t('requestElapsed', { duration: formatDuration(Math.max(0, now - current.startTime), t) }))),
            h('td', { className: 'ud-request-model', title: current.model ?? '' }, formatRequestRowModel(current.model)),
            h('td', { className: 'ud-request-number' }, requestDurationText(currentTtft, t)),
            h('td', { className: 'ud-request-number' }, currentSpeed === null ? COST_PLACEHOLDER : `~${requestSpeedText(currentSpeed)}`),
            h('td', { className: 'ud-request-number' }, currentUsage ? `~${requestTokenText(currentUsage.outputTokens)}` : COST_PLACEHOLDER),
            h('td', { className: 'ud-request-number' }, currentTotal === null ? COST_PLACEHOLDER : `~${requestTokenText(currentTotal)}`),
            h('td', { className: 'ud-request-price' }, currentCost ? `~${requestCostText(currentCost.total, currency)}` : COST_PLACEHOLDER))
        : null

      const bodyRows = []
      rows.forEach((row, index) => {
        const key = `${row.turn}:${row.step}`
        const open = expanded === key
        const cost = requestCostOf(row, rules)
        const usage = row.usage
        bodyRows.push(h('tr', {
          key,
          className: cx('ud-request-row', open && 'ud-request-row--open'),
          tabIndex: 0,
          'aria-expanded': open,
          onClick: () => setExpanded(open ? null : key),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setExpanded(open ? null : key)
            }
          },
        },
          h('td', null,
            h('span', { className: 'ud-request-chevron', 'aria-hidden': true }, '›'),
            h('span', { className: 'ud-request-time' }, index + 1)),
          h('td', { className: 'ud-request-time' }, formatClock(row.startedAt)),
          h('td', null, h('span', { className: 'ud-request-status' },
            h('span', { className: 'ud-request-dot', 'aria-hidden': true }), t('requestCompleted'))),
          h('td', { className: 'ud-request-model', title: row.model ?? '' }, formatRequestRowModel(row.model)),
          h('td', { className: 'ud-request-number' }, requestDurationText(row.ttftMs, t)),
          h('td', { className: 'ud-request-number' }, requestSpeedText(requestDecodeSpeed(row))),
          h('td', { className: 'ud-request-number' }, usage ? requestTokenText(usage.outputTokens) : COST_PLACEHOLDER),
          h('td', { className: 'ud-request-number' }, requestTokenText(requestTotalTokens(row))),
          h('td', { className: 'ud-request-price' }, cost ? requestCostText(cost.total, currency) : COST_PLACEHOLDER)))
        if (open) {
          const inputTotal = usage ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null
          const hit = cacheHitRateOf(usage)
          const priced = cost !== null
          bodyRows.push(h('tr', { key: `${key}:detail`, className: 'ud-request-expanded' },
            h('td', { colSpan: 9 },
              h('div', { className: 'ud-request-detail' },
                h('div', { className: 'ud-request-detail-col' },
                  requestDetailSection(t('requestInfo'), [
                    requestDetailLine(t('requestTurnStep'), `${row.turn} / ${row.step}`),
                    requestDetailLine(t('requestAttemptsCount'), String(row.attempts)),
                    requestDetailLine(t('requestStatus'), t('requestCompleted')),
                    requestDetailLine(t('requestModel'), row.model ?? COST_PLACEHOLDER),
                  ], 'request'),
                  requestDetailSection(t('requestTokenSection'), [
                    requestDetailLine(t('requestUncachedInput'), usage ? requestTokenText(usage.uncachedInputTokens) : COST_PLACEHOLDER),
                    requestDetailLine(t('requestCacheRead'), usage ? requestTokenText(usage.cacheReadTokens) : COST_PLACEHOLDER),
                    requestDetailLine(t('requestCacheWrite'), usage ? requestTokenText(usage.cacheWriteTokens) : COST_PLACEHOLDER),
                    requestDetailLine(t('requestOutput'), usage ? requestTokenText(usage.outputTokens) : COST_PLACEHOLDER),
                    requestDetailLine(t('requestInputTotal'), requestTokenText(inputTotal)),
                    requestDetailLine(t('requestTotalTokens'), requestTokenText(requestTotalTokens(row))),
                    requestDetailLine(t('requestCacheHit'), hit === null ? COST_PLACEHOLDER : formatPercent(hit)),
                  ], 'tokens')),
                h('div', { className: 'ud-request-detail-col' },
                  requestDetailSection(t('requestTime'), [
                    requestDetailLine(t('requestStartedAt'), formatClock(row.startedAt)),
                    requestDetailLine(t('requestFirstAt'), row.firstTokenTime === null ? COST_PLACEHOLDER : formatClock(row.firstTokenTime)),
                    requestDetailLine(t('requestCompletedAt'), formatClock(row.completedAt)),
                    requestDetailLine(t('requestFirstDelay'), requestDurationText(row.ttftMs, t)),
                    requestDetailLine(t('requestDecode'), requestDurationText(row.decodeMs, t)),
                  ], 'timing'),
                  requestDetailSection(t('requestCost'), priced ? [
                    requestDetailLine(t('requestCostInput'), requestCostText(bucketCostOf(cost.price, 'input', usage?.uncachedInputTokens), currency)),
                    requestDetailLine(t('requestCostCacheRead'), requestCostText(bucketCostOf(cost.price, 'cacheRead', usage?.cacheReadTokens), currency)),
                    requestDetailLine(t('requestCostCacheWrite'), requestCostText(bucketCostOf(cost.price, 'cacheWrite', usage?.cacheWriteTokens), currency)),
                    requestDetailLine(t('requestCostOutput'), requestCostText(bucketCostOf(cost.price, 'output', usage?.outputTokens), currency)),
                    requestDetailLine(t('requestCost'), requestCostText(cost.total, currency)),
                    requestDetailLine(t('requestPriceTime'), formatClock(row.startedAt)),
                    requestDetailLine(t('requestRule'), `${cost.rule.model} · ${cost.rule.currency || '—'}`),
                  ] : [requestDetailLine(t('requestCost'), t('requestUnpriced'))], 'cost'))))))
        }
      })

      return h('div', {
        className: 'ud-request-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) closeRefValue.current?.() },
      },
      h('div', {
        className: 'ud-request-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'ud-request-title',
        ref: modalRef,
        onPointerDown: (event) => event.stopPropagation(),
        onMouseDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
      },
        h('div', { className: 'ud-request-head' },
          h('div', { className: 'ud-request-head-text' },
            h('div', { className: 'ud-request-title', id: 'ud-request-title' }, t('requestDetailsTitle')),
            h('div', { className: 'ud-request-subtitle' }, `${t('requestDetailsSubtitle', { n: visibleCount })}${summary.unpricedCount > 0 ? ` · ${t('requestPartialUnpriced', { n: summary.unpricedCount })}` : ''}`)),
          h('button', {
            className: 'ud-request-close', type: 'button', ref: closeRef,
            'aria-label': t('requestClose'), title: t('requestClose'), onClick: () => closeRefValue.current?.(),
          }, h(Icon, { paths: ICONS.close }))),
        h('div', { className: 'ud-request-summary' },
          h('div', { className: 'ud-request-metric' },
            h('span', { className: 'ud-request-metric-label' }, t('requestFirstToken')),
            h('span', { className: 'ud-request-metric-value' }, requestDurationText(summary.ttftMs, t))),
          h('div', { className: 'ud-request-metric' },
            h('span', { className: 'ud-request-metric-label' }, t('requestSpeed')),
            h('span', { className: 'ud-request-metric-value' }, requestSpeedText(summary.speed))),
          h('div', { className: 'ud-request-metric' },
            h('span', { className: 'ud-request-metric-label' }, t('requestMeanTokens')),
            h('span', { className: 'ud-request-metric-value' }, requestTokenText(summary.totalTokens))),
          h('div', { className: 'ud-request-metric' },
            h('span', { className: 'ud-request-metric-label' }, t('requestMeanCost')),
            h('span', { className: 'ud-request-metric-value' }, requestCostText(summary.cost, currency, summary.unpricedCount > 0)))),
        h('div', { className: 'ud-request-table-wrap' },
          h('table', { className: 'ud-request-table' },
            h('colgroup', null,
              REQUEST_TABLE_COLUMNS.map((width, index) => h('col', { key: index, style: { width } }))),
            h('thead', null, h('tr', null,
              ['#', t('requestTime'), t('requestStatus'), t('requestModel'), t('requestFirstToken'), t('requestSpeed'), t('requestOutput'), t('requestTotalTokens'), t('requestEstimate')]
                .map((label, index) => h('th', { key: index, scope: 'col' }, label)))),
            h('tbody', null,
              liveRow,
              bodyRows.length > 0 ? bodyRows : h('tr', null,
                h('td', { colSpan: 9, className: 'ud-request-empty' }, t('requestEmpty')))))),
        h('div', { className: 'ud-request-foot' },
          h('span', null, `${t('requestMean', { n: summary.count })}${summary.unpricedCount > 0 ? ` · ${t('requestPartialUnpriced', { n: summary.unpricedCount })}` : ''}`),
          h('span', { title: t('requestCostHint') }, `${t('requestCost')} ${requestCostText(summary.cost, currency, summary.unpricedCount > 0)}`))))
    }

    // 子代理明细二级页:官方 Token 用量弹窗点「查看明细」后打开,复用最近请求详情的外框与表格样式
    function SubagentUsageModal({ detail, t = defaultT, currency = '', onClose }) {
      const view = subagentUsageViewOf(detail, t, currency)
      const modalRef = useRef(null)
      const closeRef = useRef(null)
      const closeRefValue = useRef(onClose)
      closeRefValue.current = onClose
      useEffect(() => {
        const previous = document.activeElement
        const previousOverflow = document.body.style.overflow
        const sourcePanel = document.querySelector('[data-session-stats-usage]')?.parentElement
        const previousVisibility = sourcePanel?.style.visibility
        if (sourcePanel) sourcePanel.style.visibility = 'hidden'
        document.body.style.overflow = 'hidden'
        closeRef.current?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeRefValue.current?.()
            return
          }
          if (event.key !== 'Tab' || !modalRef.current) return
          const focusable = [...modalRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter((node) => !node.disabled && node.offsetParent !== null)
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = previousOverflow
          if (sourcePanel) {
            if (previousVisibility === undefined) sourcePanel.style.removeProperty('visibility')
            else sourcePanel.style.visibility = previousVisibility
          }
          if (previous?.isConnected) previous.focus()
        }
      }, [])
      const headers = ['subagentColTitle', 'subagentColModel', 'subagentColInput', 'subagentColOutput', 'subagentColCacheRead', 'subagentColCacheWrite', 'subagentColTotal', 'subagentColCost']
      return h('div', {
        className: 'ud-request-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) closeRefValue.current?.() },
      },
      h('div', {
        className: 'ud-request-modal ud-subagent-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'ud-subagent-title',
        ref: modalRef,
        onPointerDown: (event) => event.stopPropagation(),
        onMouseDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
      },
        h('div', { className: 'ud-request-head' },
          h('div', { className: 'ud-request-head-text' },
            h('div', { className: 'ud-request-title', id: 'ud-subagent-title' }, view.title),
            h('div', { className: 'ud-request-subtitle' }, view.subtitle)),
          h('button', {
            className: 'ud-request-close', type: 'button', ref: closeRef,
            'aria-label': t('subagentClose'), title: t('subagentClose'), onClick: () => closeRefValue.current?.(),
          }, h(Icon, { paths: ICONS.close }))),
        h('div', { className: 'ud-request-table-wrap' },
          h('table', { className: 'ud-request-table ud-subagent-table' },
            h('colgroup', null,
              ['240px', '180px', '88px', '72px', '72px', '72px', '96px', '88px'].map((width, index) => h('col', { key: index, style: { width } }))),
            h('thead', null, h('tr', null, headers.map((key) => h('th', { key, scope: 'col' }, t(key))))),
            h('tbody', null,
              view.rows.length > 0
                ? view.rows.map((row) => h('tr', { key: row.key },
                    h('td', null,
                      h('div', { className: 'ud-subagent-name', title: row.title }, row.title),
                      row.note ? h('div', { className: 'ud-subagent-note' }, row.note) : null),
                    h('td', { title: row.model }, row.model),
                    h('td', { className: 'ud-request-number' }, row.input),
                    h('td', { className: 'ud-request-number' }, row.output),
                    h('td', { className: 'ud-request-number' }, row.cacheRead),
                    h('td', { className: 'ud-request-number' }, row.cacheWrite),
                    h('td', { className: 'ud-request-number' }, row.total),
                    h('td', { className: 'ud-request-price' }, row.amount)))
                : h('tr', null, h('td', { colSpan: 8, className: 'ud-request-empty' }, view.empty))))),
        h('div', { className: 'ud-request-foot' },
          h('span', null, view.footnotes.length > 0 ? view.footnotes.join(' · ') : ''),
          h('span', null, `${t('subagentTotal')} ${view.totals.tokens} tok${view.totals.amount === COST_PLACEHOLDER ? '' : ` · ${view.totals.amount}`}`))))
    }

    // 详情入口不占 dock 布局:只在官方弹窗打开时注入按钮与最近首 token 平均行,弹窗关闭即清理
    const RequestDetailsAppended = React.memo(function RequestDetailsAppended({ useProjection, t = defaultT }) {
      if (typeof useProjection !== 'function') return null
      const view = useProjection(RECENT_REQUESTS_PROJECTION)
      const [prefs, setPrefs] = useState(() => statsLineState.get())
      useEffect(() => statsLineState.subscribe(() => setPrefs(statsLineState.get())), [])
      const featureEnabled = prefs.requestDetails && typeof createPortal === 'function'
      const { rules } = usePricing()
      const [open, setOpen] = useState(false)
      const openRef = useRef(false)
      const anchorRef = useRef(null)
      openRef.current = open
      const requestOpen = useRef(() => {})
      requestOpen.current = () => setOpen(true)
      const target = useRecentRequestsDialog(featureEnabled, anchorRef)
      const rows = Array.isArray(view?.rows) ? view.rows : []
      const ttftAverage = requestTtftAverageSeconds(rows)
      const ttftKey = ttftAverage === null ? '' : String(ttftAverage)
      const ttftLabel = t('recentTtft')
      const entryLabel = t('requestDetailsEntry')
      const unit = t('secondsUnit')
      const hasData = rows.length > 0 || (view?.open ?? null) !== null

      useEffect(() => {
        if (!featureEnabled && open) setOpen(false)
      }, [featureEnabled, open])

      useEffect(() => {
        if (!featureEnabled || !target) return undefined
        return observeRequestDetailsExtras(target, document, MutationObserver, {
          ttftLabel,
          ttftValue: ttftAverage,
          unit,
          entryLabel,
          enabled: hasData,
          onOpen: () => requestOpen.current?.(),
        })
      }, [featureEnabled, target, ttftKey, hasData, ttftLabel, entryLabel, unit])

      if (!featureEnabled) return null
      return h(React.Fragment, null,
        h('span', { ref: anchorRef, className: 'ud-request-anchor', 'aria-hidden': 'true' }),
        featureEnabled && open && createPortal
          ? createPortal(h(RequestDetailsModal, {
              view,
              rules,
              t,
              onClose: () => setOpen(false),
            }), document.body)
          : null)
    })

    // 费用展开面板:点击费用条目打开,官方同构交互(dialog 语义 + Esc/外点关闭 + portal 到 body),
    // 面板在展开时才挂载,会话列表订阅只在打开期间存在。锚点每次重算都取触发元素当前矩形,
    // dock 布局或窗口变化时面板跟随
    function CostPopover({ triggerRef, label, onClose, children }) {
      const panelRef = useRef(null)
      const [pos, setPos] = useState(null)
      const closeRef = useRef(onClose)
      closeRef.current = onClose
      const place = () => {
        const panel = panelRef.current
        if (!panel) return
        const anchor = triggerRef?.current?.getBoundingClientRect?.()
        const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
        const size = { width: panel.offsetWidth, height: panel.offsetHeight }
        const next = anchor ? tipPlacement(anchor, size, bounds, { prefer: TIP_SIDE_TOP }) : null
        // 触发元素被压缩到极窄或未布局时,退到视口底部居中,面板保持可见可读
        const fallback = {
          left: Math.max(TIP_MARGIN_PX, (bounds.right - size.width) / 2),
          top: Math.max(TIP_MARGIN_PX, bounds.bottom - size.height - TIP_MARGIN_PX * 3),
        }
        const resolved = next ?? fallback
        setPos((prev) => (prev && prev.left === resolved.left && prev.top === resolved.top ? prev : resolved))
      }
      const placeRef = useRef(place)
      placeRef.current = place
      // 聚焦只在开面板的首帧做一次,后续投影更新重算位置但不抢焦点
      useLayoutEffect(() => {
        panelRef.current?.focus?.()
      }, [])
      useLayoutEffect(() => placeRef.current())
      useEffect(() => {
        const run = () => placeRef.current()
        window.addEventListener('scroll', run, true)
        window.addEventListener('resize', run)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(run) : null
        if (panelRef.current) observer?.observe(panelRef.current)
        return () => {
          window.removeEventListener('scroll', run, true)
          window.removeEventListener('resize', run)
          observer?.disconnect()
        }
      }, [])
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          // 面板在宿主弹窗之上:先关自己,不再让宿主同时关掉底层弹窗
          event.stopPropagation()
          closeRef.current()
          triggerRef?.current?.focus?.()
        }
        // 外点关闭走捕获阶段:面板内的点击先被识别,不误关
        const onPointer = (event) => {
          const target = event.target
          if (target && panelRef.current?.contains?.(target)) return
          if (target && triggerRef?.current?.contains?.(target)) return
          closeRef.current()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, [triggerRef])
      const box = h('div', {
        className: 'ud-cost-panel',
        role: 'dialog',
        tabIndex: -1,
        'aria-label': label,
        ref: panelRef,
        style: pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: 0, top: 0, visibility: 'hidden' },
      }, children)
      return typeof createPortal === 'function' && typeof document !== 'undefined' && document.body
        ? createPortal(box, document.body)
        : box
    }

    // 数据面分流:宿主提供 useSessions 时挂带订阅的分支,旧宿主直接以「无子代理数据面」渲染,
    // 组件自身不条件调用 hook
    function CostBreakdownBody(props) {
      if (typeof props.useSessions === 'function' && typeof props.sessionId === 'string') {
        return h(CostBreakdownWithSessions, props)
      }
      const model = costPanelModelOf({
        usage: props.usage,
        modelUsage: props.modelUsage,
        rules: props.rules,
        subagentRows: [],
        now: new Date(),
      })
      return h(CostBreakdownSections, { model, t: props.t, subagentsAvailable: false })
    }

    function CostBreakdownWithSessions({ usage, modelUsage, rules, t = defaultT, sessionId, useSessions }) {
      // 官方会话列表行自带 origin/parentId;小时投影不在行 summary 里(插件声明了 summary: false),
      // 与官方子代理面板一样在展开时按会话拉取投影再读 projectionsBySession
      const byId = useSessions((state) => state?.byId)
      const projections = useSessions((state) => state?.projectionsBySession)
      const subagents = subagentHoursOf(byId, sessionId, projections)
      const nowRef = useRef(null)
      if (nowRef.current === null) nowRef.current = new Date()
      const model = costPanelModelOf({
        usage, modelUsage, rules,
        subagentHours: subagents.hours,
        subagentMissing: subagents.missing,
        now: nowRef.current,
      })
      // 拉取失败的会话由 refreshProjections 自己记 error 状态;这里只保证不产生未处理拒绝。
      // 必须经服务对象调用(方法依赖 this.manager),同步拒绝时降级为已有投影而不是崩槽
      const refreshKey = subagentDescendantIds(byId, sessionId).join(',')
      useEffect(() => {
        if (sessionsClient === null && typeof clientCtx?.get === 'function') sessionsClient = clientCtx.get('sessions') ?? null
        const sessions = sessionsClient
        if (typeof sessions?.refreshProjections !== 'function') return
        const refresh = (id) => {
          try {
            Promise.resolve(sessions.refreshProjections(id)).catch(() => {})
          } catch {
            // 宿主服务拒绝时保持已有投影,面板按缺失计数
          }
        }
        refresh(sessionId)
        for (const id of refreshKey === '' ? [] : refreshKey.split(',')) refresh(id)
      }, [refreshKey, sessionId])
      return h(CostBreakdownSections, { model, t, subagentsAvailable: true })
    }

    function CostBreakdownSections({ model, t = defaultT, subagentsAvailable = true }) {
      const view = costPanelViewOf(model, t, { subagentsAvailable })
      return h('div', { className: 'ud-cost-inner' },
        h('div', { className: 'ud-cost-head' }, h('span', { className: 'ud-cost-title' }, view.title)),
        h('div', { className: 'ud-cost-totals' }, view.totals.map((row) => h('div', { key: row.key, className: 'ud-cost-total' },
          h('span', { className: 'ud-cost-total-label' }, row.label),
          h('span', { className: 'ud-cost-total-value' }, row.value)))),
        view.sections.map((section) => h('div', { key: section.key, className: 'ud-cost-section' },
          h('div', { className: 'ud-cost-section-title' }, section.title),
          section.note ? h('div', { className: 'ud-cost-section-note' }, section.note) : null,
          section.empty ? h('div', { className: 'ud-cost-empty' }, section.empty) : null,
          section.rows.map((row) => h('div', { key: row.key, className: 'ud-cost-row' },
            h('div', { className: 'ud-cost-row-head' },
              h('span', { className: 'ud-cost-row-model' }, row.model),
              h('span', { className: 'ud-cost-row-amount' }, row.amount)),
            h('div', { className: 'ud-cost-row-expr' }, row.terms.map((term, index) => [
              index > 0 ? ' + ' : null,
              h('span', { key: term.key, className: 'ud-cost-term', tabIndex: 0 },
                h('span', null, term.short),
                h('span', { className: 'ud-cost-term-tip', role: 'tooltip' },
                  h('span', { className: 'ud-cost-term-tip-label' }, term.label),
                  h('span', { className: 'ud-cost-term-tip-detail' }, term.detail),
                  term.rule ? h('span', { className: 'ud-cost-term-tip-rule' }, term.rule) : null)),
            ])))))),
        h('div', { className: 'ud-cost-foot' }, view.footnotes.map((line, index) => h('div', { key: `n${index}` }, line))))
    }

    // 官方明细追加补充项，底栏保留费用。最近输出速度按会话投影订阅，
    // 投影缺失（旧宿主或本会话未采集到读数）时回落窗口节点估算。
    const StatsLineAppended = React.memo(function StatsLineAppended({ useProjection, useChat, useSessions, sessionId, t = defaultT }) {
      if (typeof useProjection !== 'function') return null
      const usage = useProjection('tokenUsage')
      const modelUsage = useProjection(MODEL_USAGE_PROJECTION)
      // 会话投影由宿主按会话推送:几十个并行会话只有当前会话的更新会到这里
      const recentSpeedView = useProjection(RECENT_SPEED_PROJECTION)
      // 窗口节点订阅:宿主 dock 标准 props 恒提供 useChat,缺失时最近输出速度按无数据降级
      const windowNodes = typeof useChat === 'function' ? useChat((state) => state?.legacy?.nodes) : null
      const [prefs, setPrefs] = useState(() => statsLineState.get())
      useEffect(() => statsLineState.subscribe(() => setPrefs(statsLineState.get())), [])
      const { rules: pricingRules } = usePricing()
      // 子代理明细入口随 Token 明细开关出现;非 subagent 会话(普通 fork)不显示
      const byId = typeof useSessions === 'function' ? useSessions((state) => state?.byId) : null
      const projectionsBySession = typeof useSessions === 'function' ? useSessions((state) => state?.projectionsBySession) : null
      const subagentIds = subagentDescendantIds(byId, sessionId)
      const subagentKey = subagentIds.join(',')
      const [subagentOpen, setSubagentOpen] = useState(false)
      const subagentDetail = subagentDetailOf(byId, sessionId, projectionsBySession, Array.isArray(pricingRules) ? pricingRules : [])
      useEffect(() => {
        if (!subagentOpen) return undefined
        if (sessionsClient === null && typeof clientCtx?.get === 'function') sessionsClient = clientCtx.get('sessions') ?? null
        const sessions = sessionsClient
        if (typeof sessions?.refreshProjections !== 'function') return undefined
        for (const id of subagentKey === '' ? [] : subagentKey.split(',')) {
          try { Promise.resolve(sessions.refreshProjections(id)).catch(() => {}) } catch { /* 宿主拒绝时保留已有投影 */ }
        }
        return undefined
      }, [subagentOpen, subagentKey])
      useEffect(() => {
        if (subagentIds.length === 0) setSubagentOpen(false)
      }, [subagentKey])
      const [costOpen, setCostOpen] = useState(false)
      const anchorRef = useRef(null)
      const costRef = useRef(null)
      const costTriggerRef = useRef(null)
      const speedAnchorRef = useRef(null)
      const closeCostPanel = () => setCostOpen(false)
      const toggleCostPanel = () => setCostOpen((open) => !open)
      const percent = prefs.cachePrecision && usage ? cacheHitPercentPrecise(usage) : null
      const target = useUsageDialogTarget(anchorRef, percent)
      const speedTarget = useSpeedDialogTarget(speedAnchorRef, prefs.recentSpeed)
      // 弹窗关闭且不替换胶囊时无需取样,避免每渲染复制整个窗口节点数组
      const speedWanted = prefs.recentSpeed && (speedTarget !== null || prefs.replaceSpeed)
      // 投影读数优先(与官方同一份 decode 配对),缺失才回落窗口节点估算
      const projectedSpeed = typeof recentSpeedView?.tps === 'number' && Number.isFinite(recentSpeedView.tps)
        ? recentSpeedView.tps
        : null
      const recentSpeed = speedWanted ? projectedSpeed ?? recentSpeedOf(windowNodes) : null
      const recentSpeedReading = recentSpeed === null ? null : `${formatTokensPerSecond(recentSpeed)} tok/s`
      const replacementSpeedText = recentSpeedReading === null ? null : t('replaceSpeedReading', { speed: recentSpeedReading })
      useSpeedCapsulePatch(speedAnchorRef, prefs.replaceSpeed ? replacementSpeedText : null)
      useLayoutEffect(() => {
        const element = costRef.current
        const dock = anchorRef.current?.closest('[data-slot="conversation.composer.dock"]')?.parentElement
        if (element && dock) element.style.setProperty('--ud-dock-gap', getComputedStyle(dock).columnGap)
      })
      const rows = buildUsageDialogRows(usage, prefs, t)
      const costItem = usage && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
        ? buildSessionCostItem(usage, modelUsage, pricingRules, prefs, t)
        : null
      // 条目消失(切会话、关开关、规则清空)时收起面板,避免下次出现时凭空展开
      useEffect(() => {
        if (costItem === null) setCostOpen(false)
      }, [costItem])
      const detailRows = rows.map((row) => h(React.Fragment, { key: row.key },
        h('dt', { 'data-ud-usage-detail': row.key }, row.label),
        h('dd', { 'data-ud-usage-detail': row.key }, row.value)))
      const details = target && createPortal && detailRows.length > 0 ? createPortal(detailRows, target) : null
      const subagentEntry = target && createPortal && prefs.tokenDetail && subagentIds.length > 0
        ? createPortal([
            h('dt', { key: 'subagent', 'data-ud-usage-detail': 'subagent' }, t('subagentUsage')),
            h('dd', { key: 'subagent', 'data-ud-usage-detail': 'subagent' },
              h('button', {
                type: 'button',
                className: 'ud-subagent-entry',
                onClick: () => setSubagentOpen(true),
              }, t('subagentUsageEntry', { n: subagentIds.length }))),
          ], target)
        : null
      const speedDetails = speedTarget && createPortal && recentSpeedReading !== null
        ? createPortal([
            h('dt', { key: 'speedLabel', 'data-ud-speed-detail': 'recentSpeed' }, t('recentSpeed')),
            h('dd', { key: 'speedValue', 'data-ud-speed-detail': 'recentSpeed' }, recentSpeedReading),
          ], speedTarget)
        : null
      return h(React.Fragment, null,
        h('span', { ref: anchorRef, hidden: true }),
        h('span', { ref: speedAnchorRef, hidden: true }),
        costItem !== null && h(HintText, {
          innerRef: costRef,
          className: 'ud-statsline-root',
          text: costOpen ? null : sessionCostTitleText(t, costItem.unpriced),
          // 键盘停靠点交给内部按钮,包装件不再抢占 Tab
          tabIndex: -1,
        }, h('button', {
          type: 'button',
          ref: costTriggerRef,
          className: 'ud-cost-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': costOpen,
          'aria-label': `${costItem.text},${t('costPanelOpen')}`,
          onClick: toggleCostPanel,
        }, costItem.text)),
        costOpen && costItem !== null && h(CostPopover, {
          triggerRef: costTriggerRef,
          label: t('costPanelTitle'),
          onClose: closeCostPanel,
        }, h(CostBreakdownBody, { usage, modelUsage, rules: pricingRules, t, sessionId, useSessions })),
        details,
        subagentEntry,
        subagentOpen && createPortal
          ? createPortal(h(SubagentUsageModal, {
              detail: subagentDetail,
              currency: aggregateCurrencyOf(pricingRules),
              t,
              onClose: () => setSubagentOpen(false),
            }), document.body)
          : null,
        speedDetails)
    })

    // 注入点B 组件:回合费用芯片,官方动作行内渲染(复制与分支图标之间,赞踩/上下文跳转同排);
    // 受费用显示开关;价格异步首帧未回不渲染,回包后补渲染;显隐节奏随官方 data-actions-reveal
    // 官方槽容器固定在用量/用时芯片之前,末位排布由 SlotTailPortal 移交实现
    // 响应性:useChat selector 返回用量源稳定引用(null→引用 / 引用→引用),回合结束数据发布即触发重渲染;
    // 返回仓库本体则引用恒定,快照比对恒等,新回合永不重渲染(刷新才出现的根因)
    const CostChip = React.memo(function CostChip({ messageId, useChat, t = defaultT }) {
      if (typeof useChat !== 'function') return null
      const usageSource = typeof messageId === 'string' && messageId !== ''
        ? useChat((state) => turnUsageSourceOfMessage(state?.nodes, messageId))
        : null
      const turnTime = typeof messageId === 'string' && messageId !== ''
        ? useChat((state) => turnTimeOfMessage(state?.nodes, messageId))
        : null
      const [prefs, setPrefs] = useState(() => statsLineState.get())
      useEffect(() => statsLineState.subscribe(() => setPrefs(statsLineState.get())), [])
      const { rules: pricingRules } = usePricing()
      const matched = usageSourceBuckets(usageSource)
      // 计价时点 = 回合结束事件时刻;节点缺时刻的旧形态才冻结在首次观测时刻,
      // 保证历史回合的时间条件不会随打开页面的时刻漂移
      const observedAtRef = useRef(null)
      if (matched && observedAtRef.current === null) observedAtRef.current = turnTime ?? Date.now()
      const price = matched && prefs.costDisplay && pricingRules !== null && observedAtRef.current !== null
        ? matchPrice(pricingRules, turnModelOf(matched), new Date(observedAtRef.current))
        : null
      // 0 元(全零价/全零桶)与价未命中同不渲染,无占位符
      const cost = matched && price ? turnCostAmountOf(matched, price) : null
      const chip = cost === null ? null : h(HintText, { className: 'ud-turn-cost', text: turnCostTitleText(t, matched) },
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

    // 设置区折叠容器:标题按钮承担展开/收起语义,body 保留子树状态
    function SectionFold({ title, description, summary, open, onToggle, children, className }) {
      const bodyId = React.useId()
      return h('section', { className: cx('ud-fold', open && 'ud-fold--open', className) },
        h('button', {
          type: 'button', className: 'ud-fold-head', 'aria-expanded': open, 'aria-controls': bodyId,
          onClick: onToggle,
        },
          h('span', { className: 'ud-fold-heading' },
            h('span', { className: 'ud-fold-title' }, title),
            description ? h('span', { className: 'ud-fold-desc' }, description) : null),
          h('span', { className: 'ud-fold-side' },
            summary ? h('span', { className: 'ud-fold-summary' }, summary) : null,
            h('span', { className: 'ud-fold-caret', 'aria-hidden': 'true' }, h(Icon, { paths: ICONS.chevron })))),
        h('div', { className: 'ud-fold-body', id: bodyId, hidden: !open }, children))
    }

    // 偏好卡行:说明文案承担 aria-describedby 目标;disabled 用于总开关关闭时整组置灰
    function StatsLineOptionRow({ labelKey, descKey, descParams, checked, onToggle, disabled = false, t = defaultT }) {
      const describeId = React.useId()
      return h('div', { className: cx('ud-pref-row', disabled && 'ud-pref-row--disabled') },
        h('div', { className: 'ud-pref-text' },
          h('span', { className: 'ud-pref-title' }, t(labelKey)),
          h('span', { className: 'ud-pref-desc', id: describeId }, t(descKey, descParams))),
        h(Switch, { checked, onChange: onToggle, describedbyId: describeId, disabled }))
    }

    // 偏好卡:与底部信息栏同 store 实例,改动即时互通;设置区默认折叠,最近相关开关单独成组
    function StatsLineOptions({ t = defaultT }) {
      const [prefs, setPrefs] = useState(() => statsLineState.get())
      const [open, setOpen] = useState(false)
      const groupTitleId = React.useId()
      const recentGroupOn = recentGroupOnOf(prefs)
      useEffect(() => statsLineState.subscribe(() => setPrefs(statsLineState.get())), [])
      const activeCount = ['cachePrecision', 'tokenDetail', 'costDisplay', 'recentSpeed', 'requestDetails']
        .filter((key) => prefs[key] === true).length + (prefs.recentSpeed && prefs.replaceSpeed ? 1 : 0)
      return h(SectionFold, {
        title: t('settingsSection'),
        description: t('settingsSectionDesc'),
        summary: t('settingsOnCount', { n: activeCount }),
        open,
        onToggle: () => setOpen((value) => !value),
      }, h(React.Fragment, null,
        h('div', { className: 'ud-pref-group' },
          h('div', { className: 'ud-pref-group-head' },
            h('div', { className: 'ud-pref-group-text' },
              h('span', { className: 'ud-pref-group-title' }, t('displayGroup')),
              h('span', { className: 'ud-pref-group-desc' }, t('displayGroupDesc')))),
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
          })),
        h('div', { className: 'ud-pref-group ud-pref-group--recent' },
          h('div', { className: 'ud-pref-group-head' },
            h('div', { className: 'ud-pref-group-text' },
              h('span', { className: 'ud-pref-group-title', id: groupTitleId }, t('recentGroup')),
              h('span', { className: 'ud-pref-group-desc' }, t('recentGroupDesc'))),
            h(Switch, {
              checked: recentGroupOn,
              onChange: (value) => statsLineState.set(recentGroupPatchOf(value)),
              labelledById: groupTitleId,
            })),
          h(StatsLineOptionRow, {
            labelKey: 'recentSpeed',
            descKey: 'recentSpeedDesc',
            descParams: { n: RECENT_SPEED_STEPS },
            checked: prefs.recentSpeed,
            // 关统计时连带复位替换项:否则子开关隐藏后仍武装着,重开父开关会突然接管官方读数
            onToggle: (value) => statsLineState.set(value ? { recentSpeed: true } : { recentSpeed: false, replaceSpeed: false }),
            disabled: !recentGroupOn,
            t,
          }),
          // 替换是最近输出速度的子开关,仅在父项开启时出现
          prefs.recentSpeed && h(StatsLineOptionRow, {
            labelKey: 'replaceSpeed',
            descKey: 'replaceSpeedDesc',
            checked: prefs.replaceSpeed,
            onToggle: (value) => statsLineState.set({ replaceSpeed: value }),
            disabled: !recentGroupOn || !prefs.recentSpeed,
            t,
          }),
          h(StatsLineOptionRow, {
            labelKey: 'requestDetails',
            descKey: 'requestDetailsDesc',
            checked: prefs.requestDetails,
            onToggle: (value) => statsLineState.set({ requestDetails: value }),
            disabled: !recentGroupOn,
            t,
          }))))
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
        h('span', { className: 'ud-guard-amount' },
          h('input', {
            type: 'number', className: 'ud-input', min: 0, step: 'any', inputMode: 'decimal',
            value: rule.price?.[key] ?? '',
            onChange: (event) => onPricePatch({ price: { ...rule.price, [key]: event.target.value } }),
          }),
          h('span', { className: 'ud-guard-unit', 'aria-hidden': 'true' }, currency)),
        errorTextOf(`${pathPrefix}price.${key}`))
      return h('div', { className: 'ud-price-grid' },
        priceField('input', 'priceInput'),
        priceField('output', 'priceOutput'),
        priceField('cacheRead', 'priceCacheRead'),
        priceField('cacheWrite', 'priceCacheWrite'))
    }

    function PricingConditions({ rule, errors, pathPrefix, t, onPatch }) {
      const errorTextOf = (path) => {
        const key = errors.get(path)
        return key ? h('span', { className: 'ud-field-error' }, t(key)) : null
      }
      const conditions = rule.conditions ?? []
      const patchConditions = (next) => onPatch({ conditions: next })
      const patchConditionAt = (index, patch) => patchConditions(patchItemAt(conditions, index, patch))
      const removeConditionAt = (index) => patchConditions(conditions.filter((_, i) => i !== index))
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
        // 时段自绘 HH:MM 输入:原生 time 控件段位由浏览器按 locale 决定,部分环境渲染秒段,产出带秒值被校验拒绝
        const hhmmInput = (field, labelKey) => h('label', { key: field, className: 'ud-field' },
          h('span', { className: 'ud-field-label' }, t(labelKey)),
          h('input', {
            type: 'text', className: 'ud-input', inputMode: 'numeric', autoComplete: 'off',
            spellCheck: false, placeholder: HHMM_PLACEHOLDER,
            size: HHMM_INPUT_SIZE,
            value: condition[field] ?? '',
            onChange: (event) => patchCondition({ [field]: normalizeHHMMInput(event.target.value) }),
          }),
          errorTextOf(`${condPath}.${field}`))
        // 号段 from/to 同域 1~31(双闭),统一上限
        const numberInput = (field, labelKey) => h('label', { key: field, className: 'ud-field' },
          h('span', { className: 'ud-field-label' }, t(labelKey)),
          h('input', {
            type: 'number', className: 'ud-input', min: MONTH_DAY_MIN,
            max: MONTH_DAY_MAX, step: 1,
            value: condition[field] ?? '',
            onChange: (event) => patchCondition({ [field]: event.target.value === '' ? '' : Number(event.target.value) }),
          }),
          errorTextOf(`${condPath}.${field}`))
        // 周几 pill 仅 weekdays 条件才构造:其余类型无 days 字段,提前求值会使渲染崩溃白屏
        const weekdaysPills = () => h('div', { className: 'ud-group ud-pricing-weekdays', role: 'group', 'aria-label': t('condWeekdays') },
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
          dailyWindow: [hhmmInput('from', 'condFrom'), hhmmInput('to', 'condTo')],
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
            className: 'ud-btn ud-btn--text ud-pricing-icon', type: 'button', onClick: () => removeConditionAt(conditionIndex),
            'aria-label': t('deleteCondition'), title: t('deleteCondition'),
          }, h(Icon, { paths: ICONS.close })))
      }
      return h('div', { className: 'ud-rule-conds' },
        conditions.map(conditionRow),
        h('div', { className: 'ud-pricing-line' },
          h('span', { className: 'ud-pricing-note' }, t(conditions.length ? 'pricing.conditionsHint' : 'pricing.unconditional')),
          h('button', {
            type: 'button', className: 'ud-btn ud-btn--text',
            onClick: () => patchConditions([...conditions, defaultCondition(CONDITION_KIND_OPTIONS[0])]),
          }, `+ ${t('addCondition')}`)))
    }

    function PricingRuleFields({ rule, locked, currency, errors, t, actions }) {
      const slot = rule[DRAFT_SLOT]
      const pathPrefix = `${slot}.`
      const modelError = errors.get(`${pathPrefix}model`)
      const errorId = `${slot}-model-error`
      const [provider, model] = splitRuleSegments(rule.model) ?? ['', rule.model.replace(/^\//, '')]
      const patternError = rule.invalidProvider !== undefined ? 'pricing.providerSlash' : modelError
      const patch = (part) => actions.patch(slot, part)
      const field = (label, value, onChange, invalid) => h('label', { className: 'ud-field' },
        h('span', { className: 'ud-field-label' }, t(label)),
        h('input', { type: 'text', className: 'ud-input', value, readOnly: locked,
          'aria-invalid': Boolean(invalid), 'aria-describedby': invalid ? errorId : undefined,
          spellCheck: false, autoComplete: 'off', onChange: (event) => onChange(event.target.value),
        }))
      return h('div', { className: 'ud-card ud-pricing-fields' },
        h('div', { className: 'ud-pricing-pattern' },
          field('pricing.providerPattern', rule.invalidProvider ?? provider, (value) => {
            if (value.includes(SEGMENT_SEPARATOR)) actions.rename(slot, rule.model, value)
            else actions.rename(slot, `${value}/${model}`)
          }, patternError),
          field('pricing.modelPattern', model, (value) => actions.rename(slot, `${provider}/${value}`), modelError),
          patternError ? h('span', { className: 'ud-field-error', id: errorId }, t(patternError)) : null),
        h('div', { className: 'ud-pricing-fieldset' },
          h('h4', null, t('pricingUnit')),
          h(PricingPriceGrid, { rule, currency, errors, pathPrefix, t, onPricePatch: patch })),
        h('div', { className: 'ud-pricing-fieldset' },
          h('h4', null, t('pricing.conditions')),
          locked ? h('span', { className: 'ud-pricing-note' }, t('pricing.globalFallback'))
            : h(PricingConditions, { rule, errors, pathPrefix, t, onPatch: patch })))
    }

    const PRICING_TABS = [
      { id: 'models', labelKey: 'pricing.tabModels' },
      { id: 'rules', labelKey: 'pricing.tabRules' },
    ]
    const EMPTY_PRICING_ROWS = []
    const PRICING_PRICE_LABELS = { input: 'priceInput', output: 'priceOutput', cacheRead: 'priceCacheRead', cacheWrite: 'priceCacheWrite' }
    const isPricingFallback = (rule) => rule.model === MODEL_UNROUTED && !rule.conditions?.length
    const pricingRuleNumber = (rules, rule) => `#${rules.findIndex(item => item === rule || ruleStatsKey(item) === ruleStatsKey(rule)) + 1}`

    function pricingSnapshotOf(rules, observed, moment) {
      const ruleStats = new Map(rules.map((rule) => [rule, { billing: [], taken: [], conflict: false }]))
      const rows = new Map()
      for (const usage of observed) {
        if (typeof usage.model !== 'string' || !usage.model || usage.model === MODEL_UNROUTED || usage.model === OTHER_MODEL || rows.has(usage.model)) continue
        const result = resolvePricingRule(rules, usage.model, moment)
        const row = {
          ...result, usage, model: usage.model,
          cost: result.winner && hasTokenBuckets(usage) ? costOf(result.winner.price, usage) : null,
        }
        rows.set(usage.model, row)
        if (row.winner) ruleStats.get(row.winner).billing.push(row)
        for (const rule of row.candidates) if (row.winner && rule !== row.winner) ruleStats.get(rule).taken.push(row)
        for (const rule of row.conflictRules) ruleStats.get(rule).conflict = true
      }
      return { rows, ruleStats }
    }

    function pricingConditionsText(rule, t) {
      return rule.conditions?.map((cond) => {
        const value = cond.kind === 'weekdays' ? cond.days.map((day) => t(`weekday.${day}`)).join('、') : `${cond.from}–${cond.to}`
        return `${t(CONDITION_KIND_LABEL_KEYS[cond.kind])} ${value}`
      }).join(' · ') || t('pricing.unconditional')
    }

    function PricingPriceReadout({ rule, t }) {
      return h('dl', { className: 'ud-pricing-prices' }, PRICE_KEYS.map((key) => h('div', { key },
        h('dt', null, t(PRICING_PRICE_LABELS[key])),
        h('dd', null, `${rule.currency ?? ''}${rule.price[key]}`))))
    }

    function PricingTree({ row, rules, t }) {
      const [othersOpen, setOthersOpen] = useState(false)
      const detailsId = React.useId()
      const others = (row.candidates ?? []).filter((rule) => rule !== row.winner)
      const entry = (rule) => h('li', { key: pricingRuleNumber(rules, rule), className: cx('ud-pricing-tree-row', rule === row.winner && 'ud-pricing-tree-row--winner') },
        h('div', { className: 'ud-pricing-line' },
          h('span', { className: 'ud-pricing-tree-title' }, `${pricingRuleNumber(rules, rule)} ${rule.model}`),
          h('span', { className: 'ud-pricing-chip' }, t(rule === row.winner ? 'pricing.active' : 'pricing.inactive')),
          row.conflictRules.includes(rule) ? h('span', { className: 'ud-pricing-chip ud-pricing-warn' }, t('pricing.conflict')) : null),
        h('span', { className: 'ud-pricing-note' }, pricingConditionsText(rule, t)),
        h(PricingPriceReadout, { rule, t }))
      return h('div', { className: 'ud-pricing-tree' },
        row.winner ? h('ul', null, entry(row.winner)) : h('p', { className: 'ud-pricing-warn' }, t('pricing.noMatch')),
        others.length ? h('button', {
          className: 'ud-btn ud-btn--text', type: 'button', 'aria-expanded': othersOpen, 'aria-controls': detailsId,
          onClick: () => setOthersOpen(!othersOpen),
        }, t(othersOpen ? 'pricing.hideOthers' : 'pricing.showOthers', { n: others.length })) : null,
        h('ul', { id: detailsId, hidden: !othersOpen }, othersOpen ? others.map(entry) : null))
    }

    const PRICING_SEARCH_AUTO_GROUPS = 3
    const PRICING_MODELS_PER_PAGE = 20
    const PRICING_SEARCH_SUGGESTIONS = 40

    function PricingModels({ analysis, rules, moment, query, onQuery, selectedModel, onSelect, onEdit, clockToggle, clock, modelColors, t }) {
      const listId = React.useId()
      const [providerOverrides, setProviderOverrides] = useState(() => new Map())
      const [providerPages, setProviderPages] = useState(() => new Map())
      const rows = useMemo(() => [...analysis.rows.values()], [analysis])
      const probeKey = query.trim()
      const search = probeKey.toLowerCase()
      const exactObserved = analysis.rows.has(probeKey)
      const { groups, suggestions } = useMemo(() => {
        const groups = new Map()
        const suggestions = []
        for (const row of rows) {
          const provider = providerOf(row.model)
          if (exactObserved ? row.model !== probeKey : search && !row.model.toLowerCase().includes(search) && !provider.toLowerCase().includes(search)) continue
          if (!groups.has(provider)) groups.set(provider, [])
          groups.get(provider).push(row)
          if (suggestions.length < PRICING_SEARCH_SUGGESTIONS) suggestions.push(h('option', { key: row.model, value: row.model }))
        }
        return { groups: [...groups].sort(([a], [b]) => a.localeCompare(b, 'en')), suggestions }
      }, [rows, exactObserved, probeKey, search])
      const probe = isTwoSegmentModel(probeKey) && !probeKey.includes(MODEL_WILDCARD) && !exactObserved
        ? { model: probeKey, ...resolvePricingRule(rules, probeKey, moment) } : null
      const priced = rows.filter((row) => row.winner)
      const amountsAvailable = rows.length > 0 && rows.every((row) => row.cost !== null)
      const totals = [
        ['pricing.estimated', ICONS.coins, amountsAvailable ? formatCost(rows.reduce((sum, row) => sum + row.cost, 0), aggregateCurrencyOf(rules)) : TOOLTIP_MISSING],
        ['pricing.priced', ICONS.model, `${priced.length}/${rows.length}`],
        ['pricing.fallback', ICONS.rate, String(priced.filter((row) => isPricingFallback(row.winner)).length)],
        ['pricing.rules', ICONS.rules, String(rules.length)],
      ]
      const modelToggle = (row, label, detailId) => h('button', {
        type: 'button', className: 'ud-model-row ud-pricing-row', 'aria-controls': detailId, 'aria-expanded': selectedModel === row.model,
        'data-ud-price-model': row.model,
        onClick: () => onSelect(selectedModel === row.model ? null : row.model),
      },
        h('i', { className: 'ud-model-swatch', 'aria-hidden': true, style: { background: modelColors.get(row.model) ?? 'var(--ud-chart-other)' } }),
        h('span', { className: 'ud-model-id' },
          h('span', { className: 'ud-model-name' }, label),
          row.winner && isPricingFallback(row.winner) ? h('span', { className: 'ud-model-provider' }, t('pricing.globalFallback')) : null),
        h('span', { className: cx('ud-model-values', !row.winner && 'ud-pricing-warn') },
          h('span', { className: 'ud-model-tokens' }, row.winner
            ? `${pricingRuleNumber(rules, row.winner)} · ${t('priceInput')} ${row.winner.currency ?? ''}${row.winner.price.input} · ${t('priceOutput')} ${row.winner.currency ?? ''}${row.winner.price.output}`
            : t('pricing.unpriced'))),
        h('span', { className: 'ud-pricing-rule-caret', 'aria-hidden': 'true' }, h(Icon, { paths: ICONS.chevron })))
      const modelDetails = (row, id) => h('div', { id, hidden: selectedModel !== row.model }, selectedModel === row.model
        ? h(PricingTree, { key: row.model, row, rules, t }) : null)
      return h('div', { className: 'ud-pricing-stack' },
        h('div', { className: 'ud-pricing-search' },
          h('label', { className: 'ud-field' }, h('span', { className: 'ud-field-label' }, t('pricing.search')),
            h('span', { className: 'ud-pricing-search-input' }, h(Icon, { paths: ICONS.search }),
              h('input', {
                type: 'search', className: 'ud-input', value: query, list: listId, placeholder: t('pricing.searchPlaceholder'),
                onChange: (event) => {
                  const value = event.target.value
                  if (value.trim() !== probeKey) {
                    setProviderOverrides(new Map())
                    setProviderPages(new Map())
                  }
                  onQuery(value)
                  onSelect(analysis.rows.has(value.trim()) ? value.trim() : null)
                },
              }))),
          clockToggle),
        clock,
        h('datalist', { id: listId }, suggestions),
        probe ? h('div', { className: 'ud-card' },
          h('div', { className: 'ud-card-label' }, t('pricing.probe')),
          modelToggle(probe, probe.model, `${listId}-probe`), modelDetails(probe, `${listId}-probe`)) : null,
        rows.length ? h('div', { className: 'ud-pricing-summary' }, totals.map(([key, icon, value]) => h(Card, {
          key, icon, label: t(key),
        }, h('div', { title: value }, h(FitText, null, value))))) : null,
        rows.length > priced.length ? h('p', { className: 'ud-pricing-warn' }, t('pricing.unpricedCount', { n: rows.length - priced.length })) : null,
        !rules.length ? h('div', { className: 'ud-pricing-empty' },
          h('p', { className: 'ud-pricing-empty-text' }, t('pricingNotConfigured')),
          h('button', { className: 'ud-btn ud-btn--primary', type: 'button', onClick: onEdit }, t('pricing.configure'))) : null,
        groups.length === 0 ? h('div', { className: 'ud-pricing-empty' },
          h('p', { className: 'ud-pricing-empty-text' }, t(rows.length ? 'pricing.noSearchResults' : 'pricing.noObserved'))) : null,
        groups.length ? h('div', { className: 'ud-pricing-platforms' }, groups.map(([provider, items], index) => {
          const open = exactObserved || (providerOverrides.get(provider) ?? index < (search ? PRICING_SEARCH_AUTO_GROUPS : 1))
          const lastPage = Math.ceil(items.length / PRICING_MODELS_PER_PAGE) - 1
          const page = Math.min(providerPages.get(provider) ?? 0, lastPage)
          const start = page * PRICING_MODELS_PER_PAGE
          const paginate = (next) => setProviderPages((previous) => new Map(previous).set(provider, next))
          return h(SectionFold, {
            key: provider, className: 'ud-pricing-provider', title: provider, open,
            summary: t('pricing.modelCount', { n: items.length }),
            onToggle: () => setProviderOverrides((previous) => new Map(previous).set(provider, !open)),
          }, open ? items.slice(start, start + PRICING_MODELS_PER_PAGE).map((row) => {
            const id = `${listId}-${encodeURIComponent(row.model)}`
            return h('div', { key: row.model, className: 'ud-pricing-model' }, modelToggle(row, modelNameOf(row.model), id), modelDetails(row, id))
          }) : null,
          open && lastPage > 0 ? h('div', { className: 'ud-pricing-line ud-pricing-pages' },
            h('button', { type: 'button', className: 'ud-btn', disabled: page === 0, onClick: () => paginate(page - 1) }, t('pricing.previousModels')),
            h('span', { className: 'ud-pricing-note' }, `${page + 1}/${lastPage + 1}`),
            h('button', { type: 'button', className: 'ud-btn', disabled: page === lastPage, onClick: () => paginate(page + 1) }, t('pricing.nextModels'))) : null)
        })) : null)
    }

    function PricingDialog({ title, onClose, children }) {
      const dialogRef = useRef(null)
      const closeRef = useRef(onClose)
      closeRef.current = onClose
      const titleId = React.useId()
      useLayoutEffect(() => {
        const dialog = dialogRef.current
        if (!dialog) return undefined
        const owner = dialog.ownerDocument
        const trigger = owner.activeElement
        const view = owner.defaultView
        const onEscape = (event) => {
          if (event.key !== 'Escape' || !dialog.open || !dialog.contains(event.target)) return
          event.preventDefault()
          event.stopImmediatePropagation()
          if (!event.repeat) closeRef.current()
        }
        // 宿主设置也绑定 Escape；先在捕获阶段消费子弹窗内的按键。
        view.addEventListener('keydown', onEscape, true)
        dialog.showModal()
        return () => {
          view.removeEventListener('keydown', onEscape, true)
          if (dialog.open) dialog.close()
          if (trigger?.isConnected) trigger.focus()
        }
      }, [])
      return h('dialog', {
        className: 'ud-pricing-dialog', ref: dialogRef, 'aria-labelledby': titleId,
        onCancel: (event) => { event.preventDefault(); onClose() },
      }, h('h3', { id: titleId }, title), children)
    }

    function PricingRuleModels({ detail, analysis, rules, onClose, onJump, t }) {
      const [selected, setSelected] = useState(null)
      const [kind, setKind] = useState(detail.kind)
      const stats = detail.stats
      if (!stats) return null
      const current = stats[kind]
      return h(PricingDialog, { title: t('pricing.ruleModels', { rule: pricingRuleNumber(rules, detail.rule) }), onClose },
        h('div', { className: 'ud-pricing-line', role: 'group', 'aria-label': t('pricing.ruleModelsKinds') },
          ['billing', 'taken'].map((name) => h('button', {
            key: name, className: 'ud-btn', type: 'button', 'aria-pressed': kind === name,
            onClick: () => { setKind(name); setSelected(null) },
          }, t(`pricing.${name}`, { n: stats[name].length })))),
        current.length ? h('ul', { className: 'ud-pricing-dialog-list' }, current.map((row) => h('li', { key: row.model },
          h('div', { className: 'ud-pricing-line' }, h('code', null, row.model),
            kind === 'taken' ? h('span', { className: 'ud-pricing-note' }, t('pricing.takenBy', { rule: pricingRuleNumber(rules, row.winner) })) : null,
            h('button', {
              type: 'button', className: 'ud-btn', 'aria-expanded': selected === row.model,
              onClick: () => setSelected(selected === row.model ? null : row.model),
            }, t('pricing.tree')),
            h('button', { type: 'button', className: 'ud-btn', onClick: () => { onClose(); onJump(row.model) } }, t('pricing.jump'))),
          selected === row.model ? h(PricingTree, { key: row.model, row, rules, t }) : null)))
          : h('p', { className: 'ud-pricing-note' }, t(`pricing.no.${kind}`)),
        h('button', { className: 'ud-btn', type: 'button', onClick: onClose }, t('pricing.close')))
    }

    function PricingRuleDetails({ rule, stats, rules, t }) {
      const takeover = new Map()
      for (const row of stats.taken) takeover.set(row.winner, (takeover.get(row.winner) ?? 0) + 1)
      const cost = stats.billing.length && stats.billing.every((row) => row.cost !== null)
        ? formatCost(stats.billing.reduce((sum, row) => sum + row.cost, 0), rule.currency) : TOOLTIP_MISSING
      const tokens = formatTokens(stats.billing.reduce((sum, row) => sum + (row.usage.tokens ?? 0), 0))
      return h('div', { className: 'ud-pricing-rule-detail' },
        h('div', { className: 'ud-pricing-rule-rate' },
          h('p', { className: 'ud-pricing-rule-unit' }, t('pricingUnit')),
          h(PricingPriceReadout, { rule, t })),
        h('div', { className: 'ud-pricing-rule-meta ud-pricing-note' },
          h('p', null, t('pricing.ruleEstimate', { cost, tokens })),
          takeover.size ? h('ul', null, [...takeover].map(([winner, n]) => {
            const number = pricingRuleNumber(rules, winner)
            return h('li', { key: number }, t('pricing.takeoverDetail', { rule: number, n }))
          })) : null))
    }

    function PricingRules({ analysis, rules, onEditRule, onJump, t, footer }) {
      const [detail, setDetail] = useState(null)
      const [expanded, setExpanded] = useState(() => new Set())
      const listId = React.useId()
      const labels = [false, true]
      const items = useMemo(() => rules.map((rule, index) => ({ rule, index, segments: splitRuleSegments(rule.model) ?? ['', rule.model] }))
        .sort((a, b) => a.segments[0].localeCompare(b.segments[0], 'en') || a.segments[1].localeCompare(b.segments[1], 'en') || a.index - b.index), [rules])
      const statsByKey = useMemo(() => new Map([...analysis.ruleStats].map(([rule, stats]) => [ruleStatsKey(rule), stats])), [analysis])
      const badge = (rule, kind, n, stats) => n > 0 ? h('button', {
        type: 'button', className: cx('ud-pricing-chip ud-pricing-chip--button', `ud-pricing-chip--${kind}`),
        'aria-haspopup': 'dialog',
        onClick: (event) => { event?.stopPropagation(); setDetail({ rule, kind, stats }) },
      }, h('span', { className: 'ud-pricing-chip-dot', 'aria-hidden': 'true' }), t(`pricing.${kind}`, { n })) : null
      return h(React.Fragment, null, h('div', {
        className: 'ud-fold ud-pricing-rules', style: { '--ud-rule-index': `${String(rules.length).length + 1}ch` },
      },
        labels.map((hasStar) => {
          const group = items.filter(({ rule }) => rule.model.includes(MODEL_WILDCARD) === hasStar)
          if (!group.length) return null
          return h('section', { key: String(hasStar), className: cx('ud-pricing-group', hasStar && 'ud-pricing-group--wild') },
            h('div', { className: 'ud-pricing-group-head' },
              h('h3', { className: 'ud-fold-title' }, t(hasStar ? 'pricing.withStar' : 'pricing.withoutStar')),
              h('span', { className: 'ud-fold-summary' }, t('pricingRuleCount', { n: group.length }))),
            group.map(({ rule, index }) => {
              const stats = statsByKey.get(ruleStatsKey(rule)) ?? { billing: [], taken: [], conflict: false }
              const key = rule[DRAFT_SLOT]
              const detailId = `${listId}-${key}`
              const open = expanded.has(key)
              const toggle = () => setExpanded((previous) => {
                const next = new Set(previous)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
              return h('article', { key, className: cx('ud-pricing-rule', open && 'ud-pricing-rule--open') },
                h('div', { className: 'ud-pricing-rule-bar' },
                  h('button', {
                    type: 'button', className: 'ud-model-row ud-pricing-rule-head', 'aria-expanded': open,
                    'aria-controls': detailId, onClick: toggle,
                  },
                    h('span', { className: 'ud-pricing-rule-caret', 'aria-hidden': 'true' }, h(Icon, { paths: ICONS.chevron })),
                    h('i', { className: 'ud-pricing-rule-swatch', 'aria-hidden': 'true' }),
                    h('span', { className: 'ud-pricing-rule-no' }, `#${index + 1}`),
                    h('span', { className: 'ud-model-id' },
                      h('span', { className: 'ud-pricing-row-name' },
                        h('span', { className: 'ud-model-name' }, h('span', { className: 'ud-pricing-rule-model' }, rule.model)),
                        isPricingFallback(rule) ? h('span', { className: 'ud-pricing-note' }, t('pricing.globalFallback')) : null,
                        stats.conflict ? h('span', { className: 'ud-pricing-chip ud-pricing-warn' }, t('pricing.conflict')) : null),
                      rule.conditions?.length ? h('span', { className: 'ud-model-provider' }, pricingConditionsText(rule, t)) : null)),
                  h('div', { className: 'ud-pricing-rule-tags' },
                    badge(rule, 'billing', stats.billing.length, stats),
                    badge(rule, 'taken', stats.taken.length, stats),
                    h('button', {
                      type: 'button', className: 'ud-btn ud-btn--text ud-pricing-icon',
                      'aria-label': `${t('pricing.editRule')} #${index + 1} ${rule.model}`,
                      title: t('pricing.editRule'), onClick: () => onEditRule(index),
                    }, h(Icon, { paths: ICONS.edit })))),
                h('div', { id: detailId, hidden: !open }, open ? h(PricingRuleDetails, { rule, stats, rules, t }) : null))
            }))
        }), footer),
        detail ? h(PricingRuleModels, { detail, analysis, rules, t, onClose: () => setDetail(null), onJump }) : null)
    }

    function PricingBatch({ source, rules, observed, moment, onClose, onConfirm, t }) {
      const [input, setInput] = useState('')
      const inputId = React.useId()
      const provider = splitRuleSegments(source.model)?.[0] ?? ''
      const models = [...new Set(input.split(/[\r\n,，]+/).map((value) => value.trim()).filter(Boolean))]
      const invalid = models.some((model) => model.includes(MODEL_WILDCARD) || !isTwoSegmentModel(`${provider}/${model}`))
      const validSource = source.invalidProvider === undefined && validatePricingRules([source]).size === 0
      const { existing, validRules } = useMemo(() => ({
        existing: new Set(rules.map((rule) => rule.model)),
        validRules: rules.flatMap((rule) => rule.invalidProvider === undefined && validatePricingRules([rule]).size === 0 ? coercePricingRules([rule]) : []),
      }), [rules])
      const observedByModel = useMemo(() => {
        const index = new Map()
        for (const row of observed) {
          if (typeof row.model !== 'string' || row.model === MODEL_UNROUTED || row.model === OTHER_MODEL) continue
          const model = modelNameOf(row.model)
          if (!index.has(model)) index.set(model, new Set())
          index.get(model).add(row.model)
        }
        return index
      }, [observed])
      const preview = !invalid && validSource ? models.map((model) => {
        const key = `${provider}/${model}`
        if (existing.has(key)) return { model, candidate: null }
        const candidate = { ...copyRules([source])[0], model: key }
        const [priced] = coercePricingRules([candidate])
        const scope = { ...priced, conditions: [] }
        let covered = 0, matches = 0, billing = 0, taken = 0, conflicts = 0
        const copiedRules = [...validRules, priced]
        for (const observedKey of observedByModel.get(model) ?? []) {
          if (!matchPrice([scope], observedKey, moment)) continue
          covered++
          const result = resolvePricingRule(copiedRules, observedKey, moment)
          if (!result.candidates.includes(priced)) continue
          matches++
          if (result.winner === priced) billing++
          else if (result.winner) taken++
          if (result.conflictRules.includes(priced)) conflicts++
        }
        return { model, candidate, covered, matches, billing, taken, conflicts }
      }) : []
      const additions = preview.flatMap((row) => row.candidate ? [row.candidate] : [])
      const status = !validSource ? t('pricing.batchInvalidSource') : invalid ? t('pricing.batchInvalid') : !preview.length ? t('pricing.batchEmpty')
        : t('pricing.batchStatus', { added: additions.length, skipped: preview.length - additions.length })
      return h(PricingDialog, { title: t('pricing.batchTitle'), onClose },
        h('form', { onSubmit: (event) => { event.preventDefault(); if (additions.length) onConfirm(additions) } },
          h('div', { className: 'ud-card' }, h('code', null, source.model), h('p', { className: 'ud-pricing-note' }, pricingConditionsText(source, t)),
            h(PricingPriceReadout, { rule: source, t })),
          h('label', { className: 'ud-field' }, h('span', { className: 'ud-field-label' }, t('pricing.batchTargets')),
            h('textarea', { className: 'ud-input', rows: 3, autoFocus: true, value: input, 'aria-invalid': invalid,
              'aria-describedby': `${inputId}-hint ${inputId}-status`, onChange: (event) => setInput(event.target.value) })),
          h('p', { className: 'ud-pricing-note', id: `${inputId}-hint` }, t('pricing.batchHint')),
          h('p', { id: `${inputId}-status`, role: 'status' }, status),
          preview.length ? h('ul', { className: 'ud-pricing-dialog-list' }, preview.map((row) => h('li', { key: row.model, className: 'ud-pricing-line' },
            h('code', null, row.model), h('span', { className: 'ud-pricing-note' }, !row.candidate ? t('pricing.batchSkip')
              : !row.covered ? t('pricing.batchUnobserved') : !row.matches ? t('pricing.batchConditionsOff')
                : `${t('pricing.billing', { n: row.billing })} · ${t('pricing.taken', { n: row.taken })}${row.conflicts ? ` · ${t('pricing.conflict')} ${row.conflicts}` : ''}`)))) : null,
          h('div', { className: 'ud-pricing-line ud-pricing-confirm' },
            h('button', { className: 'ud-btn', type: 'button', onClick: onClose }, t('pricing.batchCancel')),
            h('button', { className: 'ud-btn ud-btn--primary', type: 'submit', disabled: !additions.length }, t('pricing.batchConfirm')))))
    }

    const DRAFT_SLOT = Symbol('pricing draft slot')

    function pricingDraftOf(rules, currency, allocateSlot) {
      const { rules: draft, synthetic } = ensureGlobalDefault(normalizePricingRules(copyRules(rules)), currency)
      if (synthetic) draft.at(-1).price = Object.fromEntries(PRICE_KEYS.map((key) => [key, '']))
      const slots = draft.map((rule) => ({ ...rule, [DRAFT_SLOT]: allocateSlot() }))
      return { draft: slots, synthetic: synthetic ? slots.at(-1)[DRAFT_SLOT] : null }
    }

    // 匹配器读取 Date 的日历分量；快照按宿主墙钟匹配，不受浏览器夏令时影响。
    class PricingWallDate extends Date {
      getFullYear() { return this.getUTCFullYear() }
      getMonth() { return this.getUTCMonth() }
      getDate() { return this.getUTCDate() }
      getDay() { return this.getUTCDay() }
      getHours() { return this.getUTCHours() }
      getMinutes() { return this.getUTCMinutes() }
    }

    // 单规则表单:新增与编辑共用同一视图,只是标题与初始规则不同
    function PricingRuleForm({ rule, index, creating, locked, currency, errors, t, saving, saveError, actions, clockToggle, clock, onBack, onSave, onBatch }) {
      const showError = saveError || (errors.size ? t(errors.get('fallback') ?? 'pricing.validationSummary') : '')
      return h('div', { className: 'ud-pricing-stack' },
        h('div', { className: 'ud-pricing-form-head' },
          h('div', { className: 'ud-pricing-toolrow' },
            h('button', { type: 'button', className: 'ud-btn ud-btn--text', disabled: saving, onClick: onBack }, `← ${t('pricing.backToList')}`),
            clockToggle),
          clock,
          h('div', { className: 'ud-pricing-line' },
            h('h3', null, t(creating ? 'pricing.createRule' : 'pricing.editRule')),
            creating ? null : h('span', { className: 'ud-pricing-rule-no' }, `#${index + 1}`),
            h(HintText, { className: 'ud-pricing-help', text: t('pricing.help'), tabIndex: 0 }, t('pricing.helpLabel')))),
        showError ? h('div', { className: 'ud-error', role: 'alert' }, showError) : null,
        h(PricingRuleFields, { rule, locked, currency, errors, t, actions }),
        h('div', { className: 'ud-pricing-toolrow ud-pricing-form-foot' },
          h('div', { className: 'ud-pricing-line' },
            creating || locked ? null : h(DeleteArmedButton, {
              labelKey: 'deleteRule', confirmKey: 'confirmDelete', tone: 'danger', showLabel: true, t,
              onConfirm: () => { if (!saving) { actions.remove(rule[DRAFT_SLOT]); onBack() } },
            }),
            creating ? null : h('button', { type: 'button', className: 'ud-btn ud-btn--text', disabled: saving, onClick: () => onBatch(rule) }, t('pricing.batch'))),
          h('div', { className: 'ud-pricing-actions' },
            h('button', { type: 'button', className: 'ud-btn', disabled: saving, onClick: onBack }, t('pricing.cancel')),
            h('button', { type: 'button', className: 'ud-btn ud-btn--primary', disabled: saving, onClick: onSave }, t('save')))))
    }

    function PricingEditor({ t = defaultT, publishedRules, observed = EMPTY_PRICING_ROWS, open = true, timeZone, modelColors }) {
      const [tab, setTab] = useState(PRICING_TABS[0].id)
      const [snapshot, setSnapshot] = useState('')
      const [clockOpen, setClockOpen] = useState(false)
      const [now, setNow] = useState(Date.now)
      const [selectedModel, setSelectedModel] = useState(null)
      const [query, setQuery] = useState('')
      const [phase, setPhase] = useState(null)
      const [failure, setFailure] = useState(null)
      const [loadAttempt, setLoadAttempt] = useState(0)
      const boardId = React.useId()
      const boardRef = useRef(null)
      const pendingModelFocus = useRef(null)
      useLayoutEffect(() => {
        if (tab !== 'models' || pendingModelFocus.current === null) return
        const model = pendingModelFocus.current
        pendingModelFocus.current = null
        const target = Array.from(boardRef.current?.querySelectorAll('[data-ud-price-model]') ?? []).find((button) => button.dataset.udPriceModel === model)
        target?.focus()
      }, [tab, selectedModel])
      const tabId = (name) => `${boardId}-tab-${name}`
      const panelId = (name) => `${boardId}-panel-${name}`
      const chooseTab = (name, focus = false) => {
        if (!snapshot) setNow(Date.now())
        setTab(name)
        if (focus) boardRef.current?.ownerDocument.getElementById(tabId(name))?.focus()
      }
      const onTabKey = (event, index) => {
        const last = PRICING_TABS.length - 1
        const offsets = { ArrowLeft: -1, ArrowRight: 1 }
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? last
          : offsets[event.key] ? (index + offsets[event.key] + PRICING_TABS.length) % PRICING_TABS.length : -1
        if (target < 0) return
        event.preventDefault()
        chooseTab(PRICING_TABS[target].id, true)
      }
      useEffect(() => {
        if (!open || snapshot) return undefined
        let timer
        const refresh = () => {
          clearTimeout(timer)
          if (document.visibilityState === 'hidden') return
          const value = Date.now()
          setNow(value)
          timer = setTimeout(refresh, MS_PER_MINUTE - value % MS_PER_MINUTE)
        }
        refresh()
        document.addEventListener?.('visibilitychange', refresh)
        return () => {
          clearTimeout(timer)
          document.removeEventListener?.('visibilitychange', refresh)
        }
      }, [open, snapshot])
      const [currency, setCurrency] = useState(CURRENCIES[0])
      const [rules, setRules] = useState(null)
      const [loadedRules, setLoadedRules] = useState(null)
      const [batchSource, setBatchSource] = useState(null)
      const [ruleEditor, setRuleEditor] = useState(null)
      const [errors, setErrors] = useState(() => new Map())
      const [saveError, setSaveError] = useState('')
      const [saving, setSaving] = useState(false)
      const [saved, setSaved] = useState(false)
      const savedTimerRef = useRef(null)
      const draftVersionRef = useRef(0)
      const nextSlotRef = useRef(0)
      const allocateSlot = useCallback(() => `slot:${nextSlotRef.current++}`, [])
      const editRules = useCallback((updater, structural = false) => {
        draftVersionRef.current += 1
        setRules(updater)
        if (structural) setErrors((previous) => previous.size ? new Map() : previous)
      }, [])
      const actions = useMemo(() => ({
        rename: (id, model, invalidProvider) => {
          editRules((previous) => previous.map((rule) => {
            if (rule[DRAFT_SLOT] !== id) return rule
            const next = { ...rule, model }
            if (invalidProvider === undefined) delete next.invalidProvider
            else next.invalidProvider = invalidProvider
            return next
          }), true)
        },
        patch: (id, patch) => editRules((previous) => previous.map((rule) => rule[DRAFT_SLOT] === id ? { ...rule, ...patch } : rule), 'conditions' in patch),
        remove: (id) => editRules((previous) => previous.filter((rule) => rule[DRAFT_SLOT] !== id), true),
      }), [editRules])
      const aliveRef = useRef(false)
      const syntheticGlobalRef = useRef(false)
      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      useEffect(() => {
        let alive = true
        fetchPricing(loadAttempt > 0).then((value) => {
          if (!alive) return
          if (!value) {
            setFailure(pricingFailure ?? 'transport')
            setPhase(PRICING_STATE_UNAVAILABLE)
            return
          }
          setFailure(null)
          setSaveError('')
          const unified = aggregateCurrencyOf(value.rules) || CURRENCIES[0]
          const { draft, synthetic } = pricingDraftOf(value.rules, unified, allocateSlot)
          syntheticGlobalRef.current = synthetic
          setLoadedRules(value.rules)
          setCurrency(unified)
          setRules(applyCurrencyToRules(draft, unified))
          setPhase(PRICING_STATE_READY)
        })
        return () => { alive = false }
      }, [loadAttempt])

      useEffect(() => () => {
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      }, [])

      const save = async () => {
        const isEmptySynthetic = (rule) => rule[DRAFT_SLOT] === syntheticGlobalRef.current
          && PRICE_KEYS.every((key) => rule.price[key] === '')
        const draft = rules.filter((rule) => !isEmptySynthetic(rule))
        const found = new Map([...validatePricingRules(draft)].map(([path, error]) => {
          const [index, ...suffix] = path.split('.')
          return [[draft[Number(index)][DRAFT_SLOT], ...suffix].join('.'), error]
        }))
        const defaults = new Map()
        for (const rule of draft) {
          const modelPath = `${rule[DRAFT_SLOT]}.model`
          if (rule.invalidProvider !== undefined) found.set(modelPath, 'pricing.providerSlash')
          if (rule.conditions?.length) continue
          const firstPath = defaults.get(rule.model)
          if (firstPath) {
            if (!found.has(firstPath)) found.set(firstPath, 'pricing.duplicateDefault')
            if (!found.has(modelPath)) found.set(modelPath, 'pricing.duplicateDefault')
          } else defaults.set(rule.model, modelPath)
        }
        if (draft.length && !draft.some(isPricingFallback)) {
          found.set('fallback', 'pricing.fallbackRequired')
        }
        setErrors(found)
        setSaved(false)
        setSaveError('')
        if (found.size > 0) return false
        const draftVersion = draftVersionRef.current
        setSaving(true)
        const result = await requestPost(ENDPOINTS.pricing, { rules: coercePricingRules(draft) })
        // 保存属于共享数据提交,编辑器退出后仍广播;局部状态只由存活实例更新。
        // 定价决定摘要条的币种与金额,写入后立即刷一次,不等节流窗口。
        if (result.ok && validPricing(result.value)) {
          applyPricingValue(result.value, true)
          hudRefresh({ force: true }).catch(() => {})
        }
        if (!aliveRef.current) return false
        setSaving(false)
        if (!result.ok || !validPricing(result.value)) {
          setSaveError(result.message || t('pricing.invalidResponse'))
          return false
        }
        // 保存期间用户继续编辑时不回写服务器规则,避免覆盖在飞输入;
        // 用户没有新编辑才把编辑副本同步为保存返回的规则
        const editedDuringSave = draftVersionRef.current !== draftVersion
        setSaveError('')
        if (editedDuringSave) {
          setSaved(false)
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
          return true
        }
        // 空表仍保留可见的未配置全局槽。
        const unified = aggregateCurrencyOf(result.value.rules) || currency
        const { draft: nextDraft, synthetic } = pricingDraftOf(result.value.rules, unified, allocateSlot)
        syntheticGlobalRef.current = synthetic
        setLoadedRules(result.value.rules)
        setErrors(new Map())
        setCurrency(unified)
        setRules(applyCurrencyToRules(nextDraft, unified))
        setSaved(true)
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setSaved(false), PRICING_SAVED_NOTICE_MS)
        return true
      }

      const currentRules = publishedRules ?? loadedRules ?? EMPTY_PRICING_ROWS
      const clockValue = formatDateTimeInput(new Date(now), timeZone)
      const moment = new PricingWallDate(`${snapshot || clockValue}Z`)
      const openEditRule = (index) => {
        const target = rules?.[index]
        if (!target) return
        setErrors(new Map())
        setSaveError('')
        setSaved(false)
        setRuleEditor({ slotId: target[DRAFT_SLOT], baseline: target, creating: false })
      }
      const openCreateRule = () => {
        const id = allocateSlot()
        const fresh = { ...defaultPricingRule(currency), [DRAFT_SLOT]: id }
        editRules((previous) => [...previous, fresh], true)
        setErrors(new Map())
        setSaveError('')
        setSaved(false)
        setRuleEditor({ slotId: id, baseline: fresh, creating: true })
      }
      const closeRuleEditor = () => {
        const editor = ruleEditor
        if (editor) {
          if (editor.creating) editRules((previous) => previous.filter((rule) => rule[DRAFT_SLOT] !== editor.slotId), true)
          else editRules((previous) => previous.map((rule) => rule[DRAFT_SLOT] === editor.slotId ? editor.baseline : rule), true)
        }
        setRuleEditor(null)
        setErrors(new Map())
        setSaveError('')
      }
      const activeRuleIndex = ruleEditor && rules ? rules.findIndex((rule) => rule[DRAFT_SLOT] === ruleEditor.slotId) : -1
      const activeRule = activeRuleIndex >= 0 ? rules[activeRuleIndex] : null
      const analysis = useMemo(() => open ? pricingSnapshotOf(currentRules, observed, moment) : null, [open, currentRules, observed, moment.getTime()])
      const status = phase === PRICING_STATE_UNAVAILABLE ? 'pricingUnavailable' : phase !== PRICING_STATE_READY ? 'pricing.loading' : null
      const tabList = h('div', { className: 'ud-group ud-pricing-tabs', role: 'tablist', 'aria-label': t('pricing.views') },
        PRICING_TABS.map((entry, index) => h('button', {
          key: entry.id, id: tabId(entry.id), type: 'button', role: 'tab', tabIndex: tab === entry.id ? 0 : -1,
          'aria-controls': panelId(entry.id), 'aria-selected': tab === entry.id,
          className: cx('ud-seg-item', tab === entry.id && 'ud-seg-item--on'),
          onClick: () => chooseTab(entry.id), onKeyDown: (event) => onTabKey(event, index),
        }, t(entry.labelKey))))
      const clock = h('div', { className: 'ud-pricing-clock', id: `${boardId}-clock`, hidden: !clockOpen },
        h('label', { className: 'ud-field' },
          h('span', { className: 'ud-field-label' }, t('pricing.localSnapshot', { zone: timeZone || t('pricing.localZone') })),
          h('input', {
            type: 'datetime-local', className: 'ud-input', value: snapshot || clockValue,
            onChange: (event) => { if (!event.target.value) setNow(Date.now()); setSnapshot(event.target.value) },
          })),
        h('button', { type: 'button', className: 'ud-btn', onClick: () => { setSnapshot(''); setNow(Date.now()) } }, t('pricing.backNow')))
      const clockLabel = snapshot ? `${t('pricing.snapshot')} · ${snapshot.replace('T', ' ')}` : t('pricing.localSnapshot', { zone: timeZone || t('pricing.localZone') })
      const clockToggle = h('div', { className: 'ud-group ud-pricing-clock-group' },
        h('button', {
          type: 'button', className: cx('ud-seg-item ud-pricing-clock-toggle', snapshot && 'ud-pricing-clock-toggle--active'),
          'aria-label': clockLabel, title: clockLabel,
          'aria-expanded': clockOpen, 'aria-controls': `${boardId}-clock`,
          onClick: () => { if (!snapshot) setNow(Date.now()); setClockOpen(!clockOpen) },
        }, h(Icon, { paths: ICONS.clock })))
      const currencyPicker = h('div', { className: 'ud-group', role: 'group', 'aria-label': t('pricingCurrency') },
        CURRENCIES.map((symbol) => h('button', {
          key: symbol, type: 'button',
          className: cx('ud-seg-item', currency === symbol && 'ud-seg-item--on'),
          'aria-pressed': currency === symbol,
          onClick: () => {
            setCurrency(symbol)
            editRules((previous) => applyCurrencyToRules(previous, symbol))
          },
        }, symbol)))
      const saveButton = h('button', { className: 'ud-btn ud-btn--primary', type: 'button', disabled: saving, onClick: save }, t('save'))
      const createButton = h('button', { type: 'button', className: 'ud-btn ud-pricing-create', onClick: openCreateRule },
        h(Icon, { paths: ICONS.plus }), t('pricing.createRule'))
      const controls = h('div', { className: 'ud-pricing-toolbar' },
        tabList,
        tab === 'rules' && !ruleEditor && !status ? createButton : null,
        tab === 'rules' && !ruleEditor && !status
          ? h('div', { className: 'ud-pricing-actions' },
            saved ? h('span', { className: 'ud-pref-desc', role: 'status' }, t('saved')) : null,
            clockToggle, currencyPicker, saveButton)
          : null)
      const clearAll = currentRules.length > 0 && rules?.some((rule) => !isPricingFallback(rule) || !syntheticGlobalRef.current)
        ? h('div', { className: 'ud-pricing-line ud-pricing-danger-zone' },
          h('span', { className: 'ud-pricing-danger-hint' }, t('pricing.disableHint')),
          h(DeleteArmedButton, {
            labelKey: 'pricing.disable', confirmKey: 'pricing.confirmDisable', showLabel: true, tone: 'danger', t,
            onConfirm: () => {
              const { draft, synthetic } = pricingDraftOf([], currency, allocateSlot)
              syntheticGlobalRef.current = synthetic
              setErrors(new Map())
              setSaveError('')
              setSaved(false)
              editRules(() => draft)
            },
          })) : null
      const listPanel = h('div', { className: 'ud-pricing-stack' },
        saveError || errors.size ? h('div', { className: 'ud-error', role: 'alert' }, saveError || t(errors.get('fallback') ?? 'pricing.validationSummary')) : null,
        h(PricingRules, {
          analysis, rules: rules ?? [], t, onEditRule: openEditRule,
          onJump: (model) => {
            pendingModelFocus.current = model
            setQuery(model)
            setSelectedModel(model)
            chooseTab('models')
          },
          footer: clearAll,
        }))
      const editorPanel = !status && activeRule ? h(PricingRuleForm, {
        rule: activeRule, index: activeRuleIndex, creating: Boolean(ruleEditor.creating),
        locked: isPricingFallback(ruleEditor.baseline), currency, errors, t, saving, saveError, actions, clockToggle, clock,
        onBack: closeRuleEditor,
        onSave: async () => { if (await save()) setRuleEditor(null) },
        onBatch: setBatchSource,
      }) : null
      const batchPanel = batchSource ? h(PricingBatch, {
        source: batchSource, rules, observed, moment, t, onClose: () => setBatchSource(null),
        onConfirm: (additions) => {
          const newRules = additions.map((candidate) => ({ ...candidate, [DRAFT_SLOT]: allocateSlot() }))
          editRules((previous) => {
            const existing = new Set(previous.map((rule) => rule.model))
            return [...previous, ...newRules.filter((candidate) => !existing.has(candidate.model))]
          }, true)
          setBatchSource(null)
        },
      }) : null
      const views = {
        models: analysis ? h(PricingModels, {
          analysis, rules: currentRules, moment, query,
          onQuery: setQuery, selectedModel, onSelect: setSelectedModel, clockToggle, clock, modelColors, t,
          onEdit: () => { if (!activeRule) openCreateRule(); chooseTab('rules', true) },
        }) : null,
        rules: analysis ? h(React.Fragment, null, editorPanel ?? listPanel, batchPanel) : null,
      }
      // 存量规则无法渲染时,重试只会重复失败:另给清空出口,走空表(等价未配置)自救。
      // 请求失败态不给该出口——那时原表可能完好,误清即不可恢复
      const resetPricing = async () => {
        setPhase(null)
        setSaveError('')
        const result = await requestPost(ENDPOINTS.pricing, { rules: [] })
        if (!aliveRef.current) return
        if (!result.ok || !validPricing(result.value)) {
          setSaveError(result.message || t('pricing.invalidResponse'))
          setFailure('transport')
          setPhase(PRICING_STATE_UNAVAILABLE)
          return
        }
        // 直接用写回的空表进入可用态,不再二次取价
        const unified = aggregateCurrencyOf(result.value.rules) || CURRENCIES[0]
        const { draft, synthetic } = pricingDraftOf(result.value.rules, unified, allocateSlot)
        syntheticGlobalRef.current = synthetic
        setFailure(null)
        setLoadedRules(result.value.rules)
        setCurrency(unified)
        setRules(applyCurrencyToRules(draft, unified))
        setErrors(new Map())
        setPhase(PRICING_STATE_READY)
        applyPricingValue(result.value, true)
        hudRefresh({ force: true }).catch(() => {})
      }
      return h('div', { className: 'ud-pricing-board', ref: boardRef }, controls,
        tab === 'rules' && !ruleEditor ? clock : null,
        PRICING_TABS.map((entry) => h('div', {
          key: entry.id, id: panelId(entry.id), role: 'tabpanel', 'aria-labelledby': tabId(entry.id), tabIndex: 0, hidden: tab !== entry.id,
        }, tab !== entry.id ? null : status ? h('div', { className: 'ud-empty' },
          h('p', { role: 'status' }, t(status)),
          phase === PRICING_STATE_UNAVAILABLE ? h('div', { className: 'ud-pricing-line' },
            h('button', {
              className: 'ud-btn', type: 'button', onClick: () => { setPhase(null); setLoadAttempt((attempt) => attempt + 1) },
            }, t('pricing.retry')),
            failure === 'invalid' ? h(DeleteArmedButton, {
              labelKey: 'pricing.reset', confirmKey: 'pricing.confirmReset', showLabel: true, tone: 'danger', t, onConfirm: resetPricing,
            }) : null) : null,
          saveError ? h('p', { className: 'ud-error', role: 'alert' }, saveError) : null) : views[entry.id])))
    }

    // 定价规则折叠区:编辑器保持挂载以保留草稿,折叠只隐藏 body
    function PricingSection({ rules = null, observed, timeZone, modelColors, t = defaultT }) {
      const [open, setOpen] = useState(false)
      const summary = !Array.isArray(rules) ? undefined
        : rules.length > 0 ? t('pricingRuleCount', { n: rules.length }) : t('pricingNotConfigured')
      return h(SectionFold, {
        title: t('pricing'),
        description: t('pricingSectionDesc'),
        summary,
        open,
        onToggle: () => setOpen((value) => !value),
      }, h(PricingEditor, { t, open, publishedRules: rules, observed, timeZone, modelColors }))
    }

    // 扫描异常日志入口:仅箭头标识,明细在展开的日志块中展示;
    // 折叠且有待读信息时箭头带小点,展开后消失
    function AnomalyChip({ open, news, onToggle, t = defaultT }) {
      return h('button', {
        type: 'button', className: 'ud-status-fold', 'aria-expanded': open,
        'aria-label': t('anomalyLog'), title: t('anomalyLog'),
        onClick: onToggle,
      },
      h('span', { className: 'ud-status-fold-caret', 'aria-hidden': 'true' }),
      news && !open ? h('span', { className: 'ud-status-fold-dot', 'aria-hidden': 'true' }) : null)
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
            ? h(HintText, { text: breakdownText }, t('skippedSessions', { n: status.skippedSessions }))
            : null,
          (status.recordFailures ?? 0) > 0
            ? h('span', { className: 'ud-status-err' }, t('recordFailures', { n: status.recordFailures }))
            : null),
        lines.map((entry, index) => h('div', { className: 'ud-log-line', key: index },
          h('span', { className: 'ud-log-time' }, logTimeOf(entry.time)),
          h('span', { className: cx('ud-log-kind', entry.kind === 'record' && 'ud-log-err') },
            entry.kind === 'record' ? t('logKindRecord') : t('logKindSkipped')),
          h(HintText, { className: 'ud-log-detail', text: entry.detail }, entry.detail))))
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
    const trendCostTitle = (t, id) => (id === 'day' ? t('dailyCostTrend') : id === 'hour' ? t('hourCostTrend') : t('minuteCostTrend'))
    const trendLimitedText = (t, id, count) => (id === 'day'
      ? t('trendLimited', { n: count })
      : id === 'hour' ? t('trendLimitedHour', { n: count }) : t('trendLimitedMinute', { n: count }))
    const presetLabel = (t, view, id) => t(`${view === 'hour' ? 'hourPreset' : 'minutePreset'}.${id}`)
    const tickLabelFor = (view) => (view === 'day' ? shortDay : view === 'hour' ? hourTickLabel : minuteTickLabel)
    const slotLabelFor = (view) => (view === 'hour' ? hourSlotLabel : view === 'minute' ? minuteSlotLabel : (day) => day)

    function UsageDashPanel({ t = defaultT }) {
      const [view, setView] = useState('day')
      // 趋势图金额口径开关:会话态,与视图/挡位同为面板内临时状态
      const [costView, setCostView] = useState(false)
      // 跨组件悬浮联动:图例/模型行/扇区悬停时趋势图同模型柱段保持高亮,其余降透明
      const [hoverModel, setHoverModel] = useState(null)
      const [range, setRange] = useState(DEFAULT_RANGE)
      const [customFrom, setCustomFrom] = useState('')
      const [customTo, setCustomTo] = useState('')
      const [stats, setStats] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [hourPreset, setHourPreset] = useState(DEFAULT_HOUR_PRESET)
      const [minutePreset, setMinutePreset] = useState(DEFAULT_MINUTE_PRESET)
      // 自定义挡 datetime 输入,时/分视图共享一对,各视图按桶粒度分别归一
      const [pointCustomFrom, setPointCustomFrom] = useState('')
      const [pointCustomTo, setPointCustomTo] = useState('')
      const [pointStats, setPointStats] = useState(null)
      const [pointStatus, setPointStatus] = useState('idle')
      const [fetchTick, setFetchTick] = useState(0)
      const [status, setStatus] = useState(null)
      // 宿主 IANA 时区:桶键按宿主日历聚合,面板范围生成必须同源;
      // 首帧先用浏览器时区(与本机宿主通常一致,避免重复请求),status 到达后对齐
      const [serverTimeZone, setServerTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || null)
      const [detailsOpen, setDetailsOpen] = useState(false)
      const statusMachineRef = useRef(null)
      const generationRef = useRef(0)
      const pointGenerationRef = useRef(0)
      const heatGenerationRef = useRef(0)
      const [heatDays, setHeatDays] = useState(null)
      // 热力图重取信号(F23):手动刷新/回扫完成即 bump,独立请求随之重取
      const [heatFetchTick, setHeatFetchTick] = useState(0)
      const bumpHeatFetch = () => setHeatFetchTick((tick) => tick + 1)
      // 费用展示货币来源:价格规则异步首帧未回时空串即不带符号
      const { rules: pricingRules, tick: pricingTick } = usePricing()

      const costCurrency = aggregateCurrencyOf(pricingRules)

      // 聚合/状态响应均携带宿主时区:任一到达即校正,status 失败时也能自愈
      const adoptValueTimeZone = (value) => {
        const zone = value && value.timeZone
        if (typeof zone !== 'string' || zone.length === 0) return
        setServerTimeZone((previous) => (previous === zone ? previous : zone))
      }

      // 热力图独立请求:范围切换不重取,价格变更重算费用,过期响应丢弃
      useEffect(() => {
        const generation = ++heatGenerationRef.current
        const request = {
          from: localDay(-(HEAT_WINDOW_DAYS - 1), new Date(), serverTimeZone),
          to: localDay(0, new Date(), serverTimeZone),
        }
        requestPost(ENDPOINTS.range, request).then((result) => {
          if (heatGenerationRef.current !== generation || !result.ok) return
          adoptValueTimeZone(result.value)
          const byDay = new Map(result.value.daily.map((slot) => [slot.day, slot]))
          setHeatDays(daysInRange(request.from, request.to).map((day) => {
            const slot = byDay.get(day)
            return {
              day,
              tokens: slot ? slot.total : 0,
              requests: slot ? slot.requests : 0,
              cacheHit: slot ? slot.cacheHit : 0,
              cacheMiss: slot ? slot.cacheMiss : 0,
              cost: slot ? slot.cost : 0,
            }
          }))
        })
        return () => { heatGenerationRef.current++ }
      }, [pricingTick, heatFetchTick, serverTimeZone])

      const load = useCallback(async () => {
        const request = range === 'custom'
          ? { from: customFrom, to: customTo }
          : resolveDayRange(range, new Date(), serverTimeZone)
        // 不完整范围:先取消在飞请求并复位 loading,否则首屏请求的 loading
        // 会被本次提前 return 继承,刷新按钮/骨架永久卡住
        if (!request || !request.from || !request.to) {
          generationRef.current += 1
          setLoading(false)
          setStats(null)
          setError('')
          return
        }
        const generation = ++generationRef.current
        setLoading(true)
        const result = await requestPost(ENDPOINTS.range, request)
        if (generationRef.current !== generation) return
        setLoading(false)
        if (!result.ok) {
          setError(result.message)
          return
        }
        adoptValueTimeZone(result.value)
        setError('')
        setStats(result.value)
      }, [range, customFrom, customTo, pricingTick, serverTimeZone])

      useEffect(() => {
        load()
        return () => { generationRef.current++ }
      }, [load])

      const rawPreset = view === 'hour' ? hourPreset : view === 'minute' ? minutePreset : null
      // 自定义挡输入不完整时 query 为 null:不发请求,已取数据留存缓存,输入恢复即按键命中
      const activeQuery = view === 'day' ? null : resolvePointQuery(view, rawPreset, pointCustomFrom, pointCustomTo, new Date(), serverTimeZone)

      useEffect(() => {
        if (!activeQuery) {
          pointGenerationRef.current += 1
          setPointStatus('idle')
          return
        }
        if (
          pointStatsMatches(pointStats, view, activeQuery.key, activeQuery.timeZone)
          && pointStats.pricingTick === pricingTick
        ) return
        const generation = ++pointGenerationRef.current
        setPointStatus('loading')
        requestPost(view === 'hour' ? ENDPOINTS.hours : ENDPOINTS.minutes, activeQuery.request).then((result) => {
          if (pointGenerationRef.current !== generation) return
          if (!result.ok) {
            setPointStatus('error')
            setError(result.message)
            return
          }
          adoptValueTimeZone(result.value)
          setError('')
          setPointStatus('ok')
          setPointStats({
            view,
            preset: activeQuery.key,
            timeZone: activeQuery.timeZone,
            pricingTick,
            value: result.value,
          })
        })
        return () => { pointGenerationRef.current++ }
      }, [view, rawPreset, pointCustomFrom, pointCustomTo, fetchTick, pricingTick, serverTimeZone])

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

      // 切换时/分挡位;切到自定义挡且无历史输入时预填最近窗口,即点即用
      const selectPointPreset = (id) => {
        if (id === CUSTOM_RANGE_ID && !pointCustomFrom && !pointCustomTo) {
          setPointCustomFrom(formatDateTimeInput(new Date(Date.now() - POINT_CUSTOM_DEFAULT_HOURS * MS_PER_HOUR), serverTimeZone))
          setPointCustomTo(formatDateTimeInput(new Date(), serverTimeZone))
        }
        if (view === 'hour') setHourPreset(id)
        else setMinutePreset(id)
      }

      const refresh = () => {
        setError('')
        // 手动刷新同触热力图重取(F23):重建后热力图口径随日桶更新,
        // 独立请求此前只随挂载/价格变更重取,重建产物不进热力图
        bumpHeatFetch()
        if (view === 'day') load()
        else refreshPoints()
      }

      // 回扫状态轮询:仅 running 时续 1s 快轮;空闲即停链。失败按指数退避续排,
      // 并清掉冻结的 running 态(重建/回退按钮按 running 禁用,一次失败不得永久锁死)。
      // running 失败视为回扫未结束,持续退避自愈;空闲失败只允许有限次后退避停链。
      // 隐藏页不续排任何轮(在途响应到达也丢弃),恢复可见时补一次状态检查。
      useEffect(() => {
        let timer = null
        let inFlight = false
        let alive = true
        let baseDone = null
        let wasRunning = false
        let idleFailures = 0
        let retryDelay = STATUS_POLL_RETRY_BASE_MS
        const hidden = () => document.visibilityState === 'hidden'
        const schedule = (delay) => {
          if (!alive || hidden()) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(tick, delay)
        }
        const tick = async () => {
          // 可见性切换可能让 onVisibility 与在途响应重入,同一时刻只允许一次状态请求
          if (inFlight) return
          inFlight = true
          try {
            timer = null
            const result = await requestPost(ENDPOINTS.status)
            if (!alive) return
            // 隐藏期间回来的结果一律不消费也不续排;恢复可见时重新探测,
            // 避免后台每秒轮询和隐藏页收尾刷新
            if (hidden()) return
            if (!result.ok) {
              // 失败:先清冻结的运行态,再决定续排;不能裸 return,否则 running
              // 态会永久锁死收尾刷新/热力图,按钮也停在被禁用的 running:true
              setStatus((previous) => (
                previous && previous.running === true ? { ...previous, running: false } : previous
              ))
              if (wasRunning) {
                // 回扫中失败:保持自愈续排,直到观察到空闲收尾
                const delay = retryDelay
                retryDelay = Math.min(retryDelay * 2, STATUS_POLL_RETRY_MAX_MS)
                schedule(delay)
                return
              }
              // 空闲态失败:有限次退避后停链,避免无运行态时永久 60s 轮询
              idleFailures += 1
              if (idleFailures >= STATUS_POLL_IDLE_FAILURE_LIMIT) return
              const delay = retryDelay
              retryDelay = Math.min(retryDelay * 2, STATUS_POLL_RETRY_MAX_MS)
              schedule(delay)
              return
            }
            retryDelay = STATUS_POLL_RETRY_BASE_MS
            idleFailures = 0
            const value = result.value
            setStatus(value)
            // 宿主时区随状态快照下发:与浏览器不同时,范围相关 effect 会按新时区重算并重取
            adoptValueTimeZone(value)
            if (!value.running) {
              // running→idle 转换补最终刷新(F23):reset/restore 同步等回扫,响应时 running
              // 已 false、done 增长分支不触发,收尾靠此分支。空闲不再续轮,链到此为止
              if (wasRunning) {
                wasRunning = false
                scheduleRefresh()
                bumpHeatFetch()
              }
              return
            }
            if (baseDone === null || value.done < baseDone) baseDone = value.done
            else if (value.done > baseDone) {
              baseDone = value.done
              scheduleRefresh()
            }
            wasRunning = true
            schedule(STATUS_POLL_FAST_MS)
          } finally {
            inFlight = false
          }
        }
        const onVisibility = () => {
          if (hidden()) {
            if (timer) {
              clearTimeout(timer)
              timer = null
            }
            return
          }
          if (timer === null) void tick()
        }
        document.addEventListener?.('visibilitychange', onVisibility)
        if (!hidden()) tick()
        // 重启入口:置 wasRunning 让首个 tick 走收尾分支(补刷新 + 重取热力图),
        // baseDone 归零避免回扫产物计入增量判定
        statusMachineRef.current = { restart: () => { baseDone = 0; wasRunning = true; schedule(STATUS_POLL_FAST_MS) } }
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          document.removeEventListener?.('visibilitychange', onVisibility)
          statusMachineRef.current = null
        }
      }, [])

      const grouped = useMemo(() => (stats ? groupStats(stats) : null), [stats])
      const pointView = activeQuery && pointStatsMatches(pointStats, view, activeQuery.key, activeQuery.timeZone) ? pointStats.value : null
      const pointGrouped = useMemo(() => (pointView ? groupPointSlots(pointView.daily) : null), [pointView])

      const pointActive = view !== 'day'
      const trendSource = pointActive
        ? (pointGrouped ? { slots: pointGrouped.daily, models: pointGrouped.models, value: pointView } : null)
        : (grouped ? { slots: grouped.daily, models: grouped.models, value: stats } : null)
      // 聚合展示区(统计卡/模型用量/统计截至)与趋势图同源,随视图联动;点数据未回为 null 不渲染
      const cardsStats = cardsStatsOf(view, stats, pointView)
      const usageModels = usageModelsOf(view, grouped, pointView)
      // 模型配色取当期窗口模型排名,防跨窗口取色错位
      const colorFor = useMemo(() => colorForModel(cardsStats ? cardsStats.models : []), [cardsStats])
      const modelColors = useMemo(() => new Map((usageModels ?? []).map(({ model }) => [model, colorFor(model)])), [usageModels, colorFor])
      const maxSlots = pointActive ? maxSlotsFor(view, rawPreset) : DAY_MAX_SLOTS
      const trimmedSlots = trendSource ? trimSlots(trendSource.slots, maxSlots) : null
      const { costReady, money, chartSlots } = moneyViewOf(trimmedSlots, costView)
      const notes = []
      if (trendSource && trendSource.slots.length > trimmedSlots.length) notes.push(trendLimitedText(t, view, trimmedSlots.length))
      if (trendSource?.value?.truncated) notes.push(t('trendTruncated'))

      const busy = pointActive ? pointStatus === 'loading' : loading
      const loadingVisible = pointActive ? pointStatus === 'loading' && !pointView : loading && !stats
      const emptyVisible = !error && (pointActive ? pointView && isEmptyRange(pointView) : stats && isEmptyRange(stats))

      return h('div', { className: 'ud-panel' },
        h('header', { className: 'ud-section-page-head' },
          h('h2', { className: 'ud-section-page-title' }, t('nav')),
          h('p', { className: 'ud-section-page-desc' }, t('sectionDesc'))),
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
              ? h(React.Fragment, null,
                  h('div', { className: 'ud-group', role: 'group', 'aria-label': t('range') },
                    (view === 'hour' ? HOUR_PRESETS : MINUTE_PRESETS).map((id) => h('button', {
                      key: id,
                      className: cx('ud-seg-item', rawPreset === id && 'ud-seg-item--on'),
                      'aria-pressed': rawPreset === id,
                      onClick: () => selectPointPreset(id),
                    }, presetLabel(t, view, id))),
                    h('button', {
                      className: cx('ud-seg-item', rawPreset === CUSTOM_RANGE_ID && 'ud-seg-item--on'),
                      'aria-pressed': rawPreset === CUSTOM_RANGE_ID,
                      onClick: () => selectPointPreset(CUSTOM_RANGE_ID),
                    }, t('rangeCustom'))),
                  rawPreset === CUSTOM_RANGE_ID
                    ? h('div', { className: 'ud-custom-range' },
                        h('input', {
                          type: 'datetime-local', className: 'ud-date-input', 'aria-label': t('from'),
                          value: pointCustomFrom, max: pointCustomTo || undefined,
                          onChange: (event) => setPointCustomFrom(event.target.value),
                        }),
                        h('span', { className: 'ud-custom-sep' }, '–'),
                        h('input', {
                          type: 'datetime-local', className: 'ud-date-input', 'aria-label': t('to'),
                          value: pointCustomTo, min: pointCustomFrom || undefined, max: formatDateTimeInput(new Date(), serverTimeZone),
                          onChange: (event) => setPointCustomTo(event.target.value),
                        }))
                    : null)
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
                          value: customTo, min: customFrom || undefined, max: dayBucket(new Date(), serverTimeZone),
                          onChange: (event) => setCustomTo(event.target.value),
                        }))
                    : null)),
          h('div', { className: 'ud-toolbar-side' },
            h(AnomalyChip, { open: detailsOpen, news: hasAnomalyNews(status), onToggle: () => setDetailsOpen((v) => !v), t }),
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
        loadingVisible ? h('div', { className: 'ud-loading', role: 'status', 'aria-busy': 'true', 'aria-label': t('loading') }) : null,
        cardsStats ? h(StatCards, { key: 'cards', stats: cardsStats, costCurrency, t }) : null,
        // 空范围只留一处说明:图表与模型榜在无数据时不渲染,避免空坐标系与空环
        emptyVisible ? h('div', { className: 'ud-empty' }, t('empty')) : null,
        // 活跃热力图仅按天视图展示:热力图口径为日桶,时/分视图无对应语义
        !emptyVisible && view === 'day' ? h(HeatSection, { key: 'heat', days: heatDays, costCurrency, t }) : null,
        !emptyVisible && trimmedSlots
          ? h(TrendChart, {
              key: 'trend',
              title: money ? trendCostTitle(t, view) : trendTitle(t, view),
              notes,
              slots: chartSlots,
              tipSlots: trimmedSlots,
              modelOrder: trendSource.models.map((item) => item.model),
              colorFor,
              labelFor: tickLabelFor(view),
              slotLabelFor: slotLabelFor(view),
              labelMinPitch: pointActive ? LABEL_PITCH_TIME : LABEL_PITCH_DAY,
              busy,
              legendModels: trendSource.models,
              costCurrency,
              money,
              costAvailable: costReady,
              onMetricToggle: setCostView,
              activeModel: hoverModel,
              onHoverModel: setHoverModel,
              t,
            })
          : null,
        !emptyVisible && usageModels ? h(ModelUsage, { key: 'models', models: usageModels, colorFor, costCurrency, t, onHoverModel: setHoverModel }) : null,
        cardsStats?.to ? h('div', { className: 'ud-foot' }, `${t('asOf')} ${slotLabelFor(view)(cardsStats.to)}`) : null,
        h('div', { className: 'ud-settings-stack' },
          h(StatsLineOptions, { key: 'prefs', t }),
          h(PricingSection, { key: 'pricing', t, rules: pricingRules, observed: cardsStats?.models, timeZone: serverTimeZone, modelColors }),
          // 成本控制四卡:用量摘要 / 成本护栏 / 异常哨兵 / 省钱沙盘(沙盘用得少,排在最后)
          h(HudSummarySection, { key: 'hud', t }),
          h(GuardSection, { key: 'guard', t }),
          h(SentinelSection, { key: 'sentinel', t }),
          h(WhatIfSection, { key: 'whatif', t })))
    }

    // —— 成本控制四模块:设置页内三张卡由面板统一渲染,HUD 走自己的 slot ——

    // —— 省钱沙盘卡:折叠态默认收起,标题汇总可省建议数;展开后按当前定价只读模拟 ——
    const WHATIF_DAY_OPTIONS = [30, 90]
    const WHATIF_DEFAULT_TARGET_HIT_RATE = 0.8
    const WHATIF_DEFAULT_SHIFT_RATIO = 0.3
    const WHATIF_FETCH_DELAY_MS = 400

    const WHATIF_REASON_KEYS = {
      empty: 'whatif.reason.empty',
      unpricedModels: 'whatif.reason.unpricedModels',
      targetModelRequired: 'whatif.reason.targetModelRequired',
      targetModelUnpriced: 'whatif.reason.targetModelUnpriced',
      offpeakUnpriced: 'whatif.reason.offpeakUnpriced',
      offpeakNoDifferential: 'whatif.reason.offpeakNoDifferential',
    }

    // 比例展示:整数省小数位,非整数保留一位;负数符号由调用方按差额方向给出
    const whatIfPercentText = (value) => {
      if (!Number.isFinite(value)) return '0'
      const percent = Math.round(value * 1000) / 10
      return Number.isInteger(percent) ? String(percent) : percent.toFixed(1)
    }

    const whatIfSignedMoney = (value, currency) => {
      if (value === 0) return formatCost(0, currency)
      return `${value < 0 ? '-' : '+'}${formatCost(Math.abs(value), currency)}`
    }

    const whatIfSignedPercent = (value) => {
      const sign = value < 0 ? '-' : '+'
      return `${sign}${whatIfPercentText(Math.abs(value))}%`
    }

    const whatIfReasonText = (detail, t) => {
      const key = detail && WHATIF_REASON_KEYS[detail.code]
      if (!key) return ''
      const models = Array.isArray(detail.models) ? detail.models : []
      return t(key, {
        models: models.join(', '),
        model: detail.model ?? '',
      })
    }

    const whatIfDetailText = (scenario, t) => {
      const detail = scenario.detail ?? {}
      if (scenario.id === 'model-swap') {
        return t('whatif.detail.targetModel', { model: detail.targetModel ?? '' })
      }
      if (scenario.id === 'cache-leverage') {
        return t('whatif.detail.hitRate', { rate: whatIfPercentText(detail.targetHitRate) })
      }
      return t('whatif.detail.shift', { ratio: whatIfPercentText(detail.shiftRatio) })
    }

    function WhatIfRow({ scenario, baseline, currency, t = defaultT }) {
      const ok = scenario.status === 'ok'
      const detailText = ok ? whatIfDetailText(scenario, t) : whatIfReasonText(scenario.detail, t)
      const deltaClass = scenario.delta < 0 ? 'ud-whatif-delta--save' : 'ud-whatif-delta--cost'
      const ratioText = scenario.ratio === null ? '' : ` (${whatIfSignedPercent(scenario.ratio)})`
      return h('div', { className: 'ud-whatif-row' },
        h('span', { className: 'ud-whatif-name' }, t(scenario.label)),
        detailText ? h('span', { className: 'ud-whatif-detail', title: detailText }, detailText) : null,
        ok
          ? h(React.Fragment, null,
              h('span', { className: 'ud-whatif-flow' }, t('whatif.costFlow', {
                baseline: formatCost(baseline ?? 0, currency),
                scenario: formatCost(scenario.cost, currency),
              })),
              h('span', { className: cx('ud-whatif-delta', deltaClass) },
                `${whatIfSignedMoney(scenario.delta, currency)}${ratioText}`))
          : h('span', { className: 'ud-whatif-unavailable' },
              `${COST_PLACEHOLDER} ${detailText}`.trim()))
    }

    // —— 四模块开关:模块级单源 + 监听,设置页各卡与摘要面板共用同一份读数 ——
    let featuresValue = null
    const featuresListeners = new Set()

    const featuresOf = () => featuresValue ?? FEATURES_DEFAULT

    const featuresNotify = () => {
      for (const listener of featuresListeners) listener(featuresOf())
    }

    // 单一写入点:请求结果与本地切换都经这里落到模块级读数
    const applyFeatures = (next) => {
      featuresValue = { ...FEATURES_DEFAULT, ...next }
      featuresNotify()
    }

    // 同一时刻只跑一次:设置页里多个组件同时挂载时共用在途请求。
    // GET 与 POST 会并发落地,只让更新的那次结果生效,否则慢 GET 会把刚保存的开关刷回旧值
    let featuresFlight = null
    let featuresRequestSeq = 0
    let featuresAppliedSeq = 0
    function fetchFeatures() {
      if (featuresFlight !== null) return featuresFlight
      const seq = ++featuresRequestSeq
      featuresFlight = (async () => {
        const result = await requestGet(COST_ENDPOINTS.features)
        if (result.ok && result.value && typeof result.value.features === 'object' && seq > featuresAppliedSeq) {
          featuresAppliedSeq = seq
          applyFeatures(result.value.features)
        }
        return featuresOf()
      })().finally(() => { featuresFlight = null })
      return featuresFlight
    }

    function useFeatures() {
      const [value, setValue] = useState(featuresOf)
      useEffect(() => {
        const listener = (next) => setValue(next)
        featuresListeners.add(listener)
        if (featuresValue !== null) listener(featuresValue)
        void fetchFeatures().catch(() => {})
        return () => featuresListeners.delete(listener)
      }, [])
      return value
    }

    // 单键切换按全量提交:宿主 schema 要求四键齐全。连续点两个开关时,后一次若仍读
    // 同一份旧值就会把前一次的改动覆盖掉,所以写入串成一条链,每次都基于最新状态。
    let featureWriteChain = Promise.resolve()
    async function toggleFeature(key, enabled) {
      const write = async () => {
        const next = { ...featuresOf(), [key]: enabled === true }
        const result = await requestPost(COST_ENDPOINTS.features, { features: next })
        if (!result.ok) return false
        // 写响应就是本次写入的权威结果:后发起的 GET 可能读的是写之前的旧值,
        // 不能让它把刚保存的开关刷回去,所以这里无条件落地并顶掉在飞的读
        featuresAppliedSeq = ++featuresRequestSeq
        applyFeatures(result.value?.features ?? next)
        return true
      }
      featureWriteChain = featureWriteChain.then(write, write)
      return featureWriteChain
    }

    // 开关写失败(宿主设置服务不可用等)必须可见:否则用户只看到开关自己弹回去
    function useFeatureToggle(t) {
      const [failure, setFailure] = useState('')
      const toggle = (key, enabled) => toggleFeature(key, enabled).then((ok) => {
        setFailure(ok ? '' : t('featureToggleFailed'))
        return ok
      })
      return [failure, toggle]
    }

    function WhatIfSection({ t = defaultT }) {
      const { rules } = usePricing()
      const features = useFeatures()
      const [toggleFailure, toggle] = useFeatureToggle(t)
      const enabled = features.whatif
      const [open, setOpen] = useState(false)
      const [days, setDays] = useState(WHATIF_DAY_OPTIONS[0])
      const [targetModel, setTargetModel] = useState('')
      const [remote, setRemote] = useState({ status: 'idle', value: null, error: '' })
      const modelInputId = React.useId()
      const rulesReady = Array.isArray(rules)
      const hasRules = rulesReady && rules.length > 0
      const trimmedModel = targetModel.trim()
      const modelInvalid = trimmedModel !== '' && !isTwoSegmentModel(trimmedModel)
      const queryModel = modelInvalid ? '' : trimmedModel
      const scenarios = Array.isArray(remote.value?.scenarios) ? remote.value.scenarios : null
      const suggestions = scenarios === null
        ? 0
        : scenarios.filter((scenario) => scenario.status === 'ok' && scenario.delta < 0).length
      const allEmpty = scenarios !== null && scenarios.every((scenario) => scenario.status === 'empty')
      const currency = aggregateCurrencyOf(rules)
        || (typeof remote.value?.currency === 'string' ? remote.value.currency : '')

      useEffect(() => {
        if (!enabled || !hasRules || modelInvalid) return undefined
        let alive = true
        const timer = setTimeout(() => {
          setRemote((previous) => ({ ...previous, status: 'loading' }))
          const query = `?days=${days}&targetModel=${encodeURIComponent(queryModel)}`
            + `&targetHitRate=${WHATIF_DEFAULT_TARGET_HIT_RATE}&shiftRatio=${WHATIF_DEFAULT_SHIFT_RATIO}`
          // 沙盘只读:GET + 查询串
          void requestGet(COST_ENDPOINTS.whatif + query).then((result) => {
            if (!alive) return
            if (!result.ok || !Array.isArray(result.value?.scenarios)) {
              setRemote({ status: 'error', value: null, error: result.message ?? '' })
              return
            }
            setRemote({ status: 'ready', value: result.value, error: '' })
          })
        }, WHATIF_FETCH_DELAY_MS)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [enabled, hasRules, modelInvalid, days, queryModel, rules])

      const summary = !enabled
        ? t('featureOff')
        : !rulesReady
        ? ''
        : !hasRules
          ? t('whatif.noPricing')
          : scenarios === null
            ? ''
            : t('whatif.suggestionCount', { n: suggestions })

      const toolbar = h('div', { className: 'ud-whatif-toolbar' },
        h('div', { className: 'ud-whatif-field' },
          h('span', { className: 'ud-whatif-label' }, t('whatif.days')),
          h('div', { className: 'ud-group', role: 'group', 'aria-label': t('whatif.days') },
            WHATIF_DAY_OPTIONS.map((value) => h('button', {
              key: value,
              type: 'button',
              className: cx('ud-seg-item', days === value && 'ud-seg-item--on'),
              'aria-pressed': days === value,
              onClick: () => setDays(value),
            }, t(`whatif.days.${value}`))))),
        h('div', { className: 'ud-whatif-field' },
          h('label', { className: 'ud-whatif-label', htmlFor: modelInputId }, t('whatif.targetModel')),
          h('input', {
            id: modelInputId,
            type: 'text',
            className: cx('ud-whatif-input', modelInvalid && 'ud-whatif-input--invalid'),
            value: targetModel,
            placeholder: t('whatif.targetModelPlaceholder'),
            'aria-invalid': modelInvalid,
            onChange: (event) => setTargetModel(event.target.value),
          }),
          modelInvalid
            ? h('span', { className: 'ud-whatif-error-text' }, t('whatif.invalidModel'))
            : h('span', { className: 'ud-whatif-hint' }, t('whatif.targetModelHint'))))

      let body = null
      if (!enabled) {
        body = h('div', { className: 'ud-empty' }, t('featureDisabledHint'))
      } else if (!rulesReady) {
        body = h('div', { className: 'ud-whatif-loading' }, t('whatif.rulesLoading'))
      } else if (!hasRules) {
        body = h('div', { className: 'ud-empty' }, t('whatif.noPricingHint'))
      } else {
        body = h(React.Fragment, null,
          toolbar,
          remote.status === 'error'
            ? h('div', { className: 'ud-error' }, remote.error || t('whatif.error'))
            : remote.status !== 'ready' || scenarios === null
              ? h('div', { className: 'ud-whatif-loading' }, t('whatif.loading'))
              : allEmpty
                ? h('div', { className: 'ud-empty' }, t('whatif.empty'))
                : h('div', { className: 'ud-whatif-list' },
                    scenarios.map((scenario) => h(WhatIfRow, {
                      key: scenario.id,
                      scenario,
                      baseline: remote.value?.baseline,
                      currency,
                      t,
                    }))))
      }

      return h(SectionFold, {
        title: t('whatif.title'),
        description: t('whatif.description'),
        summary,
        open,
        onToggle: () => setOpen((value) => !value),
      }, h(React.Fragment, null,
        h(StatsLineOptionRow, {
          labelKey: 'whatifEnable', descKey: 'whatifEnableDesc',
          checked: enabled, onToggle: (value) => { void toggle('whatif', value) }, t,
        }),
        toggleFailure ? h('div', { className: 'ud-error' }, toggleFailure) : null,
        body))
    }

    // 成本护栏设置卡:预算配置读写 /budget,状态行读同端点的 status(宿主 budget 读数)
    function GuardSection({ t = defaultT }) {
      const { rules: pricingRules } = usePricing()
      const currency = aggregateCurrencyOf(pricingRules) || CURRENCIES[0]
      const [toggleFailure, toggle] = useFeatureToggle(t)
      const [open, setOpen] = useState(false)
      const [loaded, setLoaded] = useState(false)
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState(null)
      const [errors, setErrors] = useState({})
      const [saving, setSaving] = useState(false)
      const [saved, setSaved] = useState(false)
      const [failure, setFailure] = useState('')
      const aliveRef = useRef(true)
      const savedTimerRef = useRef(null)
      const GUARD_ACTIONS = ['warn', 'degrade', 'block']
      const GUARD_ACTION_LABELS = { warn: 'guardActionWarn', degrade: 'guardActionDegrade', block: 'guardActionBlock' }
      const GUARD_STATE_LABELS = { ok: 'guardStateOk', warn: 'guardStateWarn', danger: 'guardStateDanger', off: 'guardStateOff' }
      const features = useFeatures()
      // 摘要快照里的预算评估与 /budget 同源:周期改了要靠它把 spent / 剩余 / ETA 带过来
      const snapshot = useHudSnapshot()
      const GUARD_DEFAULT_WARN_RATIO = 0.8
      const GUARD_SAVED_NOTICE_MS = 3 * 1000
      const PERCENT_SCALE = 100
      const PERCENT_TEXT_DECIMALS = 2

      // 限额原值呈现(0 即该档未启用);阈值按百分比呈现
      const limitText = (value) => String(Number.isFinite(value) ? value : 0)
      const percentText = (ratio) => (Number.isFinite(ratio) && ratio > 0
        ? String(Number((ratio * PERCENT_SCALE).toFixed(PERCENT_TEXT_DECIMALS)))
        : '')

      const normalizeConfig = (raw) => {
        const scopeOf = (scope) => ({
          limit: Number.isFinite(scope?.limit) && scope.limit > 0 ? scope.limit : 0,
          action: GUARD_ACTIONS.includes(scope?.action) ? scope.action : GUARD_ACTIONS[0],
        })
        return {
          warnRatio: Number.isFinite(raw?.warnRatio) && raw.warnRatio > 0 && raw.warnRatio < 1
            ? raw.warnRatio
            : GUARD_DEFAULT_WARN_RATIO,
          daily: scopeOf(raw?.daily),
          monthly: scopeOf(raw?.monthly),
          degradeModel: typeof raw?.degradeModel === 'string' ? raw.degradeModel : '',
          notify: raw?.notify !== false,
        }
      }
      const draftOf = (value) => ({
        dailyLimit: limitText(value.daily.limit),
        dailyAction: value.daily.action,
        monthlyLimit: limitText(value.monthly.limit),
        monthlyAction: value.monthly.action,
        degradeModel: value.degradeModel,
        warnPercent: percentText(value.warnRatio),
        notify: value.notify,
      })
      const patchDraft = (patch) => setDraft((previous) => (previous ? { ...previous, ...patch } : previous))

      // 数字串两段式校验:空串与非法值都就地报错且不发请求
      const parseLimit = (text) => {
        const trimmed = String(text ?? '').trim()
        const parsed = Number(trimmed)
        return trimmed !== '' && Number.isFinite(parsed) && parsed >= 0 ? { value: parsed } : { error: 'guardInvalidLimit' }
      }
      const parsePercent = (text) => {
        const trimmed = String(text ?? '').trim()
        const parsed = Number(trimmed)
        return trimmed !== '' && Number.isFinite(parsed) && parsed > 0 && parsed < PERCENT_SCALE
          ? { value: parsed }
          : { error: 'guardInvalidPercent' }
      }

      const applyPayload = (value) => {
        if (!value || typeof value !== 'object') return false
        const next = normalizeConfig(value.config)
        setStatus(value.status ?? null)
        setDraft(draftOf(next))
        // 回读到新配置即视为已恢复:旧字段的校验错误不能留着
        setErrors({})
        return true
      }

      const load = async () => {
        const result = await requestGet(COST_ENDPOINTS.budget)
        if (!aliveRef.current) return
        if (!applyPayload(result.ok ? result.value : null)) {
          setFailure(result.message || t('guardUnavailable'))
          return
        }
        setLoaded(true)
        setFailure('')
      }

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [])

      // 周期或额度变化后快照会重算:这里跟着更新状态行,不用重进设置页
      useEffect(() => {
        const live = snapshot?.budget?.status
        if (live) setStatus(live)
      }, [snapshot])

      const save = async () => {
        const daily = parseLimit(draft.dailyLimit)
        const monthly = parseLimit(draft.monthlyLimit)
        const percent = parsePercent(draft.warnPercent)
        const found = {}
        if (daily.error) found.dailyLimit = daily.error
        if (monthly.error) found.monthlyLimit = monthly.error
        if (percent.error) found.warnPercent = percent.error
        setErrors(found)
        setSaved(false)
        setFailure('')
        if (Object.keys(found).length > 0) return
        setSaving(true)
        const result = await requestPost(COST_ENDPOINTS.budget, {
          budget: {
            warnRatio: percent.value / PERCENT_SCALE,
            daily: { limit: daily.value, action: draft.dailyAction },
            monthly: { limit: monthly.value, action: draft.monthlyAction },
            degradeModel: draft.degradeModel.trim(),
            notify: draft.notify,
          },
        })
        if (!aliveRef.current) return
        setSaving(false)
        if (!result.ok) {
          setFailure(result.message || t('guardSaveFailed'))
          return
        }
        setSaved(true)
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setSaved(false), GUARD_SAVED_NOTICE_MS)
        // POST 只回配置,状态读数要再取一次才能就地刷新;摘要条按新限额决定显示与否
        await load()
        hudRefresh({ force: true }).catch(() => {})
      }

      const budgetOf = (scope) => (Array.isArray(status?.budgets)
        ? status.budgets.find((item) => item.scope === scope)
        : undefined)
      const amountText = (value, approx = false) => (Number.isFinite(value)
        ? `${approx ? COST_APPROX : ''}${formatCost(value, currency)}`
        : COST_PLACEHOLDER)
      const hoursText = (hours) => (Number.isFinite(hours) ? hours.toFixed(1) : COST_PLACEHOLDER)
      const badge = !features.guard
        ? 'off'
        : status?.action === 'block'
          ? 'danger'
          : status?.action === 'warn' || status?.action === 'degrade' ? 'warn' : 'ok'

      const statusRow = () => {
        // 折叠头已经写了「已关闭」,这里不再挂同样的徽标;额度数字照常给,
        // 因为显示进度和是否拦截是两件事
        const primary = budgetOf('daily') ?? budgetOf('monthly')
        // eta 属于某一档:挂在别的档位数字旁会误导
        const eta = status?.eta && (!primary || !status.eta.scope || status.eta.scope === primary.scope) ? status.eta : null
        const limitItems = primary
          ? [
              h('span', { key: 'spent', className: 'ud-guard-status-item' }, t(
                primary.scope === 'daily' ? 'guardSpentDaily' : 'guardSpentMonthly',
                { spent: amountText(primary.spent, true), limit: amountText(primary.limit) },
              )),
              h('span', { key: 'left', className: 'ud-guard-status-item' }, t('guardRemaining', { value: amountText(primary.remaining) })),
              h('span', { key: 'eta', className: 'ud-guard-status-item' }, eta
                ? t('guardEta', { hours: hoursText(eta.hoursLeft) })
                : t('guardEtaNone')),
            ]
          : null
        if (!features.guard) {
          return h('div', { className: 'ud-guard-status' },
            h('span', { className: 'ud-guard-status-item' }, t('guardNotEnabled')),
            limitItems)
        }
        if (!status) {
          return h('div', { className: 'ud-guard-status' },
            h('span', { className: 'ud-guard-status-item' }, t('guardNoStatus')))
        }
        return h('div', { className: 'ud-guard-status' },
          h('span', { className: cx('ud-guard-badge', `ud-guard-badge--${badge}`) }, t(GUARD_STATE_LABELS[badge])),
          limitItems ?? h('span', { className: 'ud-guard-status-item' }, t('guardNoLimit')))
      }

      const fieldOf = (key, labelKey, control, hintKey) => h('label', { className: 'ud-field', key },
        h('span', { className: 'ud-field-label' }, t(labelKey)),
        control,
        errors[key] ? h('span', { className: 'ud-field-error' }, t(errors[key])) : null,
        hintKey ? h('span', { className: 'ud-guard-hint' }, t(hintKey)) : null)

      const limitField = (scope) => {
        const key = `${scope}Limit`
        return fieldOf(key, scope === 'daily' ? 'guardDailyLimit' : 'guardMonthlyLimit',
          h('span', { className: 'ud-guard-amount' },
            h('input', {
              type: 'number', className: 'ud-input', min: 0, step: 'any', inputMode: 'decimal',
              placeholder: '0', disabled: saving,
              value: draft[key],
              onChange: (event) => patchDraft({ [key]: event.target.value }),
            }),
            h('span', { className: 'ud-guard-unit', 'aria-hidden': 'true' }, currency)),
          scope === 'daily' ? 'guardDailyLimitHint' : 'guardMonthlyLimitHint')
      }

      // 两个动作下拉的选项语义相同,说明只挂在第一处,避免同一段话写两遍
      const actionField = (scope) => {
        const key = `${scope}Action`
        return fieldOf(key, scope === 'daily' ? 'guardDailyAction' : 'guardMonthlyAction',
          h('select', {
            className: 'ud-input ud-guard-select', disabled: saving,
            value: draft[key],
            onChange: (event) => patchDraft({ [key]: event.target.value }),
          }, GUARD_ACTIONS.map((action) => h('option', { key: action, value: action }, t(GUARD_ACTION_LABELS[action])))),
          scope === 'daily' ? 'guardActionHint' : null)
      }

      const ratioField = () => fieldOf('warnPercent', 'guardWarnRatio',
        h('span', { className: 'ud-guard-amount' },
          h('input', {
            type: 'number', className: 'ud-input', min: 0, max: PERCENT_SCALE, step: 'any', inputMode: 'decimal',
            disabled: saving,
            value: draft.warnPercent,
            onChange: (event) => patchDraft({ warnPercent: event.target.value }),
          }),
          h('span', { className: 'ud-guard-unit', 'aria-hidden': 'true' }, '%')),
        'guardWarnRatioHint')

      const modelField = () => fieldOf('degradeModel', 'guardDegradeModel',
        h('input', {
          type: 'text', className: 'ud-input', autoComplete: 'off', spellCheck: false, disabled: saving,
          placeholder: 'vendor/model',
          value: draft.degradeModel,
          onChange: (event) => patchDraft({ degradeModel: event.target.value }),
        }),
        'guardDegradeModelHint')

      return h(SectionFold, {
        title: t('guard'),
        description: t('guardSectionDesc'),
        summary: loaded && status ? t(GUARD_STATE_LABELS[badge]) : undefined,
        open,
        onToggle: () => setOpen((value) => !value),
      }, h(React.Fragment, null,
        failure || toggleFailure ? h('div', { className: 'ud-error' }, failure || toggleFailure) : null,
        loaded && draft
          ? h('div', { className: 'ud-guard-block' },
              statusRow(),
              h(StatsLineOptionRow, {
                labelKey: 'guardEnable', descKey: 'guardEnableDesc',
                checked: features.guard,
                onToggle: (value) => { void toggle('guard', value).then((ok) => { if (!ok) return; void load(); hudRefresh({ force: true }).catch(() => {}) }) },
                t,
              }),
              h('div', { className: 'ud-guard-grid' },
                limitField('daily'),
                limitField('monthly'),
                actionField('daily'),
                actionField('monthly'),
                ratioField(),
                modelField()),
              h(StatsLineOptionRow, {
                labelKey: 'guardNotify', descKey: 'guardNotifyDesc',
                checked: draft.notify, onToggle: (value) => patchDraft({ notify: value }), t,
              }),
              h('div', { className: 'ud-guard-actions' },
                h('button', {
                  type: 'button', className: 'ud-btn ud-btn--text', disabled: saving,
                  onClick: () => { void save() },
                }, saving ? t('guardSaving') : t('guardSave')),
                saved ? h('span', { className: 'ud-guard-saved' }, t('guardSaved')) : null))
          : null))
    }

    function SentinelSection({ t = defaultT }) {
      const features = useFeatures()
      const [toggleFailure, toggle] = useFeatureToggle(t)
      const [form] = useState(() => {
        try {
          return clientCtx?.configForms?.get?.(STATS_LINE_SETTINGS_NAMESPACE) ?? null
        } catch {
          return null
        }
      })
      const normalizeConfig = (raw) => ({
        burnMultiplier: Number.isFinite(raw?.burnMultiplier) ? raw.burnMultiplier : SENTINEL_DEFAULT_CONFIG.burnMultiplier,
        cacheDropPoints: Number.isFinite(raw?.cacheDropPoints) ? raw.cacheDropPoints : SENTINEL_DEFAULT_CONFIG.cacheDropPoints,
        quietBurnMinutes: Number.isFinite(raw?.quietBurnMinutes) ? raw.quietBurnMinutes : SENTINEL_DEFAULT_CONFIG.quietBurnMinutes,
      })
      const readFormConfig = () => {
        try {
          return normalizeConfig(form?.getSnapshot?.()?.value?.sentinel)
        } catch {
          return { ...SENTINEL_DEFAULT_CONFIG }
        }
      }
      const [config, setConfig] = useState(readFormConfig)
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [open, setOpen] = useState(false)

      useEffect(() => {
        if (!form || typeof form.subscribe !== 'function') return undefined
        const sync = () => setConfig(readFormConfig())
        const off = form.subscribe(sync)
        sync()
        return off
      }, [])

      const load = useCallback(async () => {
        setLoading(true)
        const result = await requestGet(COST_ENDPOINTS.sentinel)
        setLoading(false)
        if (!result.ok) {
          setError(result.message)
          return
        }
        setError('')
        setData(result.value)
      }, [])

      useEffect(() => {
        void load()
        // 哨兵关着时不轮询:没有事件可看,周期请求纯属空转
        if (!features.sentinel) return undefined
        const timer = setInterval(() => {
          if (document.visibilityState !== 'hidden') void load()
        }, 30 * 1000)
        return () => clearInterval(timer)
      }, [load, features.sentinel])

      useEffect(() => {
        if (form || !data?.config) return
        setConfig(normalizeConfig(data.config))
      }, [form, data])

      const writeConfig = (patch) => {
        setConfig((previous) => ({ ...previous, ...patch }))
        if (!form || typeof form.mutate !== 'function') return
        const ops = Object.entries(patch).map(([field, value]) => ({
          op: 'set',
          path: ['sentinel', field],
          value,
        }))
        Promise.resolve(form.mutate(ops)).then((accepted) => {
          if (accepted === false) setConfig(readFormConfig())
        }, () => setConfig(readFormConfig()))
      }

      const numberHandler = (field, minimum) => (event) => {
        const value = Number(event.target.value)
        if (!Number.isFinite(value) || value < minimum) return
        writeConfig({ [field]: value })
      }

      const ackOne = async (id) => {
        const result = await requestPost(COST_ENDPOINTS.sentinelAck, { ids: [id] })
        if (!result.ok) {
          setError(result.message)
          return
        }
        setData((previous) => (previous
          ? { ...previous, events: (previous.events ?? []).filter((event) => event.id !== id) }
          : previous))
      }

      const currency = typeof data?.currency === 'string' ? data.currency : ''
      const amountText = (value) => (Number.isFinite(value) ? formatCost(value, currency) : '—')
      const shareText = (value) => (Number.isFinite(value) ? `${Math.round(value * 1000) / 10}%` : '—')
      const eventTime = (at) => {
        if (!Number.isFinite(at)) return '—'
        const parts = zonedParts(new Date(at), data?.timeZone)
        return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
      }
      const evidenceText = (event) => {
        const evidence = event?.evidence ?? {}
        if (event.kind === 'burn-spike') {
          return t('sentinelEvidenceBurn', {
            window: evidence.windowMinutes,
            cost: amountText(evidence.recentCost),
            p95: amountText(evidence.p95),
            multiplier: evidence.multiplier,
          })
        }
        if (event.kind === 'cache-drop') {
          return t('sentinelEvidenceCache', {
            window: evidence.windowMinutes,
            recent: evidence.recentHitRate,
            baseline: evidence.baselineHitRate,
            drop: evidence.dropPoints,
          })
        }
        if (event.kind === 'model-drift') {
          return t('sentinelEvidenceModel', {
            window: evidence.windowHours,
            current: evidence.currentModel,
            currentShare: shareText(evidence.currentShare),
            baseline: evidence.baselineModel,
            baselineShare: shareText(evidence.baselineShare),
          })
        }
        if (event.kind === 'quiet-burn') {
          return t('sentinelEvidenceQuiet', {
            idle: evidence.idleMinutes,
            cost: amountText(evidence.cost),
            basis: t(`sentinelBasis.${evidence.basis ?? 'last-input'}`),
          })
        }
        return ''
      }

      const events = data?.events ?? []
      const reason = data?.reason ?? null
      const localized = (key, fallback) => {
        const text = t(key)
        return text === key ? fallback : text
      }
      const eventTitle = (event) => localized(`sentinelKind.${event.kind}`, event.title || event.kind)
      const eventSuggestion = (event) => localized(`sentinelSuggestion.${event.kind}`, event.suggestion || '')
      // 关态也要有摘要:和沙盘、护栏一样,折叠头得能看出这张卡当前是关的
      const summary = features.sentinel !== true
        ? t('featureOff')
        : loading && !data
          ? t('sentinelLoading')
          : events.length > 0 ? t('sentinelEventCount', { n: events.length }) : null

      const baselineNote = () => {
        if (reason === 'disabled') return t('sentinelDisabled')
        if (reason === 'no-pricing') return t('sentinelNoPricing')
        if (reason === 'baseline-insufficient') {
          return t('sentinelBaselineInsufficient', { days: data?.baseline?.days ?? 0 })
        }
        if (reason === 'unavailable') return t('sentinelUnavailable')
        if (reason === 'error') return t('sentinelError')
        if (reason === 'initializing') return t('sentinelLoading')
        if (data?.baseline) {
          return t('sentinelBaselineReady', {
            days: data.baseline.days,
            p95: amountText(data.baseline.p95),
          })
        }
        return ''
      }

      return h(SectionFold, {
        title: t('sentinelTitle'),
        description: t('sentinelDesc'),
        summary,
        open,
        onToggle: () => setOpen((value) => !value),
      }, h('div', { className: 'ud-sentinel-block' },
        h('div', { className: 'ud-sentinel-head' },
          h('div', { className: 'ud-sentinel-head-text' },
            h('span', { className: 'ud-sentinel-head-title' }, t('sentinelEnabled')),
            h('span', { className: 'ud-sentinel-head-desc' }, t('sentinelEnabledDesc'))),
          h(Switch, {
            checked: features.sentinel,
            onChange: (value) => { void toggle('sentinel', value) },
          })),
        toggleFailure ? h('div', { className: 'ud-error' }, toggleFailure) : null,
        h('div', { className: 'ud-sentinel-thresholds' },
          h('label', { className: 'ud-sentinel-threshold' },
            h(HintText, { className: 'ud-sentinel-threshold-label', text: t('sentinelBurnMultiplierDesc') }, t('sentinelBurnMultiplier')),
            h('input', {
              type: 'number', className: 'ud-input', min: 1, step: 0.5,
              value: config.burnMultiplier,
              'aria-label': t('sentinelBurnMultiplier'),
              onChange: numberHandler('burnMultiplier', 1),
            })),
          h('label', { className: 'ud-sentinel-threshold' },
            h(HintText, { className: 'ud-sentinel-threshold-label', text: t('sentinelCacheDropDesc') }, t('sentinelCacheDrop')),
            h('input', {
              type: 'number', className: 'ud-input', min: 1, step: 1,
              value: config.cacheDropPoints,
              'aria-label': t('sentinelCacheDrop'),
              onChange: numberHandler('cacheDropPoints', 1),
            })),
          h('label', { className: 'ud-sentinel-threshold' },
            h(HintText, { className: 'ud-sentinel-threshold-label', text: t('sentinelQuietBurnDesc') }, t('sentinelQuietBurn')),
            h('input', {
              type: 'number', className: 'ud-input', min: 1, step: 1,
              value: config.quietBurnMinutes,
              'aria-label': t('sentinelQuietBurn'),
              onChange: numberHandler('quietBurnMinutes', 1),
            }))),
        baselineNote() ? h('div', { className: 'ud-sentinel-note' }, baselineNote()) : null,
        error ? h('div', { className: 'ud-error' }, error) : null,
        loading && !data ? h('div', { className: 'ud-sentinel-note' }, t('sentinelLoading')) : null,
        !loading && !error && events.length === 0 && reason === null
          ? h('div', { className: 'ud-sentinel-empty' }, t('sentinelEmpty'))
          : null,
        events.length > 0
          ? h('ul', { className: 'ud-sentinel-events' },
              events.map((event) => h('li', { key: event.id, className: 'ud-sentinel-event' },
                h('div', { className: 'ud-sentinel-event-head' },
                  h('span', { className: 'ud-sentinel-time' }, eventTime(event.at)),
                  h('span', { className: `ud-sentinel-level ud-sentinel-level--${event.level ?? 'info'}` },
                    t(`sentinelLevel.${event.level ?? 'info'}`)),
                  h('span', { className: 'ud-sentinel-title' }, eventTitle(event))),
                h('div', { className: 'ud-sentinel-evidence' }, evidenceText(event)),
                h('div', { className: 'ud-sentinel-suggestion' }, eventSuggestion(event)),
                h('div', { className: 'ud-sentinel-event-foot' },
                  h('button', {
                    type: 'button',
                    className: 'ud-btn ud-btn--text ud-sentinel-ack',
                    onClick: () => ackOne(event.id),
                  }, t('sentinelAck'))))))
          : null))
    }

    // —— 用量摘要:设置页卡片 + 输入区读数 ——
    // 数据走模块内单例快照:设置页卡片与输入区读数共用同一份,刷新走 hudRefresh 的节流与单飞。
    const HUD_DOCK_ID = 'usage-dash-hud'
    const HUD_REFRESH_MS = 30 * 1000
    // 节流窗口要短于刷新间隔,否则 tick 落在窗口边缘时会被判成「刚刷过」而跳过
    const HUD_REFRESH_GUARD_MS = HUD_REFRESH_MS * 0.8
    // 本槽内宿主无自带条目,order 只与其他插件条目排序;取 1 排在默认 0 之后
    const HUD_DOCK_ORDER = 1
    const HUD_SPARK_WIDTH = 240
    const HUD_SPARK_HEIGHT = 56
    const HUD_SPARK_PAD = 4
    const HUD_PERCENT_FULL = 100
    const HUD_HOUR_TEXT_WIDTH = 2
    const HUD_HOURS_PER_DAY = 24
    const HUD_MINUTES_PER_HOUR = 60
    const HUD_HOURS_INT_THRESHOLD = 10
    const HUD_HOURS_SCALE = 10
    const HUD_ACTION_LABELS = {
      warn: 'hudActionWarn',
      degrade: 'hudActionDegrade',
      block: 'hudActionBlock',
    }
    const HUD_ACTION_CLASSES = {
      warn: 'ud-hud-badge ud-hud-badge--warn',
      degrade: 'ud-hud-badge ud-hud-badge--warn',
      block: 'ud-hud-badge ud-hud-badge--danger',
    }
    const HUD_SCOPE_LABELS = { daily: 'hudDailyLimit', monthly: 'hudMonthlyLimit' }
    const HUD_STATE_CLASSES = {
      ok: '',
      warn: ' ud-hud-budget-fill--warn',
      exceeded: ' ud-hud-budget-fill--danger',
    }

    let hudSnapshot = null
    let hudFetchedAt = 0
    let hudBudgetAt = 0
    // 在飞期间的强制刷新只排一次:连点保存与开关不该把请求数线性放大
    let hudQueuedForce = null
    // 额度快照超过这个时长没刷新就当作没有:ETA 按当时速率算,越放越离谱
    const HUD_BUDGET_STALE_MS = HUD_REFRESH_MS * 10
    let hudFlight = null
    const hudListeners = new Set()

    const hudNotify = () => {
      for (const listener of hudListeners) listener(hudSnapshot)
    }

    // 节流刷新:窗口内直接复用快照;配置刚改过时用 force 跳过窗口;并发调用共享同一次请求
    function hudRefresh(options) {
      const force = options?.force === true
      if (!force && hudSnapshot !== null && Date.now() - hudFetchedAt < HUD_REFRESH_GUARD_MS) {
        return Promise.resolve(hudSnapshot)
      }
      if (hudFlight !== null) {
        if (!force) return hudFlight
        hudQueuedForce ??= hudFlight.then(() => {
          hudQueuedForce = null
          return hudRefresh({ force: true })
        }, (error) => {
          // 飞行失败也要放掉排队:留着一条已拒绝的链会让后续 force 永远拿它,再不自愈
          hudQueuedForce = null
          throw error
        })
        return hudQueuedForce
      }
      hudFlight = (async () => {
        const [summary, budget] = await Promise.all([
          requestGet(COST_ENDPOINTS.summary),
          requestGet(COST_ENDPOINTS.budget),
        ])
        // 预算端点随 Guard 门控注册,不可用时按未配置处理,不拖垮费用读数
        if (budget.ok) hudBudgetAt = Date.now()
        hudSnapshot = {
          summary: summary.ok ? summary.value ?? null : hudSnapshot?.summary ?? null,
          budget: budget.ok
            ? budget.value ?? null
            : Date.now() - hudBudgetAt < HUD_BUDGET_STALE_MS ? hudSnapshot?.budget ?? null : null,
          error: summary.ok ? null : summary.message ?? DEFAULT_ERROR_CODE,
        }
        hudFetchedAt = Date.now()
        hudNotify()
        return hudSnapshot
      })().finally(() => { hudFlight = null })
      return hudFlight
    }

    function useHudSnapshot() {
      const [snapshot, setSnapshot] = useState(hudSnapshot)
      useEffect(() => {
        const listener = (next) => setSnapshot(next)
        hudListeners.add(listener)
        if (hudSnapshot !== null) listener(hudSnapshot)
        return () => hudListeners.delete(listener)
      }, [])
      return snapshot
    }

    const hudCurrencyOf = (summary) =>
      typeof summary?.currency === 'string' && summary.currency !== '' ? summary.currency : null

    function hudCostText(value, currency) {
      if (currency === null || !Number.isFinite(value)) return COST_PLACEHOLDER
      return `${COST_APPROX}${formatCostCompact(value, currency)}`
    }

    function hudCostExact(value, currency) {
      if (currency === null || !Number.isFinite(value)) return COST_PLACEHOLDER
      return formatCost(value, currency)
    }

    // 限额是用户配的纯数字:没有定价规则时费用未知,但限额本身仍然可读
    // 金额去尾零:50.00 → 50,12.50 → 12.5,0.35 保持;无小数点的整数不动
    const hudTrimMoney = (text) => (text.includes('.') ? text.replace(/\.?0+$/, '') : text)

    function hudLimitText(value, currency, compact) {
      if (!Number.isFinite(value)) return COST_PLACEHOLDER
      if (currency === null) return hudTrimMoney(String(Math.round(value * 100) / 100))
      const text = compact ? `${COST_APPROX}${formatCostCompact(value, currency)}` : formatCost(value, currency)
      return hudTrimMoney(text)
    }

    function hudHoursText(hours) {
      if (!Number.isFinite(hours) || hours <= 0) return '0'
      return hours >= HUD_HOURS_INT_THRESHOLD
        ? String(Math.round(hours))
        : String(Math.round(hours * HUD_HOURS_SCALE) / HUD_HOURS_SCALE)
    }

    const hudEtaTextOf = (hours, t) => {
      if (!Number.isFinite(hours) || hours <= 0) return t('hudEtaNone')
      if (hours < 1) return t('hudEtaMinutes', { minutes: Math.max(1, Math.round(hours * HUD_MINUTES_PER_HOUR)) })
      if (hours < HUD_HOURS_PER_DAY * 2) return t('hudEtaHours', { hours: hudHoursText(hours) })
      return t('hudEtaDays', { days: Math.round(hours / HUD_HOURS_PER_DAY) })
    }

    const hudHourLabel = (bucket) =>
      typeof bucket === 'string' ? `${bucket.slice(-HUD_HOUR_TEXT_WIDTH)}:00` : ''

    // 两档额度各自可配,只填月限额时第一个档位就是月口径:标签必须跟着档位走,
    // 否则本月数据会被写成「今日」
    const hudLimitScopeLabel = (limit, t) => (limit?.scope === 'monthly' ? t('hudMonth') : t('hudToday'))

    // 主文本只表达一件事:已用 / 总额度。多段并列要读的人自己心算,速率与预估放 tooltip
    // 护栏关闭时额度不再是约束:读数只报花费,否则会让人以为还在被限制
    function hudDockTextOf(summary, status, t, guardOn) {
      if (summary === null) return null
      const currency = hudCurrencyOf(summary)
      const limit = guardOn === true ? (status?.budgets?.[0] ?? null) : null
      // 无额度时没有分母,只报今日花费;连定价都没有就没有可说的
      if (limit === null || limit === undefined) {
        if (currency === null) return null
        return `${t('hudToday')} ${hudCostText(summary.today?.cost ?? 0, currency)}`
      }
      const used = hudLimitText(limit.spent, currency)
      const total = hudLimitText(limit.limit, currency)
      return `${hudLimitScopeLabel(limit, t)} ${used} / ${total}`
    }

    // tooltip 要说清每个数是什么、怎么算出来的,不能把主文本的数字再列一遍
    function hudDockTooltipOf(summary, status, t, guardOn) {
      if (summary === null) return null
      const currency = hudCurrencyOf(summary)
      const costRows = []
      if (currency === null) {
        costRows.push({ key: 'today', label: t('hudTipTodayTokens'), value: `${formatTokensCompact(summary.today?.tokens ?? 0)} tok` })
        costRows.push({ key: 'month', label: t('hudTipMonthTokens'), value: `${formatTokensCompact(summary.cycle?.tokens ?? 0)} tok` })
      } else {
        // 金额单看不知道量级:tokens 放前面,tooltip 一眼能对上「花了多少、用了多少」
        const tokensOf = (bucket) => formatTokensCompact(bucket?.tokens ?? 0)
        costRows.push({ key: 'today', label: t('hudTipToday'), value: `${tokensOf(summary.today)} · ${hudCostExact(summary.today?.cost ?? 0, currency)}` })
        costRows.push({ key: 'month', label: t('hudTipMonth'), value: `${tokensOf(summary.cycle)} · ${hudCostExact(summary.cycle?.cost ?? 0, currency)}` })
        // 窗口内没有分钟行时两个速率都是 null:只报金额会看成分成 0,直接给占位
        const rateTokens = Number.isFinite(summary.tokensPerHour) ? `${formatTokensCompact(summary.tokensPerHour)}/h · ` : ''
        const rateCost = Number.isFinite(summary.ratePerHour) ? `${hudCostExact(summary.ratePerHour, currency)}/h` : COST_PLACEHOLDER
        costRows.push({ key: 'rate', label: t('hudTipRate'), value: `${rateTokens}${rateCost}` })
      }
      const sections = [{ key: 'cost', label: t('hudTipCostSection'), rows: costRows }]
      const limit = guardOn === true ? (status?.budgets?.[0] ?? null) : null
      if (limit) {
        const rows = [
          { key: 'limit', label: t('hudTipLimit'), value: `${hudLimitText(limit.spent, currency)} / ${hudLimitText(limit.limit, currency)}` },
          { key: 'left', label: t('hudTipRemaining'), value: hudLimitText(limit.remaining, currency) },
        ]
        const eta = status?.eta ?? null
        if (eta) rows.push({ key: 'eta', label: t('hudTipEta'), value: hudEtaTextOf(eta.hoursLeft, t) })
        sections.push({ key: 'budget', label: t('hudTipBudgetSection', { scope: hudLimitScopeLabel(limit, t) }), rows })
      }
      return {
        title: t('hudTitle'),
        text: currency === null ? t('hudTipNoPricing') : t('hudTipExplain'),
        sections,
      }
    }

    // 曲线按最大花费归一;全零或不足两点视为无数据,不画零值折线
    function hudSparkGeometry(spark) {
      if (spark.length < 2) return null
      const max = spark.reduce((value, point) => Math.max(value, point.cost ?? 0), 0)
      if (!(max > 0)) return null
      const plotWidth = HUD_SPARK_WIDTH - HUD_SPARK_PAD * 2
      const plotHeight = HUD_SPARK_HEIGHT - HUD_SPARK_PAD * 2
      const stepX = plotWidth / (spark.length - 1)
      const baseline = HUD_SPARK_HEIGHT - HUD_SPARK_PAD
      const points = spark.map((point, index) => ({
        x: HUD_SPARK_PAD + index * stepX,
        y: baseline - (Math.max(0, point.cost ?? 0) / max) * plotHeight,
      }))
      const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ')
      return {
        line,
        area: `${line} L${HUD_SPARK_PAD + plotWidth} ${baseline} L${HUD_SPARK_PAD} ${baseline} Z`,
      }
    }

    function hudBudgetRow(item, evaluation, currency, t) {
      const ratio = Number.isFinite(item.ratio) ? item.ratio : 0
      const percent = Math.min(Math.max(ratio, 0) * HUD_PERCENT_FULL, HUD_PERCENT_FULL)
      const eta = evaluation.eta?.scope === item.scope ? evaluation.eta : null
      const valueText = `${hudLimitText(item.spent, currency)} / ${hudLimitText(item.limit, currency)}`
      return h('div', { key: item.scope, className: 'ud-hud-budget-row' },
        h('div', { className: 'ud-hud-budget-line' },
          h('span', null, t(HUD_SCOPE_LABELS[item.scope])),
          // 正文与提示不能一字不差:提示要说清这行数字是什么口径
          h(HintText, { className: 'ud-hud-budget-value', text: t('hudTipLimitScope', { scope: t(HUD_SCOPE_LABELS[item.scope]) }) }, valueText)),
        h('div', { className: 'ud-hud-budget-track' },
          h('div', { className: `ud-hud-budget-fill${HUD_STATE_CLASSES[item.state] ?? ''}`, style: { width: `${percent}%` } })),
        h('div', { className: 'ud-hud-budget-meta' },
          // 没有币种时紧凑值与精确值同一串,tooltip 只会复述正文
          currency === null
            ? h('span', null, t('hudRemaining', { value: hudLimitText(item.remaining, currency) }))
            : h(HintText, { text: hudLimitText(item.remaining, currency) }, t('hudRemaining', { value: hudLimitText(item.remaining, currency, true) })),
          eta === null ? null : h('span', null, hudEtaTextOf(eta.hoursLeft, t))))
    }

    // 用量摘要进设置页:侧栏不再挂入口,主区也不再占一个面板插槽
    // 计费周期:套餐口径由用户填,默认自然月;改动即写宿主并强制刷一次摘要
    const CYCLE_KIND_OPTIONS = ['calendar', 'monthly', 'rolling']
    const CYCLE_KIND_LABEL_KEYS = {
      calendar: 'cycleKindCalendar',
      monthly: 'cycleKindMonthly',
      rolling: 'cycleKindRolling',
    }
    const CYCLE_START_DAY_MIN = 1
    const CYCLE_START_DAY_MAX = 31
    const CYCLE_DAYS_MIN = 1
    const CYCLE_DAYS_MAX = 366

    function CycleConfig({ t = defaultT }) {
      const [config, setConfig] = useState(null)
      const [range, setRange] = useState(null)
      const [failure, setFailure] = useState('')
      // 字段校验与请求失败分开:前者决定 aria-invalid,后者只提示
      const [fieldError, setFieldError] = useState('')
      const [draft, setDraft] = useState({})
      // 组件可能在保存途中被收起:所有异步回写先判存活
      const aliveRef = useRef(true)
      // 写入串成一条链,避免连续改两项时旧响应覆盖新状态
      const writeChainRef = useRef(Promise.resolve())
      // 最后真正落盘的一份:排队写入以它为基底,回滚也只回到它
      const persistedRef = useRef(null)
      // 队列里出现过失败:后续成功不要把它当成整体成功去清错误
      const saveFailedRef = useRef(false)
      const settle = (next) => {
        persistedRef.current = next
        setConfig(next.config)
        setRange(next.range)
      }
      useEffect(() => {
        aliveRef.current = true
        requestGet(COST_ENDPOINTS.cycle).then((result) => {
          if (!aliveRef.current || !result.ok) return
          settle({ config: result.value?.config ?? null, range: result.value?.window ?? null })
        })
        return () => {
          aliveRef.current = false
        }
      }, [])
      const save = (patch) => {
        const base = persistedRef.current?.config ?? config ?? {}
        // 乐观显示在当前界面值上叠加:前一条未确认的改动不会被本条覆盖掉
        setConfig((previous) => ({ ...(previous ?? base), ...patch }))
        const write = () => requestPost(COST_ENDPOINTS.cycle, { cycle: { ...(persistedRef.current?.config ?? base), ...patch } })
          .then((result) => {
            if (!result.ok) {
              saveFailedRef.current = true
              if (!aliveRef.current) return
              // 回到已落盘的值,而不是上一次未确认的乐观值
              settle(persistedRef.current ?? { config: base, range: null })
              setFailure(t('cycleSaveFailed'))
              return
            }
            // 落盘基线无论组件存亡都要更新:卸载后排队中的写仍以真实值为基底
            const next = { config: result.value?.config ?? { ...(persistedRef.current?.config ?? base), ...patch }, range: result.value?.window ?? null }
            persistedRef.current = next
            if (!aliveRef.current) return
            setConfig(next.config)
            setRange(next.range)
            if (!saveFailedRef.current) setFailure('')
            hudRefresh({ force: true }).catch(() => {})
          })
        writeChainRef.current = writeChainRef.current.then(write, write)
      }
      if (config === null) return null
      // 数字输入用字符串草稿:失焦才校验并提交,避免逐键把中间态写进设置
      const numberInput = (label, field, min, max) => {
        const shown = draft[field] === undefined ? String(config[field]) : draft[field]
        const patchDraft = (value) => setDraft((previous) => ({ ...previous, [field]: value }))
        return h('input', {
          key: field,
          className: 'ud-input ud-cycle-num',
          type: 'number',
          min,
          max,
          value: shown,
          'aria-label': label,
          'aria-invalid': fieldError === '' ? undefined : 'true',
          title: label,
          onChange: (event) => patchDraft(event.target.value),
          onBlur: (event) => {
            const raw = event.target.value.trim()
            const parsed = Number(raw)
            if (raw === '' || !Number.isInteger(parsed) || parsed < min || parsed > max) {
              // 保留草稿:让用户看到自己输错的值,而不是跳回旧值再加一句报错
              patchDraft(raw)
              setFieldError(t('cycleInvalidValue', { min, max }))
              return
            }
            patchDraft(undefined)
            setFieldError('')
            // 没改动就别写:每次写入都会产生一次配置修订与窗口重算
            const current = (persistedRef.current?.config ?? config)[field]
            if (parsed === current) {
              setFailure('')
              return
            }
            save({ [field]: parsed })
          },
        })
      }
      return h('div', { className: 'ud-cycle' },
        h('span', { className: 'ud-cycle-label' }, t('cycleLabel')),
        h('select', {
          className: 'ud-input ud-cycle-kind',
          value: config.kind,
          'aria-label': t('cycleLabel'),
          onChange: (event) => save({ kind: event.target.value }),
        }, CYCLE_KIND_OPTIONS.map((kind) => h('option', { key: kind, value: kind }, t(CYCLE_KIND_LABEL_KEYS[kind])))),
        config.kind === 'monthly' ? numberInput(t('cycleStartDay'), 'startDay', CYCLE_START_DAY_MIN, CYCLE_START_DAY_MAX) : null,
        config.kind === 'rolling' ? numberInput(t('cycleDays'), 'days', CYCLE_DAYS_MIN, CYCLE_DAYS_MAX) : null,
        range ? h('span', { className: 'ud-cycle-range' }, `${range.from} ~ ${range.to}`) : null,
        (fieldError !== '' ? fieldError : failure) === '' ? null : h('span', { className: 'ud-cycle-error', role: 'alert' }, fieldError !== '' ? fieldError : failure))
    }

    function HudSummaryBody({ t = defaultT }) {
      const features = useFeatures()
      const [toggleFailure, toggle] = useFeatureToggle(t)
      const snapshot = useHudSnapshot()
      useEffect(() => {
        hudRefresh().catch(() => {})
        // 页面不可见时不刷:与折叠行、读数保持同一判据
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') hudRefresh().catch(() => {})
        }, HUD_REFRESH_MS)
        return () => window.clearInterval(timer)
      }, [])
      const summary = snapshot?.summary ?? null
      if (summary === null) {
        return h('p', { className: snapshot?.error ? 'ud-hud-error' : 'ud-hud-empty' },
          snapshot?.error ? t('hudError') : t('hudLoading'))
      }
      const status = snapshot?.budget?.status ?? null
      const evaluation = status
      const budgets = Array.isArray(evaluation?.budgets) ? evaluation.budgets : []
      const currency = hudCurrencyOf(summary)
      const rateText = currency === null || !Number.isFinite(summary.ratePerHour) ? COST_PLACEHOLDER : `${formatCostCompact(summary.ratePerHour, currency)}/h`
      const rateExact = currency === null ? null : `${formatCost(summary.ratePerHour ?? 0, currency)}/h`
      const cacheText = Number.isFinite(summary.cacheHit) ? formatPercent(summary.cacheHit) : COST_PLACEHOLDER
      const metaOf = (totals) =>
        `${t('hudTokens', { n: formatTokensCompact(totals.tokens ?? 0) })} · ${t('hudRequests', { n: totals.requests ?? 0 })}`
      const card = (key, label, value, meta, exact, desc) => h('div', { key, className: 'ud-hud-card' },
        h('span', { className: 'ud-hud-card-label' }, label),
        h(HintText, {
          className: 'ud-hud-card-value',
          title: label,
          text: desc ?? null,
          sections: exact ? [{ key: 'exact', rows: [{ key: 'v', label: t('hudTipExact'), value: exact }] }] : [],
        }, value),
        meta === null ? null : h('span', { className: 'ud-hud-card-meta' }, meta))
      const spark = Array.isArray(summary.spark) ? summary.spark : []
      const geometry = hudSparkGeometry(spark)
      return h('div', { className: 'ud-hud ud-hud--embedded' },
        h(CycleConfig, { key: 'cycle', t }),
        h('div', { className: 'ud-hud-cards', key: 'cards' },
          card('today', t('hudToday'), hudCostText(summary.today?.cost ?? 0, currency), metaOf(summary.today ?? {}), hudCostExact(summary.today?.cost ?? 0, currency), t('hudTipTodayDesc')),
          card('month', t('hudMonth'), hudCostText(summary.cycle?.cost ?? 0, currency), metaOf(summary.cycle ?? {}), hudCostExact(summary.cycle?.cost ?? 0, currency), t('hudTipMonthDesc')),
          card('rate', t('hudRate'), rateText, Number.isFinite(summary.tokensPerHour) ? `${formatTokensCompact(summary.tokensPerHour)}/h` : null, rateExact, t('hudTipRateDesc')),
          card('cache', t('hudCacheHit'), cacheText, null, null, t('hudTipCacheDesc'))),
        currency === null ? h('p', { className: 'ud-hud-note', key: 'noPricing' }, t('hudNoPricing')) : null,
        budgets.length === 0 || features.guard !== true ? null : h('section', { className: 'ud-hud-section', key: 'budget' },
          h('div', { className: 'ud-hud-section-head' },
            h('span', null, t('hudBudgetTitle')),
            evaluation.action === 'none' ? null : h('span', { className: HUD_ACTION_CLASSES[evaluation.action] }, t(HUD_ACTION_LABELS[evaluation.action]))),
          budgets.map((item) => hudBudgetRow(item, evaluation, currency, t))),
        h('section', { className: 'ud-hud-section', key: 'spark' },
          h('div', { className: 'ud-hud-section-head' }, h('span', null, t('hudSparkTitle'))),
          geometry === null
            ? h('p', { className: 'ud-hud-empty' }, t('hudSparkEmpty'))
            : h('div', { className: 'ud-hud-spark-wrap' },
                h('svg', {
                  className: 'ud-hud-spark',
                  viewBox: `0 0 ${HUD_SPARK_WIDTH} ${HUD_SPARK_HEIGHT}`,
                  preserveAspectRatio: 'none',
                  role: 'img',
                  'aria-label': t('hudSparkTitle'),
                },
                h('path', { className: 'ud-hud-spark-area', d: geometry.area }),
                h('path', { className: 'ud-hud-spark-line', d: geometry.line })),
                h('div', { className: 'ud-hud-spark-axis' },
                  h('span', null, hudHourLabel(spark[0]?.t)),
                  h('span', null, hudHourLabel(spark[spark.length - 1]?.t))))),
        h('section', { className: 'ud-hud-section', key: 'display' },
          h('div', { className: 'ud-hud-section-head' }, h('span', null, t('hudDisplayTitle'))),
          h(StatsLineOptionRow, {
            labelKey: 'dockEnable', descKey: 'dockEnableDesc',
            checked: features.dock,
            onToggle: (value) => { void toggle('dock', value) },
            t,
          }),
          toggleFailure ? h('div', { className: 'ud-error' }, toggleFailure) : null))
    }

    // 折叠卡外壳:标题汇总只放今日花费,细节展开后看
    function HudSummarySection({ t = defaultT }) {
      const [open, setOpen] = useState(false)
      const snapshot = useHudSnapshot()
      // 折叠行也要有数:正文没展开时由这里刷,展开后正文自己刷,不用两边都挂
      useEffect(() => {
        hudRefresh().catch(() => {})
        if (open) return undefined
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') hudRefresh().catch(() => {})
        }, HUD_REFRESH_MS)
        return () => window.clearInterval(timer)
      }, [open])
      const summary = snapshot?.summary ?? null
      const foldSummary = summary === null
        ? ''
        : `${t('hudToday')} ${hudCostText(summary.today?.cost ?? 0, hudCurrencyOf(summary))}`
      return h(SectionFold, {
        title: t('hudTitle'),
        description: t('hudSubtitle'),
        summary: foldSummary,
        open,
        onToggle: () => setOpen((value) => !value),
      }, open ? h(HudSummaryBody, { t }) : null)
    }

    const HudDockLine = React.memo(function HudDockLine({ t = defaultT }) {
      const features = useFeatures()
      const snapshot = useHudSnapshot()
      // 读数常驻在输入区,自己维持刷新节奏:面板撤掉后没人再帮它刷快照了
      useEffect(() => {
        if (!features.dock) return undefined
        hudRefresh().catch(() => {})
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') hudRefresh().catch(() => {})
        }, HUD_REFRESH_MS)
        return () => window.clearInterval(timer)
      }, [features.dock])
      if (!features.dock) return null
      const summary = snapshot?.summary ?? null
      const status = snapshot?.budget?.status ?? null
      const text = hudDockTextOf(summary, status, t, features.guard)
      if (text === null) return null
      const tooltip = hudDockTooltipOf(summary, status, t, features.guard)
      const tone = status?.action === 'block'
        ? 'danger'
        : status?.action === 'warn' || status?.action === 'degrade'
          ? 'warn'
          : status?.enabled === true ? 'ok' : 'muted'
      // 圆点表示成本状态:熔断红、预警黄、正常绿;护栏关闭又没有预警时没有状态可表示,不画
      return h(HintText, { ...tooltip, className: 'ud-hud-dock', tag: 'span' },
        h('span', { className: 'ud-hud-dock-button' },
          tone === 'muted' ? null : h('span', { className: `ud-hud-dock-dot ud-hud-dock-dot--${tone}`, 'aria-hidden': 'true' }),
          h('span', { className: 'ud-hud-dock-text' }, text)))
    })

    // 只挂输入区读数:摘要本身是设置页的一张卡,不占侧栏与主区插槽
    function registerHudUi(ctx) {
      // 读数与「请选择模型」「发送」同排:输入区元信息放进输入区工具行,
      // 不另起一行悬在输入框上方。宿主没有该槽时 inject 只是永不回调,不会抛错
      ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: HUD_DOCK_ID,
        order: HUD_DOCK_ORDER,
        locale: LOCALE_NS,
      }, HudDockLine)), 'usage-dash: hud dock')
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ensureStyle(document)
        clientCtx = ctx
        // 偏好唯一来源:宿主 settings 投影(profile entry config 的 statsLine 字段)
        statsLineState = createStatsLineState(ctx.configForms.get(STATS_LINE_SETTINGS_NAMESPACE))
        // locale 座随槽声明,语言切换经新 t 引用驱动重渲染;旧宿主无 locale 服务时由 cordis 门控整体未激活
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }), 'usage-dash: dictionaries')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'usage-dash', order: 45, label: () => ctx.locale.bind(LOCALE_NS)('nav'), locale: LOCALE_NS },
            UsageDashPanel,
          ))
        // 两段式注册官方 dock 槽增强条目:宿主缺该插槽时注册抛错即禁用本功能;
        // order 2 排官方 activity(0)/usage(1) 之后,append 在官方数据后面
        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'request-details', order: 3, locale: LOCALE_NS },
              RequestDetailsAppended,
            ))
        } catch (error) {
          console.warn('[usage-dash] 最近请求详情未注册(宿主无 conversation.composer.dock 插槽)', error)
        }
        try {
          // 子代理小时投影不在列表行 summary 里:展开面板时用 sessions 服务按会话拉取,
          // 与官方子代理面板同一取数面;容器不支持反射取服务或服务缺席时面板只走摘要口径
          clientCtx = ctx
          sessionsClient = (typeof ctx.get === 'function' ? ctx.get('sessions') : null) ?? null
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'stats', order: 2, priority: STATS_SLOT_PRIORITY, locale: LOCALE_NS },
              StatsLineAppended,
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
        // 四模块都渲染在设置页,只有输入区读数需要单独挂槽
        registerHudUi(ctx)
      },
    }
  }
}
})()