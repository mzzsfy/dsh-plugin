import { setTimeout as delay } from 'node:timers/promises'
import { ACTIVE_RUN_STATES, abandonSessionRuns, expireStaleRuns } from './core/task.mjs'
import { createRunReportCollector } from './core/report-events.mjs'
import { isSessionGoneError } from './core/session-errors.mjs'

// 重连退避:失败指数增长到上限;连续失败过多即停止跟随并留告警。
// 会话不再有未核清 Run 时跟随目的已达成,直接结束——派发每次都生成新的 sessionId,
// 同一会话不会再有后续 Run。
const DEFAULT_RETRY_MS = 1 * 1000
const MAX_RETRY_MS = 60 * 1000
const DEFAULT_MAX_FAILURES = 8

function messageOf(error) {
  return String(error?.message ?? error).slice(0, 160)
}

export function createRunFollowers({
  store, sessionAdapter, onError = console.warn,
  retryMs = DEFAULT_RETRY_MS, maxRetryMs = MAX_RETRY_MS, maxFailures = DEFAULT_MAX_FAILURES,
  wait = delay,
}) {
  const followers = new Map()
  let disposed = false

  async function waitFor(ms, signal) {
    try {
      await wait(ms, undefined, { signal })
      return true
    } catch {
      return false
    }
  }

  function follow(taskId, sessionId) {
    const key = JSON.stringify([taskId, sessionId])
    if (disposed || followers.has(key)) return
    const controller = new AbortController()
    const collector = createRunReportCollector({ taskId, sessionId, store, onError })
    // 增量游标:重连只回放游标之后的 durable 事件,不随会话长度线性重放
    let cursor = -1
    // 该会话是否仍有未核清 Run:与 hasActiveRuns 同源判据。失联 Run 先按已断收敛,
    // 否则一个从未创建成功的会话会让跟随器每秒重放历史。
    let readFailureWarned = false
    // 内存观测先于落盘:节流窗口内的事件时间也要算活体证据,否则旧 lastEventAt 会让
    // 刚有工具事件的长任务在流收尾时被判失联(落盘随后补齐,不依赖该投影)。
    function withObservedRuns(aggregate) {
      const runs = Object.entries(aggregate?.runs ?? {}).map(([runId, run]) => {
        const observed = collector.lastObservedAt(runId)
        return [runId, Number.isFinite(observed) && observed > (run.lastEventAt ?? -Infinity) ? { ...run, lastEventAt: observed } : run]
      })
      return { ...aggregate, runs: Object.fromEntries(runs) }
    }
    async function hasActiveRun() {
      if (typeof store.loadAggregate !== 'function') return true
      try {
        const aggregate = await store.loadAggregate(taskId)
        const active = Object.entries(aggregate?.runs ?? {}).filter(([, run]) => run.sessionId === sessionId && ACTIVE_RUN_STATES.has(run.state))
        if (active.length === 0) return false
        const expiredIds = new Set(expireStaleRuns(withObservedRuns(aggregate)).result?.expired ?? [])
        if (!active.some(([runId]) => expiredIds.has(runId))) return true
        await store.updateAggregate(taskId, (current) => expireStaleRuns(withObservedRuns(current)).result?.aggregate ?? current)
        onError(`[boss-simulator] follow ${sessionId}: 超过失联阈值无事件,Run 按已断收敛`)
        return active.some(([runId]) => !expiredIds.has(runId))
      } catch (error) {
        // 存储持续不可用时只告警一次,避免按重试间隔刷屏
        if (!readFailureWarned) {
          readFailureWarned = true
          onError(`[boss-simulator] follow ${sessionId}: 读取 run 状态失败,按活跃处理: ${messageOf(error)}`)
        }
        return true
      }
    }
    // 放弃跟随(会话不存在/已删除/连续失败)前先把本会话在飞 Run 落盘收敛:
    // 会话不可达后这些 Run 永远不会再有 durable 事件,留着 active/unknown 会永久占执行槽,
    // 结案与删除都会被"存在未核清 Run"挡死。
    async function abandonRuns() {
      try {
        await store.updateAggregate(taskId, (current) => abandonSessionRuns(withObservedRuns(current), sessionId).result?.aggregate ?? current)
      } catch (error) {
        onError(`[boss-simulator] follow ${sessionId}: 收敛在飞 Run 失败: ${messageOf(error)}`)
      }
    }
    const done = (async () => {
      let failures = 0
      while (!controller.signal.aborted) {
        let failure = null
        try {
          for await (const event of sessionAdapter.followSessionEvents(sessionId, controller.signal, { afterSeq: cursor })) {
            if (controller.signal.aborted) return
            if (Number.isSafeInteger(event.seq) && event.seq > cursor) cursor = event.seq
            await collector.accept(event)
          }
        } catch (error) {
          if (controller.signal.aborted) return
          failure = error
        }
        if (isSessionGoneError(failure)) {
          await abandonRuns()
          onError(`[boss-simulator] follow ${sessionId}: 会话不存在或已删除,停止跟随`)
          return
        }
        if (failure === null) {
          failures = 0
          // 会话已无未核清 Run:跟随目的达成,结束而不是无限重放会话快照
          if (!(await hasActiveRun())) return
          if (!(await waitFor(retryMs, controller.signal))) return
          continue
        }
        failures += 1
        onError(`[boss-simulator] follow ${sessionId}: ${messageOf(failure)}`)
        if (failures >= maxFailures) {
          // 放弃前把在飞 Run 收敛落盘,避免失败退避把任务永久锁在执行中
          await hasActiveRun()
          await abandonRuns()
          onError(`[boss-simulator] follow ${sessionId}: 连续失败 ${failures} 次,停止跟随`)
          return
        }
        if (!(await waitFor(Math.min(maxRetryMs, retryMs * 2 ** (failures - 1)), controller.signal))) return
      }
    })().finally(() => {
      // 跟随结束即停心跳补写定时器:不跨跟随存活,也不写已终态 Run
      collector.dispose()
      followers.delete(key)
    })
    followers.set(key, { controller, done })
    return done
  }

  async function restore() {
    for (const aggregate of await store.listAggregates()) {
      for (const run of Object.values(aggregate.runs ?? {})) {
        if (run.sessionId && ACTIVE_RUN_STATES.has(run.state)) follow(aggregate.taskId, run.sessionId)
      }
    }
  }

  async function dispose() {
    disposed = true
    const active = [...followers.values()]
    active.forEach(({ controller }) => controller.abort())
    await Promise.all(active.map(({ done }) => done))
  }

  return { follow, restore, dispose }
}
