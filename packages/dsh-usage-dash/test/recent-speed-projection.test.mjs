// 最近输出速度投影:与宿主 sessionStats 同一套 decode 口径(step/start 建窗、
// assistant/attempt 锁首 token、assistant/message 结算),额外保留最近 10 条消息
// 的配对以支持窗口加权。断言覆盖口径对齐、窗口裁剪、wire 形状与状态可序列化。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'
import { RECENT_SPEED_STEPS, recentSpeedOfSamples, recentSpeedProjectionDefinition } from '../src/recent-speed.js'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const definition = recentSpeedProjectionDefinition
const run = (events, state = definition.init()) => events.reduce((acc, event) => definition.apply(acc, event), state)

const stepStart = (turn, step, time) => ({ type: 'step/start', time, data: { turn, step } })
const attempt = (turn, step, time, stream) => ({ type: 'assistant/attempt', time, data: { turn, step, stream } })
const message = (turn, step, time, outputTokens, stream) => ({
  type: 'assistant/message',
  time,
  data: { turn, step, usage: { outputTokens }, stream },
})
// 首个 token 落在 time 的极简流记录,与宿主 packed run 形态一致
const streamAt = (time) => [{ type: 'text-chunks', time0: time, dt: [10], texts: ['x'] }]

const converse = (turn, step, startTime, firstTokenTime, endTime, outputTokens) => [
  stepStart(turn, step, startTime),
  attempt(turn, step, startTime, streamAt(firstTokenTime)),
  message(turn, step, endTime, outputTokens, streamAt(firstTokenTime)),
]

test('Given 单条消息 When 结算 Then 速度为输出 token 除以首 token 到完成的毫秒', () => {
  const state = run(converse(1, 1, 0, 500, 2500, 500))
  assert.deepEqual(state.samples, [{ tokens: 500, ms: 2000, time: 2500 }])
  assert.equal(definition.wire.view(state).tps, 250)
  assert.equal(definition.wire.view(state).steps, 1)
})

test('Given 多条消息 When 取读数 Then 用 token 合计除时长合计而非算术平均', () => {
  // 300 tok/1s 与 700 tok/3s:加权 250,算术平均 266.7,断言取加权
  const state = run([...converse(1, 1, 0, 0, 1000, 300), ...converse(1, 2, 2000, 2000, 5000, 700)])
  assert.equal(definition.wire.view(state).tps, 250)
})

test('Given 首 token 未记录 When 结算 Then 不计入窗口且不留残留窗口', () => {
  const state = run([stepStart(1, 1, 0), message(1, 1, 2000, 100, undefined)])
  assert.deepEqual(state.samples, [])
  assert.equal(state.open, null)
  assert.equal(definition.wire.view(state).tps, null)
})

test('Given 输出 token 非法 When 结算 Then 与官方 usageOutputTokens 守卫一致跳过', () => {
  for (const bad of ['100', Number.NaN, -1, undefined]) {
    const state = run([stepStart(1, 1, 0), message(1, 1, 2000, bad, streamAt(0))])
    assert.deepEqual(state.samples, [], String(bad))
  }
  // 0 合法:官方守卫允许 0,只添分母
  const zero = run(converse(1, 1, 0, 0, 2000, 0))
  assert.deepEqual(zero.samples, [{ tokens: 0, ms: 2000, time: 2000 }])
  assert.equal(definition.wire.view(zero).tps, 0)
})

test('Given 消息与当前窗口不匹配 When 结算 Then 忽略(与官方 openStep 同构)', () => {
  const state = run([...converse(1, 1, 0, 0, 2000, 100), message(2, 1, 3000, 100, streamAt(2000))])
  assert.equal(state.samples.length, 1)
})

test('Given 首个 attempt 无首 token When 后续 attempt 有 Then 仍可锁定', () => {
  const state = run([
    stepStart(1, 1, 0),
    attempt(1, 1, 100, [{ type: 'text-chunks', time0: 100, dt: [10], texts: [''] }]),
    attempt(1, 1, 200, streamAt(300)),
    message(1, 1, 2300, 400, undefined),
  ])
  assert.deepEqual(state.samples, [{ tokens: 400, ms: 2000, time: 2300 }])
})

