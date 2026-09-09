// collector 行为测试:(session,turn,step) 去重、归因链回退、游标边界与
// liveness 复查、fork 前缀跳过、采集失败计数、abort 与 reset 协同。
// session/event 与 sessionPersistence 以内存假件驱动,时间取事件自带 time。

import test from 'node:test'
import assert from 'node:assert/strict'

import { UsageCollector } from '../src/collector.js'

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

const ev = (type, seq, time, data = {}) => ({ type, seq, time, data })
const usage = (extra = {}) => ({
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  ...extra,
})
const session = (id) => ({ id })
const tick = () => new Promise((resolve) => setImmediate(resolve))

// 采集器依赖的 store 面:record/seenSessions/liveSequences/markSeenSessions/
// markLiveSequences/reset/readyPromise,内存态 + 可注入失败
function fakeStore({ failRecord = false, failMarkLive = false } = {}) {
  const samples = []
  const state = { backfilledSessions: new Set(), liveFirstSeq: new Map() }
  const stats = { markLiveCalls: 0, markSeenCalls: 0, resets: 0, lastBoundaries: null }
  return {
    samples,
    state,
    stats,
    async record(sample) {
      if (failRecord) throw new Error('simulated record failure')
      samples.push(sample)
    },
    async seenSessions() {
      return new Set(state.backfilledSessions)
    },
    async liveSequences() {
      return new Map(state.liveFirstSeq)
    },
    async markSeenSessions(ids) {
      stats.markSeenCalls += 1
      for (const id of ids) state.backfilledSessions.add(id)
    },
    async markLiveSequences(entries) {
      stats.markLiveCalls += 1
      if (failMarkLive) throw new Error('simulated mark failure')
      for (const [id, seq] of entries) {
        const prev = state.liveFirstSeq.get(id)
        if (prev === undefined || seq < prev) state.liveFirstSeq.set(id, seq)
      }
    },
    async reset(boundaries) {
      stats.resets += 1
      stats.lastBoundaries = boundaries
      state.backfilledSessions.clear()
      state.liveFirstSeq = new Map(boundaries)
      samples.length = 0
    },
    async readyPromise() {},
  }
}

function fakeSessions(handles = []) {
  const byId = new Map(handles.map((handle) => [handle.id, handle]))
  return {
    list: () => handles,
    get: (id) => byId.get(id),
  }
}

// definitions: [{ id, events?, inheritedEventCount?, fail? }]
// 内部统一契约形状(list → [{id}],readLog → {inheritedEventCount, events}),
// 宿主 persistence 的多版本映射由 archive-reader 测试单独覆盖
function fakePersistence(definitions = []) {
  const byId = new Map(definitions.map((def) => [def.id, def]))
  return {
    async list() {
      return definitions.map((def) => ({ id: def.id }))
    },
    async readLog(id) {
      const def = byId.get(id)
      if (!def) throw new Error(`session "${id}" not found`)
      if (def.fail) throw new Error(def.fail)
      return { inheritedEventCount: def.inheritedEventCount ?? 0, events: def.events ?? [] }
    },
  }
}

// 宿主 handle 代形状(list 返回 snapshot,open/read/close 读体),供走
// rescan → 工厂分派 → backfill 的装配路径测试使用
function fakeHostPersistence(definitions = []) {
  const byId = new Map(definitions.map((def) => [def.id, def]))
  return {
    async list() {
      return definitions.map((def) => ({ header: { id: def.id }, revision: {} }))
    },
    async open(id, access) {
      const def = byId.get(id)
      if (!def) throw new Error(`session "${id}" not found`)
      return {
        header: { id },
        inheritedEventCount: def.inheritedEventCount ?? 0,
        access,
        async read() {
          if (def.fail) throw new Error(def.fail)
          return { eventState: 'detached', events: def.events ?? [] }
        },
        async close() {},
      }
    },
  }
}

function fakeCtx({ sessions = fakeSessions(), persistence = fakePersistence() } = {}) {
  const listeners = new Map()
  return {
    sessions,
    sessionPersistence: persistence,
    on(event, listener) {
      listeners.set(event, listener)
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args)
    },
  }
}

const liveCollector = ({ store = fakeStore(), sessions, persistence } = {}) => {
  const ctx = fakeCtx({ sessions, persistence })
  const collector = new UsageCollector(ctx, store)
  collector.start()
  return { ctx, store, collector }
}

