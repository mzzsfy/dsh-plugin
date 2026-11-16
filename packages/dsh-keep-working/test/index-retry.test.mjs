// 启动扫描重试节奏:1s→60s 指数退避,freshMs 只当总窗口
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 扫描日志按 DSH_HOME 落盘:不隔离就会写进真实 home,污染生产诊断日志
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'keep-working-retry-'))

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

function createContext(query) {
  const effects = []
  return {
    effects,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      agents: { get: () => undefined, list: () => [] },
      on: () => () => {},
      effect: (factory) => {
        const dispose = factory()
        effects.push(dispose)
        return dispose
      },
      fiber: { state: 2 },
      get(name) {
        if (name === 'sessionQuery') return query
        if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
        return undefined
      },
      inject: () => {},
    },
  }
}

test('启动扫描按 1s→60s 指数退避,且不越过 freshMs 总窗口', async () => {
  const clock = createClock()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realNow = Date.now
  const { ctx, effects } = createContext({ listSessions: async () => [] })
  globalThis.setTimeout = clock.setTimeout
  globalThis.clearTimeout = clock.clearTimeout
  Date.now = clock.now
  try {
    // 首轮永远重试(全量回退空列表可能只是服务未就绪),窗口设为 120s
    await apply(ctx, { scanOnBoot: true, freshMs: 120_000 })
    const delays = []
    // 冷启动延迟 + 退避序列;最后一跳按剩余窗口截断
    while (clock.timers.size > 0) delays.push(await clock.runNext())
    assert.deepEqual(delays, [5_000, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 52_000])
  } finally {
    for (const dispose of effects) dispose?.()
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    Date.now = realNow
  }
})
