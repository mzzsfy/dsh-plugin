(() => {
// 定时任务看板 client 半区:设置页三 Tab(看板/环境变量/日志)+ 任务与变量的完整 CRUD。
// 无构建:createElement + 一次性样式注入;IIFE 书挡,顶层零词法声明(经典 script 全局词法环境跨 bundle 共享)。
// 开关一律 cb-switch(规约 switch 形态);状态色语义以 STATUS_META 单一来源,与 core status-meta.mjs 镜像(parity 锁定)。

/* LOGIC-BEGIN */
// 运行状态元数据:与 core status-meta.mjs 逐字镜像(parity 锁定),状态名单见 RUN_STATUSES
const RUN_STATUSES = ['queued', 'running', 'success', 'fail', 'timeout', 'skipped', 'interrupted', 'cancelled']
const STATUS_META = {
  queued: { label: '排队中', tone: 'mute' },
  running: { label: '运行中', tone: 'run' },
  success: { label: '成功', tone: 'ok' },
  fail: { label: '失败', tone: 'bad' },
  timeout: { label: '超时', tone: 'bad' },
  skipped: { label: '跳过', tone: 'mute' },
  interrupted: { label: '中断', tone: 'mute' },
  cancelled: { label: '已取消', tone: 'mute' },
}
const TRIGGER_META = { cron: { label: '定时' }, manual: { label: '手动' } }
const KIND_LABELS = { shell: '脚本', session: '会话' }
const MODE_LABELS = { fresh: '每次新建', pinned: '固定会话' }
const STATUS_TONE_COLOR = { ok: 'var(--cb-status-ok)', bad: 'var(--cb-status-bad)', mute: 'var(--cb-status-mute)', run: 'var(--cb-status-run)' }
const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const PAD2 = (value) => String(value).padStart(2, '0')

// 相对时间人话:未来「x 后」过去「x 前」
function relativeTime(timestamp, now) {
  if (typeof timestamp !== 'number' || !(timestamp > 0)) return '-'
  const delta = timestamp - now
  const abs = Math.abs(delta)
  const suffix = delta >= 0 ? '后' : '前'
  if (abs < MINUTE_MS) return Math.max(1, Math.round(abs / SECOND_MS)) + ' 秒' + suffix
  if (abs < HOUR_MS) return Math.round(abs / MINUTE_MS) + ' 分钟' + suffix
  if (abs < DAY_MS) return Math.round(abs / HOUR_MS) + ' 小时' + suffix
  return Math.round(abs / DAY_MS) + ' 天' + suffix
}

function formatDateTime(timestamp, timezoneOffset) {
  if (typeof timestamp !== 'number' || !(timestamp > 0)) return '-'
  // 按调度所用时区(任务显式后缀或宿主默认)平移后取 UTC 分量,与浏览器时区无关;
  // 偏移缺失(状态未加载)瞬态回退浏览器时区
  const offset = typeof timezoneOffset === 'number' ? timezoneOffset : -new Date().getTimezoneOffset() / 60
  const shifted = new Date(timestamp + offset * HOUR_MS)
  return shifted.getUTCFullYear() + '-' + PAD2(shifted.getUTCMonth() + 1) + '-' + PAD2(shifted.getUTCDate()) + ' ' + PAD2(shifted.getUTCHours()) + ':' + PAD2(shifted.getUTCMinutes())
}

// 浏览器所在设备的时区偏移(小时,可含非整点):仅用于新建任务时固化初始时区后缀
function deviceTzOffset() {
  return -new Date().getTimezoneOffset() / 60
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !(ms >= 0)) return '-'
  if (ms < SECOND_MS) return ms + 'ms'
  if (ms < MINUTE_MS) return (ms / SECOND_MS).toFixed(1) + 's'
  return Math.round(ms / MINUTE_MS) + 'min'
}

function statusMeta(status) {
  return STATUS_META[status] || { label: status || '-', tone: 'mute' }
}

// 宿主自动化任务只读摘要:目录字段见 dsh-schedule 的 ScheduleRecord / ScheduleCatalogEntry
const AUTOMATION_STATUS_META = {
  active: { label: '启用', tone: 'ok' },
  paused: { label: '暂停', tone: 'mute' },
  inactive: { label: '停用', tone: 'mute' },
  ended: { label: '结束', tone: 'mute' },
}
const HOST_AUTOMATION_NAV_ATTR = 'data-cb-hide-host-automation-nav'

// 看板聚合与宿主侧栏入口共用开关:开启后隐藏宿主重复面板行,保留看板内只读分组作为唯一入口。
// 宿主未提供 sidebar.panellist 的隐藏 API,只能按宿主稳定 aria/icon 标记做可选 CSS 隐藏。
function syncHostAutomationNav(hidden) {
  if (typeof document === 'undefined' || !document.documentElement) return
  const root = document.documentElement
  if (typeof root.setAttribute !== 'function' || typeof root.removeAttribute !== 'function') return
  if (hidden) root.setAttribute(HOST_AUTOMATION_NAV_ATTR, '')
  else root.removeAttribute(HOST_AUTOMATION_NAV_ATTR)
}
const AUTOMATION_KIND_LABELS = { after: '一次性', at: '一次性', every: '固定间隔', daily: '每日', weekly: '每周', cron: 'Cron', rrule: '自定义' }
const WEEKDAY_LABELS = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
const WEEKDAY_CODES = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' }
const RRULE_ALLOWED_KEYS = {
  DAILY: ['FREQ', 'INTERVAL', 'COUNT', 'BYHOUR', 'BYMINUTE', 'UNTIL', 'WKST'],
  WEEKLY: ['FREQ', 'INTERVAL', 'COUNT', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'UNTIL', 'WKST'],
  MONTHLY: ['FREQ', 'INTERVAL', 'COUNT', 'BYMONTHDAY', 'BYHOUR', 'BYMINUTE', 'UNTIL', 'WKST'],
  HOURLY: ['FREQ', 'INTERVAL', 'COUNT', 'BYMINUTE', 'UNTIL', 'WKST'],
  MINUTELY: ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST'],
  YEARLY: ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST'],
}

function automationStatusMeta(status) {
  return AUTOMATION_STATUS_META[status] || { label: status || '-', tone: 'mute' }
}

function automationKindLabel(kind) {
  return AUTOMATION_KIND_LABELS[kind] || kind || '-'
}

function automationTimeOf(task) {
  if (!task || typeof task !== 'object') return '-'
  const match = /^(\d{2}):(\d{2})/.exec(String(task.time || ''))
  return match ? match[1] + ':' + match[2] : ''
}

function automationRRuleText(task) {
  const rule = String(task.rrule || '')
  const line = rule.split(/\r?\n/).find((part) => part.startsWith('RRULE:')) || rule
  const fields = {}
  for (const part of line.replace(/^RRULE:/, '').split(';')) {
    const index = part.indexOf('=')
    if (index > 0) fields[part.slice(0, index)] = part.slice(index + 1)
  }
  const allowed = RRULE_ALLOWED_KEYS[fields.FREQ]
  if (!allowed || Object.keys(fields).some((key) => !allowed.includes(key))) return '自定义规则'
  const readInteger = (key, min, max) => {
    if (fields[key] === undefined) return undefined
    if (!/^\d{1,6}$/.test(fields[key])) return null
    const value = Number(fields[key])
    return value >= min && value <= max ? value : null
  }
  const interval = readInteger('INTERVAL', 1, 999)
  const count = readInteger('COUNT', 1, 999999)
  if (interval === null || count === null) return '自定义规则'
  if (count === 1) return '一次性'
  if (fields.FREQ === 'WEEKLY' && fields.BYDAY) {
    const codes = fields.BYDAY.split(',')
    if (codes.some((code) => !WEEKDAY_CODES[code])) return '自定义规则'
    const days = codes.map((code) => '周' + WEEKDAY_CODES[code]).join('、')
    const dtstart = /DTSTART[^\n:]*:\d{8}T(\d{2})(\d{2})/.exec(rule)
    const byHour = readInteger('BYHOUR', 0, 23)
    const byMinute = readInteger('BYMINUTE', 0, 59)
    if (byHour === null || byMinute === null) return '自定义规则'
    const hour = byHour !== undefined ? byHour : (dtstart ? Number(dtstart[1]) : undefined)
    const minute = byMinute !== undefined ? byMinute : (dtstart ? Number(dtstart[2]) : undefined)
    return (interval > 1 ? '每 ' + interval + ' 周' : '每周') + ' ' + days + (hour !== undefined && minute !== undefined ? ' ' + PAD2(hour) + ':' + PAD2(minute) : '')
  }
  if (fields.FREQ === 'MONTHLY' && fields.BYMONTHDAY !== undefined) {
    const day = readInteger('BYMONTHDAY', 1, 31)
    if (day === null) return '自定义规则'
  }
  if (fields.FREQ === 'HOURLY' && fields.BYMINUTE !== undefined && readInteger('BYMINUTE', 0, 59) !== 0) return '自定义规则'
  const dtstart = /DTSTART[^\n:]*:\d{8}T(\d{2})(\d{2})/.exec(rule)
  const byHour = readInteger('BYHOUR', 0, 23)
  const byMinute = readInteger('BYMINUTE', 0, 59)
  if (byHour === null || byMinute === null) return '自定义规则'
  const hour = byHour !== undefined ? byHour : (dtstart ? Number(dtstart[1]) : undefined)
  const minute = byMinute !== undefined ? byMinute : (dtstart ? Number(dtstart[2]) : (byHour !== undefined ? 0 : undefined))
  const time = hour !== undefined && minute !== undefined ? ' ' + PAD2(hour) + ':' + PAD2(minute) : ''
  if (fields.FREQ === 'DAILY') return interval > 1 ? '每 ' + interval + ' 天' + time : '每天' + time
  if (fields.FREQ === 'WEEKLY') return (interval > 1 ? '每 ' + interval + ' 周' : '每周') + time
  if (fields.FREQ === 'MONTHLY') return (interval > 1 ? '每 ' + interval + ' 月' : '每月') + (fields.BYMONTHDAY ? ' ' + fields.BYMONTHDAY + ' 日' : '') + time
  if (fields.FREQ === 'HOURLY') return interval > 1 ? '每 ' + interval + ' 小时' : '每小时'
  if (fields.FREQ === 'MINUTELY') return interval > 1 ? '每 ' + interval + ' 分钟' : '每分钟'
  if (fields.FREQ === 'YEARLY') return (interval > 1 ? '每 ' + interval + ' 年' : '每年') + time
  return '自定义规则'
}

function automationFrequency(task) {
  if (!task || typeof task !== 'object') return '-'
  if (task.kind === 'every') return '每 ' + formatDuration(Number(task.everySeconds) * SECOND_MS)
  if (task.kind === 'daily') return ('每天 ' + automationTimeOf(task)).trimEnd()
  if (task.kind === 'weekly') {
    const days = Array.isArray(task.weekdays) ? task.weekdays.map((day) => '周' + (WEEKDAY_LABELS[day] || day)).join('、') : ''
    const time = automationTimeOf(task)
    return ('每周 ' + days).trimEnd() + (time ? ' ' + time : '')
  }
  if (task.kind === 'cron') return 'Cron ' + String(task.expression || '')
  if (task.kind === 'rrule') return automationRRuleText(task)
  return automationKindLabel(task.kind)
}

function automationTargetLabel(task) {
  const target = task && typeof task === 'object' ? task.target : null
  if (!target && task && task.sessionId) return '固定会话'
  if (!target || typeof target !== 'object') return ''
  if (target.kind === 'session') return '固定会话'
  if (target.kind === 'new_once') return '新建会话复用'
  if (target.kind === 'new') return '每次新建会话'
  return ''
}

function timeZoneOffsetOf(timeZone, timestamp) {
  if (!timeZone || typeof timeZone !== 'string') return undefined
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset', hour12: false }).formatToParts(new Date(timestamp))
    const name = parts.find((part) => part.type === 'timeZoneName')?.value || ''
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name)
    return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) + Number(match[3] || 0) / 60) : undefined
  } catch {
    return undefined
  }
}

function automationTzOffset(task, timestamp) {
  if (!task || typeof task !== 'object') return undefined
  if (typeof task.timeZone === 'string') return timeZoneOffsetOf(task.timeZone, timestamp)
  const rule = String(task.rrule || '')
  const zone = /DTSTART;TZID=([^:\n]+)/.exec(rule)?.[1]
  if (zone) return timeZoneOffsetOf(zone, timestamp)
  return /DTSTART[^\n]*Z/.test(rule) ? 0 : undefined
}

function automationNextText(task, now) {
  if (!task || typeof task !== 'object') return ''
  if (task.status === 'inactive') return '已停用'
  if (task.status === 'ended') return '已结束'
  if (task.status === 'paused') return '已暂停'
  const at = Date.parse(task.scheduledAt)
  if (!Number.isFinite(at)) return ''
  const offset = automationTzOffset(task, at)
  return '下次 ' + formatDateTime(at, offset === undefined ? deviceTzOffset() : offset) + ' · ' + relativeTime(at, now)
}
/* LOGIC-END */

/* SBUILD-BEGIN */
// 调度构建器纯函数:与 src/schedule-builder.mjs 逐字镜像(parity 测试锁定),client 无模块系统只能内联。
// 仅覆盖构建器可表达的形态,反解不出即 custom(表达式原样手输);触发点计算归 croner(经 cron/preview 接口)。
const SB_FREQS = ['daily', 'weekly', 'weekdays', 'interval', 'custom']
const SB_WEEKDAY_ORDER = ['1', '2', '3', '4', '5', '6', '0']
const SB_WEEKDAY_LABELS = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' }
const SB_MINUTE_MAX = 59
const SB_HOUR_MAX = 23
const SB_INTERVAL_MIN_MINUTES = 1
const SB_MINUTES_PER_HOUR = 60
const SB_TZ_SUFFIX_MIN = -12
const SB_TZ_SUFFIX_MAX = 14
const SB_TZ_SUFFIX_PATTERN = /\s*T([+-])(\d{1,2})$/i

