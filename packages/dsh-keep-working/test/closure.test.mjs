import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BLOCKED_PREFIX,
  DONE_MARKER,
  FILE_WRITE_TOOLS,
  assistantText,
  closureVerdict,
  hasVisibleOutput,
  isMaintenanceTurnStart,
  lastAssistantText,
  matchMarker,
  turnInitiator,
} from '../src/closure.mjs'

const TURN = 7

const event = (seq, type, data) => ({ seq, time: seq, type, data })

const turnStart = (seq, turn, reason) =>
  event(seq, 'turn/start', reason === undefined ? { turn } : { turn, reason })

const turnEnd = (seq, turn, reason = { kind: 'completed' }) =>
  event(seq, 'turn/end', { turn, reason })

const assistant = (seq, turn, text) =>
  event(seq, 'assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stream: [],
  })

const assistantToolOnly = (seq, turn) =>
  event(seq, 'assistant/message', {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', callId: 'c1', name: 'read', arguments: '{}' }],
    },
    stream: [],
  })

const toolCall = (seq, turn, name) =>
  event(seq, 'tool/call', { turn, step: 1, callId: `c-${seq}`, name, arguments: '{}' })

const presented = (seq, turn) =>
  event(seq, 'deliverables/presented', { turn, callId: `c-${seq}`, files: [{ path: 'out.md' }] })

const userMessage = (seq, kind = 'user') =>
  event(seq, 'user/message', { id: `m-${seq}`, source: { kind }, content: [{ type: 'text', text: 'go' }] })

test('marker 只认独占末行,DONE 精确、BLOCKED 前缀', () => {
  assert.equal(matchMarker('done\n(TASK_DONE)'), 'done')
  assert.equal(matchMarker('done\n  (TASK_DONE)  '), 'done')
  assert.equal(matchMarker('done\n`(TASK_DONE)`'), 'done')
  assert.equal(matchMarker('done\n(TASK_DONE).'), 'done')
  assert.equal(matchMarker('done\n(TASK_DONE)。'), 'done')
  assert.equal(matchMarker('(TASK_BLOCKED: 缺依赖)'), 'blocked')
  assert.equal(matchMarker('(TASK_DONE) 后面还有话'), null)
  assert.equal(matchMarker('提到 (TASK_DONE) 但不在末行\n结论如上'), null)
  assert.equal(matchMarker(''), null)
  assert.equal(matchMarker(undefined), null)
})

test('assistantText 拼接文本块,忽略工具块', () => {
  assert.equal(assistantText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.equal(assistantText({ content: [{ type: 'tool-call' }] }), '')
  assert.equal(assistantText(undefined), '')
})

test('lastAssistantText 跳过无文本的 assistant 消息', () => {
  const events = [turnStart(0, TURN), assistant(1, TURN, '先说明'), assistantToolOnly(2, TURN)]
  assert.equal(lastAssistantText(events, TURN), '先说明')
})

test('S1 有文件写入但无 present 且无标记:未结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), toolCall(2, TURN, 'write'), assistant(3, TURN, '改好了')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, false)
  assert.equal(verdict.reason, 'file-write-requires-present')
})

test('S2 无文件写入且末行 DONE:结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), assistant(2, TURN, '结论\n(TASK_DONE)')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, true)
  assert.equal(verdict.reason, 'marker')
})

test('S3 present 之后又写文件:present 作废,未结案', () => {
  const events = [
    turnStart(0, TURN),
    userMessage(1),
    toolCall(2, TURN, 'write'),
    presented(3, TURN),
    toolCall(4, TURN, 'edit'),
    assistant(5, TURN, '再改一下'),
  ]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, false)
  assert.equal(verdict.reason, 'file-write-requires-present')
})

test('S4 有文件写入且 present 有效:结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), toolCall(2, TURN, 'write'), presented(3, TURN), assistant(4, TURN, '交付')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, true)
  assert.equal(verdict.reason, 'present')
})

test('S5 无文件写入且末行 BLOCKED:结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), assistant(2, TURN, '(TASK_BLOCKED: 缺 API)')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, true)
  assert.equal(verdict.reason, 'marker')
})

test('S6 有文件写入时标记无效:未结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), toolCall(2, TURN, 'write'), assistant(3, TURN, '完成\n(TASK_DONE)')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, false)
  assert.equal(verdict.reason, 'file-write-requires-present')
})

test('S7 无本回合写入但 present 存在:结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), presented(2, TURN), assistant(3, TURN, '交付')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, true)
  assert.equal(verdict.reason, 'present')
})

test('S8 无任何信号:未结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), assistant(2, TURN, '我看看')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, false)
  assert.equal(verdict.reason, 'no-signal')
})

test('S9 其它回合的 present 不参与判定', () => {
  const events = [presented(1, TURN - 1), turnStart(2, TURN), userMessage(3), assistant(4, TURN, '好')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, false)
  assert.equal(verdict.reason, 'no-signal')
})

test('S10 turn/end 之后的事件不参与判定', () => {
  const events = [turnStart(0, TURN), userMessage(1), assistant(2, TURN, '半成品'), turnEnd(3, TURN), presented(4, TURN)]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, false)
  assert.equal(verdict.reason, 'no-signal')
})

test('hasVisibleOutput 只认文本内容', () => {
  assert.equal(hasVisibleOutput([assistantToolOnly(1, TURN)]), false)
  assert.equal(hasVisibleOutput([assistant(1, TURN, '有话说')]), true)
  assert.equal(hasVisibleOutput([]), false)
})

test('isMaintenanceTurnStart 识别 message-ops 维护轮', () => {
  assert.equal(isMaintenanceTurnStart(turnStart(1, TURN)), false)
  assert.equal(isMaintenanceTurnStart(turnStart(1, TURN, 'message-ops')), true)
  assert.equal(isMaintenanceTurnStart(undefined), false)
})

test('turnInitiator 取本回合首个用户来源消息的 kind', () => {
  const events = [turnStart(1, TURN), userMessage(2, 'goal'), userMessage(3, 'user')]
  assert.equal(turnInitiator(events, TURN), 'goal')
  assert.equal(turnInitiator([turnStart(1, TURN)], TURN), undefined)
})

test('文件写入工具集合覆盖宿主写入面', () => {
  for (const name of ['write', 'edit', 'apply_patch', 'str_replace_editor']) {
    assert.equal(FILE_WRITE_TOOLS.has(name), true, name)
  }
  assert.equal(FILE_WRITE_TOOLS.has('read'), false)
})

test('导出标记字面量稳定', () => {
  assert.equal(DONE_MARKER, '(TASK_DONE)')
  assert.equal(BLOCKED_PREFIX, '(TASK_BLOCKED')
})
