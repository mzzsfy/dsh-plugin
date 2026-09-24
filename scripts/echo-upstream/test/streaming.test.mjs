// BDD 场景 5-6:SSE 流式双协议(文件级共享实例,流式触发 = 请求体 stream 字段)。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../server.mjs'
import { installDelegate } from '../streaming.mjs'
import { parseSse } from './helpers.mjs'

const harness = {}

// 文件级共享实例:模块顶层 await 起服,顶层 after 收尾(避免逐测试起停的 Windows 退出竞态)
{
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-test-')), 'requests.jsonl')
  const server = await start({ port: 0, log, ...installDelegate({}) })
  after(() => { server.close(); server.closeIdleConnections() })
  harness.base = `http://127.0.0.1:${server.address().port}`
}

const post = (path, body) => fetch(harness.base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('openai 流式 chunk 序列终止 [DONE]', async () => {
  const res = await post('/v1/chat/completions', { model: 'my-model', stream: true })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const events = parseSse(await res.text())
  const payloads = events.map((e) => e.data)
  assert.equal(payloads.at(-1), '[DONE]')
  const chunks = payloads.slice(0, -1).map((d) => JSON.parse(d)).filter((c) => c.object === 'chat.completion.chunk')
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  const contentChunk = chunks.find((c) => c.choices[0].delta.content)
  assert.equal(contentChunk.choices[0].delta.content, 'echo-upstream-fixed')
  const usageChunk = chunks.find((c) => c.usage)
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
  assert.ok(chunks.every((c) => c.model === 'my-model'))
})

test('anthropic 流式 event 序列含 message_start 与 usage', async () => {
  const res = await post('/v1/messages', { model: 'claude-x', stream: true })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const events = parseSse(await res.text())
  const names = events.map((e) => e.event)
  assert.deepEqual(names, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
  const start = JSON.parse(events[0].data)
  assert.equal(start.message.model, 'claude-x')
  assert.equal(JSON.parse(events[2].data).delta.text, 'echo-upstream-fixed')
  const usage = JSON.parse(events[4].data)
  assert.equal(usage.usage.output_tokens, 1)
  assert.equal(JSON.parse(events[0].data).message.usage.input_tokens, 1)
})