// 时区下拉可选偏移:整点区间 + 当前值兜底 —— select 的 value 找不到对应 option 时会渲染空白,
// 当前偏移不在区间内(非整点/脏状态)时补一项,保证选中项始终可见
function tzSelectOptions(current, min = SB_TZ_SUFFIX_MIN, max = SB_TZ_SUFFIX_MAX) {
  const offsets = []
  for (let offset = min; offset <= max; offset++) offsets.push(offset)
  if (typeof current === 'number' && Number.isFinite(current) && !offsets.includes(current)) offsets.push(current)
  return offsets.sort((a, b) => a - b)
}

function createScheduleState(expression) {
  return {
    freq: 'daily',
    hour: 9,
    minute: 0,
    weekdays: ['1'],
    intervalMinutes: 30,
    expression,
    timezone: null,
  }
}

const sbClampInt = (raw, min, max, fallback) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return fallback
  return value
}

// cron(5 段)→ 构建器状态:匹配失败即 custom;非法数值一律归 custom,不猜;
// 非法时区后缀同样 custom 兜底(原样保留,合法性由校验通道业务报错)
function parseSchedule(expression) {
  const raw = String(expression).trim()
  let split
  try {
    split = sbSplitScheduleTz(raw)
  } catch {
    const state = createScheduleState(raw)
    state.freq = 'custom'
    return state
  }
  const state = createScheduleState(split.base)
  state.timezone = split.timezoneOffset
  const parts = split.base.split(/\s+/)
  if (parts.length !== 5) { state.freq = 'custom'; return state }
  const [minute, hour, day, month, weekday] = parts
  if (day !== '*' || month !== '*') { state.freq = 'custom'; return state }
  if (minute === '*' && hour === '*') { state.freq = 'custom'; return state }
  if (/^\*\/\d+$/.test(minute) && hour === '*') {
    state.freq = 'interval'
    state.intervalMinutes = sbClampInt(minute.slice(2), SB_INTERVAL_MIN_MINUTES, SB_MINUTE_MAX, 0)
    if (state.intervalMinutes === 0) state.freq = 'custom'
    return state
  }
  const hourNum = sbClampInt(hour, 0, SB_HOUR_MAX, NaN)
  const minuteNum = sbClampInt(minute, 0, SB_MINUTE_MAX, NaN)
  if (!Number.isInteger(hourNum) || !Number.isInteger(minuteNum)) { state.freq = 'custom'; return state }
  state.hour = hourNum
  state.minute = minuteNum
  if (weekday === '*') { state.freq = 'daily'; return state }
  if (weekday === '1-5') { state.freq = 'weekdays'; return state }
  const days = weekday.split(',')
  if (days.every((d) => /^\d$/.test(d) && d in SB_WEEKDAY_LABELS)) {
    state.freq = 'weekly'
    state.weekdays = SB_WEEKDAY_ORDER.filter((d) => days.includes(d))
    return state
  }
  state.freq = 'custom'
  return state
}

// 偏移小时数 → 展示值:+8 / -5 / +0;非整点(浏览器/宿主时区可能为 +5:30、+5:45)按 +5:30 展示
function sbFormatTzOffset(offset) {
  const sign = offset >= 0 ? '+' : '-'
  const totalMinutes = Math.round(Math.abs(offset) * SB_MINUTES_PER_HOUR)
  const hours = Math.floor(totalMinutes / SB_MINUTES_PER_HOUR)
  const minutes = totalMinutes % SB_MINUTES_PER_HOUR
  return sign + hours + (minutes === 0 ? '' : ':' + String(minutes).padStart(2, '0'))
}

// 时区后缀只支持整小时:非整点偏移不得四舍五入成错误小时(+5:30 → T+6 会整体错半小时),
// 返回 null 由调用方回退宿主默认
function tzSuffixOffset(offset) {
  return Number.isInteger(offset) ? offset : null
}

// 构建器状态 → cron;custom 透传剥离后手工表达式;整点显式时区统一附加 T±N 后缀
function buildSchedule(state) {
  const base = sbBuildBase(state)
  const offset = tzSuffixOffset(state.timezone)
  if (offset === null) return base
  return base + 'T' + sbFormatTzOffset(offset)
}

function sbBuildBase(state) {
  if (state.freq === 'custom') return String(state.expression).trim()
  const minute = String(state.minute)
  const hour = String(state.hour)
  if (state.freq === 'daily') return minute + ' ' + hour + ' * * *'
  if (state.freq === 'weekdays') return minute + ' ' + hour + ' * * 1-5'
  if (state.freq === 'weekly') return minute + ' ' + hour + ' * * ' + [...state.weekdays].sort((a, b) => Number(a) - Number(b)).join(',')
  if (state.freq === 'interval') return '*/' + state.intervalMinutes + ' * * * *'
  return String(state.expression).trim()
}

// 剥离时区后缀:返回 { base, timezoneOffset },无后缀时 timezoneOffset 为 null;
// 后缀超出支持范围抛业务错误(校验与桥接共用,脏数据须暴露)
function sbSplitScheduleTz(schedule) {
  const text = String(schedule).trim()
  const match = text.match(SB_TZ_SUFFIX_PATTERN)
  if (!match) return { base: text, timezoneOffset: null }
  const offset = Number(match[1] + match[2])
  if (offset < SB_TZ_SUFFIX_MIN || offset > SB_TZ_SUFFIX_MAX) {
    throw new Error('时区后缀不合法: T' + match[1] + match[2] + '(支持 T±N 整数小时 ' + SB_TZ_SUFFIX_MIN + ' 至 ' + SB_TZ_SUFFIX_MAX + ')')
  }
  return { base: text.slice(0, match.index).trim(), timezoneOffset: offset }
}
/* SBUILD-END */

// 任务表达式的时区偏移(小时);无后缀返回 null;脏表达式(后缀非法)兜底 null 不炸渲染
function scheduleTzOffset(schedule) {
  try {
    return sbSplitScheduleTz(schedule).timezoneOffset
  } catch {
    return null
  }
}

const API_PREFIX = '/api/cron-board/'
/* MODELKEY-BEGIN */
// 模型表单态 key 序列化(标记段供 test/model-key.test.mjs 提取执行):
// 模型表单态 key 分隔符:单元分隔控制字符(转义书写),provider/model id 空间不含控制字符不会碰撞
const MODEL_KEY_SEP = '\u001f'
// 模型表单态 key:'provider<sep>model[<sep>effort]';'' = 跟随宿主默认;effort 段省略 = 跟随模型默认
function serializeModelKey(model) {
  if (!model || typeof model !== 'object' || !model.provider || !model.model) return ''
  return [model.provider, model.model, model.reasoningEffort || ''].join(MODEL_KEY_SEP)
}
function parseModelKey(key) {
  const parts = String(key || '').split(MODEL_KEY_SEP)
  if (parts.length < 2 || parts[0] === '' || parts[1] === '') return undefined
  return parts[2] ? { provider: parts[0], model: parts[1], reasoningEffort: parts[2] } : { provider: parts[0], model: parts[1] }
}
/* MODELKEY-END */
/* JOBPATCH-BEGIN */
// 任务表单提交面:编辑只提交相对「打开编辑器时快照」有变化的字段(dirty),并带回该快照的
// updatedAt 基线交给服务端乐观锁;全量重提旧快照会把他处变更(自动禁用/开关/会话绑定)静默回滚。
const JOB_FORM_FIELDS = ['name', 'kind', 'command', 'prompt', 'workdir', 'schedule', 'timeoutMs', 'runOnce', 'enabled']
const JOB_SESSION_FIELDS = ['mode', 'pinnedSessionId', 'agentPreset', 'modelKey']
// 并发上限:空串 = 清空该键(提交 null,服务端删键表达「不限并发」),否则提交数值
function jobConcurrencyValue(raw) {
  return raw === '' ? null : Number(raw)
}
// 会话子对象:表单态 modelKey 在提交副本上还原为模型对象,state 内对象不得突变
function jobSessionPayload(session) {
  const payload = { ...session, model: parseModelKey(session.modelKey) }
  delete payload.modelKey
  return payload
}
// 新建任务:提交完整字段集
function jobCreatePayload(form) {
  return {
    ...form,
    concurrency: jobConcurrencyValue(form.concurrency),
    ...(form.kind === 'session' ? { session: jobSessionPayload(form.session) } : { session: undefined }),
  }
}
// 编辑任务:只提交 dirty 字段(+打开时的 updatedAt 基线)
function jobUpdatePayload(baseline, current) {
  const payload = {}
  for (const field of JOB_FORM_FIELDS) {
    if (current[field] !== baseline[field]) payload[field] = current[field]
  }
  if (current.concurrency !== baseline.concurrency) payload.concurrency = jobConcurrencyValue(current.concurrency)
  if (current.kind === 'session') {
    const sessionChanged = baseline.kind !== 'session'
      || JOB_SESSION_FIELDS.some((field) => current.session[field] !== baseline.session[field])
    if (sessionChanged) payload.session = jobSessionPayload(current.session)
  }
  payload.updatedAt = baseline.updatedAt
  return payload
}
/* JOBPATCH-END */
const TABS = [
  { value: 'jobs', label: '看板' },
  { value: 'envs', label: '环境变量' },
  { value: 'logs', label: '日志' },
]
const CRON_PRESETS = [
  { label: '每天 08:30', value: '30 8 * * *' },
  { label: '每天 22:00', value: '0 22 * * *' },
  { label: '每 30 分钟', value: '*/30 * * * *' },
  { label: '每 2 小时', value: '0 */2 * * *' },
  { label: '工作日 09:00', value: '0 9 * * 1-5' },
  { label: '每周一 09:00', value: '0 9 * * 1' },
  { label: '每月 1 日 00:00', value: '0 0 1 * *' },
]

