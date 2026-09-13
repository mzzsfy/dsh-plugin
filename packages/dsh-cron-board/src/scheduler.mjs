// scheduler:单一调度循环。tick 固定三步——扫描到期、先推进 nextRunAt 再执行、
// 经执行链闸门入队,收尾由执行链负责。misfire 语义:错过触发点超过一个
// tick 周期即视为停机期间错过,不补跑,记 skipped 并推进(轻量取舍,设计 §4.1)。

import { nextRunAtOf } from './cron.mjs'

const SKIPPED_MISFIRE_MESSAGE = '停机期间错过'
const INTERRUPTED_MESSAGE = 'dsh 重启中断'

export function createScheduler({ store, executor, readTickMs, now = () => Date.now() }) {
  // 重入闸门:上一 tick 未完成(store 写链排队/慢盘)时跳过本轮,防同一触发点双触发
  let ticking = false

  // 历史版本编辑残留的自愈:nextRunAt 不在当前 schedule 的触发点上即重算,
  // 防残留值到点误执行;合法触发点与空值(无未来触发点)不动,保留宽限执行与 misfire 语义
  function isLegalTrigger(schedule, at) {
    return nextRunAtOf(schedule, new Date(at - 1000)) === at
  }

  // 重启恢复:孤儿运行收尾 + 触发点残留自愈
  async function recover() {
    for (const run of [...store.runs.rows]) {
      if (run.status !== 'queued' && run.status !== 'running') continue
      await store.runs.update(run.runId, { status: 'interrupted', endedAt: now(), message: INTERRUPTED_MESSAGE })
    }
    for (const job of store.jobs.list()) {
      if (typeof job.nextRunAt !== 'number' || Number.isNaN(job.nextRunAt)) continue
      if (isLegalTrigger(job.schedule, job.nextRunAt)) continue
      await store.jobs.update(job.id, { nextRunAt: nextRunAtOf(job.schedule, new Date(now())) })
    }
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const nowMs = now()
      const graceMs = readTickMs()
      for (const job of store.jobs.list()) {
        if (!job.enabled) continue
        if (typeof job.nextRunAt !== 'number' || Number.isNaN(job.nextRunAt)) continue
        if (job.nextRunAt > nowMs) continue
        // misfire 判定须在推进前读取到期值(update 会原地改写任务对象)
        const dueAt = job.nextRunAt
        const misfired = nowMs - dueAt > graceMs
        // 先推进再执行:执行慢或并发堵不引发重复触发
        const nextAt = nextRunAtOf(job.schedule, new Date(nowMs))
        await store.jobs.update(job.id, { nextRunAt: nextAt, lastRunAt: nowMs })
        if (misfired) {
          await store.runs.create({ jobId: job.id, trigger: 'cron', status: 'skipped', message: SKIPPED_MISFIRE_MESSAGE })
          continue
        }
        await executor.dispatch(job, 'cron')
      }
    } finally {
      ticking = false
    }
  }

  // 下次触发预览:启用任务中最小的 nextRunAt(面板状态展示用)
  function nextRunAt() {
    const dueList = store.jobs
      .list((job) => job.enabled && typeof job.nextRunAt === 'number' && !Number.isNaN(job.nextRunAt))
      .map((job) => job.nextRunAt)
    return dueList.length > 0 ? Math.min(...dueList) : null
  }

  return {
    recover,
    tick,
    status: () => executor.status(),
    nextRunAt,
  }
}
