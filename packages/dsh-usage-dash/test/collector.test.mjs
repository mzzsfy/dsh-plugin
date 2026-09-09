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
// 官方助手流紧凑记录构造(与 dsh-llm AssistantStreamAccumulator.snapshot 同形):
// packed run 以 time0 + dt 差分还原成员时刻,裸 chunk 携带原始 time
const textRun = (time0, texts, dt = []) => ({ type: 'text-chunks', time0, index: 0, dt, texts })
const toolRun = (time0, args, extra = {}) => ({ type: 'tool-call-chunks', time0, index: 0, dt: [], id: 't1', args, ...extra })
const rawChunk = (time, chunk) => ({ type: 'chunk', time, chunk })
const attempt = (seq, time, turn, step, stream) => ev('assistant/attempt', seq, time, { turn, step, stream })
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
        async read(offset, length) {
          if (def.fail) throw new Error(def.fail)
          const all = def.events ?? []
          const start = typeof offset === 'number' && offset > 0 ? offset : 0
          return { eventState: 'detached', events: all.slice(start, typeof length === 'number' ? start + length : undefined) }
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

test('decode 口径:durationMs 为首 token 到汇报,ttftMs 为起点到首 token', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(2, start + 35 * 1000, 0, 0, [textRun(start + 10 * 1000, ['你好'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 3, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.durationMs, 30 * 1000)
  assert.equal(usageSample.ttftMs, 10 * 1000)
  assert.equal(usageSample.decodeTokens, 20)
  assert.equal(usageSample.outputTokens, 20)
})

test('无 attempt 时回落 message 自带 stream 取首 token', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 2, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    stream: [textRun(start + 8 * 1000, ['好'])],
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.durationMs, 32 * 1000)
  assert.equal(usageSample.ttftMs, 8 * 1000)
})

test('chunk 先发 token 契约保持,message 补发纯 timing 增量样本', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 2, start + 30 * 1000, {
    turn: 0,
    step: 0,
    chunk: { type: 'usage', usage: usage() },
  }))
  ctx.emit('session/event', session('s1'), attempt(3, start + 35 * 1000, 0, 0, [textRun(start + 10 * 1000, ['你好'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 4, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: usage({ inputTokens: 999 }),
    message: {},
  }))
  await tick()
  assert.equal(store.samples.length, 3)
  const chunkSample = store.samples[1]
  assert.equal(chunkSample.inputTokens, 10)
  assert.equal(chunkSample.durationMs, undefined)
  assert.equal(chunkSample.ttftMs, undefined)
  assert.equal(chunkSample.decodeTokens, undefined)
  assert.equal(store.samples[0].request, true)
  const timingSample = store.samples[2]
  assert.equal(timingSample.inputTokens, 0)
  assert.equal(timingSample.outputTokens, 0)
  assert.equal(timingSample.decodeTokens, 20)
  assert.equal(timingSample.durationMs, 30 * 1000)
  assert.equal(timingSample.ttftMs, 10 * 1000)
})