const STYLE = `
/* 组件令牌层(形制对齐 dsh-im):宿主 dsw-alias 定义在 body 作用域,cb- 令牌必须在 body 声明才能解析到主题值;
   fallback 取浅色中性(dsh-im 同款),深色主题由令牌接管,fallback 只兜裸宿主 */
body{
--cb-bg:var(--dsw-alias-bg-layer-1);
--cb-bg-sub:var(--dsw-alias-bg-layer-2);
--cb-bg-muted:var(--dsw-alias-bg-module-platform);
--cb-border:var(--dsw-alias-border-l2);
--cb-border-strong:var(--dsw-alias-border-l3);
--cb-text:var(--dsw-alias-label-primary);
--cb-text-sub:var(--dsw-alias-label-secondary);
--cb-text-dim:var(--dsw-alias-label-tertiary);
--cb-accent:var(--dsw-alias-brand-primary);
--cb-accent-deep:var(--dsw-alias-button-primary-hover);
--cb-accent-wash:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
--cb-danger:var(--dsw-alias-state-error-primary);
--cb-ok:var(--dsw-alias-state-success-primary);
--cb-status-ok:var(--cb-ok);--cb-status-bad:var(--cb-danger);--cb-status-mute:var(--cb-text-dim);--cb-status-run:var(--cb-status-ok);
--cb-hover:var(--dsw-alias-interactive-bg-hover);
--cb-hover-danger:var(--dsw-alias-interactive-bg-hover-danger);
--cb-card:var(--dsw-alias-bg-layer-1);
--cb-mask:var(--dsw-alias-bg-mask-1);
--cb-shadow-lift:var(--dsw-shadow-lv1);
--cb-radius-sm:var(--dsw-radius-sm);--cb-radius-md:var(--dsw-radius-md);--cb-radius-lg:var(--dsw-radius-lg);
--cb-space-1:4px;--cb-space-2:8px;--cb-space-3:8px;--cb-space-4:12px;--cb-space-5:16px;--cb-space-6:24px;
--cb-font-xs:11px;--cb-font-sm:12px;--cb-font-md:13px;--cb-font-lg:16px;
--cb-control-h:32px;
}
.cb-panel{display:flex;flex-direction:column;gap:var(--cb-space-5);min-width:0;max-width:1080px;margin:0 auto;width:100%;color:var(--cb-text);font-size:var(--cb-font-md);line-height:20px;container-type:inline-size}
/* 全局面板壳:占满宿主中央区,滚动自持(main keyed 条目根) */
.cb-main{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:var(--cb-space-6);background:var(--cb-bg)}
.cb-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.cb-page-title{font-size:20px;font-weight:500;line-height:28px;margin:0}
.cb-page-desc{margin:4px 0 0;font-size:var(--cb-font-md);line-height:20px;color:var(--cb-text-sub)}
.cb-toolbar{display:flex;align-items:center;gap:var(--cb-space-3);flex-wrap:wrap;padding-bottom:var(--cb-space-4);border-bottom:.5px solid var(--cb-border)}
/* 页面级工具条只承担 Tab 与状态计数,不再叠第二条分隔线 */
.cb-toolbar--page{padding-bottom:0;border-bottom:0}
.cb-tabs{display:flex;gap:2px;background:var(--cb-bg-muted);border-radius:var(--cb-radius-md);padding:2px}
.cb-pill{border:none;border-radius:var(--cb-radius-sm);padding:0 14px;height:28px;font-size:var(--cb-font-md);background:transparent;color:var(--cb-text-sub);cursor:pointer;font-weight:500;transition:color .15s,background .15s}
.cb-pill:hover{color:var(--cb-text)}
.cb-pill--on{background:var(--cb-bg);color:var(--cb-text);font-weight:600}
.cb-pill--on:hover{color:var(--cb-text)}
/* 页面级 Tab 与列表筛选共用 pill 结构,靠容器形态分层:页面 Tab 无底胶囊,选中用下划线 */
.cb-tabs--page{background:transparent;border-radius:0;padding:0;gap:24px}
.cb-tabs--page .cb-pill{height:36px;border-radius:0;padding:0;border-bottom:2px solid transparent;color:var(--cb-text-sub)}
.cb-tabs--page .cb-pill:hover{color:var(--cb-text);background:transparent}
.cb-tabs--page .cb-pill--on{background:transparent;color:var(--cb-text);border-bottom-color:var(--cb-accent);font-weight:600}
.cb-tabs--page .cb-pill--on:hover{background:transparent;color:var(--cb-text)}
/* 工具条内的开关标签与同排按钮同字号 */
.cb-toolbar .cb-switch .cb-meta{font-size:13px;color:var(--cb-text-sub)}
.cb-spacer{flex:1}
.cb-button{min-height:var(--cb-control-h);display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-sm);padding:0 14px;font:inherit;font-size:var(--cb-font-md);font-weight:500;background:transparent;color:var(--cb-text);cursor:pointer;transition:border-color .15s,background .15s,color .15s;white-space:nowrap}
.cb-button:hover:not(:disabled){background:var(--cb-hover)}
.cb-button:disabled{cursor:not-allowed;opacity:.5}
.cb-button--primary{background:var(--cb-accent);border-color:var(--cb-accent);color:var(--dsw-alias-bg-base)}
.cb-button--primary:hover:not(:disabled){background:var(--cb-accent-deep);border-color:var(--cb-accent-deep)}
.cb-button--danger{color:var(--cb-danger);border-color:transparent}
.cb-button--danger:hover:not(:disabled){border-color:transparent;background:var(--cb-hover-danger);color:var(--cb-danger)}
/* 确认类弹窗的主操作:危险实底 + 反白,悬停不回退成浅底 */
.cb-button--danger-solid{background:var(--cb-danger);border-color:var(--cb-danger);color:var(--dsw-alias-bg-base)}
.cb-button--danger-solid:hover:not(:disabled){background:color-mix(in srgb, var(--cb-danger) 88%, var(--dsw-alias-label-primary));border-color:var(--cb-danger);color:var(--dsw-alias-bg-base)}
.cb-button--sm{min-height:28px;padding:0 10px;font-size:var(--cb-font-sm)}
.cb-button:focus-visible,.cb-icon:focus-visible,.cb-pill:focus-visible,.cb-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.cb-cards{display:flex;flex-direction:column;gap:6px}
.cb-card{position:relative;display:flex;flex-direction:column;gap:var(--cb-space-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--cb-radius-md);padding:10px var(--cb-space-5);cursor:pointer;overflow:hidden;background:var(--cb-card);box-shadow:inset 3px 0 0 var(--cb-status);transition:border-color .15s,background .15s}
.cb-card:hover{border-color:var(--cb-border-strong);background:var(--cb-hover)}
.cb-card:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
/* 暗色下卡面与页面同为 layer-1 会糊成一片:卡升一层,描边取 border-l4 */
body[data-ds-dark-theme] .cb-card{background:var(--dsw-alias-bg-layer-3)}
body[data-ds-dark-theme] .cb-card--automation{background:var(--cb-bg-sub)}
body[data-ds-dark-theme] .cb-card:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,var(--dsw-alias-label-primary))}
.cb-card--automation{background:var(--cb-bg-sub)}
.cb-card--automation:hover{background:var(--cb-hover)}
.cb-group{display:flex;flex-direction:column;gap:var(--cb-space-2);padding-top:var(--cb-space-4);border-top:.5px solid var(--cb-border)}
.cb-group-head{display:flex;align-items:center;gap:var(--cb-space-2);flex-wrap:wrap}
.cb-error--inline{display:flex;align-items:center;gap:var(--cb-space-3)}
html[data-cb-hide-host-automation-nav] nav > div:has(> button[aria-label="自动化任务"]),
html[data-cb-hide-host-automation-nav] nav > div:has(> button[aria-label="Automation tasks"]),
html[data-cb-hide-host-automation-nav] nav > div:has(> button[aria-label="自動化タスク"]),
html[data-cb-hide-host-automation-nav] nav > div:has(> button[aria-label="Tareas de automatización"]),
html[data-cb-hide-host-automation-nav] nav > div:has(> button[aria-label="Tâches d'automatisation"]),
html[data-cb-hide-host-automation-nav] nav > div:has(> button[aria-label="Automatisierungsaufgaben"]),
html[data-cb-hide-host-automation-nav] nav > div:has(> button[aria-label="Задачи автоматизации"]),
html[data-cb-hide-host-automation-nav] nav > div:has(> button[aria-label="Tarefas de automação"]),
html[data-cb-hide-host-automation-nav] nav > div:has(> button > span > div[data-slot="sidebar.panellist"] svg[data-icon="dsw-icon-clock-outline-regular"]){display:none!important}
.cb-card-row{display:flex;align-items:center;gap:var(--cb-space-3);flex-wrap:wrap}
.cb-name{font-size:14px;font-weight:600;line-height:22px;color:var(--cb-text)}
.cb-badge{min-height:20px;display:inline-flex;align-items:center;padding:0 8px;border-radius:999px;color:var(--cb-text-sub);background:var(--cb-bg-muted);font-size:var(--cb-font-xs);font-weight:500;line-height:18px;white-space:nowrap}
/* 模式标签是类型标签的附属说明,不占第二枚实底胶囊 */
.cb-badge--mode{background:transparent;padding:0;color:var(--cb-text-dim);font-weight:400}
.cb-dot{width:8px;height:8px;border-radius:50%;background:var(--cb-status);flex:none;box-shadow:0 0 0 1px color-mix(in srgb, var(--cb-text) 38%, transparent)}
.cb-meta{font-size:var(--cb-font-sm);line-height:18px;color:var(--cb-text-sub)}
/* 运行状态点:紧邻启停开关,专职表达上次运行成败;运行中用呼吸绿区分,不占第四种色相 */
@keyframes cb-pulse{0%,100%{opacity:1}50%{opacity:.62}}
.cb-dot--pulse{animation:cb-pulse 1.8s ease-in-out infinite}
.cb-actions{display:flex;align-items:center;gap:var(--cb-space-2);margin-left:auto;height:28px}
/* 卡内操作簇统一 28px 高度:32px 开关会把标题行整体撑高 */
.cb-actions .cb-switch{min-height:28px}
.cb-icon{min-height:28px;border:none;background:transparent;color:var(--cb-text-sub);cursor:pointer;font-size:var(--cb-font-sm);padding:0 8px;border-radius:var(--cb-radius-sm);transition:background .15s,color .15s}
.cb-icon:hover{background:var(--cb-hover);color:var(--cb-text)}
/* .cb-icon 的默认字色会盖掉 cb-button--danger,危险动作单独归位 */
.cb-icon.cb-button--danger{color:var(--cb-danger)}
.cb-icon.cb-button--danger:hover:not(:disabled){background:var(--cb-hover-danger);color:var(--cb-danger)}
.cb-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;gap:var(--cb-space-3);min-height:32px}
.cb-switch input[type="checkbox"] { position:absolute;opacity:0;width:1px;height:1px }
.cb-switch__track{width:34px;height:19px;border-radius:999px;background:var(--cb-bg-muted);position:relative;transition:background .15s;flex:none}
.cb-switch__thumb{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .15s}
.cb-switch input[type="checkbox"]:not(:checked) + .cb-switch__track{box-shadow:inset 0 0 0 1px var(--cb-text-dim)}
.cb-switch input[type="checkbox"]:not(:checked) + .cb-switch__track .cb-switch__thumb{box-shadow:0 0 0 1px color-mix(in srgb, var(--cb-text-dim) 55%, transparent)}
.cb-switch input[type="checkbox"]:checked + .cb-switch__track{background:var(--cb-accent)}
.cb-switch input[type="checkbox"]:checked + .cb-switch__track .cb-switch__thumb{left:18px}
.cb-switch input[type="checkbox"]:focus-visible + .cb-switch__track{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.cb-switch input[type="checkbox"]:disabled + .cb-switch__track{opacity:.4;cursor:not-allowed}
.cb-switch:not(:has(input[type="checkbox"]:disabled)):hover .cb-switch__track{opacity:.85}
.cb-switch input[type="checkbox"]:checked:not(:disabled) + .cb-switch__track:hover{background:var(--cb-accent-deep)}
/* 设置>插件页卡片(cb-pc):镜像官方 PluginCard/SubagentModelSelectionCard 形制,数值与令牌直取官方 CSS Module;
   官方壳未导出,slot 契约声明卡片外观归插件自持,同页同 dsw-alias 令牌即同观感(含深色主题) */
.cb-pc{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.cb-pc:hover{border-color:var(--dsw-alias-label-dimmed)}
.cb-pc--open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.cb-pc__head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.cb-pc__head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.cb-pc__text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.cb-pc__name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.cb-pc__desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.cb-pc__chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;transition:transform .16s}
.cb-pc--open .cb-pc__chevron{transform:rotate(180deg)}
.cb-pc__body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.cb-pc__row{gap:6px;padding:12px 0;display:grid}
.cb-pc__rowLine{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:center;gap:16px;font-size:13px;line-height:1.5;display:flex}
.cb-pc__rowLabel{flex:1;min-width:0}
.cb-pc__hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
/* 列表表格化:整组一个外框,行间 0.5px 分隔,行高 40;不再逐行独立卡片 */
.cb-table{display:flex;flex-direction:column;font-size:var(--cb-font-md);border:.5px solid var(--cb-border);border-radius:var(--cb-radius-md);overflow:hidden}
.cb-row{display:flex;align-items:center;gap:var(--cb-space-3);padding:4px var(--cb-space-4);min-height:40px;box-sizing:border-box;flex-wrap:wrap;border-bottom:.5px solid var(--cb-border);transition:background .15s}
.cb-row:last-child{border-bottom:0}
.cb-row .cb-meta{font-variant-numeric:tabular-nums}
.cb-row:hover{background:var(--cb-hover)}
.cb-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:var(--cb-font-sm);line-height:18px;color:var(--cb-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.cb-mask{color:var(--cb-text-sub)}
.cb-modal-mask{position:fixed;inset:0;background:var(--cb-mask);display:flex;align-items:center;justify-content:center;z-index:60;animation:cb-fade-in .16s ease-out}
.cb-modal{background:var(--cb-bg);color:var(--cb-text);border-radius:var(--cb-radius-lg);padding:var(--cb-space-6);max-width:640px;width:min(640px,94vw);max-height:90vh;overflow:hidden;display:flex;flex-direction:column;gap:14px;box-shadow:var(--dsw-shadow-lv3);animation:cb-pop-in .2s ease-out}
@keyframes cb-fade-in{from{opacity:0}to{opacity:1}}
@keyframes cb-pop-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.cb-modal-mask,.cb-modal{animation:none}.cb-dot--pulse{animation:none}.cb-card,.cb-row,.cb-button,.cb-pill,.cb-icon,.cb-switch__track,.cb-pc,.cb-pc__chevron{transition:none}}
.cb-modal-head{display:flex;align-items:center;justify-content:space-between;gap:var(--cb-space-3);padding-bottom:var(--cb-space-4);border-bottom:.5px solid var(--cb-border)}
.cb-modal-title{font-size:16px;line-height:24px;font-weight:600}
/* 弹窗底部与头部分隔线对齐;sticky 仍由 .cb-modal .cb-toolbar 承担 */
.cb-modal-footer{border-top:.5px solid var(--cb-border);padding-top:var(--cb-space-4)}
.cb-modal-body{display:flex;flex-direction:column;gap:var(--cb-space-4);flex:1 1 auto;min-height:0;overflow:auto}
.cb-modal .cb-toolbar{position:sticky;bottom:calc(-1 * var(--cb-space-6));z-index:1;background:var(--cb-bg);padding-top:var(--cb-space-3);border-bottom:0}
.cb-section{display:flex;flex-direction:column;gap:var(--cb-space-2)}
.cb-section-title{font-size:var(--cb-font-sm);font-weight:600;color:var(--cb-text);display:flex;align-items:center;gap:var(--cb-space-2)}
.cb-section-title::before{content:'';width:3px;height:12px;border-radius:999px;background:var(--cb-accent)}
.cb-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--cb-space-3) var(--cb-space-4)}
.cb-field{display:flex;flex-direction:column;gap:4px;font-size:var(--cb-font-sm);min-width:0;color:var(--cb-text-sub)}
.cb-field--wide{grid-column:1 / -1}
.cb-field input[type="text"],.cb-field input[type="number"],.cb-field textarea,.cb-field select{min-height:30px;border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:4px 10px;font:inherit;font-size:var(--cb-font-md);background:var(--cb-bg);color:var(--cb-text);min-width:0;transition:border-color .15s,box-shadow .15s}
.cb-field input:focus,.cb-field textarea:focus,.cb-field select:focus{outline:none;border-color:var(--cb-accent);box-shadow:0 0 0 3px var(--cb-accent-wash)}
.cb-field textarea{min-height:64px;resize:vertical;font-family:inherit}
.cb-hint{font-size:var(--cb-font-xs);color:var(--cb-text-dim)}
.cb-preview{font-size:var(--cb-font-sm);border:1px dashed var(--cb-border-strong);border-radius:var(--cb-radius-md);padding:var(--cb-space-2) var(--cb-space-3);color:var(--cb-text-sub);background:var(--cb-accent-wash);border-color:color-mix(in srgb, var(--cb-accent) 35%, transparent);color:var(--cb-text)}
/* —— 表单 v2:统一分段组件 + 调度构建器(设计稿 .superdesign/shots/7、8 锁定形态)—— */
/* seg:类型/会话模式/调度频率共用同一形态,禁止另起多套选择样式 */
.cb-seg{display:inline-flex;gap:2px;background:var(--cb-bg-muted);border-radius:var(--cb-radius-sm);padding:2px;width:fit-content}
.cb-seg__opt{border:none;background:transparent;border-radius:calc(var(--cb-radius-sm) - 2px);padding:0 12px;height:28px;font:inherit;font-size:var(--cb-font-md);font-weight:500;color:var(--cb-text-sub);cursor:pointer;line-height:20px;white-space:nowrap;transition:background .15s,color .15s}
.cb-seg__opt:hover{color:var(--cb-text)}
.cb-seg__opt--on{background:var(--cb-accent);color:var(--dsw-alias-bg-base);font-weight:560}
.cb-seg__opt--on:hover{color:var(--dsw-alias-bg-base)}
.cb-seg__opt:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
/* 调度构建器:极浅洗底面板,收纳频率/上下文/表达式/预览 */
.cb-builder{background:var(--cb-bg-sub);border:.5px solid var(--cb-border);border-radius:var(--cb-radius-md);padding:var(--cb-space-5);display:flex;flex-direction:column;gap:12px}
.cb-bline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.cb-blabel{font-size:var(--cb-font-sm);color:var(--cb-text-sub);flex:none}
.cb-time{width:44px;text-align:center;font-variant-numeric:tabular-nums}
.cb-colon{color:var(--cb-text-dim);font-size:var(--cb-font-sm)}
.cb-expr{font-family:var(--ds-font-family-code);font-size:var(--cb-font-sm);background:var(--cb-bg);border:.5px solid var(--cb-border);border-radius:var(--cb-radius-sm);padding:4px 10px;color:var(--cb-text);display:inline-flex;align-items:center;min-width:0}
.cb-expr input{border:none;background:transparent;font:inherit;color:var(--cb-text);padding:0;width:9em}
.cb-expr input:focus{outline:none}
.cb-linkbtn{border:none;background:transparent;color:var(--cb-accent);font:inherit;font-size:var(--cb-font-sm);font-weight:520;cursor:pointer;padding:0}
.cb-linkbtn:hover{color:var(--cb-accent-deep)}
.cb-runs{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.cb-run{display:inline-flex;align-items:center;gap:6px;font-size:var(--cb-font-xs);color:var(--cb-text-sub);background:var(--cb-bg);border:1px solid var(--cb-border);border-radius:999px;padding:2px 8px;white-space:nowrap}
.cb-run::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--cb-accent);flex:none}
.cb-run + .cb-run::before{background:var(--cb-text-dim)}
/* 紧凑行组:名称+类型 / 策略单行 */
.cb-formrow{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}
.cb-formrow > .cb-field{flex:1;min-width:180px}
.cb-formrow > .cb-field--fit{flex:0 0 auto;min-width:0;width:min(300px, 42%)}
/* 运行策略单行:标题+开关+内联数字段同一行 */
.cb-inline{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.cb-inlinesection{font-size:var(--cb-font-sm);font-weight:600;color:var(--cb-text);display:inline-flex;align-items:center;gap:6px}
.cb-inlinesection::before{content:'';width:3px;height:11px;border-radius:999px;background:var(--cb-accent)}
.cb-if{display:inline-flex;align-items:center;gap:6px}
.cb-if > .cb-field{flex-direction:row;align-items:center;gap:6px}
.cb-if input[type="number"]{width:104px}
.cb-log{font-family:ui-monospace,SFMono-Regular,monospace;font-size:var(--cb-font-sm);white-space:pre-wrap;word-break:break-all;background:var(--cb-bg-sub);border-radius:var(--cb-radius-md);padding:var(--cb-space-3);max-height:320px;overflow:auto}
.cb-empty{font-size:14px;line-height:22px;color:var(--cb-text-sub);padding:var(--cb-space-6) 0;text-align:center;display:flex;flex-direction:column;align-items:center;gap:var(--cb-space-4)}
.cb-select{min-height:var(--cb-control-h);border:1px solid var(--cb-border-strong);border-radius:var(--cb-radius-sm);padding:4px 8px;font:inherit;font-size:var(--cb-font-md);background:var(--cb-bg);color:var(--cb-text)}
.cb-confirm-text{font-size:var(--cb-font-md);color:var(--cb-text);line-height:1.5}
.cb-log::-webkit-scrollbar,.cb-modal::-webkit-scrollbar{width:8px;height:8px}
.cb-log::-webkit-scrollbar-thumb,.cb-modal::-webkit-scrollbar-thumb{background:var(--cb-border-strong);border-radius:999px}
.cb-log::-webkit-scrollbar-track,.cb-modal::-webkit-scrollbar-track{background:transparent}
.cb-error{font-size:var(--cb-font-sm);color:var(--cb-danger);background:var(--cb-bg-sub);border-left:3px solid var(--cb-danger);border-radius:var(--cb-radius-sm);padding:var(--cb-space-2) var(--cb-space-3)}
/* 容器查询:会话视图区与 better-sidebar tab 宽度差异大,跟随面板自身宽度而非视口。
   模态不受面板容器宽度连累:mask 固定定位于视口,断点用视口媒体查询独立判定 */
@container (max-width: 560px){
.cb-card-row .cb-actions{margin-left:0;width:100%;justify-content:flex-end;flex-wrap:wrap}
.cb-panel{gap:var(--cb-space-4)}
}
@media (max-width: 560px){
.cb-grid{grid-template-columns:1fr}
.cb-modal{max-height:92vh}
.cb-main{padding:var(--cb-space-4)}
}
`

