// pi-context BDD:replay 信封校验全分支、降级语义、round-trip 不变量、
// 文本路径(工具名恢复/参数容忍/system 投影)与空历史边界。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toPiAssistant, toPiReplayState, toPiContext, toPiContextWithImages } from '../src/pi-context.mjs'

function harnessAssistant(overrides = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
    source: {
      kind: 'model',
      api: 'anthropic-messages',
      provider: 'gw',
      model: 'm1',
      replayState: {
        response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: 'gw', model: 'm1', stopReason: 'stop' },
        blocks: [{ type: 'text' }],
      },
    },
    ...overrides,
  }
}

function degradedReason(message) {
  const reasons = []
  const assistant = toPiAssistant(message, (reason) => reasons.push(reason))
  return { assistant, reasons }
}

test('toPiAssistant:合法 replay 重建原生历史并保留签名', () => {
  const message = harnessAssistant()
  message.source.replayState.blocks[0].textSignature = 'sig-1'
  const assistant = toPiAssistant(message)
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.api, 'anthropic-messages')
  assert.equal(assistant.content[0].textSignature, 'sig-1')
})

test('toPiAssistant:无 replay 元数据即外来历史(api 为外来标识)', () => {
  const message = harnessAssistant()
  delete message.source.replayState
  const assistant = toPiAssistant(message)
  assert.equal(assistant.api, 'dsh-foreign')
})

test('toPiAssistant:损坏信封逐 reason 降级且回调被调', () => {
  const cases = [
    'not-an-object',
    [],
    { response: null },
    { response: { kind: 'other' } },
    { response: { kind: 'pi-ai', version: 1, api: 'a', provider: 'p', model: 'm', stopReason: 'stop' } },
    { response: { kind: 'pi-ai', version: 2, api: '', provider: 'p', model: 'm', stopReason: 'stop' } },
    { response: { kind: 'pi-ai', version: 2, api: 'a', provider: 'p', model: 'm', stopReason: 'pending' } },
    { response: { kind: 'pi-ai', version: 2, api: 'a', provider: 'p', model: 'm', stopReason: 'stop' }, blocks: 'no' },
    { response: { kind: 'pi-ai', version: 2, api: 'a', provider: 'p', model: 'm', stopReason: 'stop' }, blocks: [null] },
    { response: { kind: 'pi-ai', version: 2, api: 'a', provider: 'p', model: 'm', stopReason: 'stop' }, blocks: [{ type: 'image' }] },
  ]
  for (const replayState of cases) {
    const { assistant, reasons } = degradedReason(harnessAssistant({ source: { ...harnessAssistant().source, replayState } }))
    assert.equal(assistant.api, 'dsh-foreign', JSON.stringify(replayState))
    assert.equal(reasons.length, 1)
    assert.match(reasons[0], /invalid pi-ai replay state/)
  }
})

test('toPiAssistant:信封与消息源不匹配(provider/model/块数)即降级', () => {
  const mismatchedProvider = harnessAssistant()
  mismatchedProvider.source.replayState.response.provider = 'other'
  assert.equal(degradedReason(mismatchedProvider).assistant.api, 'dsh-foreign')

  const mismatchedModel = harnessAssistant()
  mismatchedModel.source.replayState.response.model = 'other'
  assert.equal(degradedReason(mismatchedModel).assistant.api, 'dsh-foreign')

  const mismatchedBlocks = harnessAssistant({
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
  })
  assert.equal(degradedReason(mismatchedBlocks).assistant.api, 'dsh-foreign')
})

test('toPiAssistant:toolCall 块恢复 thoughtSignature 与参数对象', () => {
  const message = harnessAssistant({
    content: [{ type: 'tool-call', id: 't1', name: 'run', arguments: '{"a":1}' }],
  })
  message.source.replayState = {
    response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: 'gw', model: 'm1', stopReason: 'toolUse' },
    blocks: [{ type: 'tool-call', thoughtSignature: 'ts-1' }],
  }
  const assistant = toPiAssistant(message)
  assert.equal(assistant.content[0].type, 'toolCall')
  assert.equal(assistant.content[0].thoughtSignature, 'ts-1')
  assert.deepEqual(assistant.content[0].arguments, { a: 1 })
})

test('toPiAssistant:toolCall 畸形参数容忍为空对象', () => {
  const message = harnessAssistant({
    content: [{ type: 'tool-call', id: 't1', name: 'run', arguments: '{broken' }],
  })
  message.source.replayState = {
    response: { kind: 'pi-ai', version: 2, api: 'anthropic-messages', provider: 'gw', model: 'm1', stopReason: 'toolUse' },
    blocks: [{ type: 'tool-call' }],
  }
  const assistant = toPiAssistant(message)
  assert.deepEqual(assistant.content[0].arguments, {})
})

