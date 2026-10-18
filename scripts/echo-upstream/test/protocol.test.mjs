// BDD 场景 1-4 + 12(非流式回归锁定 + 留档形态):特征测试,锁定迁移前既有行为。
// Given 运行中 echo-upstream 服务(文件级共享实例),When 按协议请求,Then 响应与留档符合契约。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../server.mjs'
import { FIXED_CONTENT } from '../protocol.mjs'
import { resolveScenario } from '../scenarios.mjs'

const harness = {}

// 文件级共享实例:模块顶层 await 起服,顶层 after 收尾(避免逐测试起停的 Windows 退出竞态)
{
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-test-')), 'requests.jsonl')
  const base = { port: 0, log }
  const server = await start(base)
  after(() => { server.close(); server.closeIdleConnections() })
  harness.base = `http://127.0.0.1:${server.address().port}`
  harness.log = log
  const compatServer = await start({ ...base, echoUserMessage: true, resolveScenario: ({ parsedBody }) => resolveScenario(parsedBody?.model) })
  after(() => { compatServer.close(); compatServer.closeIdleConnections() })
  harness.compatBase = `http://127.0.0.1:${compatServer.address().port}`
  const compatHistoryServer = await start({ ...base, echoUserMessage: true, resolveScenario: ({ parsedBody }) => resolveScenario(parsedBody?.model) })
  after(() => { compatHistoryServer.close(); compatHistoryServer.closeIdleConnections() })
  harness.compatHistoryBase = `http://127.0.0.1:${compatHistoryServer.address().port}`
}
const post = (path, body, headers = {}, base = harness.base) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body,
})

test('opt-in 只在 default OpenAI/Anthropic 普通消息中回显 user 内容', async () => {
  const openai = await post('/v1/chat/completions', JSON.stringify({ model: 'my-model', messages: [{ role: 'user', content: '回复:ok' }] }), {}, harness.compatBase)
  assert.equal((await openai.json()).choices[0].message.content, `${FIXED_CONTENT} 回复:ok`)
  const anthropic = await post('/v1/messages', JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: [{ type: 'text', text: '回复:anth' }] }] }), {}, harness.compatBase)
  assert.equal((await anthropic.json()).content[0].text, `${FIXED_CONTENT} 回复:anth`)
})

test('opt-in 仅回显最后一条 user 文本，忽略非文本块与空白', async () => {
  const messages = [
    { role: 'user', content: 'older' },
    { role: 'assistant', content: 'thinking' },
    { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: '  last user  ' }, { type: 'text', text: 'tail' }] },
  ]
  const response = await post('/v1/chat/completions', JSON.stringify({ model: 'my-model', messages }), {}, harness.compatBase)
  assert.equal((await response.json()).choices[0].message.content, `${FIXED_CONTENT} last user tail`)
})

test('opt-in 忽略运行时注入的 user context，只回显用户内容', async () => {
  const messages = [
    { role: 'user', content: 'reply to the current user' },
    { role: 'user', content: 'Current runtime context. snapshot' },
    { role: 'user', content: '<system-reminder>runtime injected</system-reminder>' },
  ]
  const response = await post('/v1/messages', JSON.stringify({ model: 'claude-x', messages }), {}, harness.compatBase)
  assert.equal((await response.json()).content[0].text, `${FIXED_CONTENT} reply to the current user`)
})

test('opt-in 不复用历史 assistant 输出', async () => {
  const messages = [
    { role: 'user', content: 'reply to the current user' },
    { role: 'assistant', content: 'injected system reminder' },
    { role: 'user', content: 'current user prompt' },
  ]
  const response = await post('/v1/chat/completions', JSON.stringify({ model: 'my-model', messages }), {}, harness.compatBase)
  assert.equal((await response.json()).choices[0].message.content, `${FIXED_CONTENT} current user prompt`)
})


test('opt-in 不回显空文本', async () => {
  const response = await post('/v1/messages', JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: '   ' }] }] }), {}, harness.compatBase)
  assert.equal((await response.json()).content[0].text, FIXED_CONTENT)
})

test('opt-in 不改变 think/tool/Responses 路径', async () => {
  const anthropicThinking = await post('/v1/messages', JSON.stringify({ model: 'claude-x-think', messages: [{ role: 'user', content: [{ type: 'text', text: 'secret-input' }] }] }), {}, harness.compatBase)
  const anthropicText = (await anthropicThinking.json()).content.find((block) => block.type === 'text')?.text
  assert.equal(anthropicText, FIXED_CONTENT)
  const thinking = await post('/v1/chat/completions', JSON.stringify({ model: 'my-model-think', messages: [{ role: 'user', content: 'secret-input' }] }), {}, harness.compatBase)
  assert.equal((await thinking.json()).choices[0].message.content, FIXED_CONTENT)
  const tool = await post('/v1/chat/completions', JSON.stringify({ model: 'my-model-tool', messages: [{ role: 'user', content: 'secret-input' }] }), {}, harness.compatBase)
  const toolBody = await tool.json()
  assert.equal(toolBody.choices[0].message.content, null)
  assert.ok(toolBody.choices[0].message.tool_calls)
  const responses = await post('/v1/responses', JSON.stringify({ model: 'my-model', input: 'secret-input', messages: [{ role: 'user', content: 'unexpected' }] }), {}, harness.compatBase)
  assert.equal((await responses.json()).output[0].content[0].text, FIXED_CONTENT)
})

test('openai 非流式固定响应与模型回显', async () => {
  const res = await post('/v1/chat/completions', JSON.stringify({ model: 'my-model' }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.model, 'my-model')
  assert.equal(body.choices[0].message.content, FIXED_CONTENT)
  assert.deepEqual(body.usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })
})

test('anthropic 非流式 message 形状', async () => {
  const res = await post('/v1/messages', JSON.stringify({ model: 'claude-x' }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.type, 'message')
  assert.equal(body.model, 'claude-x')
  assert.equal(body.stop_reason, 'end_turn')
  assert.equal(body.content[0].text, FIXED_CONTENT)
  assert.deepEqual(body.usage, { input_tokens: 1, output_tokens: 1 })
})

test('模型发现双形态按 anthropic-version 头判定', async () => {
  const a = await fetch(harness.base + '/v1/models', { headers: { 'anthropic-version': '2023-06-01' } })
  const ab = await a.json()
  assert.equal(ab.data[0].id, 'echo-model')
  assert.equal(ab.has_more, false)
  const o = await fetch(harness.base + '/v1/models')
  const ob = await o.json()
  assert.equal(ob.object, 'list')
  assert.equal(ob.data[0].id, 'echo-model')
})

test('非法 JSON body 不拒绝照常响应', async () => {
  const res = await post('/v1/chat/completions', 'not-json{{')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.model, null)
})

test('未知路径回 openai 形状', async () => {
  const res = await post('/api/other', JSON.stringify({ model: 'm' }))
  assert.equal(res.status, 200)
  assert.equal((await res.json()).object, 'chat.completion')
})

test('留档逐行 JSON 含 at/method/path/headers/body', async () => {
  const before = readFileSync(harness.log, 'utf8').trim().split('\n').length
  await post('/v1/chat/completions', JSON.stringify({ model: 'rec-model' }))
  const lines = readFileSync(harness.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, before + 1)
  const last = lines.at(-1)
  assert.equal(last.method, 'POST')
  assert.equal(last.path, '/v1/chat/completions')
  assert.equal(last.body.model, 'rec-model')
  assert.ok(last.at)
  assert.ok(last.headers['content-type'])
})
