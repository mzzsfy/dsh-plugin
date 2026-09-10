// cron 解析薄封装:croner 承担表达式解析与触发点计算(5/6 段通吃、时区、DST)。
// 非法表达式以业务错误抛出,文案中文原样透传给路由层。

import { Cron } from 'croner'

// 求自 from 起下一次触发点(ms epoch);表达式无未来触发点时返回 null
export function nextRunAtOf(schedule, from = new Date()) {
  const job = new Cron(schedule)
  const next = job.nextRun(from)
  return next ? next.getTime() : null
}

// 求自 from 起下 N 次触发点(编辑表单实时预览用)
export function nextRunsOf(schedule, count, from = new Date()) {
  const job = new Cron(schedule)
  return job.nextRuns(count, from).map((date) => date.getTime())
}

// 表达式合法性校验:合法返回 null,非法抛业务错误
export function assertValidSchedule(schedule) {
  try {
    new Cron(schedule)
  } catch (error) {
    throw new Error('cron 表达式不合法: ' + schedule)
  }
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const PAD2 = (value) => String(value).padStart(2, '0')

// 人话摘要(轻量规则覆盖常用形态,兜底回原表达式)
export function summarizeCron(schedule) {
  const parts = String(schedule).trim().split(/\s+/)
  if (parts.length !== 5) return schedule
  const [minute, hour, day, month, weekday] = parts
  const clock = (h, m) => PAD2(h) + ':' + PAD2(m)
  const dayFree = day === '*' && month === '*' && weekday === '*'
  if (dayFree && /^\*\/\d+$/.test(hour) && minute === '0') return '每 ' + hour.slice(2) + ' 小时'
  if (dayFree && hour.startsWith('*/')) return '每 ' + hour.slice(2) + ' 小时(第 ' + minute + ' 分)'
  if (dayFree && /^\*\/\d+$/.test(minute) && hour === '*') return '每 ' + minute.slice(2) + ' 分钟'
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return schedule
  if (month !== '*' || day !== '*') {
    if (/^\d+$/.test(day) && month === '*') return '每月 ' + day + ' 日 ' + clock(hour, minute)
    return schedule
  }
  if (weekday === '1-5') return '工作日 ' + clock(hour, minute)
  if (/^\d$/.test(weekday)) return '每周' + (WEEKDAY_LABELS[Number(weekday)] || weekday) + ' ' + clock(hour, minute)
  if (day === '*' && weekday === '*') return '每天 ' + clock(hour, minute)
  return schedule
}
