// 路由分发 BDD:StreamOptions 装配(sessionId / headers / metadata / onPayload)/
// 事件流适配 / 错误路径。协议模块以 mock 注入,不依赖 pi-ai 可解析。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoute } from '../src/config.mjs'
import { createGatewayAdapter } from '../src/adapter.mjs'
import { deriveMarker } from '../src/marker.mjs'

function makeRoutes(profile) {
  return new Map(Object.entries({ 'new-api': resolveRoute('new-api', profile) }))
}

function fakeProtocol(captured) {
  return {
    streamSimple: async function * (model, context, options) {
      captured.push({ model, context, options })
      // 以模型协议对应形状的请求体驱动 onPayload,验证标记与模板装配
      const raw = model.api.startsWith('openai')
        ? { model: model.id, messages: [] }
        : { system: 'x', max_tokens: 1 }
      const payload = options.onPayload === undefined ? raw : options.onPayload(raw, model)
      captured.at(-1).payload = payload
      yield { type: 'start' }
      yield { type: 'text_start', contentIndex: 0 }
      yield { type: 'text_delta', contentIndex: 0, delta: 'hi' }
      yield { type: 'text_end', contentIndex: 0, content: 'hi' }
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          api: 'anthropic-messages',
          provider: 'new-api',
          model: model.id,
          usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: zeroCost() },
          stopReason: 'stop',
          timestamp: 0,
        },
      }
    },
  }
}

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
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

test('分发装配:sessionId 派生标记写入 metadata.user_id,透传 headers 与 cacheRetention', async () => {
  const captured = []
  const routes = makeRoutes(baseProfile({
    headers: { 'x-gateway-group': 'pool-a' },
    cacheRetention: 'short',
  }))
  const adapter = createGatewayAdapter(routes, async () => fakeProtocol(captured))
  const chunks = await collect(adapter.stream(request()))
  const { options, payload, model } = captured[0]
  assert.equal(options.sessionId, 'session-a')
  assert.equal(options.headers['x-gateway-group'], 'pool-a')
  assert.equal(options.cacheRetention, 'short')
  assert.equal(payload.metadata.user_id, deriveMarker('session-a'))
  assert.equal(model.api, 'anthropic-messages')
  assert.equal(model.baseUrl, 'https://gw.example.com')
  assert.deepEqual(model.compat, {})
  // 事件流适配:文本块 + usage + finish
  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'block-start', 'text-delta', 'block-end', 'usage', 'finish',
  ])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(finish.replayState.response.kind, 'pi-ai')
})

test('标记与 metadata 模板独立:模板 user_id 被标记覆盖,其余键透传', async () => {
  const captured = []
  const routes = makeRoutes(baseProfile({
    metadata: { user_id: '{"session":"{sessionId}"}', gateway: 'newapi' },
  }))
  const adapter = createGatewayAdapter(routes, async () => fakeProtocol(captured))
  await collect(adapter.stream(request()))
  const { options, payload } = captured[0]
  assert.equal(options.metadata.gateway, 'newapi')
  assert.equal(payload.metadata.gateway, 'newapi')
  assert.equal(payload.metadata.user_id, deriveMarker('session-a'))
})

test('sessionMarker.enabled false 时不挂 onPayload,body 无标记', async () => {
  const captured = []
  const routes = makeRoutes(baseProfile({ sessionMarker: { enabled: false } }))
  const adapter = createGatewayAdapter(routes, async () => fakeProtocol(captured))
  await collect(adapter.stream(request()))
  const { options, payload } = captured[0]
  assert.equal(options.onPayload, undefined)
  assert.equal(payload.metadata, undefined)
  assert.equal(payload.prompt_cache_key, undefined)
})

test('openai 协议路由经 onPayload 写 prompt_cache_key', async () => {
  const captured = []
  const routes = makeRoutes({ api: 'openai-completions', baseURL: 'https://gw.example.com', models: [{ id: 'gpt' }] })
  const adapter = createGatewayAdapter(routes, async () => fakeProtocol(captured))
  await collect(adapter.stream(request({ model: 'gpt' })))
  const { options, payload } = captured[0]
  assert.equal(payload.prompt_cache_key, deriveMarker('session-a'))
  assert.equal(payload.metadata, undefined)
})

test('未拥有路由 NO_ADAPTER,未知模型 UNKNOWN_MODEL,凭据缺失 MISSING_CREDENTIAL', async () => {
  const adapter = createGatewayAdapter(makeRoutes(baseProfile()), async () => fakeProtocol([]))
  await assert.rejects(collect(adapter.stream(request({ provider: 'other' }))), (error) => error.code === 'NO_ADAPTER')
  await assert.rejects(collect(adapter.stream(request({ model: 'nope' }))), (error) => error.code === 'UNKNOWN_MODEL')
  const routes = makeRoutes(baseProfile({ apiKeyEnv: 'DEFINITELY_UNSET_ENV_4711' }))
  const gated = createGatewayAdapter(routes, async () => fakeProtocol([]))
  await assert.rejects(collect(gated.stream(request())), (error) => error.code === 'MISSING_CREDENTIAL')
})

test('模型条目 maxTokens / reasoning 进入 pi-ai Model,缺省用默认', async () => {
  const captured = []
  const routes = makeRoutes(baseProfile({
    models: [{ id: 'auto', contextWindow: 200000, maxTokens: 16384, reasoning: false }],
  }))
  const adapter = createGatewayAdapter(routes, async () => fakeProtocol(captured))
  await collect(adapter.stream(request()))
  assert.equal(captured[0].model.maxTokens, 16384)
  assert.equal(captured[0].model.reasoning, false)
  const capturedDefault = []
  const defaults = createGatewayAdapter(makeRoutes(baseProfile()), async () => fakeProtocol(capturedDefault))
  await collect(defaults.stream(request()))
  assert.equal(capturedDefault[0].model.maxTokens, 8192)
  assert.equal(capturedDefault[0].model.reasoning, true)
})

test('sessionId 缺失或空拒绝 INVALID_REQUEST', async () => {
  const adapter = createGatewayAdapter(makeRoutes(baseProfile()), async () => fakeProtocol([]))
  await assert.rejects(collect(adapter.stream(request({ sessionId: undefined }))), (error) => error.code === 'INVALID_REQUEST')
  await assert.rejects(collect(adapter.stream(request({ sessionId: '' }))), (error) => error.code === 'INVALID_REQUEST')
})

test('providerInfo / listModels / resolveModel', async () => {
  const routes = makeRoutes(baseProfile({
    models: [
      { id: 'auto', contextWindow: 200000 },
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
    ],
  }))
  const adapter = createGatewayAdapter(routes, async () => fakeProtocol([]))
  assert.deepEqual(adapter.providerInfo('new-api'), { id: 'new-api', name: 'new-api' })
  const models = await adapter.listModels('new-api')
  assert.deepEqual(models.map((model) => model.id), ['auto', 'gpt-4o'])
  const resolved = await adapter.resolveModel('new-api', 'gpt-4o')
  assert.equal(resolved.context.contextWindow, 128000)
})

function baseProfile(overrides = {}) {
  return {
    api: 'anthropic-messages',
    baseURL: 'https://gw.example.com',
    models: [{ id: 'auto', contextWindow: 200000 }],
    ...overrides,
  }
}