test('turn/end 产生 turn 标记样本:事件 time 口径,零桶,无去重键', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 14, 37)
  ctx.emit('session/event', session('s1'), ev('turn/end', 7, t))
  await tick()
  assert.equal(store.samples.length, 1)
  assert.deepEqual(store.samples[0], {
    time: t,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turn: true,
  })
})

test('step/start 与 llm/retry-started 产生 request 标记样本', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 14, 37)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, t))
  ctx.emit('session/event', session('s1'), ev('llm/retry-started', 2, t))
  await tick()
  assert.equal(store.samples.length, 2)
  for (const sample of store.samples) {
    assert.equal(sample.request, true)
    assert.equal(sample.turn, undefined)
    assert.equal(sample.inputTokens, 0)
    assert.equal(sample.time, t)
  }
})

test('step/start 观测起点:首个 usage 样本附 durationMs(start 到样本时刻)', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  const sampleAt = start + 6 * 1000 + 500
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 2, sampleAt, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.durationMs, 6500)
})

test('(session,turn,step) 去重:同键先到样本生效,重复报告吞掉', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 1, t, {
    turn: 0,
    step: 0,
    chunk: { type: 'usage', usage: usage({ inputTokens: 100 }) },
  }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 2, t, {
    turn: 0,
    step: 0,
    usage: usage({ inputTokens: 999 }),
    message: {},
  }))
  await tick()
  assert.equal(store.samples.length, 1)
  assert.equal(store.samples[0].inputTokens, 100)
})

test('无 step/start 起点的 usage 样本不带 durationMs', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('assistant/message', 1, t, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  assert.equal(store.samples.length, 1)
  assert.equal(store.samples[0].durationMs, undefined)
})

test('retry-started 重置起点:时长只含最终尝试', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  const retryAt = start + 60 * 1000
  const sampleAt = retryAt + 5 * 1000
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('llm/retry-started', 2, retryAt, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 3, sampleAt, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.durationMs, 5000)
})

test('同时刻零时长不附 durationMs,request 标记样本不带时长', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, t, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 2, t, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  assert.equal(store.samples.length, 2)
  for (const sample of store.samples) {
    assert.equal(sample.durationMs, undefined)
  }
})

test('不同 (turn,step) 各自成立,跨会话同键互不影响', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  const chunkAt = (seq, turn, step) => ev('assistant/chunk', seq, t, {
    turn,
    step,
    chunk: { type: 'usage', usage: usage({ inputTokens: turn * 10 + step }) },
  })
  ctx.emit('session/event', session('s1'), chunkAt(1, 0, 0))
  ctx.emit('session/event', session('s1'), chunkAt(2, 0, 1))
  ctx.emit('session/event', session('s2'), chunkAt(1, 0, 0))
  await tick()
  assert.deepEqual(store.samples.map((sample) => sample.inputTokens), [0, 1, 0])
})

test('四桶全零 usage 为噪声不产样本', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('assistant/message', 1, t, {
    turn: 0,
    step: 0,
    usage: usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  }))
  await tick()
  assert.equal(store.samples.length, 0)
})

test('纯缓存调用(仅缓存桶非零)仍产样本', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('assistant/message', 1, t, {
    turn: 0,
    step: 0,
    usage: usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 5, cacheWriteTokens: 0 }),
  }))
  await tick()
  assert.equal(store.samples.length, 1)
  assert.equal(store.samples[0].cacheReadTokens, 5)
  assert.equal(store.samples[0].inputTokens, 0)
})

test('非 usage 型 chunk 与缺 usage 的 message 忽略', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 1, t, {
    turn: 0,
    step: 0,
    chunk: { type: 'text-delta', text: 'hi' },
  }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 2, t, { turn: 0, step: 1, message: {} }))
  await tick()
  assert.equal(store.samples.length, 0)
})

test('归因链:观测路由归因 chunk 样本', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('request/context', 0, t, { provider: 'deepseek', model: 'chat' }))
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 1, t, {
    turn: 0,
    step: 0,
    chunk: { type: 'usage', usage: usage() },
  }))
  await tick()
  assert.equal(store.samples.length, 1)
  assert.equal(store.samples[0].model, 'deepseek/chat')
})

test('归因链:message.source 权威并刷新会话路由供后续样本沿用', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('request/context', 0, t, { provider: 'deepseek', model: 'chat' }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 1, t, {
    turn: 0,
    step: 0,
    usage: usage({ inputTokens: 1 }),
    message: { source: { provider: 'other', model: 'pro' } },
  }))
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 2, t, {
    turn: 0,
    step: 1,
    chunk: { type: 'usage', usage: usage({ inputTokens: 2 }) },
  }))
  await tick()
  assert.deepEqual(store.samples.map((sample) => [sample.inputTokens, sample.model]), [
    [1, 'other/pro'],
    [2, 'other/pro'],
  ])
})