test('Given 首 token 已在 attempt 锁定 When 消息流缺首 token Then 沿用锁定值', () => {
  const state = run([stepStart(1, 1, 0), attempt(1, 1, 0, streamAt(400)), message(1, 1, 2400, 500, undefined)])
  assert.deepEqual(state.samples, [{ tokens: 500, ms: 2000, time: 2400 }])
})

test('Given 超过窗口上限 When 继续结算 Then 只保留最近 RECENT_SPEED_STEPS 条', () => {
  const events = []
  for (let step = 1; step <= RECENT_SPEED_STEPS + 5; step += 1) {
    events.push(...converse(1, step, step * 10000, step * 10000, step * 10000 + 1000, 100))
  }
  const state = run(events)
  assert.equal(state.samples.length, RECENT_SPEED_STEPS)
  assert.equal(state.samples.at(-1).time, (RECENT_SPEED_STEPS + 5) * 10000 + 1000)
  // 全为 100 tok/s 的等速消息,裁剪后读数不变
  assert.equal(definition.wire.view(state).tps, 100)
})

test('Given 重试与新步骤 When 交替到达 Then 窗口只认当前步(官方单开窗口语义)', () => {
  const state = run([
    ...converse(1, 1, 0, 0, 1000, 100),
    stepStart(1, 2, 2000),
    { type: 'llm/retry-started', time: 2100, data: { turn: 1, step: 2 } },
    attempt(1, 2, 2100, streamAt(2200)),
    message(1, 2, 3200, 200, undefined),
  ])
  assert.deepEqual(state.samples, [
    { tokens: 100, ms: 1000, time: 1000 },
    { tokens: 200, ms: 1000, time: 3200 },
  ])
})

test('Given state When 序列化往返 Then schema 通过且读数不变', () => {
  const state = run(converse(1, 1, 0, 0, 2000, 500))
  const revived = JSON.parse(JSON.stringify(state))
  assert.deepEqual(definition.stateSchema.parse(revived), state)
  assert.equal(definition.wire.view(revived).tps, 250)
  assert.equal(definition.stateSchema.parse(definition.init()).samples.length, 0)
})

test('Given wire 形状 When 校验 Then 只含 tps 与 steps', () => {
  const view = definition.wire.view(run(converse(1, 1, 0, 0, 2000, 500)))
  assert.deepEqual(Object.keys(view).sort(), ['steps', 'tps'])
  assert.deepEqual(definition.wire.viewSchema.parse(view), view)
})

test('Given 空窗口 When 取读数 Then tps 为 null 且步数为零', () => {
  const view = definition.wire.view(definition.init())
  assert.deepEqual(view, { tps: null, steps: 0 })
})

test('Given host 投影与 client 回退 When 同一配对 Then 加权结果一致', () => {
  // 回退估算与投影共用同一除法口径:client 是单文件 bundle 不能 import host 模块
  const cases = [
    [],
    [{ tokens: 500, ms: 2000 }],
    [{ tokens: 300, ms: 1000 }, { tokens: 700, ms: 3000 }],
    [{ tokens: 0, ms: 2000 }, { tokens: 100, ms: 1000 }],
  ]
  const nodesOf = (samples) => samples.map((item) => ({
    kind: 'assistant',
    timing: { stepStartTime: 0, firstTokenTime: 0, completedTime: item.ms },
    usage: { outputTokens: item.tokens },
  }))
  for (const samples of cases) {
    assert.equal(core.recentSpeedOf(nodesOf(samples)), recentSpeedOfSamples(samples))
  }
})

test('Given 客户端常量 When 对齐 Then 与投影窗口上限一致', () => {
  assert.equal(core.RECENT_SPEED_STEPS, RECENT_SPEED_STEPS)
})
