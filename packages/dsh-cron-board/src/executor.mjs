// executor:执行链共用模块(api 手动运行与 scheduler cron 触发同源)。
// 预占 RunRecord → 全局/任务级并发闸门(内存队列)→ 执行到终态。
// 会话任务不展开同名多值(设计 §4.2);shell 任务按启用变量笛卡尔积展开。
// 停止生命周期:stopAccepting 后 dispatch 拒绝;cancelQueued 清队;
// abortActive 杀在途;settle 等活跃归零(插件卸载 await 收敛用)。

import { DEFAULT_MAX_EXPANSION, JOB_DELETING_REASON } from './config.mjs'
import { expandEnvMatrix } from './env-expand.mjs'
import { createShellRunner } from './shell-runner.mjs'

// 会话执行通道缺失时的兜底:记录 fail 而非让执行链崩溃
const SESSION_UNAVAILABLE = {
  run: async () => ({ status: 'fail', message: '会话服务不可用' }),
}

// 卸载收敛上限:可取消单元(shell)立即终态,不可取消单元(会话)超限放行
const SETTLE_TIMEOUT_MS = 5 * 1000
// 活跃归零轮询间隔
const SETTLE_POLL_MS = 20
const CANCELLED_STOP_MESSAGE = '执行链停止,排队运行取消'
const CANCELLED_JOB_MESSAGE = '任务已删除,排队运行取消'
const CANCELLED_PREEMPT_MESSAGE = '执行预占失败,运行取消'

// 调度冲突:删除窗口 / 任务已删除 / 执行链已停止都是状态类拒绝,api 层按 409 回给调用方,
// 不得收敛成「系统级错误」把真实原因吞掉
function conflictError(message) {
  const error = new Error(message)
  error.status = 409
  return error
}

