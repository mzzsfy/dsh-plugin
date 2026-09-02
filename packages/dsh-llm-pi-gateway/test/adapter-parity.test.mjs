// modelInfo / stream 请求选项与官方 dsh-llm-pi-ai 对表 BDD:
// reasoning 声明(efforts 列表 + defaultEffort)/ effort 校验链 /
// profileOptions 对齐(maxRetries 0、transport 等)/ attribution 头合并。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoute } from '../src/config.mjs'
import { createGatewayAdapter } from '../src/adapter.mjs'
import { requestHeaders } from '../src/headers.mjs'

function makeAdapter(profile, captured = [], protocol) {
  const routes = new Map([['new-api', resolveRoute('new-api', profile)]])
  return createGatewayAdapter(routes, async () => protocol ?? fakeProtocol(captured))
}

function fakeProtocol(captured) {
  return {
    streamSimple: async function * (model, context, options) {
      captured.push({ model, context, options })
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: 0,
        },
      }
    },
  }
}

function request(overrides = {}) {
  return {
    provider: 'new-api',
    model: 'auto',
    sessionId: 'session-a',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function baseProfile(overrides = {}) {
  return {
    api: 'anthropic-messages',
    baseURL: 'https://gw.example.com',
    models: [{ id: 'auto', contextWindow: 200000 }],
    ...overrides,
  }
}

test('resolveModel 声明 reasoning efforts(经 pi-ai getSupportedThinkingLevels)', async () => {
  const adapter = makeAdapter(baseProfile({
    models: [{ id: 'auto', contextWindow: 200000, reasoningEfforts: { off: null, low: 'low', max: 'ultra' } }],
  }))
  const info = await adapter.resolveModel('new-api', 'auto')
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['off', 'low', 'max'])
  assert.equal(info.reasoning.defaultEffort, undefined)
})

test('route reasoning 作为 defaultEffort,且仅当模型支持时描述', async () => {
  const adapter = makeAdapter(baseProfile({
    reasoning: 'low',
    models: [{ id: 'auto', contextWindow: 200000, reasoningEfforts: { off: null, low: 'low' } }],
  }))
  const info = await adapter.resolveModel('new-api', 'auto')
  assert.equal(info.reasoning.defaultEffort, 'low')
})

test('route reasoning 模型不支持时省略 defaultEffort(描述不失败)', async () => {
  const adapter = makeAdapter(baseProfile({
    reasoning: 'max',
    models: [{ id: 'auto', contextWindow: 200000, reasoningEfforts: { off: null, low: 'low' } }],
  }))
  const info = await adapter.resolveModel('new-api', 'auto')
  assert.equal(info.reasoning.defaultEffort, undefined)
})

test('非推理模型不声明 reasoning 字段', async () => {
  const adapter = makeAdapter(baseProfile())
  const info = await adapter.resolveModel('new-api', 'auto')
  assert.equal(info.reasoning, undefined)
})

test('声明的 defaultMaxTokens 进入 modelInfo', async () => {
  const adapter = makeAdapter(baseProfile({
    models: [{ id: 'auto', contextWindow: 200000, maxTokens: 16384 }],
  }))
  const info = await adapter.resolveModel('new-api', 'auto')
  assert.equal(info.defaultMaxTokens, 16384)
})

test('explicit effort 校验:不支持即 UNSUPPORTED_REASONING_EFFORT', async () => {
  const adapter = makeAdapter(baseProfile({
    models: [{ id: 'auto', contextWindow: 200000, reasoningEfforts: { off: null, low: 'low' } }],
  }))
  await assert.rejects(
    collect(adapter.stream(request({ reasoningEffort: 'high' }))),
    (error) => error.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
})

test('route reasoning 不支持时请求路径拒绝(描述宽松,请求严格)', async () => {
  const adapter = makeAdapter(baseProfile({
    reasoning: 'max',
    models: [{ id: 'auto', contextWindow: 200000, reasoningEfforts: { off: null, low: 'low' } }],
  }))
  await assert.rejects(
    collect(adapter.stream(request())),
    (error) => error.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
})

test('off effort 省略 reasoning 参数,其余档位发射', async () => {
  const captured = []
  const profile = baseProfile({
    models: [{ id: 'auto', contextWindow: 200000, reasoningEfforts: { off: null, low: 'low' } }],
  })
  await collect(makeAdapter(profile, captured).stream(request({ reasoningEffort: 'off' })))
  assert.equal('reasoning' in captured[0].options, false)
  await collect(makeAdapter(profile, captured).stream(request({ reasoningEffort: 'low' })))
  assert.equal(captured.at(-1).options.reasoning, 'low')
})

test('profileOptions 对齐:maxRetries 恒 0,transport/timeoutMs/thinkingBudgets 透传', async () => {
  const captured = []
  const profile = baseProfile({
    transport: 'websocket',
    timeoutMs: 60_000,
    websocketConnectTimeoutMs: 5_000,
    thinkingBudgets: { low: 1024 },
    cacheRetention: 'long',
  })
  await collect(makeAdapter(profile, captured).stream(request()))
  const options = captured[0].options
  assert.equal(options.maxRetries, 0)
  assert.equal(options.transport, 'websocket')
  assert.equal(options.timeoutMs, 60000)
  assert.equal(options.websocketConnectTimeoutMs, 5000)
  assert.deepEqual(options.thinkingBudgets, { low: 1024 })
  assert.equal(options.cacheRetention, 'long')
})

test('requestHeaders:attribution 恒在,用户撞名头大小写不敏感剥除', () => {
  const headers = requestHeaders({
    'User-Agent': 'my-agent/1.0',
    'x-gateway-group': 'pool-a',
  })
  assert.equal(headers['x-gateway-group'], 'pool-a')
  assert.match(headers['user-agent'], /^deepseek-harness\//)
  assert.equal('User-Agent' in headers, false)
})

test('模型缺省容量用路由 defaultContextWindow / defaultMaxTokens / defaultInput', async () => {
  const captured = []
  const profile = {
    api: 'anthropic-messages',
    baseURL: 'https://gw.example.com',
    defaultContextWindow: 131072,
    defaultMaxTokens: 4096,
    models: [{ id: 'auto' }],
  }
  const adapter = makeAdapter(profile, captured)
  const info = await adapter.resolveModel('new-api', 'auto')
  assert.equal(info.context.contextWindow, 131072)
  await collect(adapter.stream(request()))
  assert.equal(captured[0].model.maxTokens, 4096)
  assert.deepEqual(captured[0].model.input, ['text'])
})
