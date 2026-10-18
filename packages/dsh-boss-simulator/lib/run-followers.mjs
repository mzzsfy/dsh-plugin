import { setTimeout as delay } from 'node:timers/promises'
import { createRunReportCollector } from './core/report-events.mjs'

export function createRunFollowers({ store, sessionAdapter, onError = console.warn, retryMs = 1000 }) {
  const followers = new Map()
  let disposed = false
  function follow(taskId, sessionId) {
    const key = JSON.stringify([taskId, sessionId])
    if (disposed || followers.has(key)) return
    const controller = new AbortController()
    const collector = createRunReportCollector({ taskId, sessionId, store })
    const done = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of sessionAdapter.followSessionEvents(sessionId, controller.signal)) {
            if (controller.signal.aborted) return
            await collector.accept(event)
          }
        } catch (error) {
          if (controller.signal.aborted) return
          onError(`[boss-simulator] follow ${sessionId}: ${String(error.message).slice(0, 160)}`)
        }
        try { await delay(retryMs, undefined, { signal: controller.signal }) } catch { return }
      }
    })().finally(() => followers.delete(key))
    followers.set(key, { controller, done })
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