export function createExecutor({ store, logger, runner, sessionRunner, maxExpansion = DEFAULT_MAX_EXPANSION, readMaxConcurrent, readLogKeep, readMaskEnvInPrompt, logSystem, onChange, settleTimeoutMs = SETTLE_TIMEOUT_MS }) {
  const shellRunner = runner || createShellRunner({ workdirFallback: process.cwd() })
  // 队列与活跃计数:许可数 = min(全局上限, 任务级收紧值);全局上限经 readMaxConcurrent 动态读
  const queue = []
  const activeByJob = new Map()
  let activeTotal = 0
  // 停止态与在途句柄:cancelByRunId 登记可取消运行;settled 等待零活跃
  let stopped = false
  const cancelByRunId = new Map()
  // 删除保护:stopJob 起标记,阻止并发 dispatch 在删除窗口内再入队;
  // 删除被取消(在途未终止)时由调用方 releaseJob 解除
  const refusing = new Set()

  function activeOf(jobId) {
    return activeByJob.get(jobId) || 0
  }

  function limitOf(job) {
    const globalLimit = readMaxConcurrent ? readMaxConcurrent() : Infinity
    const jobLimit = Number.isInteger(job.concurrency) && job.concurrency > 0 ? job.concurrency : Infinity
    return Math.min(globalLimit, jobLimit)
  }

  function pump() {
    if (stopped) return
    for (let i = 0; i < queue.length;) {
      const item = queue[i]
      if (activeTotal >= (readMaxConcurrent ? readMaxConcurrent() : Infinity)) break
      if (activeOf(item.job.id) >= limitOf(item.job)) {
        i++
        continue
      }
      queue.splice(i, 1)
      activeTotal++
      activeByJob.set(item.job.id, activeOf(item.job.id) + 1)
      // 终态写失败不悬挂:状态留在内存,下次任意写落盘自愈
      runUnit(item).catch(() => {})
    }
  }

  async function runUnit({ job, record, env, runnerFor }) {
    // 首个 await 之前先登记取消句柄:stop/stopJob 若落在 running 落库的等待窗口内,
    // 必须能取消「尚未启动」的单元;否则 stop 等满 deadline 返回后 runner 仍会启动,
    // 留下停止返回之后才出现的 shell 进程(取消句柄此时才登记,已无人认领)
    const cancelState = { requested: false, reason: CANCELLED_STOP_MESSAGE, cancel: undefined }
    const requestCancel = (reason) => {
      cancelState.requested = true
      if (typeof reason === 'string') cancelState.reason = reason
      cancelState.cancel?.()
    }
    cancelByRunId.set(record.runId, { cancel: requestCancel, jobId: job.id })
    try {
      const startedAt = Date.now()
      await store.runs.update(record.runId, { status: 'running', startedAt })
      // 停止窗口落在 running 落库之前:不启动 runner,直接以 cancelled 收敛
      if (cancelState.requested || stopped) {
        await store.runs.update(record.runId, {
          status: 'cancelled',
          endedAt: Date.now(),
          message: cancelState.reason,
        }).catch(() => {})
        return
      }
      // pinned 绑定在准入锁内发布;出队使用最新绑定,其余参数保留入队快照。
      const current = job.kind === 'session' ? store.jobs.get(job.id) : undefined
      const executionJob = current && job.session?.mode === 'pinned'
        ? { ...job, session: { ...job.session, pinnedSessionId: current.session?.pinnedSessionId } }
        : job
      const execution = runnerFor(executionJob).run({
        job: executionJob,
        env,
        mask: readMaskEnvInPrompt ? readMaskEnvInPrompt() : false,
        // 会话 runner 无可取消句柄:删除/停止窗口内以谓词在创建会话/投递 prompt 前自检
        isCancelled: () => stopped || refusing.has(job.id),
        // 日志写入为旁路:失败留痕但不产生未处理 rejection(磁盘满/权限变更不应打断执行链)
        logSink: {
          append: (chunk) => {
            try {
              return Promise.resolve(logger.append(job.id, record.runId, chunk)).catch((error) => {
                const detail = error && error.message ? error.message : String(error)
                logSystem?.('cron-board 日志写入失败 run=' + record.runId + ' 错误=' + detail)
              })
            } catch (error) {
              const detail = error && error.message ? error.message : String(error)
              logSystem?.('cron-board 日志写入失败 run=' + record.runId + ' 错误=' + detail)
              return Promise.resolve()
            }
          },
        },
        updateRecord: (patch) => store.runs.update(record.runId, patch),
        updateBinding: (sessionId) => store.jobs.updateRuntime(job.id, {
          session: { ...(store.jobs.get(job.id)?.session ?? job.session), pinnedSessionId: sessionId },
          pinnedSessionId: undefined,
        }),
      })
      // 统一形态:{ promise, cancel };async 兼容形态(既有 runner/测试桩)转 { promise, cancel: 无 }
      const promise = typeof execution?.then === 'function' ? execution : execution.promise
      const cancel = typeof execution?.cancel === 'function' ? execution.cancel : undefined
      cancelState.cancel = cancel
      // 取消请求早于 runner 就绪:补一次取消,不等 stop 再轮询
      if (cancelState.requested) cancel?.()
      const outcome = await promise
      cancelByRunId.delete(record.runId)
      // 终态补记:session 附带 message/sessionId,pinned 自愈时回写新会话 id
      const patch = {
        status: outcome.status,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      }
      if (outcome.exitCode !== undefined) patch.exitCode = outcome.exitCode
      if (outcome.message !== undefined) patch.message = outcome.message
      if (outcome.sessionId !== undefined) patch.sessionId = outcome.sessionId
      if (outcome.model !== undefined) patch.model = outcome.model
      await store.runs.update(record.runId, patch)
      // 任务卡状态回填:看板状态点/耗时直接读任务行(手动与 cron 同源更新)
      const jobPatch = { lastStatus: outcome.status, lastDurationMs: patch.durationMs }
      await store.jobs.updateRuntime(job.id, jobPatch)
    } catch (error) {
      // runner 拒绝(会话服务异常等)也必须有终态,否则运行记录永久停留 running;
      // 先读当前态:try 侧已落库终态(部分写成功,如任务卡回填失败)不得覆写,
      // 任务卡回填改报实际终态;补写失败经 logSystem 留痕(store 损坏时文件日志仍可观测)
      const detail = error && error.message ? error.message : String(error)
      const current = store.runs.get(record.runId)
      const persisted = current !== undefined && current.status !== 'queued' && current.status !== 'running'
      try {
        if (!persisted) {
          await store.runs.update(record.runId, {
            status: 'fail',
            endedAt: Date.now(),
            message: detail,
          })
        }
        await store.jobs.updateRuntime(job.id, { lastStatus: persisted ? current.status : 'fail' })
      } catch (persistError) {
        // 两条路径都留痕(可观测性):未落库=数据面缺口须知晓;已落库=任务卡回填缺口
        const persistDetail = persistError && persistError.message ? persistError.message : String(persistError)
        if (persisted) {
          logSystem?.('cron-board 运行已终态但任务卡回填失败 run=' + record.runId + ' 错误=' + persistDetail)
        } else {
          logSystem?.('cron-board 运行终态补写失败 run=' + record.runId + ' 原始错误=' + detail + ' 补写错误=' + persistDetail)
        }
      }
    } finally {
      cancelByRunId.delete(record.runId)
      activeTotal--
      activeByJob.set(job.id, activeOf(job.id) - 1)
      pump()
      // 运行收尾即状态变更(队列/活跃计数与任务卡回填),发布总线
      if (onChange) onChange()
      // 终态后按保留策略裁剪该任务旧日志(失败不打断执行链)
      if (readLogKeep) {
        await logger.prune(job.id, readLogKeep()).catch(() => {})
      }
    }
  }

  // 排队记录收敛:移出内存队列并按 cancelled 补写终态(补写失败不打断停止链)
  async function markCancelled(records, message) {
    const pending = new Set(records.map((record) => record.runId))
    for (let i = queue.length - 1; i >= 0; i--) {
      if (pending.has(queue[i].record.runId)) queue.splice(i, 1)
    }
    for (const record of records) {
      const current = store.runs.get(record.runId)
      if (current === undefined || current.status !== 'queued') continue
      await store.runs.update(record.runId, {
        status: 'cancelled',
        endedAt: Date.now(),
        message,
      }).catch(() => {})
    }
  }

  // 预占准入:删除窗口与任务存在性都可能在上一次 await 之后改变(DELETE 与 dispatch 并发),
  // 故入口与每轮预占前都要重查,单次入口检查不足以保证「删除后不落库」
  function assertClaimable(jobId) {
    if (refusing.has(jobId)) throw conflictError(JOB_DELETING_REASON)
    if (!store.jobs.get(jobId)) throw conflictError('任务不存在或已删除,拒绝新运行')
  }

  // 记录无归属(任务已删除):整行删除,不留 jobId 指向不存在任务的孤儿 run;
  // 行删除失败(集合损坏等)退回取消终态,至少不悬挂在 queued
  async function discardRecords(records) {
    for (const record of records) {
      const removed = await store.runs.remove(record.runId).catch(() => false)
      if (!removed) await markCancelled([record], CANCELLED_PREEMPT_MESSAGE)
    }
  }

  // 有界等待:条件持续为真超过 deadline 即放行,遗留 running 由 recover() 收敛
  async function settleActive(pending) {
    const deadline = Date.now() + settleTimeoutMs
    while (pending() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
    }
  }

  return {
    // 预占记录并按闸门调度执行;返回 runIds 同步可得(执行在后台按许可推进)
    async dispatch(job, trigger, meta = {}) {
      // 停止态拒绝新执行:拒绝须发生在预占记录之前,不留 queued 孤儿
      if (stopped) throw conflictError('执行链已停止(插件卸载中),拒绝新运行')
      // 删除窗口/任务已被删除:调度快照可能是旧的,任何预占与日志目录创建都必须被拒绝
      assertClaimable(job.id)
      const expansion = job.kind === 'session'
        ? { combinations: [{}], truncated: false }
        : expandEnvMatrix({ envs: store.envs.list(), maxExpansion })
      const combinations = expansion.combinations
      const runnerFor = job.kind === 'session' ? () => (sessionRunner || SESSION_UNAVAILABLE) : () => shellRunner
      const records = []
      try {
        for (let i = 0; i < combinations.length; i++) {
          // 每轮预占前重查:上一轮 create/update 的 await 之间可能已完成 DELETE 与持久化删除
          assertClaimable(job.id)
          // 归因随预占记录落库:cron 触发带上命中的表达式行,manual 不写(空数组也不写)
          const attribution = Array.isArray(meta.schedules) && meta.schedules.length > 0 ? { schedules: meta.schedules } : {}
          const record = await store.runs.create({ jobId: job.id, trigger, status: 'queued', logFile: joinLog(job.id), ...attribution })
          // 先登记再补写:create 成功后的任何失败都必须能回滚这条已落库记录
          records.push(record)
          await store.runs.update(record.runId, { logFile: joinLog(job.id, record.runId) })
          // 截断不静默:受影响运行记录直接带告警文案
          if (expansion.truncated) {
            await store.runs.update(record.runId, { message: '环境变量组合超出上限已截断' })
          }
          // 预占期间的停止/删除态不入队(循环后统一补终态),避免内存队列残留永不执行的项
          if (!stopped && !refusing.has(job.id)) queue.push({ job, record, env: combinations[i], runnerFor })
        }
      } catch (error) {
        // 预占中途失败:已落库的 queued 记录收敛为 cancelled,不留永远排队的孤儿;
        // 删除窗口类拒绝则连行一起清掉(任务已不可见,取消终态也仍是孤儿)
        if (Number.isInteger(error && error.status)) await discardRecords(records)
        else await markCancelled(records, CANCELLED_PREEMPT_MESSAGE)
        throw error
      }
      // 卸载/HMR 落在预占 await 之间:预占记录收敛为 cancelled,且跳过 runOnce 自动禁用
      // (真实运行从未开始,不该留下「已禁用 + 无运行记录」的混合态)
      if (stopped) {
        await markCancelled(records, CANCELLED_STOP_MESSAGE)
        return records.map((record) => record.runId)
      }
      // 删除窗口落在最后一次预占之后:任务已不可见,记录不得留库,显式 409 拒绝
      if (refusing.has(job.id) || !store.jobs.get(job.id)) {
        await discardRecords(records)
        throw conflictError(JOB_DELETING_REASON)
      }
      // 单次任务入队即禁用:先占运行再落禁用,封死 cron 连续 tick 的重复触发窗口;
      // 禁用写失败必须回滚已入队记录,否则调度失败后仍留有可被后续 pump 捡起的孤儿
      try {
        if (job.runOnce === true) {
          await store.jobs.update(job.id, { enabled: false })
        }
      } catch (error) {
        await markCancelled(records, CANCELLED_PREEMPT_MESSAGE)
        throw error
      }
      pump()
      return records.map((record) => record.runId)
    },
    status() {
      return { active: activeTotal, queued: queue.length }
    },
    // 停止生命周期:拒新 → 清队(记录 cancelled)→ 杀在途 → settle 等活跃归零
    async stop() {
      stopped = true
      await markCancelled(queue.splice(0, queue.length).map((item) => item.record), CANCELLED_STOP_MESSAGE)
      for (const entry of [...cancelByRunId.values()]) entry.cancel(CANCELLED_STOP_MESSAGE)
      cancelByRunId.clear()
      await settleActive(() => activeTotal > 0)
    },
    // 任务级清场(删除任务前置):清该任务排队记录、杀该任务在途运行、等其归零;
    // 不置停止态,其余任务不受影响。无执行面的任务幂等空操作
    async stopJob(jobId) {
      // 删除窗口从清场开始:并发 dispatch 在 queue 清空后、job 删除前不得再塞入新记录
      refusing.add(jobId)
      const cancelled = []
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].job.id !== jobId) continue
        cancelled.unshift(queue.splice(i, 1)[0].record)
      }
      await markCancelled(cancelled, CANCELLED_JOB_MESSAGE)
      for (const [runId, entry] of [...cancelByRunId]) {
        if (entry.jobId !== jobId) continue
        entry.cancel(CANCELLED_JOB_MESSAGE)
        cancelByRunId.delete(runId)
      }
      // 与卸载收敛同一 deadline:会话运行无取消句柄,无上限等待会让删除路由永久挂起
      await settleActive(() => activeOf(jobId) > 0)
      return { settled: activeOf(jobId) === 0, active: activeOf(jobId) }
    },
    // 删除被取消(在途未终止):解除拒绝态,任务继续正常调度
    releaseJob(jobId) {
      refusing.delete(jobId)
    },
    // 等待全部活跃单元终态收敛(pump 已被停止态闸死,活跃只减不增);
    // 上限兜底:会话 runner 无取消句柄,单步在途可能长时间挂起——超限放行,
    // 不阻塞宿主卸载(记录留 running,重启 recover 收敛为 interrupted)
    async settle() {
      await settleActive(() => activeTotal > 0)
    },
  }

}

function joinLog(jobId, runId) {
  const name = runId === undefined ? 'pending' : runId + '.log'
  return jobId + '/' + name
}