// 空模块兜底:react 缺席即整面板禁用(宿主必有 react,防御性)
function noopFactory() {
  return { inject: [], apply() {} }
}

/* STYLE-ENSURE-BEGIN */
const STYLE_ID = 'dsh-cron-board-style'
// 样式单例:按 id 命中即原位复用,复用路径必须无条件补 data-plugin——修复前旧代节点
// 可能缺标记,缺标记样式会被宿主 claimStyles 归属给后续材质化插件,其 HMR 重建即整批删除本包样式。
function ensureStyle(document, css) {
  const style = document.getElementById(STYLE_ID) || document.createElement('style')
  style.id = STYLE_ID
  style.setAttribute('data-plugin', '@mzzsfy/dsh-cron-board')
  if (style.textContent !== css) style.textContent = css
  if (style.isConnected !== true) document.head.appendChild(style)
  return style
}
/* STYLE-ENSURE-END */

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: '@mzzsfy/dsh-cron-board', factory })

  // 导航图标声明:交给 dsh-settings-nav-icons 统一渲染;键 = 市场短名(发现页
  // 收录显示形态);该插件未就绪时入队,由其启动时排空
  const NAV_ICON = { 'dsh-cron-board': 'plan' }
  if (window.__navicIcons !== undefined) window.__navicIcons.register(NAV_ICON)
  else if (Array.isArray(window.__navicIconQueue)) window.__navicIconQueue.push(NAV_ICON)
  else window.__navicIconQueue = [NAV_ICON]

  function factory(require) {
    let React = null
    try {
      React = require('react')
    } catch (error) {
      // 宿主种子表异常的防御兜底:干净禁用但必须显式报错,禁止静默
      console.error('[cron-board] react 加载失败,面板禁用:', error)
      return noopFactory()
    }
    // 公共工具库为总线订阅硬消费:数据刷新唯一通道,缺失即 factory 抛错交装载层判定
    // (client-dependency 规约),禁止吞成静默禁用;装载行由本包 cordis.patch.yml 自带,
    // 见 README「依赖」节
    const tools = require('@mzzsfy/dsh-common-tools/client')
    const { useState, useEffect, useRef, useCallback } = React
    const h = (type, props, ...children) => React.createElement(type, props ?? null, ...children)

    // 数据请求:统一 envelope,error 透传中文业务文案
    async function request(method, endpoint, body) {
      let response
      try {
        response = await fetch(API_PREFIX + endpoint, {
          method,
          // 写方法即使无体也必须带 JSON 类型:装配层 withRouteGate 对 POST/PATCH/DELETE 一律校验
          headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) }
      }
      let json = null
      try { json = await response.json() } catch { json = null }
      if (!response.ok) return { ok: false, error: json && json.error ? json.error : '请求失败(' + response.status + ')' }
      return { ok: true, data: json }
    }

    // 文本文件导出:日志全文只在用户显式导出时取(Blob + 临时 <a download>)
    function downloadText(name, text) {
      const url = URL.createObjectURL(new Blob([text ?? ''], { type: 'text/plain;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener'
      anchor.click()
      // 交还对象 URL 须在点击之后:同步撤销会让下载拿到空内容
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }

    const statusReaders = new WeakMap()
    function createStatusReader(bus) {
      let pending = null, resolvePending
      const snapshot = tools.createSnapshotRefresh(async () => {
        const outcome = await request('GET', 'status')
        const resolve = resolvePending
        pending = resolvePending = null
        resolve?.(outcome)
      })
      const read = () => pending ??= new Promise(resolve => { resolvePending = resolve; snapshot.refresh() })
      statusReaders.set(bus, read)
      return () => {
        snapshot.dispose()
        statusReaders.delete(bus)
        resolvePending?.({ ok: false, error: '插件已卸载' })
        pending = resolvePending = null
      }
    }

    // 规约 switch:input 锚定状态选择器,视觉由 track+thumb 呈现
    function switchToggle(props) {
      return h('label', { className: 'cb-switch' },
        h('input', { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: props.onChange,
          title: props.title, 'aria-label': props.ariaLabel }),
        h('span', { className: 'cb-switch__track' }, h('span', { className: 'cb-switch__thumb' })),
        props.label ? h('span', { className: 'cb-meta' }, props.label) : null)
    }

    function PillGroup({ options, value, onChange, variant }) {
      return h('div', { className: 'cb-tabs' + (variant === 'page' ? ' cb-tabs--page' : '') },
        options.map((option) => h('button', {
          key: option.value,
          className: 'cb-pill' + (option.value === value ? ' cb-pill--on' : ''),
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    function Field({ label, hint, wide, fit, children }) {
      return h('div', { className: 'cb-field' + (wide ? ' cb-field--wide' : '') + (fit ? ' cb-field--fit' : '') },
        h('span', null, label),
        children,
        hint ? h('span', { className: 'cb-hint' }, hint) : null)
    }

    function Modal({ title, onClose, children, width }) {
      const bodyRef = useRef(null)
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        const first = bodyRef.current && bodyRef.current.querySelector('input, textarea, select')
        if (first) first.focus()
        return () => document.removeEventListener('keydown', onKey)
      }, [])
      return h('div', { className: 'cb-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'cb-modal', style: width ? { width: 'min(' + width + 'px, 92vw)' } : null },
          h('div', { className: 'cb-modal-head' },
            h('span', { className: 'cb-modal-title' }, title),
            h('button', { className: 'cb-icon', 'aria-label': '关闭', onClick: onClose }, '✕')),
          h('div', { className: 'cb-modal-body', ref: bodyRef }, children)))
    }

    // 节标题:表单分区渐进披露(基础/执行/调度)
    function Section({ title, children }) {
      return h('div', { className: 'cb-section' },
        h('div', { className: 'cb-section-title' }, title),
        children)
    }

    // —— 任务表单(新建/编辑)——
    // v2 布局(设计稿 shots/7、8 锁定):统一分段组件(cb-seg)承担类型/会话模式/调度频率切换;
    // 调度构建器洗底面板:结构化频率生成表达式,反解不出即 custom 手输;触发点预览仍归后端 cron/preview。
    function Segmented({ options, value, onChange, ariaLabel, multi, selected }) {
      // multi:周几类多选切换;与单选共用同一 DOM/CSS 形态,仅选中判定不同
      const isOn = (optionValue) => (multi ? selected.includes(optionValue) : optionValue === value)
      return h('div', { className: 'cb-seg', role: 'group', 'aria-label': ariaLabel },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          'aria-pressed': multi ? isOn(option.value) : undefined,
          className: 'cb-seg__opt' + (isOn(option.value) ? ' cb-seg__opt--on' : ''),
          onClick: () => onChange(option.value),
        }, option.label)))
    }

    const FREQ_OPTIONS = [
      { value: 'daily', label: '每天' },
      { value: 'weekly', label: '每周' },
      { value: 'weekdays', label: '工作日' },
      { value: 'interval', label: '固定间隔' },
      { value: 'custom', label: '自定义' },
    ]

    // 调度构建器面板:频率分段 + 上下文选择器 + 时区行 + 表达式芯片 + 即将执行 chips
    function ScheduleBuilder({ scheduleState, onStateChange, preview, previewError, serverTzOffset }) {
      const state = scheduleState
      const setFreq = (freq) => onStateChange({ ...state, freq })
      const patchClock = (field, raw) => {
        const value = Math.max(0, Math.min(field === 'hour' ? SB_HOUR_MAX : SB_MINUTE_MAX, Number(raw) || 0))
        onStateChange({ ...state, [field]: value })
      }
      const toggleWeekday = (day) => {
        const days = state.weekdays.includes(day)
          ? state.weekdays.filter((d) => d !== day)
          : SB_WEEKDAY_ORDER.filter((d) => state.weekdays.includes(d) || d === day)
        if (days.length === 0) return
        onStateChange({ ...state, weekdays: days })
      }
      // 时区选择:非整点偏移无后缀语法,选中即回退宿主默认(null),不留「下拉值与表达式不一致」
      const setTz = (raw) => onStateChange({ ...state, timezone: raw === 'host' ? null : tzSuffixOffset(Number(raw)) })
      const displayTzOffset = state.timezone == null ? serverTzOffset : state.timezone
      const clockRow = (h('div', { className: 'cb-bline' },
        h('span', { className: 'cb-blabel' }, '执行时间'),
        h('input', { type: 'number', className: 'cb-time', min: 0, max: SB_HOUR_MAX, value: state.hour, onChange: (e) => patchClock('hour', e.target.value) }),
        h('span', { className: 'cb-colon' }, ':'),
        h('input', { type: 'number', className: 'cb-time', min: 0, max: SB_MINUTE_MAX, value: state.minute, onChange: (e) => patchClock('minute', e.target.value) }),
        h('span', { className: 'cb-hint' }, state.freq === 'weekdays' ? '周一至周五在指定时刻运行' : state.freq === 'weekly' ? '所选星期在指定时刻运行' : '按天在指定时刻运行')))
      const intervalRow = (h('div', { className: 'cb-bline' },
        h('span', { className: 'cb-blabel' }, '间隔'),
        h('input', { type: 'number', className: 'cb-time', min: SB_INTERVAL_MIN_MINUTES, max: SB_MINUTE_MAX, value: state.intervalMinutes, onChange: (e) => onStateChange({ ...state, intervalMinutes: Math.max(SB_INTERVAL_MIN_MINUTES, Number(e.target.value) || SB_INTERVAL_MIN_MINUTES) }) }),
        h('span', { className: 'cb-hint' }, '分钟,每 N 分钟运行一次')))
      const customRow = (h('div', { className: 'cb-bline' },
        h('span', { className: 'cb-blabel' }, '表达式'),
        h('input', { type: 'text', value: state.expression, placeholder: '分 时 日 月 周', onChange: (e) => onStateChange({ ...state, expression: e.target.value }) }),
        h('span', { className: 'cb-hint' }, '分 时 日 月 周;预设: ' + CRON_PRESETS.slice(0, 3).map((p) => p.label + ' ' + p.value).join(' / '))))
      return h('div', { className: 'cb-builder' },
        h(Segmented, { options: FREQ_OPTIONS, value: state.freq, onChange: setFreq, ariaLabel: '调度频率' }),
        state.freq === 'interval' ? intervalRow : null,
        state.freq === 'custom' ? customRow : clockRow,
        state.freq === 'weekly'
          ? h('div', { className: 'cb-bline' },
              h('span', { className: 'cb-blabel' }, '星期'),
              h(Segmented, {
                multi: true,
                selected: state.weekdays,
                options: SB_WEEKDAY_ORDER.map((d) => ({ value: d, label: SB_WEEKDAY_LABELS[d] })),
                onChange: toggleWeekday,
                ariaLabel: '星期',
              }))
          : null,
        h('div', { className: 'cb-bline' },
          h('span', { className: 'cb-blabel' }, '生成表达式'),
          h('span', { className: 'cb-expr' }, buildSchedule(state)),
          state.freq === 'custom'
            ? null
            : h('button', { type: 'button', className: 'cb-linkbtn', onClick: () => setFreq('custom') }, '自定义'),
          state.freq === 'custom' ? null : h('span', { className: 'cb-hint' }, '由上方选择自动生成')),
        h('div', { className: 'cb-bline' },
          h('span', { className: 'cb-blabel' }, '时区'),
          // 选项必须覆盖当前值(兜底项):select 的 value 找不到 option 时渲染空白
          h('select', { className: 'cb-select', value: state.timezone == null ? 'host' : String(state.timezone), onChange: (e) => setTz(e.target.value) },
            h('option', { value: 'host' }, '宿主默认' + (typeof serverTzOffset === 'number' ? '(UTC' + sbFormatTzOffset(serverTzOffset) + ')' : '')),
            tzSelectOptions(state.timezone).map((offset) => h('option', { key: offset, value: String(offset) }, 'UTC' + sbFormatTzOffset(offset)))),
          h('span', { className: 'cb-hint' }, '固定偏移不随夏令时变化;写入表达式后缀 T±N(仅整小时)')),
        h('div', { className: 'cb-bline' },
          h('span', { className: 'cb-blabel' }, '即将执行'),
          preview
            ? h('span', { className: 'cb-runs' }, preview.nextAt.map((at) => h('span', { key: at, className: 'cb-run' }, formatDateTime(at, displayTzOffset))))
            : h('span', { className: 'cb-hint' }, previewError || '表达式非法或计算中')))
    }

    function JobForm({ job, onDone, wsModel, serverTzOffset }) {
      // 工作区清单:订阅 model 快照(服务缺失或形态不符即空表,仅保留手输)
      const [wsItems, setWsItems] = useState(() => (wsModel ? wsModel.getSnapshot().items || [] : []))
      useEffect(() => {
        if (!wsModel) return undefined
        const update = () => setWsItems(wsModel.getSnapshot().items || [])
        update()
        return wsModel.subscribe(update)
      }, [wsModel])
      const editing = Boolean(job && job.id)
      // 构建器初始状态:新建任务把设备时区偏移固化为显式后缀,
      // 宿主环境时区异常(如 UTC)时任务仍按设备预期时刻触发;编辑存量保持原表达式语义。
      // 非整点设备时区(+5:30/+5:45)无后缀语法,回退宿主默认 —— 取整成相邻整点会整体错半小时
      const [scheduleState, setScheduleState] = useState(() => {
        const parsed = parseSchedule(job ? job.schedule : '0 9 * * *')
        if (!editing) parsed.timezone = tzSuffixOffset(deviceTzOffset())
        return parsed
      })
      const initialSchedule = editing ? job.schedule : buildSchedule(scheduleState)
      const buildForm = () => ({
        name: job ? job.name : '',
        kind: job ? job.kind : 'shell',
        command: job ? job.command : '',
        prompt: job ? job.prompt : '',
        workdir: job ? job.workdir : '',
        schedule: initialSchedule,
        timeoutMs: job ? job.timeoutMs : 60 * 60 * 1000,
        runOnce: job ? job.runOnce === true : false,
        concurrency: job && job.concurrency ? String(job.concurrency) : '',
        enabled: job ? job.enabled : true,
        // 打开时的行版本:编辑提交原样带回,服务端据此做乐观锁(409)
        updatedAt: job ? job.updatedAt : undefined,
        session: {
          mode: job && job.session ? job.session.mode : 'fresh',
          pinnedSessionId: job && job.session ? job.session.pinnedSessionId : '',
          agentPreset: job && job.session ? job.session.agentPreset : '',
          // 表单态为序列化 key(分隔符见 MODELKEY 段 / '' = 跟随宿主默认),提交时还原对象
          modelKey: serializeModelKey(job && job.session ? job.session.model : undefined),
        },
      })
      const [form, setForm] = useState(buildForm)
      // dirty 比对基线:打开编辑器时的快照,生命周期内不变
      const [initialForm] = useState(buildForm)
      const [preview, setPreview] = useState(null)
      const [previewError, setPreviewError] = useState(null)
      const [error, setError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [presetCatalog, setPresetCatalog] = useState({ defaultId: '', items: [] })
      const [modelCatalog, setModelCatalog] = useState({ default: null, items: [], failures: [] })
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))
      const setSession = (patch) => setForm((prev) => ({ ...prev, session: { ...prev.session, ...patch } }))
      // 模型选择派生态:modelKey 仍指向目录中存在的项才有效(目录刷新后残留项回退默认)
      const modelSelected = parseModelKey(form.session.modelKey)
      const selectedModelMeta = modelSelected
        ? (modelCatalog.items.find((group) => group.provider === modelSelected.provider) || { models: [] }).models.find((model) => model.id === modelSelected.model)
        : null
      const applyScheduleState = (next) => {
        // custom 频率下表达式携带合法后缀时以表达式为准(剥离归一并回填时区);
        // 无后缀保留调用方传入的时区(select 与频率切换不丢配置);非法后缀原文保留且时区置空
        if (next.freq === 'custom') {
          try {
            const split = sbSplitScheduleTz(next.expression)
            if (split.timezoneOffset != null) next = { ...next, expression: split.base, timezone: split.timezoneOffset }
          } catch {
            next = { ...next, timezone: null }
          }
        }
        setScheduleState(next)
        set({ schedule: buildSchedule(next) })
      }

      // 执行预设目录:会话任务表单打开时拉取一次;服务缺失即空目录,仅「跟随宿主默认」可选
      useEffect(() => {
        let alive = true
        request('GET', 'agent-presets').then((outcome) => {
          if (alive && outcome.ok && outcome.data && Array.isArray(outcome.data.items)) setPresetCatalog(outcome.data)
        })
        // 模型目录同源拉取:失败或宿主不支持即空目录,仅「跟随宿主默认」可选
        request('GET', 'model-catalog').then((outcome) => {
          if (alive && outcome.ok && outcome.data && Array.isArray(outcome.data.items)) setModelCatalog(outcome.data)
        })
        return () => { alive = false }
      }, [])

      useEffect(() => {
        let alive = true
        // 表达式变更即清空旧错误:防抖窗口内不残留上一次失败文案
        setPreviewError(null)
        const timer = setTimeout(async () => {
          const outcome = await request('POST', 'cron/preview', { schedule: form.schedule })
          if (!alive) return
          setPreview(outcome.ok ? outcome.data : null)
          setPreviewError(outcome.ok ? null : outcome.error)
        }, 300)
        return () => { alive = false; clearTimeout(timer) }
      }, [form.schedule])

      const submit = async () => {
        if (saving) return
        setSaving(true)
        setError(null)
        // 编辑只提交 dirty 字段 + updatedAt 基线;新建提交完整字段集
        const payload = editing ? jobUpdatePayload(initialForm, form) : jobCreatePayload(form)
        const outcome = await request(editing ? 'PATCH' : 'POST', editing ? 'jobs/' + job.id : 'jobs', payload)
        setSaving(false)
        if (outcome.ok) onDone()
        else setError(outcome.error)
      }

      return h(Modal, { title: editing ? '编辑任务' : '新建任务', onClose: onDone, width: 640 },
        h('div', { className: 'cb-formrow' },
          h(Field, { label: '名称' }, h('input', { type: 'text', value: form.name, onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: '类型', fit: true }, h(Segmented, {
            options: [{ value: 'shell', label: KIND_LABELS.shell }, { value: 'session', label: KIND_LABELS.session }],
            value: form.kind,
            onChange: (kind) => set({ kind }),
            ariaLabel: '类型',
          }))),
        h(Section, { title: '调度计划' },
          h(ScheduleBuilder, { scheduleState, onStateChange: applyScheduleState, preview, previewError, serverTzOffset })),
        form.kind === 'shell'
          ? h(Section, { title: '运行配置(shell)' },
              h(Field, { label: '命令', hint: '经由宿主 shell 执行,支持环境变量插值 $NAME' },
                h('input', { type: 'text', value: form.command, onChange: (e) => set({ command: e.target.value }) })),
              h('div', { className: 'cb-formrow' },
                h(Field, { label: '工作目录(可空)' }, h('input', { type: 'text', value: form.workdir, onChange: (e) => set({ workdir: e.target.value }) }))))
          : h(Section, { title: '运行配置(会话)' },
              h('div', { className: 'cb-formrow' },
                h(Field, {
                  label: '工作区(会话 cwd,可空)',
                  hint: wsItems.length > 0 ? '从宿主工作区选择,或留空使用默认目录' : '留空使用宿主默认目录;填入路径则会话在该目录下创建',
                },
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    wsItems.length > 0
                      ? h('select', {
                          className: 'cb-select',
                          value: wsItems.some((w) => w.path === form.workdir) ? form.workdir : '',
                          onChange: (e) => set({ workdir: e.target.value }),
                        },
                          h('option', { value: '' }, '默认目录'),
                          wsItems.map((w) => h('option', { key: w.path || w.workspaceId, value: w.path }, w.title || w.path)))
                      : null,
                    h('input', { type: 'text', placeholder: '或手输路径', value: form.workdir, onChange: (e) => set({ workdir: e.target.value }) }))),
                h(Field, { label: '会话模式', fit: true },
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h(Segmented, {
                      options: [{ value: 'fresh', label: MODE_LABELS.fresh }, { value: 'pinned', label: MODE_LABELS.pinned }],
                      value: form.session.mode,
                      onChange: (mode) => setSession({ mode }),
                      ariaLabel: '会话模式',
                    }),
                    form.session.mode === 'pinned'
                      ? h('input', {
                          type: 'text',
                          placeholder: '固定会话 ID(可空,首跑自动绑定)',
                          title: '留空则首跑自动绑定;会话被删除或归档时自动重建并回写',
                          value: form.session.pinnedSessionId,
                          onChange: (e) => setSession({ pinnedSessionId: e.target.value }),
                        })
                      : null))),
              h(Field, { label: '执行预设', hint: '会话使用的 Agent Preset;跟随宿主默认时由宿主解析当前默认' },
                h('select', {
                  className: 'cb-select',
                  value: presetCatalog.items.some((item) => item.id === form.session.agentPreset) ? form.session.agentPreset : '',
                  onChange: (e) => setSession({ agentPreset: e.target.value }),
                },
                  h('option', { value: '' }, '跟随宿主默认'),
                  presetCatalog.items.map((item) => h('option', { key: item.id, value: item.id }, item.label)))),
              h(Field, {
                label: '模型',
                hint: modelCatalog.failures.length > 0
                  ? '部分 provider 目录加载失败:' + modelCatalog.failures.map((item) => item.name || item.id).join('、')
                  : '仅作用于本任务的会话;跟随宿主默认时不改变任何全局设置',
              },
                h('select', {
                  className: 'cb-select',
                  value: modelSelected ? serializeModelKey(modelSelected) : form.session.modelKey,
                  onChange: (e) => setSession({ modelKey: e.target.value }),
                },
                  h('option', { value: '' }, '跟随宿主默认'),
                  modelCatalog.items.map((group) => h('optgroup', { key: group.provider, label: group.name },
                    group.models.map((model) => {
                      // 选项 value 统一经 serializeModelKey 产出:与解析侧同分隔符,防三侧漂移
                      const value = serializeModelKey({ provider: group.provider, model: model.id, ...(model.efforts.length > 0 && model.defaultEffort ? { reasoningEffort: model.defaultEffort } : {}) })
                      return h('option', { key: value, value }, model.name)
                    }))))),
              modelSelected && selectedModelMeta && selectedModelMeta.efforts.length > 0
                ? h(Field, { label: '推理强度', hint: '仅作用于本任务;跟随模型默认时由模型解析' },
                    h('select', {
                      className: 'cb-select',
                      value: modelSelected.reasoningEffort || '',
                      onChange: (e) => setSession({ modelKey: serializeModelKey({ ...modelSelected, reasoningEffort: e.target.value }) }),
                    },
                      h('option', { value: '' }, '跟随模型默认'),
                      selectedModelMeta.efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name))))
                : null,
              h(Field, { label: '任务文本', hint: '投递给会话的任务内容,环境变量会折叠在文本前部' },
                h('textarea', { value: form.prompt, onChange: (e) => set({ prompt: e.target.value }) }))),
        h('div', { className: 'cb-inline' },
          h('span', { className: 'cb-inlinesection' }, '运行策略'),
          switchToggle({ checked: form.runOnce, onChange: (e) => set({ runOnce: e.target.checked }), label: '单次运行' }),
          form.kind === 'shell'
            ? h('span', { className: 'cb-if' },
                h('span', { className: 'cb-blabel' }, '超时'),
                h('input', { type: 'number', value: form.timeoutMs, title: '毫秒,超时即中断并标记失败', onChange: (e) => set({ timeoutMs: Number(e.target.value) }) }),
                h('span', { className: 'cb-hint' }, 'ms'))
            : null,
          form.kind === 'shell'
            ? h('span', { className: 'cb-if' },
                h('span', { className: 'cb-blabel' }, '并发上限'),
                h('input', { type: 'number', value: form.concurrency, style: { width: 72 }, title: '限制该任务同时进行的执行数,可空', onChange: (e) => set({ concurrency: e.target.value }) }))
            : null,
          form.kind === 'session' ? h('span', { className: 'cb-hint' }, '会话任务投递即完成,无超时与并发语义') : null),
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar cb-modal-footer' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          switchToggle({ checked: form.enabled, onChange: (e) => set({ enabled: e.target.checked }), label: '启用' }),
          h('button', { className: 'cb-button cb-button--primary', disabled: saving, onClick: submit }, saving ? '保存中…' : '保存')))
    }

    function JobCard({ job, now, onToggle, onRun, onEdit, onDelete }) {
      const meta = statusMeta(job.lastStatus)
      const enabled = Boolean(job.enabled)
      // 卡片色随启用态;上次运行成败另用状态点表达,两种语义不再抢同一个点
      const tone = enabled ? (job.lastStatus ? meta.tone : 'ok') : 'mute'
      const style = { '--cb-status': STATUS_TONE_COLOR[tone] }
      return h('div', { className: 'cb-card', style, role: 'button', tabIndex: 0, onClick: onEdit },
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-name' }, job.name),
          h('span', { className: 'cb-badge' }, KIND_LABELS[job.kind] || job.kind),
          job.kind === 'session' && job.session ? h('span', { className: 'cb-badge cb-badge--mode' }, MODE_LABELS[job.session.mode]) : null,
          h('div', { className: 'cb-actions', onClick: (event) => event.stopPropagation() },
            h('span', { className: 'cb-dot cb-dot--state' + (meta.tone === 'run' ? ' cb-dot--pulse' : ''), style: { '--cb-status': STATUS_TONE_COLOR[meta.tone] }, title: job.lastStatus ? '上次运行:' + meta.label : '尚未运行' }),
            switchToggle({ checked: Boolean(job.enabled), onChange: onToggle }),
            h('button', { className: 'cb-button cb-button--sm', disabled: !job.enabled, title: job.enabled ? '立即运行' : '已停用', onClick: onRun }, '运行'),
            h('button', { className: 'cb-icon', title: '编辑', onClick: onEdit }, '编辑'),
            h('button', { className: 'cb-icon cb-button--danger', title: '删除', onClick: onDelete }, '删除'))),
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-meta' }, job.lastStatus ? meta.label : '未运行'),
          h('span', { className: 'cb-meta' }, job.summary || job.schedule),
          typeof job.nextRunAt === 'number' && job.enabled ? h('span', { className: 'cb-meta' }, '下次 ' + relativeTime(job.nextRunAt, now)) : null,
          typeof job.lastDurationMs === 'number' ? h('span', { className: 'cb-meta' }, '耗时 ' + formatDuration(job.lastDurationMs)) : null),
        h('div', { className: 'cb-code' }, job.kind === 'session' ? job.prompt : job.command))
    }

    // 宿主自动化任务只读卡:点击打开宿主页面管理,不在本插件内复制编辑/删除/启停
    function AutomationTaskCard({ task, now, onOpen }) {
      const status = automationStatusMeta(task.status)
      const style = { '--cb-status': STATUS_TONE_COLOR[status.tone] }
      const meta = [automationFrequency(task), automationNextText(task, now), automationTargetLabel(task)].filter(Boolean)
      return h('div', {
        className: 'cb-card cb-card--automation', style, role: 'button', tabIndex: 0,
        onClick: onOpen,
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } },
      },
        h('div', { className: 'cb-card-row' },
          h('span', { className: 'cb-name' }, task.title || '(未命名)'),
          h('span', { className: 'cb-badge' }, '自动化'),
          h('span', { className: 'cb-badge' }, status.label),
          h('div', { className: 'cb-actions' },
            h('span', { className: 'cb-dot cb-dot--state', style: { '--cb-status': STATUS_TONE_COLOR[status.tone] }, title: status.label }),
            h('span', { className: 'cb-hint' }, '点击打开宿主页面'))),
        h('div', { className: 'cb-card-row' },
          meta.map((text, index) => h('span', { className: 'cb-meta', key: index }, text))),
        task.prompt ? h('div', { className: 'cb-code' }, task.prompt) : null)
    }

    // 应用内删除确认(替换 window.confirm:风格统一 + ESC 可取消)
    function ConfirmDialog({ message, onConfirm, onCancel }) {
      return h(Modal, { title: '删除确认', onClose: onCancel, width: 420 },
        h('div', { className: 'cb-confirm-text' }, message),
        h('div', { className: 'cb-toolbar cb-modal-footer' },
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: onCancel }, '取消'),
          h('button', { className: 'cb-button cb-button--danger-solid', onClick: onConfirm }, '删除')))
    }

    function JobsTab({ jobs, status, now, reload, applyJobPatch, wsModel, automationOn, automationAvailable, automationBusy, onToggleAutomation, automationTasks, automationError, onOpenAutomation }) {
      const [formJob, setFormJob] = useState(null)
      const [notice, setNotice] = useState(null)
      const [kindFilter, setKindFilter] = useState('all')
      const [pendingDelete, setPendingDelete] = useState(null)

      const runJob = async (job) => {
        const outcome = await request('POST', 'jobs/' + job.id + '/run')
        setNotice(outcome.ok ? '已发起 ' + outcome.data.runIds.length + ' 个运行' : outcome.error)
        setTimeout(reload, 300)
      }
      const toggleJob = async (job) => {
        // 乐观翻转:受控开关即时到位;失败回滚并提示,不静默
        applyJobPatch(job.id, { enabled: !job.enabled })
        const outcome = await request('PATCH', 'jobs/' + job.id, { enabled: !job.enabled })
        if (!outcome.ok) {
          applyJobPatch(job.id, { enabled: job.enabled })
          setNotice('切换失败:' + outcome.error)
        }
        reload()
      }
      const deleteJob = async (job) => {
        const outcome = await request('DELETE', 'jobs/' + job.id)
        setPendingDelete(null)
        if (!outcome.ok) {
          // 失败(并发删除/写失败)必须提示并以服务端状态对账,不得宣称已删除
          setNotice('删除失败:' + outcome.error)
          reload()
          return
        }
        setNotice('已删除「' + job.name + '」')
        reload()
      }

      const visible = jobs.filter((job) => kindFilter === 'all' || job.kind === kindFilter)
        .sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0))
      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h(PillGroup, {
            options: [{ value: 'all', label: '全部' }, { value: 'shell', label: KIND_LABELS.shell }, { value: 'session', label: KIND_LABELS.session }],
            value: kindFilter,
            onChange: setKindFilter,
          }),
          h('div', { className: 'cb-spacer' }),
          status && !status.timerRunning ? h('span', { className: 'cb-badge', style: { color: 'var(--cb-danger)' } }, status.timerReason || '调度停用') : null,
          switchToggle({
            checked: automationOn,
            disabled: automationBusy || (!automationAvailable && !automationOn),
            onChange: (event) => onToggleAutomation(event.target.checked),
            label: '自动化任务',
            ariaLabel: '显示自动化任务',
            title: automationAvailable ? '在看板下方显示宿主自动化任务(只读),并隐藏侧栏重复入口' : '宿主未提供自动化任务服务',
          }),
          h('button', { className: 'cb-button cb-button--primary', onClick: () => setFormJob({}) }, '新建任务')),
        notice ? h('div', { className: 'cb-hint' }, notice) : null,
        !automationOn && automationError ? h('div', { className: 'cb-error cb-error--inline', role: 'alert' },
          h('span', null, automationError)) : null,
        visible.length === 0
          ? h('div', { className: 'cb-empty' },
              h('div', null, kindFilter === 'all' ? '还没有定时任务' : '该类型下暂无任务'),
              h('button', { className: 'cb-button cb-button--primary', onClick: () => setFormJob({}) }, '新建任务'))
          : h('div', { className: 'cb-cards' },
              visible.map((job) => h(JobCard, {
                key: job.id, job, now,
                onToggle: () => toggleJob(job),
                onRun: () => runJob(job),
                onEdit: () => setFormJob(job),
                onDelete: () => setPendingDelete(job),
              }))),
        automationOn ? h('div', { className: 'cb-group' },
          h('div', { className: 'cb-group-head' },
            h('div', { className: 'cb-section-title' }, '自动化任务'),
            h('span', { className: 'cb-hint' }, '宿主内置 · 只读'),
            h('div', { className: 'cb-spacer' }),
            h('button', { className: 'cb-linkbtn', onClick: onOpenAutomation }, '打开自动化任务页')),
          automationError ? h('div', { className: 'cb-error cb-error--inline', role: 'alert' },
            h('span', null, automationError),
            h('button', { className: 'cb-linkbtn', onClick: reload }, '重试')) : null,
          automationTasks === null
            ? h('div', { className: 'cb-hint' }, '加载中…')
            : automationTasks.length === 0
              ? (automationError ? null : h('div', { className: 'cb-hint' }, '暂无自动化任务'))
              : h('div', { className: 'cb-cards' },
                  automationTasks.map((task) => h(AutomationTaskCard, { key: task.id, task, now, onOpen: onOpenAutomation })))) : null,
        pendingDelete ? h(ConfirmDialog, {
          message: '删除任务「' + pendingDelete.name + '」?运行记录与日志一并清除,操作不可撤销。',
          onConfirm: () => deleteJob(pendingDelete),
          onCancel: () => setPendingDelete(null),
        }) : null,
        formJob ? h(JobForm, { job: formJob.id ? formJob : null, wsModel, serverTzOffset: status ? status.serverTzOffset : undefined, onDone: () => { setFormJob(null); reload() } }) : null)
    }

    // —— 环境变量 Tab ——
    // —— 环境变量表单(新建/编辑)——
    // 编辑经明文单条接口回填:列表接口的 value 已打码,直接回填保存会覆盖真实值。
    // 提交门控:明文加载完成前不可保存;加载失败禁保存(掩码值不得提交);
    // 值未被用户修改时 PATCH 不携带该字段(防迟到回填与掩码路径覆盖真值)
    function EnvForm({ row, onDone }) {
      const editing = Boolean(row && row.id)
      const [form, setForm] = useState(() => ({
        name: row ? row.name : '',
        value: editing ? undefined : '',
        remarks: row ? row.remarks : '',
        multi: row ? row.multi : false,
        enabled: row ? row.enabled : true,
      }))
      const [plaintextReady, setPlaintextReady] = useState(!editing)
      const [plaintextFailed, setPlaintextFailed] = useState(false)
      const valueDirtyRef = useRef(false)
      const [error, setError] = useState(null)
      useEffect(() => {
        if (!editing) return
        let alive = true
        request('GET', 'envs/' + row.id).then((outcome) => {
          if (!alive) return
          if (outcome.ok) {
            // 用户已抢先输入草稿时迟到回填不得覆盖
            setForm((prev) => (valueDirtyRef.current ? prev : { ...prev, value: outcome.data.value }))
            setPlaintextReady(true)
          } else {
            setPlaintextFailed(true)
            setError('读取变量明文失败,保存已禁用:' + outcome.error)
          }
        })
        return () => { alive = false }
      }, [editing, row && row.id])
      const set = (patch) => {
        if (patch.value !== undefined) valueDirtyRef.current = true
        setForm((prev) => ({ ...prev, ...patch }))
      }
      const submit = async () => {
        setError(null)
        // 掩码不可提交:未修改时值字段不携带,服务端保留原值;新建时值始终提交
        const valueSubmittable = !editing || (plaintextReady && !plaintextFailed && valueDirtyRef.current)
        const payload = { ...form, value: valueSubmittable ? form.value : undefined }
        if (valueSubmittable && form.multi) payload.values = form.value.split('\n').map((line) => line.trim()).filter(Boolean)
        const outcome = await request(editing ? 'PATCH' : 'POST', editing ? 'envs/' + row.id : 'envs', payload)
        if (outcome.ok) onDone()
        else setError(outcome.error)
      }
      const submitBlocked = editing && (!plaintextReady || plaintextFailed)
      return h(Modal, { title: editing ? '编辑变量' : '新建变量', onClose: onDone, width: 520 },
        h('div', { className: 'cb-grid' },
          h(Field, { label: '名称' }, h('input', { type: 'text', value: form.name, onChange: (e) => set({ name: e.target.value }) })),
          h(Field, { label: '备注(可空)' }, h('input', { type: 'text', value: form.remarks, onChange: (e) => set({ remarks: e.target.value }) })),
          h(Field, { label: '值', wide: true, hint: submitBlocked ? '正在读取变量明文…' : '勾选多值后每行一个值,运行时按同名多值展开' },
            form.multi
              ? h('textarea', { value: form.value ?? '', onChange: (e) => set({ value: e.target.value }), disabled: submitBlocked })
              : h('input', { type: 'text', value: form.value ?? '', onChange: (e) => set({ value: e.target.value }), disabled: submitBlocked })),
          h('div', { className: 'cb-field' }, switchToggle({ checked: form.multi, onChange: (e) => set({ multi: e.target.checked }), label: '多值' })),
        ),
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar cb-modal-footer' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          switchToggle({ checked: form.enabled, onChange: (e) => set({ enabled: e.target.checked }), label: '启用' }),
          h('button', { className: 'cb-button cb-button--primary', onClick: submit, disabled: submitBlocked }, '保存')))
    }

    function ImportForm({ onDone, reload }) {
      const [text, setText] = useState('')
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const doPreview = async () => {
        const outcome = await request('POST', 'envs/import', { text, apply: false })
        if (outcome.ok) setPreview(outcome.data)
        else setError(outcome.error)
      }
      const doApply = async (overwrite) => {
        const outcome = await request('POST', 'envs/import', { text, apply: true, overwrite })
        if (outcome.ok) { onDone(); reload() } else setError(outcome.error)
      }
      return h(Modal, { title: '导入环境变量', onClose: onDone, width: 560 },
        h('div', { className: 'cb-field cb-field--wide' },
          h('textarea', { style: { minHeight: '120px' }, placeholder: 'NAME=value #备注', value: text, onChange: (e) => setText(e.target.value) })),
        preview ? h('div', { className: 'cb-preview' },
          '解析 ' + preview.parsed.length + ' 条,非法 ' + preview.invalid + ' 条') : null,
        error ? h('div', { className: 'cb-error' }, error) : null,
        h('div', { className: 'cb-toolbar cb-modal-footer' },
          h('button', { className: 'cb-button', onClick: onDone }, '取消'),
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: doPreview }, '预览'),
          h('button', { className: 'cb-button', onClick: () => doApply(false) }, '追加导入'),
          h('button', { className: 'cb-button cb-button--danger', onClick: () => doApply(true) }, '覆盖导入')))
    }

    function EnvsTab({ envs, reload, applyEnvPatch }) {
      const [formRow, setFormRow] = useState(null)
      const [importing, setImporting] = useState(false)
      const [exportText, setExportText] = useState(null)
      const [notice, setNotice] = useState(null)

      const toggleEnv = async (row) => {
        // 乐观翻转:受控开关即时到位;失败回滚并提示,不静默
        applyEnvPatch(row.id, { enabled: !row.enabled })
        const outcome = await request('PATCH', 'envs/' + row.id, { enabled: !row.enabled })
        if (!outcome.ok) {
          applyEnvPatch(row.id, { enabled: row.enabled })
          setNotice('切换失败:' + outcome.error)
        }
        reload()
      }
      const deleteEnv = async (row) => {
        if (!window.confirm('删除变量「' + row.name + '」?')) return
        const outcome = await request('DELETE', 'envs/' + row.id)
        if (!outcome.ok) {
          // 删除失败必须提示并以服务端状态对账,不得静默 reload 造成「已删除」错觉
          setNotice('删除失败:' + outcome.error)
          reload()
          return
        }
        setNotice('已删除「' + row.name + '」')
        reload()
      }
      const doExport = async () => {
        const outcome = await request('GET', 'envs/export')
        if (outcome.ok) setExportText(outcome.data.text)
      }

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h('div', { className: 'cb-spacer' }),
          h('button', { className: 'cb-button', onClick: doExport }, '导出'),
          h('button', { className: 'cb-button', onClick: () => setImporting(true) }, '导入'),
          h('button', { className: 'cb-button cb-button--primary', onClick: () => setFormRow({}) }, '新建变量')),
        notice ? h('div', { className: 'cb-hint' }, notice) : null,
        envs.length === 0 ? h('div', { className: 'cb-empty' },
          h('span', null, '暂无环境变量'),
          h('button', { className: 'cb-button', onClick: () => setFormRow({}) }, '新建变量')) :
          h('div', { className: 'cb-table' },
            envs.map((row) => h('div', { key: row.id, className: 'cb-row' },
              switchToggle({ checked: Boolean(row.enabled), onChange: () => toggleEnv(row) }),
              h('span', { className: 'cb-code' }, row.name),
              h('span', { className: 'cb-code cb-mask' }, row.value),
              row.remarks ? h('span', { className: 'cb-meta' }, '# ' + row.remarks) : null,
              row.multi ? h('span', { className: 'cb-badge' }, '多值') : null,
              h('div', { className: 'cb-actions' },
                h('button', { className: 'cb-icon', onClick: () => setFormRow(row) }, '编辑'),
                h('button', { className: 'cb-icon cb-button--danger', onClick: () => deleteEnv(row) }, '删除'))))),
        formRow ? h(EnvForm, { row: formRow.id ? formRow : null, onDone: () => { setFormRow(null); reload() } }) : null,
        importing ? h(ImportForm, { onDone: () => setImporting(false), reload }) : null,
        exportText !== null ? h(Modal, { title: '导出(仅启用行)', onClose: () => setExportText(null) },
          h('div', { className: 'cb-field cb-field--wide' }, h('textarea', { readOnly: true, value: exportText, style: { minHeight: '160px' } })),
          h('div', { className: 'cb-toolbar cb-modal-footer' },
            h('button', { className: 'cb-button', onClick: () => { setNotice(null); navigator.clipboard && navigator.clipboard.writeText(exportText).then(() => setNotice('已复制到剪贴板')) } }, '复制'),
            h('div', { className: 'cb-spacer' }),
            h('button', { className: 'cb-button', onClick: () => setExportText(null) }, '关闭'))) : null)
    }

    // —— 日志 Tab ——
    function LogsTab({ jobs, reload, reloadFlag, serverTzOffset }) {
      const [jobId, setJobId] = useState(jobs.length > 0 ? jobs[0].id : null)
      const [runs, setRuns] = useState([])
      const [notice, setNotice] = useState(null)
      // 日志视图:{ runId, text, truncated, tailLines };服务端缺省只回尾部窗口,全文经导出按钮取
      const [logView, setLogView] = useState(null)
      // 展示时区随所选任务:显式后缀用其偏移,无后缀用宿主默认(调度与展示同源)
      const selectedJob = jobs.find((job) => job.id === jobId)
      const displayTzOffset = scheduleTzOffset(selectedJob ? selectedJob.schedule : null) ?? (typeof serverTzOffset === 'number' ? serverTzOffset : undefined)

      useEffect(() => {
        let alive = true
        if (!jobId) { setRuns([]); return undefined }
        request('GET', 'runs?jobId=' + encodeURIComponent(jobId)).then((outcome) => {
          if (alive && outcome.ok) setRuns(outcome.data.items)
        })
        return () => { alive = false }
      }, [jobId, reloadFlag])

      // 任务集合变化(删除当前任务/首次加载)时复位选中项与日志视图:
      // 保持指向已不存在的 jobId 会让运行列表与日志永久空白
      useEffect(() => {
        if (jobs.length === 0) {
          setJobId(null)
          setLogView(null)
          return
        }
        if (!jobs.some((job) => job.id === jobId)) {
          setJobId(jobs[0].id)
          setLogView(null)
        }
      }, [jobs, jobId])

      const openLog = async (run) => {
        const outcome = await request('GET', 'runs/' + run.runId + '/log')
        if (outcome.ok) setLogView({ runId: run.runId, ...outcome.data })
      }
      const exportLog = async (run) => {
        // 显式 tail=all 才取全文:大日志的常规查看不应压满内存与 DOM
        const outcome = await request('GET', 'runs/' + run.runId + '/log?tail=all')
        if (outcome.ok) downloadText('cron-board-' + run.runId + '.log', outcome.data.text)
      }
      const clearLog = async (run) => {
        const outcome = await request('DELETE', 'runs/' + run.runId + '/log')
        if (!outcome.ok) {
          setNotice('清空日志失败:' + outcome.error)
          return
        }
        setLogView(null)
        setNotice('已清空日志')
        reload()
      }

      return h('div', { className: 'cb-panel' },
        h('div', { className: 'cb-toolbar' },
          h('select', { className: 'cb-select', value: jobId || '', onChange: (e) => setJobId(e.target.value) },
            jobs.map((job) => h('option', { key: job.id, value: job.id }, job.name)))),
        notice ? h('div', { className: 'cb-hint' }, notice) : null,
        runs.length === 0 ? h('div', { className: 'cb-empty' }, jobId ? '该任务暂无运行记录' : '暂无任务') :
          h('div', { className: 'cb-table' },
            runs.map((run) => {
              const meta = statusMeta(run.status)
              return h('div', { key: run.runId, className: 'cb-row' },
                h('span', { className: 'cb-dot' + (meta.tone === 'run' ? ' cb-dot--pulse' : ''), style: { '--cb-status': STATUS_TONE_COLOR[meta.tone] } }),
                h('span', { className: 'cb-meta' }, meta.label),
                h('span', { className: 'cb-badge' }, TRIGGER_META[run.trigger] ? TRIGGER_META[run.trigger].label : run.trigger),
                h('span', { className: 'cb-meta' }, formatDateTime(run.createdAt, displayTzOffset)),
                typeof run.durationMs === 'number' ? h('span', { className: 'cb-meta' }, formatDuration(run.durationMs)) : null,
                run.model ? h('span', { className: 'cb-badge' }, run.model) : null,
                run.message ? h('span', { className: 'cb-meta' }, run.message) : null,
                h('div', { className: 'cb-actions' },
                  h('button', { className: 'cb-icon', onClick: () => openLog(run) }, '日志'),
                  h('button', { className: 'cb-icon cb-button--danger', onClick: () => clearLog(run) }, '清空')))
            })),
        logView !== null ? h(Modal, { title: '运行日志', onClose: () => setLogView(null), width: 640 },
          logView.truncated
            ? h('div', { className: 'cb-hint' }, '日志较长,仅载入最后 ' + logView.tailLines + ' 行;点「导出」可取全文')
            : null,
          h('div', { className: 'cb-log' }, logView.text || '(空)'),
          h('div', { className: 'cb-toolbar cb-modal-footer' },
            h('div', { className: 'cb-spacer' }),
            h('button', { className: 'cb-button', onClick: () => exportLog(logView) }, '导出'),
            h('button', { className: 'cb-button', onClick: () => setLogView(null) }, '关闭'))) : null)
    }

    function CronBoardPanel({ bus, visible, wsModel, automation }) {
      const active = visible !== false
      const [tab, setTab] = useState('jobs')
      const [jobs, setJobs] = useState([])
      const [envs, setEnvs] = useState([])
      const [status, setStatus] = useState(null)
      const [now, setNow] = useState(Date.now())
      const [reloadFlag, setReloadFlag] = useState(0)
      const [automationOn, setAutomationOn] = useState(false)
      const [automationReady, setAutomationReady] = useState(() => automation.available())
      const [automationBusy, setAutomationBusy] = useState(false)
      const [automationTasks, setAutomationTasks] = useState(null)
      const [automationError, setAutomationError] = useState('')
      const automationSaving = useRef(false)
      const statusEpoch = useRef(0)
      const refreshRef = useRef(() => {})
      const reload = useCallback(() => { refreshRef.current(); setReloadFlag((value) => value + 1) }, [])
      // 乐观更新:受控开关点击即时到位,PATCH 失败由调用方回滚;reload 拉权威态对账
      const applyJobPatch = useCallback((id, patch) => {
        setJobs((prev) => prev.map((job) => (job.id === id ? { ...job, ...patch } : job)))
      }, [])
      const applyEnvPatch = useCallback((id, patch) => {
        setEnvs((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
      }, [])

      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const load = async () => {
          const epoch = ++statusEpoch.current
          const [jobsOutcome, envsOutcome, statusOutcome] = await Promise.all([
            request('GET', 'jobs'),
            request('GET', 'envs'),
            statusReaders.get(bus)(),
          ])
          if (!alive || epoch !== statusEpoch.current) return
          if (jobsOutcome.ok) setJobs(jobsOutcome.data.items)
          if (envsOutcome.ok) setEnvs(envsOutcome.data.items)
          if (statusOutcome.ok) {
            setStatus(statusOutcome.data)
            // 总线刷新采纳服务端偏好;保存期间跳过,避免在途旧快照回滚乐观态
            if (!automationSaving.current) {
              const nextAutomation = statusOutcome.data.ui?.showAutomationTasks === true
              setAutomationOn(nextAutomation)
              syncHostAutomationNav(nextAutomation)
            }
          }
          setNow(Date.now())
        }
        // 数据刷新唯一通道:订阅推送总线(首连 onReset 即首拉,消息到达刷新);
        // 相对时间走针是纯本地时钟,本地 timer 驱动,不发请求
        const snapshot = tools.createSnapshotRefresh(load)
        refreshRef.current = snapshot.refresh
        const unsubscribe = bus.subscribe(snapshot.refresh, { onReset: snapshot.refresh })
        const clock = setInterval(() => setNow(Date.now()), SECOND_MS)
        return () => { alive = false; refreshRef.current = () => {}; snapshot.dispose(); unsubscribe(); clearInterval(clock) }
      }, [bus, active])

      // 服务就绪态随 remote.schedule 点分 inject 到达而变化(缺失宿主上开关保持禁用)
      useEffect(() => {
        const update = () => setAutomationReady(automation.available())
        update()
        return automation.subscribe(update)
      }, [automation])

      // 宿主自动化任务只读目录:开关开启才请求;宿主 schedule/changed 事件触发重拉
      useEffect(() => {
        if (!active || !automationOn) {
          setAutomationTasks(null)
          setAutomationError('')
          return undefined
        }
        let alive = true
        const load = async () => {
          const outcome = await automation.catalog()
          if (!alive) return
          if (outcome.ok) {
            setAutomationTasks(outcome.items)
            setAutomationError('')
          } else {
            setAutomationTasks([])
            setAutomationError(outcome.error || '加载自动化任务失败')
          }
        }
        load()
        const unsubscribe = automation.subscribe(load)
        return () => { alive = false; unsubscribe() }
      }, [active, automationOn, reloadFlag, automation])

      const toggleAutomation = useCallback(async (next) => {
        if (automationSaving.current) return
        automationSaving.current = true
        statusEpoch.current += 1
        setAutomationBusy(true)
        setAutomationOn(next)
        syncHostAutomationNav(next)
        setAutomationError('')
        try {
          const outcome = await request('POST', 'ui-settings', { showAutomationTasks: next })
          if (!outcome.ok || !outcome.data || outcome.data.ok !== true) {
            setAutomationOn(!next)
            syncHostAutomationNav(!next)
            setAutomationError(outcome.error || (outcome.data && outcome.data.error) || '切换失败')
            return
          }
          if (outcome.data.ui) {
            const actual = outcome.data.ui.showAutomationTasks === true
            setAutomationOn(actual)
            syncHostAutomationNav(actual)
          }
        } finally {
          automationSaving.current = false
          setAutomationBusy(false)
          refreshRef.current()
        }
      }, [])

      const openAutomation = useCallback(() => {
        const outcome = automation.openTask()
        if (!outcome.ok) setAutomationError(outcome.error)
      }, [automation])

      return h('div', { className: 'cb-panel' },
        h('header', { className: 'cb-page-head' },
          h('div', null,
            h('h1', { className: 'cb-page-title' }, '定时任务'),
            h('p', { className: 'cb-page-desc' }, '按计划运行 shell 命令或会话任务;调度状态、任务配置与运行历史在此统一管理。'))),
        h('div', { className: 'cb-toolbar cb-toolbar--page' },
          h(PillGroup, { options: TABS, value: tab, onChange: setTab, variant: 'page' }),
          h('div', { className: 'cb-spacer' }),
          status ? h('span', { className: 'cb-meta' },
            '运行中 ' + status.scheduler.active + ' · 队列 ' + status.scheduler.queued +
            (status.nextAt ? ' · 下次 ' + relativeTime(status.nextAt, now) : '')) : null),
        tab === 'jobs' ? h(JobsTab, {
          key: 'jobs', jobs, status, now, reload, applyJobPatch, wsModel,
          automationOn,
          automationAvailable: automationReady,
          automationBusy,
          onToggleAutomation: toggleAutomation,
          automationTasks,
          automationError,
          onOpenAutomation: openAutomation,
        }) : null,
        tab === 'envs' ? h(EnvsTab, { key: 'envs', envs, reload, applyEnvPatch }) : null,
        tab === 'logs' ? h(LogsTab, { key: 'logs', jobs, reload, reloadFlag, serverTzOffset: status ? status.serverTzOffset : undefined }) : null)
    }

    // —— 主页面挂载:宿主官方全局面板契约(main keyed 插槽 + sidebar.panellist 侧栏入口)——
    // 侧栏行与中央面板均由宿主渲染:点击入口行宿主调 layout.selectPanel 切换,会话保持不动;
    // 切回会话走官方路径(会话行/新会话 openSession → selectPanel(null))。禁 DOM 刮取。
    // better-sidebar 偏好开启时改注册其扩展槽 tab(服务契约,同样非 DOM 刮取),两形态互斥。

    const TAB_ID = 'cron-board:board'
    const PANEL_ID = 'cron-board'
    const PANEL_LABEL = '定时任务'
    const PKG_ID = '@mzzsfy/dsh-cron-board'

    // 设置>插件页卡片:官方 PluginCard 形制(名称/描述头部 + chevron 折叠 + 行内开关);better-sidebar 在场可切换,否则仅展示禁用态
    const CARD_TITLE = '定时任务'
    const CARD_TOGGLE_LABEL = '看板移入 better-sidebar 侧边栏'
    const CARD_AUTOMATION_LABEL = '看板显示自动化任务'
    const readSidebarTabPref = (outcome) => outcome.ok && outcome.data &&
      typeof outcome.data.ui === 'object' && outcome.data.ui !== null && outcome.data.ui.sidebarTab === true
    const readShowAutomationPref = (outcome) => outcome.ok && outcome.data &&
      typeof outcome.data.ui === 'object' && outcome.data.ui !== null && outcome.data.ui.showAutomationTasks === true
    const CHEVRON_DOWN = () => h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      h('path', { d: 'm3.5 5.5 3.5 3.5 3.5-3.5' }))

    function CronBoardPluginCard({ ctx, bus, automation }) {
      const [enabled, setEnabled] = useState(null)
      const [showAutomation, setShowAutomation] = useState(null)
      const [automationReady, setAutomationReady] = useState(() => automation.available())
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [open, setOpen] = useState(false)
      // 渲染时重探服务在场:better-sidebar 晚于设置页装载时,重渲染自动纠正禁用态
      const sidebarReady = ctx.get('betterSidebar') !== undefined
      useEffect(() => {
        let alive = true
        const read = async () => {
          const outcome = await request('GET', 'status')
          if (!alive) return
          setEnabled(readSidebarTabPref(outcome))
          const nextAutomation = readShowAutomationPref(outcome)
          setShowAutomation(nextAutomation)
          syncHostAutomationNav(nextAutomation)
        }
        read()
        const unsubscribe = bus && typeof bus.subscribe === 'function' ? bus.subscribe(read, { onReset: read }) : undefined
        return () => { alive = false; unsubscribe?.() }
      }, [bus])
      useEffect(() => {
        const update = () => setAutomationReady(automation.available())
        update()
        return automation.subscribe(update)
      }, [automation])
      const toggle = async () => {
        if (busy || enabled === null || !sidebarReady) return
        setBusy(true)
        setError('')
        const outcome = await request('POST', 'ui-settings', { sidebarTab: !enabled })
        if (outcome.ok && outcome.data && outcome.data.ui) setEnabled(outcome.data.ui.sidebarTab === true)
        else setError(outcome.error || (outcome.data && outcome.data.error) || '切换失败')
        setBusy(false)
      }
      const toggleShowAutomation = async () => {
        if (busy || showAutomation === null || (!automationReady && !showAutomation)) return
        setBusy(true)
        setError('')
        const outcome = await request('POST', 'ui-settings', { showAutomationTasks: !showAutomation })
        if (outcome.ok && outcome.data && outcome.data.ui) {
          const actual = outcome.data.ui.showAutomationTasks === true
          setShowAutomation(actual)
          syncHostAutomationNav(actual)
        } else setError(outcome.error || (outcome.data && outcome.data.error) || '切换失败')
        setBusy(false)
      }
      return h('li', { className: 'cb-pc' + (open ? ' cb-pc--open' : '') },
        h('button', { type: 'button', className: 'cb-pc__head', 'aria-expanded': open,
          'aria-label': (open ? '折叠' : '展开') + ': ' + CARD_TITLE, onClick: () => setOpen(!open) },
          h('span', { className: 'cb-pc__text' },
            h('span', { className: 'cb-pc__name' }, CARD_TITLE),
            h('span', { className: 'cb-pc__desc' }, '计划任务看板、环境变量与执行日志')),
          h('span', { className: 'cb-pc__chevron' }, h(CHEVRON_DOWN))),
        open ? h('div', { className: 'cb-pc__body' },
          h('div', { className: 'cb-pc__row' },
            h('div', { className: 'cb-pc__rowLine' },
              h('span', { className: 'cb-pc__rowLabel' }, CARD_TOGGLE_LABEL),
              switchToggle({
                checked: enabled === true,
                disabled: busy || enabled === null || !sidebarReady,
                onChange: toggle,
                ariaLabel: CARD_TOGGLE_LABEL,
              })),
            h('p', { className: 'cb-pc__hint' },
              sidebarReady ? '开启后看板以侧边栏页签呈现,关闭时使用全局面板。' : '需已装载 better-sidebar 后方可切换;未装载时看板始终使用全局面板。'),
            h('div', { className: 'cb-pc__rowLine' },
              h('span', { className: 'cb-pc__rowLabel' }, CARD_AUTOMATION_LABEL),
              switchToggle({
                checked: showAutomation === true,
                disabled: busy || showAutomation === null || (!automationReady && !showAutomation),
                onChange: toggleShowAutomation,
                ariaLabel: CARD_AUTOMATION_LABEL,
                title: automationReady ? '显示宿主自动化任务并隐藏侧栏重复入口' : '宿主未提供自动化任务服务',
              })),
            h('p', { className: 'cb-pc__hint' }, automationReady
              ? '开启后在看板下方以只读分组显示宿主「自动化任务」,并隐藏其在侧栏的重复入口;点击任务打开宿主页面管理。'
              : '宿主未提供自动化任务服务,该开关不可用。'),
            error ? h('p', { className: 'cb-error', role: 'alert' }, error) : null)) : null)
    }

    // better-sidebar tab:注册即单实例(single);只注册不主动打开,
    // 打开由用户从侧边栏目录手动进入(注册即 openTab 会在每次页面加载时抢占当前视图)
    function registerBoardTab(ctx, service, wsModel, bus, automation) {
      return ctx.effect(() => {
        const disposeTab = service.registerTab({
          id: TAB_ID,
          title: PANEL_LABEL,
          icon: (size) => h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
            stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
            h('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2 }),
            h('path', { d: 'M6 2v12M10 2v12' })),
          order: 46,
          single: true,
          component: (props) => h(CronBoardPanel, { visible: props.visible, wsModel, bus, automation }),
        })
        return disposeTab
      }, 'cron-board sidebar tab')
    }

    // 面板图标:panellist 渲染契约组件,宿主传 { size, active }
    function PanelIcon({ size }) {
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2 }),
        h('path', { d: 'M6 2v12M10 2v12' }))
    }

    // 全局面板形态:main keyed 条目(中央面板)+ sidebar.panellist 条目(侧栏入口行),同 id 配对;
    // 页签点击切换、激活高亮均由宿主管;effect 工厂必须交付组合清理,否则互斥仲裁拆不掉条目
    function registerMainPanel(ctx, wsModel, bus, automation) {
      return ctx.effect(() => {
        const injectDisposers = []
        injectDisposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, () => h('div', { className: 'cb-main' }, h(CronBoardPanel, { wsModel, bus, automation })))))
        injectDisposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          label: PANEL_LABEL,
        }, (iconProps) => h(PanelIcon, iconProps))))
        return () => { for (const dispose of injectDisposers) dispose() }
      }, 'cron-board main panel')
    }

    return {
      // workspaces 由宿主 client 常驻提供;slots 供设置页分区挂载;layout 用于跳转宿主自动化任务页
      inject: ['workspaces', 'slots', 'layout'],
      apply(ctx) {
        const bus = tools.setupCommonTools(ctx)
        ctx.effect(() => createStatusReader(bus), 'cron-board 共享状态快照')
        ensureStyle(document, STYLE)
        // 工作区 model(list 即 getSnapshot/subscribe 契约的响应式模型;形态不符传 null,表单仅保留手输)
        const wsService = ctx.get('workspaces')
        const wsModel = wsService && wsService.list && typeof wsService.list.getSnapshot === 'function' ? wsService.list : null
        // 宿主自动化任务只读门面:remote.schedule 是版本脆弱子面,点分 inject 等 assembly 挂载;
        // 缺失时仅本功能不可用,不阻塞看板其余能力(dsh-api-alignment.md 条款 1)
        const automation = {
          remote: null,
          listeners: new Set(),
          available() { return automation.remote !== null },
          subscribe(listener) {
            automation.listeners.add(listener)
            return () => { automation.listeners.delete(listener) }
          },
          async catalog() {
            const remote = automation.remote
            if (!remote) return { ok: false, error: '宿主自动化任务服务不可用' }
            try {
              const result = await remote.catalog()
              if (!result || result.ok !== true) {
                const failure = result && result.error
                return { ok: false, error: (failure && (failure.message || failure.code)) || '加载自动化任务失败' }
              }
              return { ok: true, items: Array.isArray(result.value) ? result.value : [] }
            } catch (error) {
              return { ok: false, error: String(error && error.message || error) }
            }
          },
          openTask() {
            try {
              ctx.layout.selectPanel('schedules')
              return { ok: true }
            } catch {
              return { ok: false, error: '宿主自动化任务页面不可用' }
            }
          },
        }
        ctx.inject(['remote', 'remote.schedule'], (remoteCtx) => {
          automation.remote = remoteCtx && remoteCtx.remote ? remoteCtx.remote.schedule : null
          const off = remoteCtx && remoteCtx.remote && typeof remoteCtx.remote.$on === 'function'
            ? remoteCtx.remote.$on('schedule/changed', () => {
                for (const listener of [...automation.listeners]) listener()
              })
            : undefined
          for (const listener of [...automation.listeners]) listener()
          return () => {
            off?.()
            automation.remote = null
            for (const listener of [...automation.listeners]) listener()
          }
        })
        // 挂载权交给用户:默认注册全局面板;设置 sidebarTab 开启且侧边栏服务在场才移入扩展槽,注册后不再自动回退
        let currentSidebar = ctx.get('betterSidebar')
        let sidebarTabOn = false
        let tabDisposer = null
        let panelDisposer = null
        const attachBoardTab = (sidebar) => registerBoardTab(ctx, sidebar, wsModel, bus, automation)
        const applyPref = () => {
          const wantTab = sidebarTabOn && currentSidebar !== undefined
          if (wantTab && tabDisposer === null) {
            if (panelDisposer) { panelDisposer(); panelDisposer = null }
            tabDisposer = attachBoardTab(currentSidebar)
          } else if (!wantTab && tabDisposer !== null) {
            tabDisposer()
            tabDisposer = null
          }
          if (!wantTab && panelDisposer === null) panelDisposer = registerMainPanel(ctx, wsModel, bus, automation)
        }
        // 偏好仲裁数据源:订阅总线刷新(updateUiSettings 变更即 publish),不再周期轮询
        let prefAlive = true
        const syncPref = async () => {
          try {
            const outcome = await statusReaders.get(bus)()
            if (!prefAlive) return
            syncHostAutomationNav(outcome.ok && outcome.data && outcome.data.ui && outcome.data.ui.showAutomationTasks === true)
            const next = readSidebarTabPref(outcome)
            if (next !== sidebarTabOn) {
              const previous = sidebarTabOn
              sidebarTabOn = next
              try {
                applyPref()
              } catch (error) {
                // 形态切换失败回滚偏好,下轮事件重试,避免入口消失后卡死
                sidebarTabOn = previous
                console.warn('[cron-board] 看板形态切换失败:', error)
              }
            }
          } catch { /* 刷新失败保形态不变,下轮事件重试 */ }
        }
        const prefRefresh = tools.createSnapshotRefresh(syncPref)
        const unsubscribePref = bus.subscribe(prefRefresh.refresh, { onReset: prefRefresh.refresh })
        ctx.effect(() => () => {
          prefAlive = false
          prefRefresh.dispose()
          unsubscribePref()
          syncHostAutomationNav(false)
          if (tabDisposer) tabDisposer()
          if (panelDisposer) panelDisposer()
        }, 'cron-board mount arbitration')
        // 设置>插件页卡片:key 配对 ns,宿主按 describe 命名空间分发;effect 随 fiber 回收
        ctx.effect(() => ctx.slots.inject('settings.plugin.item', function* () {
          yield ctx.slots.register(
            { name: 'settings.plugin.item', key: PANEL_ID, label: PANEL_LABEL },
            () => h(CronBoardPluginCard, { ctx, bus, automation }),
          )
        }), 'cron-board settings card')
        // 插件管理页(0.1.7-rc.1+)包详情配置卡:key = 包名,管理页 ledger.bundles 判定 section
        // 在场;卡片自包含(只调本插件 API,不触宿主 settings)。两代槽位并存注册:inject 是
        // 声明生命周期效应,错误世代宿主永不声明该槽,回调挂起不执行,零成本
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', function* () {
          yield ctx.slots.register(
            { name: 'plugins.bundle.config', key: PKG_ID },
            () => h(CronBoardPluginCard, { ctx, bus, automation }),
          )
        }), 'cron-board plugin manager card')
        ctx.inject(['betterSidebar'], (bsCtx) => {
          currentSidebar = bsCtx.betterSidebar
          applyPref()
        })
        applyPref()
      },
    }
  }
}
})()
