import { setTimeout as delay } from 'node:timers/promises'
import { ACTIVE_RUN_STATES } from './core/task.mjs'
import { createRunReportCollector } from './core/report-events.mjs'

// 重连退避:失败指数增长到上限;连续失败过多即停止跟随并留告警。
// 会话不再有未核清 Run 时跟随目的已达成,直接结束——派发每次都生成新的 sessionId,
// 同一会话不会再有后续 Run。
const DEFAULT_RETRY_MS = 1 * 1000
const MAX_RETRY_MS = 60 * 1000
const DEFAULT_MAX_FAILURES = 8

// 会话不存在/已删除属终态:重连不会恢复,按错误码与文案识别
const TERMINAL_CODES = new Set(['SESSION_NOT_FOUND', 'SESSION_DELETED', 'session_not_found', 'session_deleted'])
const TERMINAL_MESSAGE = /(session|会话)[^\n]{0,40}(not found|missing|deleted|不存在|已删除)|ENOENT[^\n]*session/i

export function isTerminalFollowError(error) {
  if (!error) return false
  if (TERMINAL_CODES.has(error.code)) return true
  return TERMINAL_MESSAGE.test(String(error.message ?? error))
}

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
    const collector = createRunReportCollector({ taskId, sessionId, store })
    // 该会话是否仍有未核清 Run:与 hasActiveRuns 同源判据。
    // 判不了(存储不提供按 id 读, 或读失败)按活跃处理:多等一轮继续跟随,
    // 优于据此停止跟随或让异常冒泡成宿主的未处理拒绝
    let readFailureWarned = false
    async function hasActiveRun() {
      if (typeof store.loadAggregate !== 'function') return true
      try {
        const aggregate = await store.loadAggregate(taskId)
        return Object.values(aggregate?.runs ?? {}).some((run) => run.sessionId === sessionId && ACTIVE_RUN_STATES.has(run.state))
      } catch (error) {
        // 存储持续不可用时只告警一次,避免按重试间隔刷屏
        if (!readFailureWarned) {
          readFailureWarned = true
          onError(`[boss-simulator] follow ${sessionId}: 读取 run 状态失败,按活跃处理: ${messageOf(error)}`)
        }
        return true
      }
    }
    const done = (async () => {
      let failures = 0
      while (!controller.signal.aborted) {
        let failure = null
        try {
          for await (const event of sessionAdapter.followSessionEvents(sessionId, controller.signal)) {
            if (controller.signal.aborted) return
            await collector.accept(event)
          }
        } catch (error) {
          if (controller.signal.aborted) return
          failure = error
        }
        if (isTerminalFollowError(failure)) {
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
          onError(`[boss-simulator] follow ${sessionId}: 连续失败 ${failures} 次,停止跟随`)
          return
        }
        if (!(await waitFor(Math.min(maxRetryMs, retryMs * 2 ** (failures - 1)), controller.signal))) return
      }
    })().finally(() => followers.delete(key))
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
