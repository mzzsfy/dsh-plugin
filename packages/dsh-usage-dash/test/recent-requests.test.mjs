// 最近请求详情投影:每个 step 的完整可测指标与当前生成态。
// Given/When/Then 场景内嵌于用例描述。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { recentRequestsProjectionDefinition as definition, __test } from '../src/recent-requests.js'

const ev = (type, time, data = {}) => ({ type, time, data })
const usage = (extra = {}) => ({
  inputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  ...extra,
})
const stream = (first) => [{ type: 'text-chunks', time0: first, index: 0, dt: [], texts: ['x'] }]
const start = (time = 1000, turn = 0, step = 0) => ev('step/start', time, { turn, step })
const attempt = (time, turn, step, first) => ev('assistant/attempt', time, { turn, step, stream: stream(first) })
const message = (time, turn, step, extra = {}) => ev('assistant/message', time, {
  turn,
  step,
  usage: usage(),
  message: { source: { provider: 'deepseek', model: 'chat' } },
  ...extra,
})

const run = (events) => events.reduce((state, event) => definition.apply(state, event), definition.init())

test('Given step 启动、首 token 与完成 When 折叠 Then 行内保留完整 token、模型与时长', () => {
  const state = run([
    ev('request/context', 900, { provider: 'deepseek', model: 'chat' }),
    start(),
    attempt(3000, 0, 0, 2000),
    message(7000, 0, 0),
  ])
  assert.equal(state.open, null)
  assert.equal(state.rows.length, 1)
  const row = state.rows[0]
  assert.equal(row.ttftMs, 1000)
  assert.equal(row.decodeMs, 5000)
  assert.equal(row.startedAt, 1000)
  assert.equal(row.completedAt, 7000)
  assert.equal(row.model, 'deepseek/chat')
  assert.deepEqual(row.usage, {
    uncachedInputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
  })
})

test('Given 同一 step 重报 When 折叠 Then 原位替换而不重复计数', () => {
  const first = run([start(), attempt(2000, 0, 0, 1500), message(5000, 0, 0)])
  const second = definition.apply(first, message(6000, 0, 0, { usage: usage({ outputTokens: 80 }) }))
  assert.equal(second.rows.length, 1)
  assert.equal(second.rows[0].usage.outputTokens, 80)
})

test('Given 超过窗口上限 When 折叠 Then 只保留最近 10 条', () => {
  const events = []
  for (let index = 0; index < 12; index += 1) {
    events.push(start(1000 + index * 1000, 0, index))
    events.push(attempt(1200 + index * 1000, 0, index, 1100 + index * 1000))
    events.push(message(2000 + index * 1000, 0, index))
  }
  const state = run(events)
  assert.equal(state.rows.length, 10)
  assert.equal(state.rows[0].step, 2)
  assert.equal(state.rows[9].step, 11)
})

test('Given 重试 When 折叠 Then attempts 增加且首 token 不被后续 attempt 覆盖', () => {
  const state = run([
    start(),
    attempt(2000, 0, 0, 1500),
    ev('llm/retry-started', 2500, { turn: 0, step: 0 }),
    attempt(3000, 0, 0, 2800),
  ])
  assert.equal(state.open.attempts, 2)
  assert.equal(state.open.firstTokenTime, 1500)
})

test('Given 首 token 缺席 When 完成 Then 行仍保留 token,TTFT 与 decode 为空', () => {
  const state = run([start(), message(5000, 0, 0)])
  assert.equal(state.rows.length, 1)
  assert.equal(state.rows[0].ttftMs, null)
  assert.equal(state.rows[0].decodeMs, null)
})

test('Given 流式 usage chunk When 生成中 Then open 暴露部分 token 供当前行展示', () => {
  const state = run([
    start(),
    ev('assistant/chunk', 1500, {
      turn: 0,
      step: 0,
      chunk: { type: 'usage', usage: usage({ outputTokens: 12 }) },
    }),
  ])
  assert.equal(state.open.usage.outputTokens, 12)
  assert.equal(definition.wire.view(state).open.usage.outputTokens, 12)
})

test('Given assistant/message 缺 turn/step When 完成 Then 忽略且不产生坏行', () => {
  const initial = run([start()])
  const next = definition.apply(initial, ev('assistant/message', 5000, { usage: usage() }))
  assert.equal(next, initial)
  assert.equal(next.open.turn, 0)
})

test('Given step 或 message 缺时间 When 折叠 Then 状态不变且不产生坏行', () => {
  const initial = definition.init()
  assert.equal(definition.apply(initial, ev('step/start', undefined, { turn: 0, step: 0 })), initial)
  const started = definition.apply(initial, start())
  assert.equal(definition.apply(started, ev('assistant/message', undefined, {
    turn: 0,
    step: 0,
    usage: usage(),
  })), started)
})

test('Given 无关事件或缺 turn/step When 折叠 Then 状态不变', () => {
  const initial = definition.init()
  assert.equal(definition.apply(initial, ev('tool/result', 1, {})), initial)
  assert.equal(definition.apply(initial, ev('step/start', 1, {})), initial)
  assert.equal(__test.usageOf(ev('assistant/message', 1, {})), undefined)
})
