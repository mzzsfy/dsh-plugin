// executor:执行链共用模块(api 手动运行与 scheduler cron 触发同源)。
// 预占 RunRecord → 全局/任务级并发闸门(内存队列)→ 执行到终态。
// 会话任务不展开同名多值(设计 §4.2);shell 任务按启用变量笛卡尔积展开。

import { DEFAULT_MAX_EXPANSION } from './config.mjs'
import { expandEnvMatrix } from './env-expand.mjs'
import { createShellRunner } from './shell-runner.mjs'

// 会话执行通道缺失时的兜底:记录 fail 而非让执行链崩溃
const SESSION_UNAVAILABLE = {
  run: async () => ({ status: 'fail', message: '会话服务不可用' }),
}

export function createExecutor({ store, logger, runner, sessionRunner, maxExpansion = DEFAULT_MAX_EXPANSION, readMaxConcurrent, readLogKeep, readMaskEnvInPrompt, logSystem }) {
  const shellRunner = runner || createShellRunner({ workdirFallback: process.cwd() })
  // 队列与活跃计数:许可数 = min(全局上限, 任务级收紧值);全局上限经 readMaxConcurrent 动态读
  const queue = []
  const activeByJob = new Map()
  let activeTotal = 0

  function activeOf(jobId) {
    return activeByJob.get(jobId) || 0
  }

  function limitOf(job) {
    const globalLimit = readMaxConcurrent ? readMaxConcurrent() : Infinity
    const jobLimit = Number.isInteger(job.concurrency) && job.concurrency > 0 ? job.concurrency : Infinity
    return Math.min(globalLimit, jobLimit)
  }

  function pump() {
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
    try {
      const startedAt = Date.now()
      await store.runs.update(record.runId, { status: 'running', startedAt })
      const outcome = await runnerFor(job).run({
        job,
        env,
        mask: readMaskEnvInPrompt ? readMaskEnvInPrompt() : false,
        logSink: { append: (chunk) => logger.append(job.id, record.runId, chunk) },
        updateRecord: (patch) => store.runs.update(record.runId, patch),
      })
      // 终态补记:session 附带 message/sessionId,pinned 自愈时回写新会话 id
      const patch = {
        status: outcome.status,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      }
      if (outcome.exitCode !== undefined) patch.exitCode = outcome.exitCode
      if (outcome.message !== undefined) patch.message = outcome.message
      if (outcome.sessionId !== undefined) patch.sessionId = outcome.sessionId
      await store.runs.update(record.runId, patch)
      // 任务卡状态回填:看板状态点/耗时直接读任务行(手动与 cron 同源更新)
      const jobPatch = { lastStatus: outcome.status, lastDurationMs: patch.durationMs }
      if (outcome.pinnedNewId !== undefined) jobPatch.pinnedSessionId = outcome.pinnedNewId
      await store.jobs.update(job.id, jobPatch)
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
        await store.jobs.update(job.id, { lastStatus: persisted ? current.status : 'fail' })
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
      activeTotal--
      activeByJob.set(job.id, activeOf(job.id) - 1)
      pump()
      // 终态后按保留策略裁剪该任务旧日志(失败不打断执行链)
      if (readLogKeep) {
        await logger.prune(job.id, readLogKeep()).catch(() => {})
      }
    }
  }

  return {
    // 预占记录并按闸门调度执行;返回 runIds 同步可得(执行在后台按许可推进)
    async dispatch(job, trigger) {
      const expansion = job.kind === 'session'
        ? { combinations: [{}], truncated: false }
        : expandEnvMatrix({ envs: store.envs.list(), maxExpansion })
      const combinations = expansion.combinations
      const runnerFor = job.kind === 'session' ? () => (sessionRunner || SESSION_UNAVAILABLE) : () => shellRunner
      const records = []
      for (let i = 0; i < combinations.length; i++) {
        const record = await store.runs.create({ jobId: job.id, trigger, status: 'queued', logFile: joinLog(job.id) })
        await store.runs.update(record.runId, { logFile: joinLog(job.id, record.runId) })
        // 截断不静默:受影响运行记录直接带告警文案
        if (expansion.truncated) {
          await store.runs.update(record.runId, { message: '环境变量组合超出上限已截断' })
        }
        records.push(record)
        queue.push({ job, record, env: combinations[i], runnerFor })
      }
      pump()
      return records.map((record) => record.runId)
    },
    status() {
      return { active: activeTotal, queued: queue.length }
    },
  }
}

function joinLog(jobId, runId) {
  const name = runId === undefined ? 'pending' : runId + '.log'
  return jobId + '/' + name
}