test('toPiReplayState 到 toPiAssistant round-trip:签名保留、类型对齐', () => {
  const piMessage = {
    api: 'openai-completions',
    provider: 'gw',
    model: 'm1',
    content: [
      { type: 'text', text: 'part one', textSignature: 's1' },
      { type: 'thinking', thinking: 'deep', thinkingSignature: 's2' },
      { type: 'toolCall', id: 't9', name: 'run', arguments: { x: 2 }, thoughtSignature: 's3' },
    ],
    stopReason: 'toolUse',
    responseId: 'resp-1',
    responseModel: 'm1',
  }
  const replayState = toPiReplayState(piMessage)
  const harnessMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'part one' },
      { type: 'reasoning', text: 'deep' },
      { type: 'tool-call', id: 't9', name: 'run', arguments: '{"x":2}' },
    ],
    source: { kind: 'model', api: 'openai-completions', provider: 'gw', model: 'm1', replayState },
  }
  const assistant = toPiAssistant(harnessMessage)
  assert.equal(assistant.content[0].textSignature, 's1')
  assert.equal(assistant.content[1].thinkingSignature, 's2')
  assert.equal(assistant.content[2].thoughtSignature, 's3')
  assert.equal(assistant.responseId, 'resp-1')
})

test('toPiReplayState:未知块类型产出空洞槽位(官方 map 无 default 同语义)', () => {
  const replayState = toPiReplayState({
    api: 'a', provider: 'p', model: 'm',
    content: [{ type: 'text', text: 'x' }, { type: 'plugin-block' }],
    stopReason: 'stop',
  })
  assert.equal(replayState.blocks[1], undefined)
  const persisted = JSON.parse(JSON.stringify(replayState))
  assert.equal(persisted.blocks[1], null)
})

test('toPiContext:tool result 名从前置 assistant tool-call 恢复,孤儿归 unknown', () => {
  const context = toPiContext({
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 't1', name: 'run', arguments: '{}' }], source: { kind: 'model', api: 'a', provider: 'p', model: 'm', replayState: undefined } },
      { role: 'toolResult', content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] }] },
      { role: 'toolResult', content: [{ type: 'tool-result', toolCallId: 'ghost', content: [{ type: 'text', text: 'orphan' }] }] },
    ],
  })
  assert.equal(context.messages[0].content[0].type, 'toolCall')
  assert.equal(context.messages[1].toolName, 'run')
  assert.equal(context.messages[2].toolName, 'unknown')
})

test('toPiContext:system 消息投影为 user;纯工具回合不产生空 user 消息', () => {
  const context = toPiContext({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'rules' }] },
      { role: 'toolResult', content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'text', text: 'out' }] }] },
    ],
  })
  assert.deepEqual(context.messages[0], { role: 'user', content: 'rules', timestamp: 0 })
  assert.equal(context.messages.length, 2)
  assert.equal(context.messages[1].role, 'toolResult')
})

test('toPiContext:空 content 的 tool-result 输出归并为占位文本', () => {
  const context = toPiContext({
    messages: [
      { role: 'toolResult', content: [{ type: 'tool-result', toolCallId: 't1', content: [] }] },
    ],
  })
  assert.equal(context.messages.length, 1)
  assert.equal(context.messages[0].toolCallId, 't1')
  assert.equal(context.messages[0].content[0].text, '(no output)')
})

test('toPiContext:tools 装配仅非空出现;空历史产出空 messages', () => {
  const empty = toPiContext({ messages: [] })
  assert.deepEqual(empty.messages, [])
  assert.equal('tools' in empty, false)
  const withTools = toPiContext({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'run', description: 'd', parameters: {} }],
  })
  assert.deepEqual(withTools.tools, [{ name: 'run', description: 'd', parameters: {} }])
})

test('toPiContext:历史含图片即拒(文本路径)', () => {
  assert.throws(
    () => toPiContext({
      messages: [{ role: 'user', content: [{ type: 'image', image: 'x' }] }],
    }),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('toPiContextWithImages:user 图片经 attachments 读出;assistant 图片拒', async () => {
  const asked = []
  const attachments = {
    asked,
    async readImageRequest(ref) {
      asked.push(ref.attachmentId)
      return { attachment: ref, data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 4, height: 4, bytes: 3 }
    },
  }
  const context = await toPiContextWithImages({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', attachment: { attachmentId: 'att-1', bytes: 3 } },
      ],
    }],
  }, attachments, undefined, 20 * 1024 * 1024, { maxPixels: 4 * 1024 * 1024, maxBytes: 1024 * 1024 })
  const content = context.messages[0].content
  assert.equal(content[0].type, 'text')
  assert.equal(content[0].text, 'look')
  assert.equal(content[2].type, 'image')
  assert.equal(content[2].mimeType, 'image/png')
  assert.deepEqual(attachments.asked, ['att-1'])

  await assert.rejects(
    () => toPiContextWithImages({
      messages: [{ role: 'assistant', content: [{ type: 'image', attachment: { attachmentId: 'att-1', bytes: 3 } }] }],
    }, attachments, undefined, 20 * 1024 * 1024, { maxPixels: 4 * 1024 * 1024, maxBytes: 1024 * 1024 }),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
})
