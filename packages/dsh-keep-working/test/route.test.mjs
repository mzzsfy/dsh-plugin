// 配置路由接线测试:handler 真实调用守卫,拒绝路径必须回 403/415 而不是抛错
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/index.js'

function makeRes() {
  const res = { status: null, payload: null, ended: false }
  res.headers = {}
  res.setHeader = (name, value) => {
    res.headers[name] = value
  }
  res.writeHead = (status) => {
    res.status = status
  }
  Object.defineProperty(res, 'statusCode', {
    get: () => res.status,
    set: (value) => {
      res.status = value
    },
  })
  res.end = (text) => {
    res.ended = true
    res.payload = text ? JSON.parse(text) : null
  }
  return res
}

function makeReq({ method = 'POST', body, headers = {} } = {}) {
  return {
    method,
    headers: { host: 'localhost:3080', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body === undefined) return
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
}

async function makeHarness({ settings } = {}) {
  const routes = new Map()
  const handlers = new Map()
  const sections = []
  const writes = []
  const systemPromptStub = {
    getSectionOrder: () => 0,
    section: () => {
      sections.push(1)
      return () => {}
    },
  }
  // undefined 用默认桩;null 表示宿主未提供 settings 服务
  const settingsService = settings === undefined ? {
    async update(namespace, patch) {
      writes.push({ namespace, patch })
      return patch
    },
  } : settings
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    systemPrompt: {
      getSectionOrder: () => 0,
      section: () => {
        sections.push(1)
        return () => {}
      },
    },
    agents: { get: () => undefined, list: () => [] },
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    effect: (factory) => factory(),
    fiber: { state: 2 },
    get: (name) => {
      if (name === 'systemPrompt') return systemPromptStub
      return name === 'settings' && settingsService !== null ? settingsService : undefined
    },
    inject: (deps, fn) => {
      const stub = {
        effect: (factory) => factory(),
        on: () => () => {},
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
      }
      fn(stub)
    },
  }
  await apply(ctx, { scanOnBoot: false })
  const handler = routes.get('/api/keep-working/config')
  assert.ok(handler, '配置路由必须注册')
  return { handler, writes, handlers, ctx, sections }
}

const PATH = '/api/keep-working/config'

test('接线:同源 JSON 写入生效', async () => {
  const { handler, writes } = await makeHarness()
  const res = makeRes()
  await handler(makeReq({ body: { maxConsecutive: 5 }, headers: { origin: 'http://localhost:3080', 'content-type': 'application/json' } }), res)
  assert.equal(res.status, 200)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].patch.maxConsecutive, 5)
})

test('接线:跨源 Origin 回 403 且不写设置', async () => {
  const { handler, writes } = await makeHarness()
  const res = makeRes()
  await handler(makeReq({ body: { maxConsecutive: 5 }, headers: { origin: 'http://evil.example', 'content-type': 'application/json' } }), res)
  assert.equal(res.status, 403)
  assert.equal(res.payload.ok, false)
  assert.equal(writes.length, 0)
})

test('接线:非 JSON 体回 415 且不写设置', async () => {
  const { handler, writes } = await makeHarness()
  const res = makeRes()
  await handler(
    makeReq({ body: { maxConsecutive: 5 }, headers: { origin: 'http://localhost:3080', 'content-type': 'text/plain' } }),
    res,
  )
  assert.equal(res.status, 415)
  assert.equal(writes.length, 0)
})

test('接线:无 Origin 的本地调用放行', async () => {
  const { handler, writes } = await makeHarness()
  const res = makeRes()
  await handler(makeReq({ body: { maxConsecutive: 7 }, headers: { 'content-type': 'application/json' } }), res)
  assert.equal(res.status, 200)
  assert.equal(writes[0].patch.maxConsecutive, 7)
})

test('接线:GET 回读走默认值,非 POST 方法 405', async () => {
  const { handler } = await makeHarness()
  const get = makeRes()
  await handler(makeReq({ method: 'GET' }), get)
  assert.equal(get.status, 200)
  assert.equal(typeof get.payload.value.graceMs, 'number')
  const put = makeRes()
  await handler(makeReq({ method: 'PUT' }), put)
  assert.equal(put.status, 405)
})

test('接线:设置服务缺失回 503', async () => {
  const { handler } = await makeHarness({ settings: null })
  const res = makeRes()
  await handler(makeReq({ body: { maxConsecutive: 2 }, headers: { 'content-type': 'application/json' } }), res)
  assert.equal(res.status, 503)
})

test('路由 path 常量与文档一致', () => {
  assert.equal(PATH, '/api/keep-working/config')
})
test('接线:非对象请求体回 400 且不写设置', async () => {
  const { handler, writes } = await makeHarness()
  for (const body of ['null', '[1,2]', '"text"', '42']) {
    const res = makeRes()
    await handler(
      makeReq({ body, headers: { origin: 'http://localhost:3080', 'content-type': 'application/json' } }),
      res,
    )
    assert.equal(res.status, 400, body)
    assert.equal(res.payload.ok, false)
  }
  assert.equal(writes.length, 0)
})

test('接线:设置修订冲突回 409 并带原因', async () => {
  const conflict = Object.assign(new Error('设置已被其他窗口修改'), { code: 'SETTINGS_CONFLICT' })
  const { handler } = await makeHarness({
    settings: {
      async update() {
        throw conflict
      },
    },
  })
  const res = makeRes()
  await handler(
    makeReq({ body: { maxConsecutive: 5 }, headers: { origin: 'http://localhost:3080', 'content-type': 'application/json' } }),
    res,
  )
  assert.equal(res.status, 409)
  assert.equal(res.payload.ok, false)
  assert.match(res.payload.error, /其他窗口/)
})

test('接线:loader/volatile-update 触发运行期重建', async () => {
  const h = await makeHarness()
  const listener = h.handlers.get('loader/volatile-update')
  assert.equal(typeof listener, 'function', '必须订阅宿主 volatile 更新')
  const before = h.sections.length
  listener()
  await new Promise((resolve) => queueMicrotask(resolve))
  assert.equal(h.sections.length, before + 1, '注册新段落即说明运行期完成一次重建')
})

test('接线:卸载后微任务不再重建', async () => {
  const h = await makeHarness()
  const listener = h.handlers.get('loader/volatile-update')
  h.ctx.fiber.state = 4
  const before = h.sections.length
  listener()
  await new Promise((resolve) => queueMicrotask(resolve))
  assert.equal(h.sections.length, before, '已卸载的插件不得再重建')
})
