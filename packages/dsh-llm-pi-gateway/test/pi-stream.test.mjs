// pi-stream BDD:usage 映射、错误分类序(与官方 classifyPiAiError 同序)、
// 终态映射(双通道超窗判定优先)、事件流转换与无终态拒收。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapUsage, classifyPiAiError, mapStopReason, toStreamChunks } from '../src/pi-stream.mjs'

function piMessage(overrides = {}) {
  return {
    api: 'anthropic-messages',
    provider: 'gw',
    model: 'm1',
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    stopReason: 'stop',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    timestamp: 0,
    ...overrides,
  }
}

test('mapUsage:cache 字段仅非零出现', () => {
  const plain = mapUsage({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 })
  assert.deepEqual(plain, { inputTokens: 1, outputTokens: 2, totalTokens: 3 })
  const cached = mapUsage({ input: 1, output: 2, cacheRead: 7, cacheWrite: 9, totalTokens: 19 })
  assert.equal(cached.cacheReadTokens, 7)
  assert.equal(cached.cacheWriteTokens, 9)
})

test('classifyPiAiError:分支序表(quota 先于 rate limit;与官方同序为人工源码对表结论,本用例钉扎本包行为)', () => {
  assert.equal(classifyPiAiError('HTTP 401 unauthorized'), 'AUTH')
  assert.equal(classifyPiAiError('403 forbidden'), 'AUTH')
  assert.equal(classifyPiAiError('insufficient quota for this account'), 'QUOTA')
  assert.equal(classifyPiAiError('rate limit exceeded, quota exhausted later'), 'QUOTA')
  assert.equal(classifyPiAiError('429 too many requests'), 'RATE_LIMIT')
  assert.equal(classifyPiAiError('413 payload too large'), 'INVALID_REQUEST')
  assert.equal(classifyPiAiError('invalid request body'), 'INVALID_REQUEST')
  assert.equal(classifyPiAiError('500 internal server error'), 'SERVER')
  assert.equal(classifyPiAiError('request timed out'), 'TIMEOUT')
  assert.equal(classifyPiAiError('stream ended before any content'), 'TRANSPORT')
  assert.equal(classifyPiAiError('ECONNRESET while reading'), 'TRANSPORT')
  assert.equal(classifyPiAiError('something utterly inexplicable'), 'PI_AI_ERROR')
})

test('classifyPiAiError:quota 判定优先于更早出现的 rate limit 文本', () => {
  assert.equal(classifyPiAiError('429 rate limit hit: out of credits'), 'QUOTA')
})

test('mapStopReason:stop 正常终止', () => {
  assert.deepEqual(mapStopReason(piMessage(), 1000), { kind: 'stop' })
})

test('mapStopReason:空内容 stop 归 EMPTY_RESPONSE', () => {
  const reason = mapStopReason(piMessage({ content: [] }), 1000)
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'EMPTY_RESPONSE')
})

test('mapStopReason:length/toolUse 映射', () => {
  assert.deepEqual(mapStopReason(piMessage({ stopReason: 'length' }), 1000), { kind: 'max-tokens' })
  assert.deepEqual(mapStopReason(piMessage({ stopReason: 'toolUse' }), 1000), { kind: 'tool-calls' })
})

test('mapStopReason:pending/deferred 归 PI_AI_ERROR', () => {
  assert.equal(mapStopReason(piMessage({ stopReason: 'pending' }), 1000).failure.code, 'PI_AI_ERROR')
  assert.equal(mapStopReason(piMessage({ stopReason: 'deferred' }), 1000).failure.code, 'PI_AI_ERROR')
})

test('mapStopReason:aborted 与 error', () => {
  const aborted = mapStopReason(piMessage({ stopReason: 'aborted' }), 1000)
  assert.equal(aborted.kind, 'aborted')
  const error = mapStopReason(piMessage({ stopReason: 'error', errorMessage: '429 too many requests' }), 1000)
  assert.equal(error.kind, 'error')
  assert.equal(error.failure.code, 'RATE_LIMIT')
})

test('mapStopReason:callerAborted 把 error 终态改写为 aborted', () => {
  const reason = mapStopReason(piMessage({ stopReason: 'error', errorMessage: 'boom' }), 1000, true)
  assert.equal(reason.kind, 'aborted')
})

