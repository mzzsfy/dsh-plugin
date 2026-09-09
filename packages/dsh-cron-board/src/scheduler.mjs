// scheduler:单一调度循环。tick 固定四步——扫描到期、先推进 nextRunAt 再执行、
// 经执行链闸门入队、超时与收尾由执行链负责。misfire 语义:错过触发点超过一个
// tick 周期即视为停机期间错过,不补跑,记 skipped 并推进(轻量取舍,设计 §4.1)。

import { nextRunAtOf } from './cron.mjs'
import { hasWindow, inWindow, nextWindowStart } from './session-window.mjs'

const SKIPPED_MISFIRE_MESSAGE = '停机期间错过'
const SKIPPED_WINDOW_MESSAGE = '窗口外跳过'
const INTERRUPTED_MESSAGE = 'dsh 重启中断'

export function createScheduler({ store, executor, readTickMs, now = () => Date.now(), scheduleAt = (at, fn) => setTimeout(fn, Math.max(0, at - now())) }) {
  // 重入闸门:上一 tick 未完成(store 写链排队/慢盘)时跳过本轮,防同一触发点双触发
  let ticking = false
  // defer 挂起句柄登记:dispose 统一清除,不遗留生命周期外触发
  const deferredCancels = new Set()

  // 重启孤儿收尾:上次进程遗留的 queued/running 统一标 interrupted,不误标失败
  async function recover() {
    for (const run of [...store.runs.rows]) {
      if (run.status !== 'queued' && run.status !== 'running') continue
      await store.runs.update(run.runId, { status: 'interrupted', endedAt: now(), message: INTERRUPTED_MESSAGE })
    }
  }

  // defer 到点回调:按 id 重读任务,已删/已停/会话形态变化一律放弃(不吃旧快照)
  function armDeferred(jobId, at) {
    const handle = scheduleAt(at, () => {
      deferredCancels.delete(cancel)
      void (async () => {
        const job = store.jobs.get(jobId)
        if (!job || !job.enabled || job.kind !== 'session' || !hasWindow(job.session)) return
        if (inWindow(job.session, new Date(now()))) await executor.dispatch(job, 'cron')
      })().catch(() => {})
    })
    // 句柄取消形态归一:函数直接调,定时器对象走 clearTimeout
    const cancel = typeof handle === 'function' ? handle : () => clearTimeout(handle)
    deferredCancels.add(cancel)
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
        // 会话任务窗口:窗口外按 onMiss 跳过或顺延至窗口起点(defer 挂起不持久化,重启按 skip)
        if (job.kind === 'session' && hasWindow(job.session) && !inWindow(job.session, new Date(nowMs))) {
          if (job.session.onMiss === 'defer') {
            armDeferred(job.id, nextWindowStart(job.session, new Date(nowMs)).getTime())
          } else {
            await store.runs.create({ jobId: job.id, trigger: 'cron', status: 'skipped', message: SKIPPED_WINDOW_MESSAGE })
          }
          continue
        }
        await executor.dispatch(job, 'cron')
      }
    } finally {
      ticking = false
    }
  }

  function dispose() {
    for (const cancel of deferredCancels) {
      try { cancel() } catch { /* 句柄已自行失效即无清理需求 */ }
    }
    deferredCancels.clear()
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
    dispose,
    status: () => executor.status(),
    nextRunAt,
  }
}
