// 模型发现 BDD(官方 discoverModels 减 catalog 分支):openai 系可探测,
// 其余协议明确不支持,坏端点/坏响应归类,探测键与 attribution 头携带。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverModels } from '../src/discovery.mjs'

function jsonResponse(payload, init = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const encoded = new TextEncoder().encode(body)
  return {
    ok: init.status === undefined || (init.status >= 200 && init.status < 300),
    status: init.status ?? 200,
    headers: new Map(Object.entries(init.headers ?? {})),
    body: {
      getReader() {
        let done = false
        return {
          async read() {
            if (done) return { done: true }
            done = true
            return { done: false, value: encoded }
          },
          async cancel() {},
        }
      },
    },
  }
}

function fetchOk(payload) {
  return async (url, init) => {
    fetchOk.captured = { url, init }
    return jsonResponse(payload)
  }
}

function codeOf(promise) {
  return promise.then(
    () => undefined,
    (error) => error.code,
  )
}

test('openai-completions 草稿探测:listing 行解析,bearer + attribution 头携带', async () => {
  const impl = fetchOk({ data: [
    { id: 'm1', name: 'Model One', context_window: 1000, max_output_tokens: 100 },
    { id: 'm2' },
    { nope: true },
  ] })
  const models = await discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example/v1/', apiKey: ' sk-x ' },
    async () => undefined,
    impl,
  )
  assert.deepEqual(models, [
    { id: 'm1', name: 'Model One', contextWindow: 1000, maxTokens: 100 },
    { id: 'm2' },
  ])
  assert.equal(fetchOk.captured.url, 'https://gw.example/v1/models')
  assert.equal(fetchOk.captured.init.headers.authorization, 'Bearer sk-x')
  assert.match(fetchOk.captured.init.headers['user-agent'], /^deepseek-harness\//)
})

test('openai-responses 可探测;anthropic-messages 报 DISCOVERY_UNSUPPORTED', async () => {
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-responses', baseURL: 'https://gw.example' },
    async () => undefined,
    fetchOk({ data: [] }),
  )), undefined)
  assert.equal(await codeOf(discoverModels(
    { api: 'anthropic-messages', baseURL: 'https://gw.example' },
    async () => undefined,
    fetchOk({ data: [] }),
  )), 'DISCOVERY_UNSUPPORTED')
})

test('无 baseURL 报 DISCOVERY_FAILED;非 2xx 报 DISCOVERY_FAILED', async () => {
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions' },
    async () => undefined,
    fetchOk({ data: [] }),
  )), 'DISCOVERY_FAILED')
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => undefined,
    async () => jsonResponse({}, { status: 401 }),
  )), 'DISCOVERY_FAILED')
})

test('非 JSON 响应报 DISCOVERY_FAILED;缺 data 数组报 DISCOVERY_FAILED', async () => {
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => undefined,
    fetchOk('<html>nope</html>'),
  )), 'DISCOVERY_FAILED')
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => undefined,
    fetchOk({ nope: true }),
  )), 'DISCOVERY_FAILED')
})

test('声明超限 content-length 直接拒收', async () => {
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => undefined,
    async () => jsonResponse('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }),
  )), 'DISCOVERY_FAILED')
})

test('draft 无键时用存量凭据探测', async () => {
  const impl = fetchOk({ data: [] })
  let asked = false
  await discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => {
      asked = true
      return 'sk-stored'
    },
    impl,
  )
  assert.equal(asked, true)
  assert.equal(fetchOk.captured.init.headers.authorization, 'Bearer sk-stored')
})

function streamingResponse(chunks, { headers = {} } = {}) {
  const encoder = new TextEncoder()
  const queue = chunks.map((chunk) => encoder.encode(chunk))
  return {
    ok: true,
    status: 200,
    headers: new Map(Object.entries(headers)),
    body: {
      getReader() {
        return {
          async read() {
            if (queue.length === 0) return { done: true }
            return { done: false, value: queue.shift() }
          },
          async cancel() {
            streamingResponse.cancelled = true
          },
        }
      },
    },
  }
}

test('流式累计超限拒收且取消 reader', async () => {
  streamingResponse.cancelled = false
  const chunk = 'x'.repeat(1024 * 1024)
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => undefined,
    async () => streamingResponse([chunk, chunk, chunk, chunk, chunk]),
  )), 'DISCOVERY_FAILED')
  assert.equal(streamingResponse.cancelled, true)
})

test('body 为 null 返回空串落 JSON 解析失败;无 reader 兜底限量读', async () => {
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => undefined,
    async () => ({ ok: true, status: 200, headers: new Map(), body: null }),
  )), 'DISCOVERY_FAILED')
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => undefined,
    async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      body: { async text() { return 'x'.repeat(5 * 1024 * 1024) } },
    }),
  )), 'DISCOVERY_FAILED')
  const listed = await discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example' },
    async () => undefined,
    async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      body: { async text() { return JSON.stringify({ data: [{ id: 'm1' }] }) } },
    }),
  )
  assert.deepEqual(listed, [{ id: 'm1' }])
})

test('探测请求被中断且 signal 已取消时归 ABORTED', async () => {
  const controller = new AbortController()
  controller.abort()
  const error = await discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example', signal: controller.signal },
    async () => undefined,
    async () => {
      throw new Error('The operation was aborted')
    },
  ).then(
    () => undefined,
    (thrown) => thrown,
  )
  assert.equal(error.code, 'ABORTED')
})

test('空白探测键与不可入头字符键报 INVALID_CREDENTIAL', async () => {
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example', apiKey: '   ' },
    async () => undefined,
    fetchOk({ data: [] }),
  )), 'INVALID_CREDENTIAL')
  assert.equal(await codeOf(discoverModels(
    { api: 'openai-completions', baseURL: 'https://gw.example', apiKey: 'sk-\nline' },
    async () => undefined,
    fetchOk({ data: [] }),
  )), 'INVALID_CREDENTIAL')
})