test('归因链:无观测路由时从 requestContext() 懒播种', async () => {
  const sessions = fakeSessions([{ id: 's1', requestContext: () => ({ model: 'solo' }) }])
  const { ctx, store } = liveCollector({ sessions })
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('assistant/message', 1, t, {
    turn: 0,
    step: 0,
    usage: usage({ inputTokens: 1 }),
    message: {},
  }))
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 2, t, {
    turn: 0,
    step: 1,
    chunk: { type: 'usage', usage: usage({ inputTokens: 2 }) },
  }))
  await tick()
  assert.deepEqual(store.samples.map((sample) => sample.model), ['solo', 'solo'])
})

test('归因链:全部缺失时样本无 model', async () => {
  const sessions = fakeSessions([{ id: 's1' }])
  const { ctx, store } = liveCollector({ sessions })
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('assistant/message', 1, t, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  assert.equal(store.samples.length, 1)
  assert.equal(store.samples[0].model, undefined)
})

test('实时游标:首事件标记 firstSeq 并合批,同会话不重复,seq 缺失记哨兵', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 3, t))
  ctx.emit('session/event', session('s1'), ev('step/start', 4, t))
  ctx.emit('session/event', session('s2'), ev('turn/end', 0, t))
  await tick()
  assert.deepEqual(store.state.liveFirstSeq, new Map([['s1', 3], ['s2', 0]]))
  assert.equal(store.stats.markLiveCalls, 1)
  ctx.emit('session/event', session('s3'), { type: 'turn/end', time: t })
  ctx.emit('session/event', {}, ev('turn/end', 0, t))
  await tick()
  assert.equal(store.state.liveFirstSeq.get('s3'), -1)
  assert.equal(store.state.liveFirstSeq.size, 3)
  assert.equal(store.stats.markLiveCalls, 2)
})

test('采集侧 store 失败计入 recordFailures 且不抛断采集', async () => {
  const { ctx, store, collector } = liveCollector({ store: fakeStore({ failRecord: true, failMarkLive: true }) })
  const t = local(2026, 8, 2, 10, 0)
  // request/context 只触发游标写(失败),不产样本
  ctx.emit('session/event', session('s1'), ev('request/context', 0, t, { model: 'm' }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 1, t, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  await tick()
  assert.equal(collector.status().recordFailures, 2)
  assert.equal(collector.status().log.length, 2)
  assert.ok(collector.status().log.every((entry) => entry.kind === 'record' && typeof entry.time === 'number'))
  assert.equal(store.samples.length, 0)
})

test('session/disposed 后该会话去重状态重置', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  const chunk = (seq) => ev('assistant/chunk', seq, t, {
    turn: 0,
    step: 0,
    chunk: { type: 'usage', usage: usage() },
  })
  ctx.emit('session/event', session('s1'), chunk(1))
  ctx.emit('session/disposed', session('s1'))
  ctx.emit('session/event', session('s1'), chunk(2))
  await tick()
  assert.equal(store.samples.length, 2)
})

test('回扫:无边界会话全量重放,归因与游标写回', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{
    id: 's1',
    events: [
      ev('request/context', 0, t, { provider: 'deepseek', model: 'chat' }),
      ev('step/start', 1, t),
      ev('assistant/message', 2, t, {
        turn: 0,
        step: 0,
        usage: usage(),
        message: { source: { provider: 'deepseek', model: 'chat' } },
      }),
      ev('turn/end', 3, t),
    ],
  }])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.equal(store.samples.length, 3)
  assert.equal(store.samples[0].request, true)
  assert.equal(store.samples[0].model, 'deepseek/chat')
  assert.equal(store.samples[1].inputTokens, 10)
  assert.equal(store.samples[1].model, 'deepseek/chat')
  assert.equal(store.samples[2].turn, true)
  assert.deepEqual([...store.state.backfilledSessions], ['s1'])
  assert.equal(collector.status().total, 1)
  assert.equal(collector.status().done, 1)
  assert.equal(collector.status().scannedSessions, 1)
})

test('回扫:重放路径同样附加 durationMs', async () => {
  const start = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{
    id: 's1',
    events: [
      ev('request/context', 0, start, { provider: 'deepseek', model: 'chat' }),
      ev('step/start', 1, start, { turn: 0, step: 0 }),
      ev('assistant/message', 2, start + 7 * 1000, {
        turn: 0,
        step: 0,
        usage: usage(),
        message: { source: { provider: 'deepseek', model: 'chat' } },
      }),
    ],
  }])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.durationMs, 7000)
})