test('attempt 首 token 锁定:后续 attempt 不覆盖首个产出 token 的时刻', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(2, start + 35 * 1000, 0, 0, [textRun(start + 10 * 1000, ['a'])]))
  ctx.emit('session/event', session('s1'), attempt(3, start + 38 * 1000, 0, 0, [textRun(start + 20 * 1000, ['b'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 4, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.ttftMs, 10 * 1000)
  assert.equal(usageSample.durationMs, 30 * 1000)
})

test('首个 attempt 无 token,由后续产出 token 的 attempt 锁定', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(2, start + 5 * 1000, 0, 0, [
    textRun(start + 5 * 1000, ['']),
    rawChunk(start + 6 * 1000, { type: 'usage' }),
  ]))
  ctx.emit('session/event', session('s1'), attempt(3, start + 38 * 1000, 0, 0, [toolRun(start + 15 * 1000, ['{'], { name: 'fn' })]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 4, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.ttftMs, 15 * 1000)
  assert.equal(usageSample.durationMs, 25 * 1000)
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

test('retry 不重置起点:TTFT 含失败尝试,decode 段自成功首 token 起', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  const retryAt = start + 60 * 1000
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('llm/retry-started', 2, retryAt, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(3, retryAt + 3 * 1000, 0, 0, [textRun(retryAt + 5 * 1000, ['好'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 4, retryAt + 35 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.ttftMs, 65 * 1000)
  assert.equal(usageSample.durationMs, 30 * 1000)
})

test('零 TTFT(起点即出 token)附 ttftMs 为 0', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(2, start + 30 * 1000, 0, 0, [textRun(start, ['快'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 3, start + 30 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.ttftMs, 0)
  assert.equal(usageSample.durationMs, 30 * 1000)
})

test('时刻倒挂防回拨:首 token 晚于汇报,durationMs 钳 0 不附,ttftMs 照常', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(2, start + 50 * 1000, 0, 0, [textRun(start + 50 * 1000, ['晚'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 3, start + 3 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.durationMs, undefined)
  assert.equal(usageSample.decodeTokens, undefined)
  assert.equal(usageSample.ttftMs, 50 * 1000)
})

test('时刻倒挂防回拨:首 token 早于起点,ttftMs 钳 0 照常计步,durationMs 照常', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(2, start + 1 * 1000, 0, 0, [textRun(start - 5 * 1000, ['回拨'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 3, start + 3 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.ttftMs, 0)
  assert.equal(usageSample.durationMs, 8 * 1000)
})

test('usage 缺 outputTokens:不建 decode 配对(官方守卫),ttft 照常', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(2, start + 30 * 1000, 0, 0, [textRun(start + 10 * 1000, ['早'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 3, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: usage({ outputTokens: undefined }),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.outputTokens, 0)
  assert.equal(usageSample.durationMs, undefined)
  assert.equal(usageSample.decodeTokens, undefined)
  assert.equal(usageSample.ttftMs, 10 * 1000)
})

test('重复报告不重复补发 timing:chunk → message → 重复 message 恰一条增量', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 2, start + 30 * 1000, {
    turn: 0,
    step: 0,
    chunk: { type: 'usage', usage: usage() },
  }))
  ctx.emit('session/event', session('s1'), attempt(3, start + 35 * 1000, 0, 0, [textRun(start + 10 * 1000, ['好'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 4, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: usage({ inputTokens: 999 }),
    message: {},
  }))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 5, start + 41 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const timingSamples = store.samples.filter((sample) => !sample.request && sample.decodeTokens !== undefined)
  assert.equal(timingSamples.length, 1)
  assert.equal(timingSamples[0].decodeTokens, 20)
  assert.equal(timingSamples[0].durationMs, 30 * 1000)
  assert.equal(timingSamples[0].ttftMs, 10 * 1000)
})

test('message 首发后到达的 chunk usage 不补 timing', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), attempt(2, start + 35 * 1000, 0, 0, [textRun(start + 10 * 1000, ['好'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 3, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 4, start + 41 * 1000, {
    turn: 0,
    step: 0,
    chunk: { type: 'usage', usage: usage() },
  }))
  await tick()
  const usageSamples = store.samples.filter((sample) => !sample.request)
  assert.equal(usageSamples.length, 1)
  assert.equal(usageSamples[0].decodeTokens, 20)
  assert.equal(usageSamples[0].durationMs, 30 * 1000)
})

test('chunk 非零后 message usage 全零仍补发 timing', async () => {
  const { ctx, store } = liveCollector()
  const start = local(2026, 8, 2, 10, 0)
  const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ctx.emit('session/event', session('s1'), ev('step/start', 1, start, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('assistant/chunk', 2, start + 30 * 1000, {
    turn: 0,
    step: 0,
    chunk: { type: 'usage', usage: usage() },
  }))
  ctx.emit('session/event', session('s1'), attempt(3, start + 35 * 1000, 0, 0, [textRun(start + 10 * 1000, ['好'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 4, start + 40 * 1000, {
    turn: 0,
    step: 0,
    usage: zeroUsage,
    message: {},
  }))
  await tick()
  const timingSamples = store.samples.filter((sample) => !sample.request && sample.ttftMs !== undefined)
  assert.equal(timingSamples.length, 1)
  assert.equal(timingSamples[0].inputTokens, 0)
  assert.equal(timingSamples[0].ttftMs, 10 * 1000)
  assert.equal(timingSamples[0].decodeTokens, 0)
  assert.equal(timingSamples[0].durationMs, 30 * 1000)
})

test('缺 turn/step 的 message 带 stream:首发全量样本含 timing 且不污染去重集合', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), ev('assistant/message', 1, t + 30 * 1000, {
    usage: usage(),
    stream: [textRun(t, ['早'])],
    message: {},
  }))
  await tick()
  assert.equal(store.samples.length, 1)
  assert.equal(store.samples[0].durationMs, 30 * 1000)
  assert.equal(store.samples[0].ttftMs, undefined)
})

test('有首 token 无起点:durationMs 附而 ttftMs 不附', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  ctx.emit('session/event', session('s1'), attempt(1, t + 10 * 1000, 0, 0, [textRun(t, ['早'])]))
  ctx.emit('session/event', session('s1'), ev('assistant/message', 2, t + 30 * 1000, {
    turn: 0,
    step: 0,
    usage: usage(),
    message: {},
  }))
  await tick()
  const usageSample = store.samples.find((sample) => !sample.request)
  assert.equal(usageSample.durationMs, 30 * 1000)
  assert.equal(usageSample.ttftMs, undefined)
})

test('无任何 stream 信息不附时长与首字(存量超旧日志形态)', async () => {
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
  assert.equal(store.samples[0].ttftMs, undefined)
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

test('V3 日志兼容:V3 专有事件与新字段被折叠忽略不炸', async () => {
  const { ctx, store } = liveCollector()
  const t = local(2026, 8, 2, 10, 0)
  // V3 新增事件(SESSION_FORMAT_VERSION 3):统计不消费,折叠必须安全忽略
  ctx.emit('session/event', session('s1'), ev('system/message', 1, t, { turn: 0, step: 0, message: { role: 'system', content: 'sys' } }))
  ctx.emit('session/event', session('s1'), ev('assistant/attempt', 2, t, { turn: 0, step: 0, stream: [] }))
  ctx.emit('session/event', session('s1'), ev('request/header', 3, t, { header: { config: {} }, reason: 'initial' }))
  ctx.emit('session/event', session('s1'), ev('user/message', 4, t, { role: 'user', content: 'hi' }, ))
  ctx.emit('session/event', session('s1'), ev('tool/call', 5, t, { turn: 0, step: 0, callId: 'c1', name: 'n', arguments: '{}' }))
  ctx.emit('session/event', session('s1'), ev('tool/result', 6, t, { turn: 0, step: 0, message: { role: 'toolResult', content: 'r' } }))
  ctx.emit('session/event', session('s1'), ev('session/end-seed', 7, t, {}))
  ctx.emit('session/event', session('s1'), ev('step/end', 8, t, { turn: 0, step: 0 }))
  ctx.emit('session/event', session('s1'), ev('turn/start', 9, t, { turn: 1 }))
  // V3 assistant/message 携带 stream/surfaceOp/interrupted 等新字段:usage 折叠不受影响
  ctx.emit('session/event', session('s1'), ev('assistant/message', 10, t, {
    turn: 1,
    step: 0,
    usage: usage({ inputTokens: 5 }),
    message: { role: 'assistant', source: { provider: 'p', model: 'm' } },
    stream: [{ type: 'text-delta', text: 'x' }],
    surfaceOp: 'append',
    interrupted: true,
  }))
  await tick()
  assert.equal(store.samples.length, 1)
  assert.equal(store.samples[0].inputTokens, 5)
  assert.equal(store.samples[0].model, 'p/m')
})

test('V3 日志兼容:回扫重放 V3 事件流,样本与游标正确', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{
    id: 'v3session',
    events: [
      ev('request/header', 0, t, { header: { config: {} }, reason: 'resume' }),
      ev('system/message', 1, t, { turn: 0, step: 0, message: { role: 'system', content: 'sys' } }),
      ev('user/message', 2, t, { role: 'user', content: 'q' }),
      ev('step/start', 3, t, { turn: 0, step: 0 }),
      ev('assistant/attempt', 4, t, { turn: 0, step: 0, stream: [] }),
      ev('assistant/message', 5, t, {
        turn: 0,
        step: 0,
        usage: usage({ inputTokens: 7 }),
        message: { role: 'assistant', source: { provider: 'p', model: 'm' } },
        stream: [],
      }),
      ev('step/end', 6, t, { turn: 0, step: 0 }),
      ev('turn/end', 7, t, { turn: 0, reason: { kind: 'completed' } }),
    ],
  }])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.deepEqual(store.samples.map((sample) => [sample.request ?? sample.turn ?? false, sample.inputTokens]), [
    [true, 0],
    [false, 7],
    [true, 0],
  ])
  assert.deepEqual([...store.state.backfilledSessions], ['v3session'])
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

test('回扫:重放路径同样产出 decode 口径时长与首字', async () => {
  const start = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([{
    id: 's1',
    events: [
      ev('request/context', 0, start, { provider: 'deepseek', model: 'chat' }),
      ev('step/start', 1, start, { turn: 0, step: 0 }),
      attempt(2, start + 5 * 1000, 0, 0, [textRun(start + 2 * 1000, ['回'])]),
      ev('assistant/message', 3, start + 7 * 1000, {
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
  assert.equal(usageSample.durationMs, 5 * 1000)
  assert.equal(usageSample.ttftMs, 2 * 1000)
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

test('回扫:skipped 计数独立累加,超过日志上限不漂移', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const defs = Array.from({ length: 210 }, (_, i) => ({ id: `bad${i}`, fail: 'uses unsupported descriptor version 2' }))
  const persistence = fakePersistence(defs)
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.equal(collector.status().skippedSessions, 210)
  assert.equal(collector.status().log.length, 200)
  assert.deepEqual(collector.status().skippedBreakdown, { descriptor: 210, corrupt: 0, legacy: 0, other: 0 })
})

test('回扫:skipped 按 detail 归因分类,次轮扫描计数复位', async () => {
  const t = local(2026, 8, 2, 14, 0)
  const persistence = fakePersistence([
    { id: 'a', fail: 'uses unsupported descriptor version 2; source v0 artifact remains unchanged' },
    { id: 'b', fail: 'stored log is corrupt: SessionFormatError: seq gap' },
    { id: 'c', fail: 'format v0 contains unknown member "editor"' },
    { id: 'd', fail: 'mystery failure' },
    { id: 'ok', events: [ev('turn/end', 0, t)] },
  ])
  const store = fakeStore()
  const collector = new UsageCollector(fakeCtx({ persistence }), store)
  await collector.backfill(persistence, fakeSessions())
  assert.deepEqual(collector.status().skippedBreakdown, { descriptor: 1, corrupt: 1, legacy: 1, other: 1 })
  assert.equal(collector.status().skippedSessions, 4)
  // 次轮:失败档不进游标会重现,但本轮从空游标重扫,计数从头累计且包含上一轮成功档
  await collector.backfill(persistence, fakeSessions())
  assert.equal(collector.status().skippedSessions, 4)
  assert.deepEqual(collector.status().skippedBreakdown, { descriptor: 1, corrupt: 1, legacy: 1, other: 1 })
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
    skippedBreakdown: { descriptor: 0, corrupt: 0, legacy: 0, other: 0 },
    log: [],
  })
  const before = collector.status().skippedBreakdown
  before.descriptor = 99
  assert.equal(collector.status().skippedBreakdown.descriptor, 0)
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
