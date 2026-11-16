// 调度构建器纯函数:表单结构化状态(freq + 上下文)与 cron 表达式互转。
// 仅覆盖构建器可表达的形态,反解不出即 custom(表达式原样手输);触发点计算仍归 croner(cron.mjs)。

export const FREQS = ['daily', 'weekly', 'weekdays', 'interval', 'custom']

export const WEEKDAY_ORDER = ['1', '2', '3', '4', '5', '6', '0']
export const WEEKDAY_LABELS = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' }

export const MINUTE_MAX = 59
export const HOUR_MAX = 23
export const INTERVAL_MIN_MINUTES = 1
const MINUTES_PER_HOUR = 60

// 结构化调度状态:custom 时 expression 为唯一有效字段,其余字段仍保留(切回结构化频率不丢配置);
// timezone 为内联时区后缀的偏移小时数,后缀语法只收整小时,故非整点偏移在状态里保持 null
// (按宿主系统时区),null 表示无后缀
export function createScheduleState(expression) {
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

const clampInt = (raw, min, max, fallback) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return fallback
  return value
}

// cron(5 段)→ 构建器状态:匹配失败即 custom;非法数值一律归 custom,不猜;
// 非法时区后缀同样 custom 兜底(原样保留,合法性由校验通道业务报错)
export function parseSchedule(expression) {
  const raw = String(expression).trim()
  let split
  try {
    split = splitScheduleTz(raw)
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
    state.intervalMinutes = clampInt(minute.slice(2), INTERVAL_MIN_MINUTES, MINUTE_MAX, 0)
    if (state.intervalMinutes === 0) state.freq = 'custom'
    return state
  }
  const hourNum = clampInt(hour, 0, HOUR_MAX, NaN)
  const minuteNum = clampInt(minute, 0, MINUTE_MAX, NaN)
  if (!Number.isInteger(hourNum) || !Number.isInteger(minuteNum)) { state.freq = 'custom'; return state }
  state.hour = hourNum
  state.minute = minuteNum
  if (weekday === '*') { state.freq = 'daily'; return state }
  if (weekday === '1-5') { state.freq = 'weekdays'; return state }
  const days = weekday.split(',')
  if (days.every((d) => /^\d$/.test(d) && d in WEEKDAY_LABELS)) {
    state.freq = 'weekly'
    state.weekdays = WEEKDAY_ORDER.filter((d) => days.includes(d))
    return state
  }
  state.freq = 'custom'
  return state
}

// 偏移小时数 → 展示值:+8 / -5 / +0;非整点(浏览器/宿主时区可能为 +5:30、+5:45)按 +5:30 展示
export function formatTzOffset(offset) {
  const sign = offset >= 0 ? '+' : '-'
  const totalMinutes = Math.round(Math.abs(offset) * MINUTES_PER_HOUR)
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
  const minutes = totalMinutes % MINUTES_PER_HOUR
  return sign + hours + (minutes === 0 ? '' : ':' + String(minutes).padStart(2, '0'))
}

// 时区后缀只支持整小时:非整点偏移不得四舍五入成错误小时(+5:30 → T+6 会整体错半小时),
// 返回 null 由调用方回退宿主默认
export function tzSuffixOffset(offset) {
  return Number.isInteger(offset) ? offset : null
}

// 构建器状态 → cron;custom 透传剥离后手工表达式;整点显式时区统一附加 T±N 后缀
export function buildSchedule(state) {
  const base = buildBase(state)
  const offset = tzSuffixOffset(state.timezone)
  if (offset === null) return base
  return base + 'T' + formatTzOffset(offset)
}

function buildBase(state) {
  if (state.freq === 'custom') return String(state.expression).trim()
  const minute = String(state.minute)
  const hour = String(state.hour)
  if (state.freq === 'daily') return minute + ' ' + hour + ' * * *'
  if (state.freq === 'weekdays') return minute + ' ' + hour + ' * * 1-5'
  if (state.freq === 'weekly') return minute + ' ' + hour + ' * * ' + [...state.weekdays].sort((a, b) => Number(a) - Number(b)).join(',')
  if (state.freq === 'interval') return '*/' + state.intervalMinutes + ' * * * *'
  return String(state.expression).trim()
}

// —— 内联时区后缀:表达式形态的一部分,构建器读写,cron.mjs 桥接 croner 时复用 ——

export const TZ_SUFFIX_MIN = -12
export const TZ_SUFFIX_MAX = 14
// T±N 整数小时,允许与表达式空格分隔,大小写均可
const TZ_SUFFIX_PATTERN = /\s*T([+-])(\d{1,2})$/i

// 时区下拉可选偏移:整点区间 + 当前值兜底 —— select 的 value 找不到对应 option 时会渲染空白,
// 当前偏移不在区间内(非整点/脏状态)时补一项,保证选中项始终可见
export function tzSelectOptions(current, min = TZ_SUFFIX_MIN, max = TZ_SUFFIX_MAX) {
  const offsets = []
  for (let offset = min; offset <= max; offset++) offsets.push(offset)
  if (typeof current === 'number' && Number.isFinite(current) && !offsets.includes(current)) offsets.push(current)
  return offsets.sort((a, b) => a - b)
}

// 剥离时区后缀:返回 { base, timezoneOffset },无后缀时 timezoneOffset 为 null;
// 后缀超出支持范围抛业务错误(校验与桥接共用,脏数据须暴露)
export function splitScheduleTz(schedule) {
  const text = String(schedule).trim()
  const match = text.match(TZ_SUFFIX_PATTERN)
  if (!match) return { base: text, timezoneOffset: null }
  const offset = Number(match[1] + match[2])
  if (offset < TZ_SUFFIX_MIN || offset > TZ_SUFFIX_MAX) {
    throw new Error('时区后缀不合法: T' + match[1] + match[2] + '(支持 T±N 整数小时 ' + TZ_SUFFIX_MIN + ' 至 ' + TZ_SUFFIX_MAX + ')')
  }
  return { base: text.slice(0, match.index).trim(), timezoneOffset: offset }
}
