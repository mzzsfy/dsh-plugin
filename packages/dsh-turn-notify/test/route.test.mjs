// host 路由测试:stub ctx 装载真实 src/index.js,验证 config 读写链路与
// test-webhook 的真实投递结果(回归:测试按钮不再无条件谎报成功)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply } from '../src/index.js'

const MIN_TURN_MS = 5 * 1000

function makeRes() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
}

function makeReq(method, payload, headers) {
  const req = new EventEmitter()
  req.method = method
  req.url = '/api/turn-notify/config'
  req.headers = { host: '127.0.0.1:3080', ...(headers || {}) }
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload))
  process.nextTick(() => {
    if (data !== null) req.emit('data', data)
    req.readableEnded = true
    req.emit('end')
  })
  return req
}

const JSON_HEADERS = { 'content-type': 'application/json' }

// settings 最小实现:get/update 挂服务级(对齐 SettingsProvider),update 按两层
// 对象合并,覆盖 enabled 部分开关语义;近似点:get 返回原始节,真实实现返回
// schema 解析后的冻结值,对被测读写语义无影响
function makeSettings() {
  const doc = new Map()
  const merge = (under, over) => {
    const out = { ...under }
    for (const [key, value] of Object.entries(over)) {
      const underValue = out[key]
      const bothPlain = (value !== null && typeof value === 'object' && !Array.isArray(value))
        && (underValue !== null && typeof underValue === 'object' && !Array.isArray(underValue))
      out[key] = bothPlain ? merge(underValue, value) : value
    }
    return out
  }
  return {
    register(ns) {
      if (!doc.has(ns)) doc.set(ns, {})
      return {
        get: () => doc.get(ns),
        watch: () => () => {},
      }
    },
    get: (ns) => doc.get(ns),
    update: async (ns, patch) => { doc.set(ns, merge(doc.get(ns) ?? {}, patch)) },
  }
}

function makeCtx() {
  const routes = new Map()
  const settingsService = makeSettings()
  const ctx = {
    on() {},
    get(key) { return key === 'settings' ? settingsService : undefined },
    inject(deps, fn) { fn({ settings: settingsService }) },
    effect(thunk) { thunk() },
    webServer: { register(route) { routes.set(route.path, route.handler) } },
  }
  return { ctx, routes }
}

test('config GET 返回解析后的默认配置,webhookUrl 凭据不出主机', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const handler = routes.get('/api/turn-notify/config')
  assert.ok(handler, 'config 路由未注册')
  const res = makeRes()
  await handler(makeReq('GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.webhookConfigured, false)
  assert.equal('webhookUrl' in res.body, false)
  assert.equal(res.body.minTurnDurationMs, MIN_TURN_MS)
  assert.equal(res.body.rootsOnly, true)
  assert.equal(res.body.enabled.completed, true)
})

test('config POST 非法补丁 400,合法补丁持久化且部分开关不覆盖其他分类', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const handler = routes.get('/api/turn-notify/config')
  const bad = makeRes()
  await handler(makeReq('POST', { webhookUrl: 'ftp://hook.example' }, JSON_HEADERS), bad)
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /http\(s\)/)
  const good = makeRes()
  await handler(makeReq('POST', { webhookUrl: 'https://hook.example', enabled: { completed: false } }, JSON_HEADERS), good)
  assert.equal(good.status, 200)
  assert.equal(good.body.webhookConfigured, true)
  assert.equal(good.body.enabled.completed, false)
  assert.equal(good.body.enabled.error, true)
  const readback = makeRes()
  await handler(makeReq('GET'), readback)
  assert.equal(readback.body.webhookConfigured, true)
})

test('config POST 负路径:跨源 403,非 JSON 400,畸形体 400,空补丁 200', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const handler = routes.get('/api/turn-notify/config')
  const crossOrigin = makeRes()
  await handler(makeReq('POST', {}, { ...JSON_HEADERS, origin: 'https://evil.example' }), crossOrigin)
  assert.equal(crossOrigin.status, 403)
  const sameOrigin = makeRes()
  await handler(makeReq('POST', { rootsOnly: false }, { ...JSON_HEADERS, origin: 'http://127.0.0.1:3080' }), sameOrigin)
  assert.equal(sameOrigin.status, 200)
  const wrongType = makeRes()
  await handler(makeReq('POST', {}, { 'content-type': 'text/plain' }), wrongType)
  assert.equal(wrongType.status, 400)
  const malformed = makeRes()
  await handler(makeReq('POST', undefined, JSON_HEADERS), malformed)
  assert.equal(malformed.status, 400)
  const empty = makeRes()
  await handler(makeReq('POST', {}, JSON_HEADERS), empty)
  assert.equal(empty.status, 200)
})

test('config POST 超限体 400', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const handler = routes.get('/api/turn-notify/config')
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/turn-notify/config'
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
  req.destroy = () => { req.destroyed = true }
  process.nextTick(() => {
    req.emit('data', Buffer.alloc(64 * 1024 + 1))
    req.readableEnded = true
    req.emit('end')
  })
  const res = makeRes()
  await handler(req, res)
  assert.equal(res.status, 400)
})

test('config 路由 405:PUT 被拒', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('PUT', {}, JSON_HEADERS), res)
  assert.equal(res.status, 405)
})

test('全部写路由守卫:upload 与 sound 删除跨源 403,mapping 非 JSON 400', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const upload = makeRes()
  await routes.get('/api/turn-notify/upload')(
    makeReq('POST', undefined, { origin: 'https://evil.example' }), upload)
  assert.equal(upload.status, 403)
  const sound = makeRes()
  await routes.get('/api/turn-notify/sound')(
    makeReq('DELETE', undefined, { origin: 'https://evil.example' }), sound)
  assert.equal(sound.status, 403)
  const mapping = makeRes()
  await routes.get('/api/turn-notify/mapping')(
    makeReq('POST', { category: 'completed', id: '' }, { 'content-type': 'text/plain' }), mapping)
  assert.equal(mapping.status, 400)
  const mappingCross = makeRes()
  await routes.get('/api/turn-notify/mapping')(
    makeReq('POST', { category: 'completed', id: '' }, { ...JSON_HEADERS, origin: 'https://evil.example' }), mappingCross)
  assert.equal(mappingCross.status, 403)
})

test('test-webhook 未配置时如实返回失败', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  await routes.get('/api/turn-notify/test-webhook')(makeReq('POST'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: false, detail: '未配置 webhook' })
})

test('test-webhook 跨源 403', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  await routes.get('/api/turn-notify/test-webhook')(makeReq('POST', undefined, { origin: 'https://evil.example' }), res)
  assert.equal(res.status, 403)
})

test('test-webhook 已配置时送达并返回真实结果', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return { ok: true, status: 200 }
  }
  try {
    const { ctx, routes } = makeCtx()
    apply(ctx)
    await routes.get('/api/turn-notify/config')(makeReq('POST', { webhookUrl: 'https://hook.example' }, JSON_HEADERS), makeRes())
    const res = makeRes()
    await routes.get('/api/turn-notify/test-webhook')(makeReq('POST'), res)
    assert.deepEqual(res.body, { ok: true, detail: 'HTTP 200' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://hook.example')
    assert.ok(String(calls[0].body.text).startsWith('[dsh]'), 'webhook payload 缺少 text')
  } finally { globalThis.fetch = original }
})
