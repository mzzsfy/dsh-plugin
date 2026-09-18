// cron 解析薄封装:croner 承担表达式解析与触发点计算(5/6 段通吃、时区、DST)。
// 表达式支持内联时区后缀 T±N(语法归 schedule-builder):显式后缀按固定偏移,
// 无后缀按宿主系统时区(crontab 惯例,与 croner 原生行为一致)。

import { Cron } from 'croner'

import { splitScheduleTz, formatTzOffset } from './schedule-builder.mjs'

// 固定偏移 → croner 时区名(Etc/GMT 为 POSIX 反转:UTC+8 即 Etc/GMT-8)
function etcGmtName(timezoneOffset) {
  if (timezoneOffset === 0) return 'UTC'
  return timezoneOffset > 0 ? 'Etc/GMT-' + timezoneOffset : 'Etc/GMT+' + (-timezoneOffset)
}

// croner 构造选项:无后缀不指定时区(宿主系统时区)
function cronOptions(timezoneOffset) {
  return timezoneOffset === null ? {} : { timezone: etcGmtName(timezoneOffset) }
}

// 求自 from 起下一次触发点(ms epoch);表达式无未来触发点时返回 null
export function nextRunAtOf(schedule, from = new Date()) {
  const { base, timezoneOffset } = splitScheduleTz(schedule)
  const job = new Cron(base, cronOptions(timezoneOffset))
  const next = job.nextRun(from)
  return next ? next.getTime() : null
}

// 求自 from 起下 N 次触发点(编辑表单实时预览用)
export function nextRunsOf(schedule, count, from = new Date()) {
  const { base, timezoneOffset } = splitScheduleTz(schedule)
  const job = new Cron(base, cronOptions(timezoneOffset))
  return job.nextRuns(count, from).map((date) => date.getTime())
}

// 表达式合法性校验:合法返回 null,非法抛业务错误(后缀与表达式分别报因)
export function assertValidSchedule(schedule) {
  const { base } = splitScheduleTz(schedule)
  try {
    new Cron(base)
  } catch (error) {
    throw new Error('cron 表达式不合法: ' + schedule)
  }
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const PAD2 = (value) => String(value).padStart(2, '0')

// 时区尾注:显式后缀标注自身,无后缀标注宿主默认(hostOffset 可显式传入以便测试)
function tzNote(timezoneOffset, hostOffset) {
  return timezoneOffset === null
    ? '(宿主 UTC' + formatTzOffset(hostOffset) + ')'
    : '(UTC' + formatTzOffset(timezoneOffset) + ')'
}

// 人话摘要(轻量规则覆盖常用形态,兜底回原表达式),一律携带时区尾注
export function summarizeCron(schedule, hostOffset = -new Date().getTimezoneOffset() / 60) {
  const { base, timezoneOffset } = splitScheduleTz(schedule)
  const note = tzNote(timezoneOffset, hostOffset)
  const parts = base.trim().split(/\s+/)
  if (parts.length !== 5) return base + note
  const [minute, hour, day, month, weekday] = parts
  const clock = (h, m) => PAD2(h) + ':' + PAD2(m)
  const dayFree = day === '*' && month === '*' && weekday === '*'
  if (dayFree && /^\*\/\d+$/.test(hour) && minute === '0') return '每 ' + hour.slice(2) + ' 小时' + note
  if (dayFree && hour.startsWith('*/')) return '每 ' + hour.slice(2) + ' 小时(第 ' + minute + ' 分)' + note
  if (dayFree && /^\*\/\d+$/.test(minute) && hour === '*') return '每 ' + minute.slice(2) + ' 分钟' + note
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return base + note
  if (month !== '*' || day !== '*') {
    if (/^\d+$/.test(day) && month === '*') return '每月 ' + day + ' 日 ' + clock(hour, minute) + note
    return base + note
  }
  if (weekday === '1-5') return '工作日 ' + clock(hour, minute) + note
  if (/^\d$/.test(weekday)) return '每周' + (WEEKDAY_LABELS[Number(weekday)] || weekday) + ' ' + clock(hour, minute) + note
  if (day === '*' && weekday === '*') return '每天 ' + clock(hour, minute) + note
  return base + note
}
