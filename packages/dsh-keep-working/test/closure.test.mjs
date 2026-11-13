import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BLOCKED_PREFIX,
  DONE_MARKER,
  FILE_WRITE_TOOLS,
  assistantText,
  closureVerdict,
  hasVisibleOutput,
  humanInitiatedTurn,
  lastAssistantText,
  matchMarker,
  turnInitiator,
  userTookOver,
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

const toolCall = (seq, turn, name, args = '{}') =>
  event(seq, 'tool/call', { turn, step: 1, callId: `c-${seq}`, name, arguments: args })

const presented = (seq, turn) =>
  event(seq, 'deliverables/presented', { turn, callId: `c-${seq}`, files: [{ path: 'out.md' }] })

const userMessage = (seq, kind = 'user') =>
  event(seq, 'user/message', { id: `m-${seq}`, source: { kind }, content: [{ type: 'text', text: 'go' }] })

test('marker 只认裸标记独占末行,括号与装饰不算', () => {
  assert.equal(matchMarker('done\nTASK_DONE'), 'done')
  assert.equal(matchMarker('done\n  TASK_DONE  '), 'done')
  assert.equal(matchMarker('TASK_BLOCKED: 缺依赖'), 'blocked')
  assert.equal(matchMarker('TASK_BLOCKED:缺依赖'), 'blocked')
  assert.equal(matchMarker('done\n(TASK_DONE)'), null)
  assert.equal(matchMarker('done\n__TASK_DONE'), null)
  assert.equal(matchMarker('done\n-TASK_DONE'), null)
  assert.equal(matchMarker('done\n`TASK_DONE`'), null)
  assert.equal(matchMarker('done\n**TASK_DONE**'), null)
  assert.equal(matchMarker('TASK_DONE。'), null)
  assert.equal(matchMarker('TASK_DONE 后面还有话'), null)
  assert.equal(matchMarker('TASK_BLOCKED'), null)
  assert.equal(matchMarker('TASK_BLOCKED:'), null)
  assert.equal(matchMarker('TASK_BLOCKED:   '), null)
  assert.equal(matchMarker('提到 TASK_DONE 但不在末行\n结论如上'), null)
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
  const events = [turnStart(0, TURN), userMessage(1), assistant(2, TURN, '结论\nTASK_DONE')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, true)
  assert.equal(verdict.reason, 'marker')
})

test('S2b 无文件写入且末行旧括号标记:未结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), assistant(2, TURN, '结论\n(TASK_DONE)')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, false)
  assert.equal(verdict.reason, 'no-signal')
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
  const events = [turnStart(0, TURN), userMessage(1), assistant(2, TURN, 'TASK_BLOCKED: 缺 API')]
  const verdict = closureVerdict(events, TURN)
  assert.equal(verdict.closed, true)
  assert.equal(verdict.reason, 'marker')
})

test('S6 有文件写入时标记无效:未结案', () => {
  const events = [turnStart(0, TURN), userMessage(1), toolCall(2, TURN, 'write'), assistant(3, TURN, '完成\nTASK_DONE')]
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

test('turnInitiator 跳过非真人来源取真人消息', () => {
  const events = [turnStart(1, TURN), userMessage(2, 'goal'), userMessage(3, 'user')]
  assert.equal(turnInitiator(events, TURN), 'user')
  assert.equal(turnInitiator([turnStart(1, TURN)], TURN), undefined)
  assert.equal(turnInitiator([turnStart(1, TURN), userMessage(2, 'goal')], TURN), undefined, '只有 agent 来源不算真人发起')
})

test('文件写入工具集合覆盖宿主写入面', () => {
  for (const name of ['write', 'edit', 'str_replace_editor']) {
    assert.equal(FILE_WRITE_TOOLS.has(name), true, name)
  }
  assert.equal(FILE_WRITE_TOOLS.has('read'), false)
})

test('导出标记字面量稳定', () => {
  assert.equal(DONE_MARKER, 'TASK_DONE')
  assert.equal(BLOCKED_PREFIX, 'TASK_BLOCKED')
})

// 宿主先注入上下文(agent-instructions 等)再投递真人消息,首条 user/message 不是真人
const injected = (seq, kind = 'agent-instructions') =>
  ({
    seq,
    time: 1_000,
    type: 'user/message',
    data: { id: `inj-${seq}`, source: { kind }, content: [{ type: 'text', text: 'AGENTS.md' }] },
  })

test('注入上下文前置时仍识别真人发起', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    injected(2),
    userMessage(3),
    assistant(4, 1, '做完了'),
  ]
  assert.equal(turnInitiator(events, 1), 'user')
  assert.equal(humanInitiatedTurn(events, 1, new Set()), true)
})

