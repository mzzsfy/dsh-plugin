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
