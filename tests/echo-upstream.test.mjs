// echo-upstream 工具测试:双协议固定返回 + 请求留档
// Given 服务已启动 When 发送各协议请求 Then 断言固定响应形状与留档记录
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/echo-upstream.mjs', import.meta.url))
const FIXED_TEXT = 'echo-upstream-fixed'

function startServer(args) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`启动超时: ${out}`)), 5000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      const match = out.match(/listening 127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve({ child, port: Number(match[1]) })
      }
    })
    child.on('exit', (code) => reject(new Error(`提前退出 code=${code}: ${out}`)))
  })
}

const stopServer = (child) => new Promise((resolve) => {
  child.once('exit', resolve)
  child.kill()
})

async function post(port, path, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

test('openai_chat_completions_返回固定chat_completion形状', async () => {
  const { child, port } = await startServer(['--port', '0'])
  try {
    // When: openai-completions 形态请求
    const { status, json } = await post(port, '/v1/chat/completions', {
      model: 'echo-model', messages: [{ role: 'user', content: 'hi' }], prompt_cache_key: 'dsh:abc',
    })
    // Then: 合法 chat.completion 形状,content 固定,model 回显
    assert.equal(status, 200)
    assert.equal(json.object, 'chat.completion')
    assert.equal(json.model, 'echo-model')
    assert.equal(json.choices.length, 1)
    assert.equal(json.choices[0].message.role, 'assistant')
    assert.equal(json.choices[0].message.content, FIXED_TEXT)
    assert.equal(json.choices[0].finish_reason, 'stop')
  } finally {
    await stopServer(child)
  }
})

test('anthropic_messages_返回固定message形状', async () => {
  const { child, port } = await startServer(['--port', '0'])
  try {
    const { status, json } = await post(port, '/v1/messages', {
      model: 'echo-anthropic', messages: [{ role: 'user', content: 'hi' }], metadata: { user_id: 'dsh:abc' },
    })
    assert.equal(status, 200)
    assert.equal(json.type, 'message')
    assert.equal(json.role, 'assistant')
    assert.equal(json.model, 'echo-anthropic')
    assert.equal(json.content.length, 1)
    assert.equal(json.content[0].type, 'text')
    assert.equal(json.content[0].text, FIXED_TEXT)
    assert.equal(json.stop_reason, 'end_turn')
  } finally {
    await stopServer(child)
  }
})

test('请求留档_记录小写头与body提取字段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-upstream-'))
  const logPath = join(dir, 'requests.jsonl')
  const { child, port } = await startServer(['--port', '0', '--log', logPath])
  try {
    // When: 带自定义头与 body 标记的请求
    await post(port, '/v1/chat/completions', {
      model: 'echo-model', prompt_cache_key: 'dsh:marker',
      metadata: { gateway: 'newapi', user_id: 'dsh:derived' },
    }, { 'x-session-affinity': 'session-1', 'x-gateway-group': 'pool-a' })
    await post(port, '/v1/messages', { model: 'echo-anthropic', metadata: { user_id: 'dsh:derived' } },
      { 'x-session-affinity': 'session-2' })
    // Then: 留档逐条记录,头小写化,body 关键字段可断言
    assert.ok(existsSync(logPath), '留档文件已写')
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    const [openai, anthropic] = lines
    assert.equal(openai.path, '/v1/chat/completions')
    assert.equal(openai.headers['x-session-affinity'], 'session-1')
    assert.equal(openai.headers['x-gateway-group'], 'pool-a')
    assert.equal(openai.body.prompt_cache_key, 'dsh:marker')
    assert.deepEqual(openai.body.metadata, { gateway: 'newapi', user_id: 'dsh:derived' })
    assert.equal(anthropic.headers['x-session-affinity'], 'session-2')
    assert.deepEqual(anthropic.body.metadata, { user_id: 'dsh:derived' })
  } finally {
    await stopServer(child)
  }
})

test('get_models_返回空列表', async () => {
  const { child, port } = await startServer(['--port', '0'])
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`)
    const json = await response.json()
    assert.equal(response.status, 200)
    assert.equal(json.object, 'list')
    assert.deepEqual(json.data, [])
  } finally {
    await stopServer(child)
  }
})

test('非法json与未知路径_仍返回固定响应不拒绝', async () => {
  const { child, port } = await startServer(['--port', '0'])
  try {
    // 非法 JSON:工具语义是不拒绝任何输入
    const bad = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json{',
    })
    assert.equal(bad.status, 200)
    const badJson = await bad.json()
    assert.equal(badJson.choices[0].message.content, FIXED_TEXT)
    // 未知路径:按 openai 形状固定返回,链路测试不因路径拼写中断
    const unknown = await post(port, '/completions', { model: 'm' })
    assert.equal(unknown.status, 200)
    assert.equal(unknown.json.choices[0].message.content, FIXED_TEXT)
  } finally {
    await stopServer(child)
  }
})