test('回扫:已入游标会话不再重扫', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{ id: 's1', events: [ev('turn/end', 0, t)] }])
  const store = fakeStore()
  store.state.backfilledSessions.add('s1')
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.equal(store.samples.length, 0)
  assert.equal(collector.status().total, 0)
})

test('回扫:liveFirstSeq 边界只重放前缀,实时已拥事件跳过', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{
    id: 's1',
    events: [
      ev('assistant/message', 0, t, { turn: 0, step: 0, usage: usage({ inputTokens: 1 }), message: {} }),
      ev('turn/end', 1, t),
      ev('assistant/message', 2, t, { turn: 1, step: 0, usage: usage({ inputTokens: 2 }), message: {} }),
      ev('turn/end', 3, t),
    ],
  }])
  const store = fakeStore()
  store.state.liveFirstSeq.set('s1', 2)
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.deepEqual(store.samples.map((sample) => [sample.inputTokens, sample.turn]), [[1, undefined], [0, true]])
})

test('回扫:-1 哨兵会话重放零事件但仍入游标', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{ id: 's1', events: [ev('turn/end', 0, t)] }])
  const store = fakeStore()
  store.state.liveFirstSeq.set('s1', -1)
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.equal(store.samples.length, 0)
  assert.deepEqual([...store.state.backfilledSessions], ['s1'])
  assert.equal(collector.status().scannedSessions, 1)
})

test('回扫:活跃会话无有效边界时整会话跳过', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{ id: 's1', events: [ev('turn/end', 0, t)] }])
  const sessions = fakeSessions([{ id: 's1' }])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, sessions)
  assert.equal(store.samples.length, 0)
  assert.equal(store.state.backfilledSessions.size, 0)
  assert.equal(collector.status().done, 1)
  assert.equal(collector.status().scannedSessions, 0)
})

test('回扫:活跃会话有边界时只重放前缀', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{
    id: 's1',
    events: [
      ev('turn/end', 0, t),
      ev('turn/end', 1, t),
      ev('turn/end', 2, t),
    ],
  }])
  const sessions = fakeSessions([{ id: 's1', seq: 5 }])
  const store = fakeStore()
  store.state.liveFirstSeq.set('s1', 2)
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, sessions)
  assert.equal(store.samples.length, 2)
  assert.deepEqual([...store.state.backfilledSessions], ['s1'])
  assert.equal(collector.status().scannedSessions, 1)
})

test('回扫:fork 继承前缀整体跳过且不播种路由', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{
    id: 'child',
    inheritedEventCount: 2,
    events: [
      ev('request/context', 0, t, { model: 'inherited-model' }),
      ev('assistant/message', 1, t, { turn: 0, step: 0, usage: usage({ inputTokens: 500 }), message: {} }),
      ev('assistant/chunk', 2, t, {
        turn: 0,
        step: 1,
        chunk: { type: 'usage', usage: usage({ inputTokens: 7 }) },
      }),
    ],
  }])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.equal(store.samples.length, 1)
  assert.equal(store.samples[0].inputTokens, 7)
  assert.equal(store.samples[0].model, undefined)
})

test('回扫:单会话失败不中断整轮且不进游标', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([
    { id: 's1', events: [ev('turn/end', 0, t)] },
    { id: 's2', fail: 'corrupted log' },
  ])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.equal(store.samples.length, 1)
  assert.deepEqual([...store.state.backfilledSessions], ['s1'])
  assert.equal(collector.status().error, undefined)
  assert.equal(collector.status().skippedSessions, 1)
  assert.equal(collector.status().done, 2)
  assert.equal(collector.status().log.length, 1)
  assert.equal(collector.status().log[0].kind, 'skipped')
  assert.ok(collector.status().log[0].detail.startsWith('s2'))
})

test('回扫:record 失败使会话失败并保留游标重试机会', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{ id: 's1', events: [ev('turn/end', 0, t)] }])
  const store = fakeStore({ failRecord: true })
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.equal(store.state.backfilledSessions.size, 0)
  assert.equal(collector.status().skippedSessions, 1)
  assert.equal(collector.status().done, 1)
})

