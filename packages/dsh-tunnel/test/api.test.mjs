// REST 路由测试: CRUD / status / ui-settings / 错误语义(设计 docs/设计-隧道GUI.md §3.1)。
// 桩形态对齐 cron-board routes.test.mjs: makeReq/call 内存桩, tunnelsApi 业务桩。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createApi } from '../src/api.mjs'

function makeTunnelsApi() {
  const rows = new Map()
  return {
    rows,
    open(args) {
      if (rows.has(args.name)) return { ok: false, error: `隧道名已占用: ${args.name}` }
      rows.set(args.name, { createdAt: 't' })
      return { ok: true, name: args.name }
    },
    list() {
      return { ok: true, tunnels: [...rows.keys()].map((name) => ({ name })) }
    },
    close({ name }) {
      const removed = rows.delete(name)
      return { ok: true, removed }
    },
  }
}

function makeReq(method, pathAndQuery, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = pathAndQuery
  req.headers = { host: 'localhost:3000' }
  if (body !== undefined) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    process.nextTick(() => {
      req.emit('data', Buffer.from(payload))
      req.emit('end')
    })
  }
  return req
}

async function call(api, method, pathAndQuery, body) {
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => {
    res.raw = text
    try { res.payload = JSON.parse(text) } catch { res.payload = null }
  }
  await api.handle(makeReq(method, pathAndQuery, body), res)
  return res
}

function makeApi(overrides = {}) {
  const tunnelsApi = makeTunnelsApi()
  const api = createApi({
    tunnelsApi,
    readUi: overrides.readUi ?? (() => ({ sidebarTab: false })),
    updateUi: overrides.updateUi ?? ((body) => {
      if (typeof body?.sidebarTab !== 'boolean') throw new Error('sidebarTab 须为布尔')
      return { ok: true, ui: { sidebarTab: body.sidebarTab } }
    }),
    logSystem: overrides.logSystem ?? (() => {}),
  })
  return { tunnelsApi, api }
}

test('GET tunnels 返回同表列表', async () => {
  const { tunnelsApi, api } = makeApi()
  tunnelsApi.open({ name: 'app', targetPort: 80 })
  const res = await call(api, 'GET', '/api/tunnel/tunnels')
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.items, [{ name: 'app' }])
})

test('POST tunnels 合法入表, 业务错误 400 中文透传', async () => {
  const { api } = makeApi()
  const ok = await call(api, 'POST', '/api/tunnel/tunnels', { name: 'app', targetPort: 80 })
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.ok, true)
  const clash = await call(api, 'POST', '/api/tunnel/tunnels', { name: 'app', targetPort: 81 })
  assert.equal(clash.status, 400)
  assert.match(clash.payload.error, /已占用/)
})

test('DELETE tunnels/:name 幂等', async () => {
  const { api } = makeApi()
  await call(api, 'POST', '/api/tunnel/tunnels', { name: 'app', targetPort: 80 })
  const first = await call(api, 'DELETE', '/api/tunnel/tunnels/app')
  assert.deepEqual(first.payload, { ok: true, removed: true })
  const again = await call(api, 'DELETE', '/api/tunnel/tunnels/app')
  assert.deepEqual(again.payload, { ok: true, removed: false })
})

test('GET status 携带 ui 与 total', async () => {
  const { tunnelsApi, api } = makeApi()
  tunnelsApi.open({ name: 'a', targetPort: 80 })
  tunnelsApi.open({ name: 'b', targetPort: 81 })
  const res = await call(api, 'GET', '/api/tunnel/status')
  assert.deepEqual(res.payload, { ui: { sidebarTab: false }, total: 2 })
})

test('POST ui-settings 合法回写, 非法 400', async () => {
  const seen = []
  const { api } = makeApi({
    updateUi: (body) => {
      if (typeof body?.sidebarTab !== 'boolean') throw new Error('sidebarTab 须为布尔')
      seen.push(body.sidebarTab)
      return { ok: true, ui: { sidebarTab: body.sidebarTab } }
    },
  })
  const ok = await call(api, 'POST', '/api/tunnel/ui-settings', { sidebarTab: true })
  assert.deepEqual(ok.payload, { ok: true, ui: { sidebarTab: true } })
  assert.deepEqual(seen, [true])
  const bad = await call(api, 'POST', '/api/tunnel/ui-settings', { sidebarTab: 'yes' })
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /布尔/)
})

test('POST ui-settings 服务缺失降级: updateUi 返回 ok:false 时 200 透传', async () => {
  const { api } = makeApi({
    updateUi: () => ({ ok: false, error: '设置服务不可用' }),
  })
  const res = await call(api, 'POST', '/api/tunnel/ui-settings', { sidebarTab: true })
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload, { ok: false, error: '设置服务不可用' })
})

test('DELETE 畸形百分号编码按 404 不抛英文错误', async () => {
  const { api } = makeApi()
  const res = await call(api, 'DELETE', '/api/tunnel/tunnels/%E0%A4%A')
  assert.equal(res.status, 404)
  assert.match(res.payload.error, /接口不存在/)
})

test('未知路径与方法 404, 非法 JSON 400', async () => {
  const { api } = makeApi()
  assert.equal((await call(api, 'GET', '/api/tunnel/nope')).status, 404)
  assert.equal((await call(api, 'PATCH', '/api/tunnel/tunnels')).status, 404)
  assert.equal((await call(api, 'GET', '/other')).status, 404)
  const bad = await call(api, 'POST', '/api/tunnel/tunnels', '{not-json')
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /JSON/)
})
