// scheduler:单一调度循环。tick 固定三步——扫描到期、先推进 nextRunAt 再执行、
// 经执行链闸门入队,收尾由执行链负责。misfire 语义:错过触发点超过一个
// tick 周期即视为停机期间错过,不补跑,记 skipped 并推进(轻量取舍,设计 §4.1)。

import { nextRunAtOf, nextRunAtOfSchedules, splitSchedules } from './cron.mjs'

const SKIPPED_MISFIRE_MESSAGE = '停机期间错过'
const INTERRUPTED_MESSAGE = 'dsh 重启中断'
// DST 跃变窗口:不存在的墙钟时刻最多被顺延到几小时内(常见 1h,历史时区有 2h)
const DST_MAPPED_LOOKBACK_MS = 3 * 60 * 60 * 1000
// 窗口内逐触发点探测的上限:只要把 at 之前的触发点枚举完即停,不会无限枚举
const DST_MAPPED_MAX_PROBES = 64

export function createScheduler({ store, executor, readTickMs, onChange, logSystem, now = () => Date.now() }) {
  // 重入闸门:上一 tick 未完成(store 写链排队/慢盘)时跳过本轮,防同一触发点双触发;
  // inFlight 供 dispose 等待:tick 是异步链,不等它收尾,dispose 返回后仍会推进 nextRunAt/写记录
  let ticking = false
  let inFlight = null
  let disposed = false

  // 历史版本编辑残留的自愈:nextRunAt 不在计划内任一表达式的触发点上即重算,
  // 防残留值到点误执行;合法触发点与空值(无未来触发点)不动,保留宽限执行与 misfire 语义。
  // 逐条探测只在 recover 自愈路径发生,条数上界即计划行数上限,不进入 tick 热路径
  function isLegalTrigger(schedule, at) {
    return splitSchedules(schedule).some((line) => isLegalLineTrigger(line, at))
  }

  function isLegalLineTrigger(schedule, at) {
    if (nextRunAtOf(schedule, new Date(at - 1000)) === at) return true
    return isMappedDstTrigger(schedule, at)
  }

  // DST 春跳:不存在的墙钟时刻被 croner 顺延(如 02:30→03:30),而「从 at-1s 求下一次」
  // 会跳过这个映射点(直接给次日),合法触发点被误判成残留值。回看跃变窗口枚举真实触发点,
  // 只在上述判定失败时兜底,不改变普通触发点/高频表达式的判定成本
  function isMappedDstTrigger(schedule, at) {
    let cursor = at - DST_MAPPED_LOOKBACK_MS
    for (let probe = 0; probe < DST_MAPPED_MAX_PROBES; probe++) {
      const next = nextRunAtOf(schedule, new Date(cursor))
      if (next === null || next > at) return false
      if (next === at) return true
      cursor = next
    }
    return false
  }

  // 重启恢复:孤儿运行收尾 + 触发点残留自愈
  async function recover() {
    const interruptedJobs = new Set()
    for (const run of [...store.runs.rows]) {
      if (run.status !== 'queued' && run.status !== 'running') continue
      await store.runs.update(run.runId, { status: 'interrupted', endedAt: now(), message: INTERRUPTED_MESSAGE })
      if (typeof run.jobId === 'string' && run.jobId !== '') interruptedJobs.add(run.jobId)
    }
    // 任务卡状态回填:上次进程中断时最后状态停留在历史值,恢复后必须显示「中断」
    for (const jobId of interruptedJobs) {
      if (!store.jobs.get(jobId)) continue
      await store.jobs.updateRuntime(jobId, { lastStatus: 'interrupted' })
    }
    for (const job of store.jobs.list()) {
      if (typeof job.nextRunAt !== 'number' || Number.isNaN(job.nextRunAt)) continue
      if (isLegalTrigger(job.schedule, job.nextRunAt)) continue
      await store.jobs.updateRuntime(job.id, { nextRunAt: nextRunAtOfSchedules(job.schedule, new Date(now())) })
    }
  }

  async function reportDispatchFailure(job, error) {
    const detail = error && error.message ? error.message : String(error)
    logSystem?.('[cron-board] cron 调度失败 job=' + job.id + ' 错误=' + detail)
    // 调度失败不能静默消耗触发点:补一条 cron fail 记录,保留可观测证据;
    // 已进入停止流程时不再补记:tick 正在被 dispose 收敛,失败是停止本身造成的
    if (disposed || !store.jobs.get(job.id)) return
    try {
      await store.runs.create({ jobId: job.id, trigger: 'cron', status: 'fail', message: '调度失败: ' + detail })
    } catch (recordError) {
      const recordDetail = recordError && recordError.message ? recordError.message : String(recordError)
      logSystem?.('[cron-board] 调度失败记录写入失败 job=' + job.id + ' 错误=' + recordDetail)
    }
  }

  async function tick() {
    if (ticking) return inFlight
    ticking = true
    inFlight = (async () => {
      try {
        const nowMs = now()
        const graceMs = readTickMs()
        let dueCount = 0
        for (const job of store.jobs.list()) {
          // 停止流程已开始:不再推进/派发,本轮剩余触发点留给重启后的 misfire 语义
          if (disposed) break
          if (!job.enabled) continue
          if (typeof job.nextRunAt !== 'number' || Number.isNaN(job.nextRunAt)) continue
          if (job.nextRunAt > nowMs) continue
          dueCount++
          // misfire 判定须在推进前读取到期值(update 会原地改写任务对象)
          const dueAt = job.nextRunAt
          const misfired = nowMs - dueAt > graceMs
          // 先推进再执行:执行慢或并发堵不引发重复触发;
          // 多条表达式取各自下一次触发中的最早值,同刻多条表达式合并为一次运行
          const nextAt = nextRunAtOfSchedules(job.schedule, new Date(nowMs))
          await store.jobs.updateRuntime(job.id, { nextRunAt: nextAt, lastRunAt: nowMs })
          // 停止流程落在推进的 await 之间:不再派发,本触发点归入重启后的 misfire 语义
          if (disposed) break
          // 推进期间任务可能被删除(或停用):快照 job 已失效,不能再 dispatch,
          // 否则会为一个不可见任务创建记录与日志目录
          const fresh = store.jobs.get(job.id)
          if (!fresh || !fresh.enabled) continue
          if (misfired) {
            await store.runs.create({ jobId: job.id, trigger: 'cron', status: 'skipped', message: SKIPPED_MISFIRE_MESSAGE })
            continue
          }
          try {
            await executor.dispatch(fresh, 'cron')
          } catch (error) {
            if (disposed) break
            await reportDispatchFailure(fresh, error)
          }
        }
        // 有到期任务即有状态变更(nextRunAt 推进 / skipped 记录 / 运行入队),发布总线
        if (dueCount > 0 && onChange) onChange()
      } finally {
        ticking = false
        inFlight = null
      }
    })()
    return inFlight
  }

  // 下次触发预览:启用任务中最小的 nextRunAt(面板状态展示用)
  function nextRunAt() {
    const dueList = store.jobs
      .list((job) => job.enabled && typeof job.nextRunAt === 'number' && !Number.isNaN(job.nextRunAt))
      .map((job) => job.nextRunAt)
    return dueList.length > 0 ? Math.min(...dueList) : null
  }

  // 停止:置位后新 tick 直通返回;在飞 tick 必须等它收尾再停执行链,
  // 否则 tick 会在 dispose 返回后继续推进 nextRunAt/写调度失败记录
  async function dispose() {
    disposed = true
    if (inFlight) await inFlight.catch(() => {})
    await executor.stop()
  }

  return {
    recover,
    tick() {
      if (disposed) return inFlight || Promise.resolve()
      return tick()
    },
    status: () => executor.status(),
    nextRunAt,
    dispose,
  }
}
