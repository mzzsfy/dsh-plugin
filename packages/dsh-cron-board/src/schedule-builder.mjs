// 调度构建器纯函数:表单结构化状态(freq + 上下文)与 cron 表达式互转。
// 仅覆盖构建器可表达的形态,反解不出即 custom(表达式原样手输);触发点计算仍归 croner(cron.mjs)。

export const FREQS = ['daily', 'weekly', 'weekdays', 'interval', 'custom']

export const WEEKDAY_ORDER = ['1', '2', '3', '4', '5', '6', '0']
export const WEEKDAY_LABELS = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' }

export const MINUTE_MAX = 59
export const HOUR_MAX = 23
export const INTERVAL_MIN_MINUTES = 1

// 结构化调度状态:custom 时 expression 为唯一有效字段,其余字段仍保留(切回结构化频率不丢配置)
export function createScheduleState(expression) {
  return {
    freq: 'daily',
    hour: 9,
    minute: 0,
    weekdays: ['1'],
    intervalMinutes: 30,
    expression,
  }
}

const clampInt = (raw, min, max, fallback) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return fallback
  return value
}

// cron(5 段)→ 构建器状态:匹配失败即 custom;非法数值一律归 custom,不猜
export function parseSchedule(expression) {
  const raw = String(expression).trim()
  const parts = raw.split(/\s+/)
  const state = createScheduleState(raw)
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

// 构建器状态 → cron;custom 直接返回手工表达式
export function buildSchedule(state) {
  if (state.freq === 'custom') return String(state.expression).trim()
  const minute = String(state.minute)
  const hour = String(state.hour)
  if (state.freq === 'daily') return minute + ' ' + hour + ' * * *'
  if (state.freq === 'weekdays') return minute + ' ' + hour + ' * * 1-5'
  if (state.freq === 'weekly') return minute + ' ' + hour + ' * * ' + [...state.weekdays].sort((a, b) => Number(a) - Number(b)).join(',')
  if (state.freq === 'interval') return '*/' + state.intervalMinutes + ' * * * *'
  return String(state.expression).trim()
}