test('mapStopReason:usage 超窗双通道之 usage 判定', () => {
  const reason = mapStopReason(piMessage({ usage: { input: 2000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2000 } }), 1000)
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('mapStopReason:usage 超窗双通道之文本判定(error 终态才生效)', () => {
  const reason = mapStopReason(piMessage({ stopReason: 'error', errorMessage: 'prompt is too long for this model' }), 1000)
  assert.equal(reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  const notOverflow = mapStopReason(piMessage({ stopReason: 'stop', errorMessage: 'prompt is too long for this model' }), 1000)
  assert.equal(notOverflow.kind, 'stop')
})

test('toStreamChunks:文本块三段与 thinking 块映射', async () => {
  async function* events() {
    yield { type: 'start', contentIndex: 0 }
    yield { type: 'text_start', contentIndex: 0 }
    yield { type: 'text_delta', contentIndex: 0, delta: 'he' }
    yield { type: 'text_delta', contentIndex: 0, delta: 'y' }
    yield { type: 'text_end', contentIndex: 0, content: 'hey' }
    yield { type: 'thinking_start', contentIndex: 1 }
    yield { type: 'thinking_delta', contentIndex: 1, delta: 'hmm' }
    yield { type: 'thinking_end', contentIndex: 1, content: 'hmm' }
    yield { type: 'done', message: piMessage() }
  }
  const chunks = []
  for await (const chunk of toStreamChunks(events(), 1000)) chunks.push(chunk)
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'he' })
  assert.deepEqual(chunks[2], { type: 'text-delta', index: 0, text: 'y' })
  assert.deepEqual(chunks[3], { type: 'block-end', index: 0, block: { type: 'text', text: 'hey' } })
  assert.deepEqual(chunks[4], { type: 'block-start', index: 1, blockType: 'reasoning' })
  assert.deepEqual(chunks[5], { type: 'reasoning-delta', index: 1, text: 'hmm' })
  assert.deepEqual(chunks[6], { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'hmm' } })
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(finish.replayState.response.kind, 'pi-ai')
  assert.deepEqual(chunks.find((c) => c.type === 'usage'), { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
})

test('toStreamChunks:tool-call 三段携带 id 与参数', async () => {
  async function* events() {
    yield { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ type: 'toolCall', id: 't1', name: 'run', arguments: '' }] } }
    yield { type: 'toolcall_delta', contentIndex: 0, delta: '{"a"' }
    yield {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 't1', name: 'run', arguments: { a: 1 } },
    }
    yield { type: 'done', message: piMessage({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't1', name: 'run', arguments: { a: 1 } }] }) }
  }
  const chunks = []
  for await (const chunk of toStreamChunks(events(), 1000)) chunks.push(chunk)
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'tool-call' })
  assert.equal(chunks[1].type, 'tool-call-delta')
  assert.equal(chunks[1].id, 't1')
  assert.equal(chunks[1].name, 'run')
  assert.deepEqual(chunks[2].block, { type: 'tool-call', id: 't1', name: 'run', arguments: '{"a":1}' })
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('toStreamChunks:toolcall_start partial 尚无该块时防御回退为空 id(生产流必先追加块,此为分支存活性钉扎)', async () => {
  async function* events() {
    yield { type: 'toolcall_start', contentIndex: 0, partial: { content: [] } }
    yield { type: 'toolcall_delta', contentIndex: 0, delta: '{}' }
    yield { type: 'done', message: piMessage() }
  }
  const chunks = []
  for await (const chunk of toStreamChunks(events(), 1000)) chunks.push(chunk)
  assert.equal(chunks[1].id, '')
  assert.equal('name' in chunks[1], false)
})

test('toStreamChunks:done 携带 usage 时产出 usage 块', async () => {
  async function* events() {
    yield { type: 'done', message: piMessage({ usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7 } }) }
  }
  const chunks = []
  for await (const chunk of toStreamChunks(events(), 1000)) chunks.push(chunk)
  assert.deepEqual(chunks[0], { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } })
  assert.equal(chunks.length, 2)
})

test('toStreamChunks:error 终态按 finish 送达', async () => {
  async function* events() {
    yield { type: 'error', error: piMessage({ stopReason: 'error', errorMessage: 'socket hung up' }) }
  }
  const chunks = []
  for await (const chunk of toStreamChunks(events(), 1000)) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TRANSPORT')
})

test('toStreamChunks:无终态事件抛 STREAM_CLOSED', async () => {
  async function* events() {
    yield { type: 'start', contentIndex: 0 }
  }
  await assert.rejects(
    () => toStreamChunks(events(), 1000).next(),
    (error) => error.code === 'STREAM_CLOSED',
  )
})
