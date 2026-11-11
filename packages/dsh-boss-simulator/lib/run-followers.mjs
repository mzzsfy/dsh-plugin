import { setTimeout as delay } from 'node:timers/promises'
import { createRunReportCollector } from './core/report-events.mjs'

// 重连退避:失败指数增长到上限;连续失败过多即停止跟随并留告警,
// 正常流自然结束(无异常)按短退避继续跟随,settle/rejected 由调用方停止。
const DEFAULT_RETRY_MS = 1 * 1000
const MAX_RETRY_MS = 60 * 1000
const DEFAULT_MAX_FAILURES = 8
// 会话已无未结 run 时的重订阅间隔:跟随目的已达成,只需等待新 run 出现
const DEFAULT_IDLE_RETRY_MS = 30 * 1000

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
  retryMs = DEFAULT_RETRY_MS, idleRetryMs = DEFAULT_IDLE_RETRY_MS, maxRetryMs = MAX_RETRY_MS, maxFailures = DEFAULT_MAX_FAILURES,
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
    // 该会话是否仍有未结 run:与 restore 的准入判据同源
    async function hasActiveRun() {
      const aggregate = await store.loadAggregate?.(taskId)
      return Object.values(aggregate?.runs ?? {}).some((run) => run.sessionId === sessionId && !['settled', 'rejected'].includes(run.state))
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
          // 流自然结束且已无未结 run:退到空闲间隔等待新 run,不再每秒重放整段会话历史
          if (!(await waitFor((await hasActiveRun()) ? retryMs : idleRetryMs, controller.signal))) return
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
        if (run.sessionId && !['settled', 'rejected'].includes(run.state)) follow(aggregate.taskId, run.sessionId)
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