test('注入上下文之后的真人消息不算用户接管', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    injected(2),
    userMessage(3),
    assistant(4, 1, '做完了'),
  ]
  assert.equal(userTookOver(events, 1, new Set()), false)
})

test('注入上下文加真人插话仍判接管', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    injected(2),
    userMessage(3),
    userMessage(4),
    assistant(5, 1, '做完了'),
  ]
  assert.equal(userTookOver(events, 1, new Set()), true)
})

test('只有注入上下文没有真人消息时不判真人发起', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    injected(2),
    assistant(3, 1, '收到'),
  ]
  assert.equal(turnInitiator(events, 1), undefined)
  assert.equal(humanInitiatedTurn(events, 1, new Set()), false)
})

test('失败的写不算改过文件', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    userMessage(2),
    { seq: 3, time: 1_000, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' } },
    { seq: 4, time: 1_000, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: true, content: [] } } },
    assistant(5, 1, '写不了\nTASK_DONE'),
    { seq: 6, time: 1_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(closureVerdict(events, 1).closed, true, '写失败没有产物,应允许标记结案')
})

test('编辑器 view 子命令不算改过文件', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    userMessage(2),
    {
      seq: 3,
      time: 1_000,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'c1', name: 'str_replace_editor', arguments: '{"command":"view","path":"a.ts"}' },
    },
    assistant(4, 1, '看完了\nTASK_DONE'),
    { seq: 5, time: 1_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(closureVerdict(events, 1).closed, true)
})

test('成功的写仍要求 present', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    userMessage(2),
    { seq: 3, time: 1_000, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{}' } },
    { seq: 4, time: 1_000, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false, content: [] } } },
    assistant(5, 1, '改好了'),
    { seq: 6, time: 1_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(closureVerdict(events, 1).closed, false)
})

test('成功的写不因同回合其它工具失败被剔除', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    userMessage(2),
    { seq: 3, time: 1_000, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{}' } },
    { seq: 4, time: 1_000, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false, content: [] } } },
    { seq: 5, time: 1_000, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{}' } },
    { seq: 6, time: 1_000, type: 'tool/result', data: { turn: 1, step: 2, message: { toolCallId: 'c2', isError: true, content: [] } } },
    assistant(7, 1, '改好了\nTASK_BLOCKED: 测试失败'),
    { seq: 8, time: 1_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(closureVerdict(events, 1).closed, false, '成功的写仍要求 present')
})

test('present 之后又写文件且随后工具失败仍判未结案', () => {
  const events = [
    { seq: 1, time: 1_000, type: 'turn/start', data: { turn: 1 } },
    userMessage(2),
    { seq: 3, time: 1_000, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'write', arguments: '{}' } },
    { seq: 4, time: 1_000, type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false, content: [] } } },
    { seq: 5, time: 1_000, type: 'deliverables/presented', data: { turn: 1 } },
    { seq: 6, time: 1_000, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'edit', arguments: '{}' } },
    { seq: 7, time: 1_000, type: 'tool/result', data: { turn: 1, step: 2, message: { toolCallId: 'c2', isError: false, content: [] } } },
    { seq: 8, time: 1_000, type: 'tool/call', data: { turn: 1, step: 2, callId: 'c3', name: 'bash', arguments: '{}' } },
    { seq: 9, time: 1_000, type: 'tool/result', data: { turn: 1, step: 2, message: { toolCallId: 'c3', isError: true, content: [] } } },
    assistant(10, 1, '改完了'),
    { seq: 11, time: 1_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(closureVerdict(events, 1).closed, false, 'present 被后续写作废')
})
