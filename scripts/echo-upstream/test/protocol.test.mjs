// BDD 场景 1-4 + 12(非流式回归锁定 + 留档形态):特征测试,锁定迁移前既有行为。
// Given 运行中 echo-upstream 服务(文件级共享实例),When 按协议请求,Then 响应与留档符合契约。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../server.mjs'

const FIXED_CONTENT = 'echo-upstream-fixed'
const harness = {}

// 文件级共享实例:模块顶层 await 起服,顶层 after 收尾(避免逐测试起停的 Windows 退出竞态)
{
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-test-')), 'requests.jsonl')
  const server = await start({ port: 0, log })
  after(() => { server.close(); server.closeIdleConnections() })
  harness.base = `http://127.0.0.1:${server.address().port}`
  harness.log = log
}const post = (path, body, headers = {}) => fetch(harness.base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body,
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
