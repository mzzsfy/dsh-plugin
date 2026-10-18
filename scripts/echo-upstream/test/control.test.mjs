import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { start } from '../server.mjs'
import { installDelegate } from '../streaming.mjs'

const server = await start({ ...installDelegate(), port: 0, log: join(mkdtempSync(join(tmpdir(), 'llm-control-')), 'requests.jsonl') })
after(() => { server.closeAllConnections(); server.close() })
const base = `http://127.0.0.1:${server.address().port}`
const request = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer should-not-be-recorded' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() }
}
const generate = (body = {}) => request('/v1/chat/completions', 'POST', { model: 'echo-model', messages: [{ role: 'user', content: 'probe' }], ...body })

test('HTTP 设置两轮回复，模型发现不消费队列，上次请求包含对话与tools', async () => {
  // Given 两轮自定义回复；When 发现模型后连续生成；Then FIFO一次消费且控制查询不污染上游记录。
  await request('/control/reset', 'POST', {})
  const queued = await request('/control/replies', 'POST', { replies: [{ text: 'first', thinking: 'independent thought' }, { toolCalls: [{ name: 'pwsh', arguments: { command: 'Get-Date' } }] }] })
  assert.equal(queued.status, 201)
  await request('/v1/models')
  const tools = [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }]
  const first = await generate({ tools })
  assert.equal(first.body.choices[0].message.content, 'first')
  assert.equal(first.body.choices[0].message.reasoning_content, 'independent thought')
  const second = await generate({ tools })
  assert.equal(second.body.choices[0].message.tool_calls[0].function.name, 'pwsh')
  const last = (await request('/control/requests/latest')).body
  assert.deepEqual(last.tools, tools)
  assert.equal(last.messages[0].content, 'probe')
  assert.equal(last.reply.toolCalls[0].name, 'pwsh')
  assert.doesNotMatch(JSON.stringify(last), /should-not-be-recorded/)
  assert.equal((await request('/control/state')).body.requestCount, 2)
  assert.equal((await request('/control/state')).body.pendingCount, 0)
  assert.equal((await generate()).body.choices[0].message.content, 'echo-upstream-fixed')
})

test('默认回复可单独更新思考与速度，非法队列事务拒绝，重置清历史', async () => {
  // Given 默认正文/速度与一次性队列；When 更新思考并提交坏批次；Then 默认保留、坏批次不入队。
  await request('/control/reset', 'POST', {})
  assert.equal((await request('/control/default', 'PUT', { text: 'default', stream: { chunkSize: 2, intervalMs: 1 } })).status, 200)
  assert.equal((await request('/control/default', 'PATCH', { thinking: 'new thought', stream: { thinkingChunkSize: 1, thinkingIntervalMs: 1 } })).status, 200)
  const configured = (await request('/control/default')).body
  assert.equal(configured.text, 'default')
  assert.equal(configured.thinking, 'new thought')
  assert.equal(configured.stream.chunkSize, 2)
  const invalid = await request('/control/replies', 'POST', { replies: [{ text: 'not queued' }, { stream: { intervalMs: -1 } }] })
  assert.equal(invalid.status, 400)
  assert.equal((await request('/control/replies')).body.replies.length, 0)
  assert.equal((await generate()).body.choices[0].message.reasoning_content, 'new thought')
  const listed = (await request('/control/requests?after=0&limit=1')).body
  assert.equal(listed.requests.length, 1)
  await request('/control/reset', 'POST', {})
  assert.equal((await request('/control/requests/latest')).body, null)
  assert.equal((await request('/control/default')).body, null)
})

test('PATCH原始非法形态与定时器溢出事务拒绝', async () => {
  // Given合法默认值；When无效PATCH或超出Node timer边界；Then400且原配置不变。
  await request('/control/reset', 'POST', {})
  await request('/control/default', 'PUT', { text: 'keep', stream: { intervalMs: 8 } })
  for (const patch of [null, [], true, { stream: null }, { text: 'changed', stream: [] }]) {
    assert.equal((await request('/control/default', 'PATCH', patch)).status, 400)
    assert.equal((await request('/control/default')).body.text, 'keep')
  }
  for (const key of ['intervalMs', 'thinkingIntervalMs']) assert.equal((await request('/control/replies', 'POST', { stream: { [key]: 2 ** 31 } })).status, 400)
})

test('自动工具id避开显式id，三协议结果调用身份唯一', async () => {
  // Given显式id与自动id同批；When各协议响应；Then工具结果可唯一关联。
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
    await request('/control/replies', 'POST', { toolCalls: [{ id: 'call_echo_0', name: 'a', arguments: {} }, { name: 'b', arguments: {} }] })
    const result = (await request(path, 'POST', { model: 'echo-model' })).body
    const ids = result.choices ? result.choices[0].message.tool_calls.map(t => t.id) : result.output ? result.output.filter(t => t.type === 'function_call').map(t => t.call_id) : result.content.filter(t => t.type === 'tool_use').map(t => t.id)
    assert.equal(new Set(ids).size, 2)
    assert.equal(ids[0], 'call_echo_0')
  }
})

test('畸形原始HTTP request-target 不杀服务', async () => {
  // Given真实TCP畸形目标；WhenHTTP处理；Then仍能继续响应正常模型请求。
  const raw = await new Promise((resolve, reject) => {
    let text = ''
    const socket = createConnection({ host: '127.0.0.1', port: server.address().port }, () => socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'))
    socket.setEncoding('utf8')
    socket.on('data', chunk => { text += chunk })
    socket.on('error', reject)
    socket.on('end', () => resolve(text))
  })
  assert.match(raw, /HTTP\/1\.1 200/)
  assert.equal((await generate()).status, 200)
})

test('控制接口未知字段/非法JSON与未支持路径拒绝但服务不崩', async () => {
  // Given非法控制参数；When提交；Then400/404且正常LLM可继续工作。
  assert.equal((await request('/control/replies', 'POST', { toolCalls: [{ name: 'pwsh', arguments: '{bad' }] })).status, 400)
  assert.equal((await request('/control/replies', 'POST', { unknown: true })).status, 400)
  assert.equal((await request('/control/missing')).status, 404)
  const response = await fetch(base + '/control/replies', { method: 'POST', body: '{bad' })
  assert.equal(response.status, 400)
  assert.equal((await generate()).status, 200)
})
