// 卸载/重建在途扫描:旧代必须在 await 之后失效,不得再 resume/followup
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

function createClock(start = 1_000_000) {
  let now = start
  let nextId = 0
  const timers = new Map()
  return {
    timers,
    now: () => now,
    setTimeout(fn, ms) {
      const id = (nextId += 1)
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    async runNext() {
      const [id, timer] = timers.entries().next().value
      timers.delete(id)
      now += timer.ms
      await timer.fn()
      return timer.ms
    },
  }
}

const events = [
  { seq: 1, time: 1_000_000, type: 'turn/start', data: { turn: 1 } },
  {
    seq: 2,
    time: 1_000_000,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '话说到一半' }] }, stream: [] },
  },
]

test('dispose 在途扫描:观察返回后不得再 resume/followup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'keep-working-dispose-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const clock = createClock()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realNow = Date.now
  globalThis.setTimeout = clock.setTimeout
  globalThis.clearTimeout = clock.clearTimeout
  Date.now = clock.now

  let resolveObserve
  let observeStarted
  const observing = new Promise((resolve) => { observeStarted = resolve })
  const observation = new Promise((resolve) => { resolveObserve = resolve })
  let resumeCalls = 0
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      get: () => undefined,
      resume: async () => { resumeCalls += 1 },
      list: () => [],
    },
    on: () => () => {},
    effect: (factory) => {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    fiber: { state: 2 },
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [{ header: { id: 's1' }, events }],
          observeSession: async () => {
            observeStarted()
            return observation
          },
        }
      }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      return undefined
    },
    inject: () => {},
  }

  try {
    await apply(ctx, { scanOnBoot: true, freshMs: 120_000 })
    const scanDone = clock.runNext()
    await observing
    // 卸载运行期(逆序回收 effect,lifecycle 在最后)
    for (const dispose of effects.reverse()) dispose?.()
    resolveObserve({ header: { id: 's1' }, events, [Symbol.dispose]() {} })
    await scanDone
    assert.equal(resumeCalls, 0, '旧代在途扫描不得再物化会话')
    assert.equal(clock.timers.size, 0, '卸载后不得再排重试')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    Date.now = realNow
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})
