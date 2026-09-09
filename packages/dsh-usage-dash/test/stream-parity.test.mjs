// 官方同构 parity:collector 移植的助手流首 token 读取与官方 dsh-llm
// assistantStreamFirstTokenTime / isTokenDelta / runFirstTokenTime 语义逐向量对表。
// 期望值按官方源码语义推导(首个 token delta = 非空 text/reasoning 成员、
// 非空 tool-call arguments 成员或具名 tool-call run 起点)。
// 对表锚点:对表自 dsh 0.1.2-rc.1 官方源码(dsh-llm/lib/types/assistant-stream.js
// 与 dsh-session-stats/lib/types/projection.js);dsh 本体升级后须重对表,
// 此处静态向量不感知官方实现漂移。

import test from 'node:test'
import assert from 'node:assert/strict'

import { assistantStreamFirstTokenTime } from '../src/collector.js'

const textRun = (time0, texts, dt = []) => ({ type: 'text-chunks', time0, index: 0, dt, texts })
const reasoningRun = (time0, texts, dt = []) => ({ type: 'reasoning-chunks', time0, index: 0, dt, texts })
const toolRun = (time0, args, extra = {}) => ({ type: 'tool-call-chunks', time0, index: 0, dt: [], id: 'c1', args, ...extra })
const rawChunk = (time, chunk) => ({ type: 'chunk', time, chunk })

test('text run 首个非空成员时刻按 time0+dt 差分还原', () => {
  assert.equal(assistantStreamFirstTokenTime([textRun(1000, ['', 'ab'], [100])]), 1100)
})

test('全空 text run 无首 token', () => {
  assert.equal(assistantStreamFirstTokenTime([textRun(1000, ['', ''])]), undefined)
})

test('reasoning run 与 text run 同语义', () => {
  assert.equal(assistantStreamFirstTokenTime([reasoningRun(500, ['', '思考'], [20])]), 520)
})

test('具名 tool call run 整体起于 time0', () => {
  assert.equal(assistantStreamFirstTokenTime([toolRun(700, ['', '{'], { name: 'fn' })]), 700)
})

test('匿名 tool call run 取首个非空 arguments 成员', () => {
  assert.equal(assistantStreamFirstTokenTime([toolRun(700, ['', '{'], { dt: [30] })]), 730)
})

test('裸 chunk:text-delta 非空即 token,空文本跳过', () => {
  assert.equal(assistantStreamFirstTokenTime([
    rawChunk(100, { type: 'text-delta', index: 0, text: '' }),
    rawChunk(200, { type: 'text-delta', index: 0, text: 'hi' }),
  ]), 200)
})

test('裸 chunk:usage 与 finish 非 token', () => {
  assert.equal(assistantStreamFirstTokenTime([
    rawChunk(100, { type: 'usage' }),
    rawChunk(200, { type: 'finish' }),
  ]), undefined)
})

test('首个产出 token 的记录生效,后续记录不覆盖', () => {
  assert.equal(assistantStreamFirstTokenTime([
    rawChunk(100, { type: 'usage' }),
    textRun(900, ['a']),
    textRun(500, ['b']),
  ]), 900)
})

test('空流与非数组输入无首 token', () => {
  assert.equal(assistantStreamFirstTokenTime([]), undefined)
  assert.equal(assistantStreamFirstTokenTime(undefined), undefined)
})

test('未知记录形态安全跳过不崩溃', () => {
  assert.equal(assistantStreamFirstTokenTime([
    { type: 'text-delta', text: 'x' },
    textRun(300, ['晚到']),
  ]), 300)
})

test('dt 差分短缺视为损坏,按无首 token 处理', () => {
  assert.equal(assistantStreamFirstTokenTime([textRun(1000, ['', 'ab'], [])]), undefined)
})
