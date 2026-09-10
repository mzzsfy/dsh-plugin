// session-window:会话任务时间窗口判定(设计 §4.3)。start>=end 视为跨零点(如 22:00-06:00)。

const MINUTES_PER_DAY = 24 * 60

function parseMinutes(hhmm) {
  const [hours, minutes] = String(hhmm).split(':').map((part) => parseInt(part, 10))
  return hours * 60 + minutes
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

// 触发时刻是否落在窗口内;start>=end 即跨零点区间。session = job.session 子对象
export function inWindow(session, date) {
  const start = parseMinutes(session.windowStart)
  const end = parseMinutes(session.windowEnd)
  const nowMinutes = minutesOfDay(date)
  if (start <= end) return nowMinutes >= start && nowMinutes < end
  return nowMinutes >= start || nowMinutes < end
}

// 最近的窗口起点时刻(defer 挂起目标):起点未过用今日,已过用明日
export function nextWindowStart(session, date) {
  const start = parseMinutes(session.windowStart)
  const at = new Date(date)
  at.setSeconds(0, 0)
  at.setHours(Math.floor(start / 60), start % 60)
  if (at.getTime() <= date.getTime()) at.setDate(at.getDate() + 1)
  return at
}

export function hasWindow(session) {
  return Boolean(session && session.windowStart && session.windowEnd)
}

export { MINUTES_PER_DAY }
