// executor:执行链共用模块(api 手动运行与 scheduler cron 触发同源)。
// 预占 RunRecord → 全局/任务级并发闸门(内存队列)→ 执行到终态。
// 会话任务不展开同名多值(设计 §4.2);shell 任务按启用变量笛卡尔积展开。

import { DEFAULT_MAX_EXPANSION } from './config.mjs'
import { expandEnvMatrix } from './env-expand.mjs'
import { createShellRunner } from './shell-runner.mjs'

export function createExecutor({ store, logger, runner, sessionRunner, maxExpansion = DEFAULT_MAX_EXPANSION, readMaxConcurrent, readLogKeep }) {
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
        logSink: { append: (chunk) => logger.append(job.id, record.runId, chunk) },
      })
      await store.runs.update(record.runId, {
        status: outcome.status,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        exitCode: outcome.exitCode,
      })
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
      const combinations = job.kind === 'session'
        ? [{}]
        : expandEnvMatrix({ envs: store.envs.list(), maxExpansion }).combinations
      const runnerFor = job.kind === 'session' ? () => sessionRunner : () => shellRunner
      const records = []
      for (let i = 0; i < combinations.length; i++) {
        const record = await store.runs.create({ jobId: job.id, trigger, status: 'queued', logFile: joinLog(job.id) })
        await store.runs.update(record.runId, { logFile: joinLog(job.id, record.runId) })
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