test('回扫:list 失败记入 error 并向上传播,running 复位', async () => {
  const failure = new Error('sessionPersistence API 未识别')
  const persistence = {
    async list() {
      throw failure
    },
    async readLog() {
      throw new Error('not reached')
    },
  }
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await assert.rejects(collector.backfill(persistence, fakeSessions()), (error) => error === failure)
  assert.equal(collector.status().error, failure.message)
  assert.equal(collector.status().running, false)
  assert.equal(store.samples.length, 0)
})

test('abort:已中止 signal 直接返回不进入扫描', async () => {
  const persistence = fakePersistence([{ id: 's1', events: [] }])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  const controller = new AbortController()
  controller.abort()
  await collector.backfill(persistence, fakeSessions(), controller.signal)
  assert.equal(collector.status().running, false)
  assert.equal(collector.status().total, 0)
  assert.equal(store.samples.length, 0)
})

test('abort:扫描中中断停止处理且不写游标', async () => {
  const controller = new AbortController()
  const t = local(2026, 8, 2, 14, 0)
  const persistence = {
    async list() {
      return [{ id: 's1' }]
    },
    async readLog() {
      controller.abort()
      return { inheritedEventCount: 0, events: [ev('turn/end', 0, t)] }
    },
  }
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx(), store)
  await collector.backfill(persistence, fakeSessions(), controller.signal)
  assert.equal(store.samples.length, 0)
  assert.equal(store.state.backfilledSessions.size, 0)
  assert.equal(collector.status().running, false)
  assert.equal(collector.status().done, 1)
})

test('回扫并发受默认并发 4 约束', async () => {
  const TARGET_COUNT = 8
  const EXPECTED_CONCURRENCY = 4
  const GATE_TIMEOUT_MS = 250
  let inFlight = 0
  let peak = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const t = local(2026, 8, 2, 14, 0)
  const defs = Array.from({ length: TARGET_COUNT }, (_, i) => ({ id: `s${i}`, events: [ev('turn/end', 0, t)] }))
  const persistence = {
    async list() {
      return defs.map((def) => ({ id: def.id }))
    },
    async readLog(id) {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      if (inFlight >= EXPECTED_CONCURRENCY) release()
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, GATE_TIMEOUT_MS))])
      inFlight -= 1
      const def = defs.find((candidate) => candidate.id === id)
      return { inheritedEventCount: 0, events: def.events }
    },
  }
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx(), store)
  await collector.backfill(persistence, fakeSessions())
  assert.equal(peak, EXPECTED_CONCURRENCY)
  assert.equal(store.samples.length, TARGET_COUNT)
})

test('resetAndRescan 以 wipe 时刻日志长度为活跃会话边界并重扫', async () => {
  const t = local(2026, 8, 2, 9, 0)
  const events = Array.from({ length: 13 }, (_, seq) => ev('turn/end', seq, t))
  const persistence = fakeHostPersistence([{ id: 'live-a', events }])
  const sessions = fakeSessions([{ id: 'live-a', seq: 10 }, { id: 'live-b' }])
  const store = fakeStore()
  store.state.liveFirstSeq.set('live-a', 3)
  const collector = new UsageCollector(fakeCtx({ sessions, persistence }), store)
  await collector.resetAndRescan()
  assert.equal(store.stats.resets, 1)
  assert.deepEqual([...store.stats.lastBoundaries.keys()].sort(), ['live-a', 'live-b'])
  assert.equal(store.stats.lastBoundaries.get('live-a'), 10)
  assert.equal(store.stats.lastBoundaries.get('live-b'), -1)
  assert.equal(store.samples.length, 10)
  assert.deepEqual([...store.state.backfilledSessions], ['live-a'])
})

test('并发 resetAndRescan 合并为一次重建', async () => {
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence: fakeHostPersistence() }), store)
  const first = collector.resetAndRescan()
  const second = collector.resetAndRescan()
  await Promise.all([first, second])
  assert.equal(store.stats.resets, 1)
})

test('status() 返回快照,外部修改不影响内部状态', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{ id: 's1', events: [ev('turn/end', 0, t)] }])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  assert.deepEqual(collector.status(), {
    running: false,
    total: 0,
    done: 0,
    scannedSessions: 0,
    lastSessionId: undefined,
    error: undefined,
    recordFailures: 0,
    skippedSessions: 0,
    log: [],
  })
  await collector.backfill(persistence, fakeSessions())
  const snapshot = collector.status()
  assert.equal(snapshot.running, false)
  assert.equal(snapshot.total, 1)
  assert.equal(snapshot.done, 1)
  assert.equal(snapshot.scannedSessions, 1)
  assert.equal(snapshot.lastSessionId, 's1')
  snapshot.total = 99
  assert.equal(collector.status().total, 1)
})
