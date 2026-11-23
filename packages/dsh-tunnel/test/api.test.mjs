// REST 路由测试: CRUD / status / ui-settings / 错误语义(设计 docs/设计-隧道GUI.md §3.1)。
// 桩形态对齐 cron-board routes.test.mjs: makeReq/call 内存桩, tunnelsApi 业务桩。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { once } from 'node:events'

import { createApi, MESSAGES } from '../src/api.mjs'

function makeTunnelsApi() {
  const rows = new Map()
  return {
    rows,
    open(args) {
      if (rows.has(args.name)) return { ok: false, error: `隧道名已占用: ${args.name}` }
      rows.set(args.name, { createdAt: 't', enabled: true })
      return { ok: true, name: args.name }
    },
    async list() {
      return { ok: true, tunnels: [...rows.keys()].map((name) => ({ name })) }
    },
    async update({ name, patch }) {
      const row = rows.get(name)
      if (row === undefined) return { ok: false, error: `隧道不存在: ${name}` }
      Object.assign(row, patch)
      return { ok: true, name, enabled: row.enabled, targetPort: row.targetPort }
    },
    async listPorts() {
      return { supported: true, scannedAt: 't', items: [{ port: 8090, process: 'collectord.exe', dev: true, tunnelNames: [] }] }
    },
    async probePort(port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port 须为 1..65535 整数' }
      return { ok: true, listening: port === 8090, health: { state: port === 8090 ? 'online' : 'offline' } }
    },
    close({ name }) {
      const removed = rows.delete(name)
      return { ok: true, removed }
    },
    logs(args = {}) {
      const items = [
        { at: '2026-11-23T10:00:00.000Z', tunnel: 'app', kind: 'http', method: 'GET', path: '/p/app/a', status: 200, ms: 2 },
        { at: '2026-11-23T10:00:01.000Z', tunnel: 'web', kind: 'http', method: 'GET', path: '/p/web/b', status: 404, ms: 3 },
        { at: '2026-11-23T10:00:02.000Z', tunnel: 'web', kind: 'http', method: 'GET', path: '/p/web/c', status: 500, ms: 4 },
      ].filter((item) => args.name === undefined || item.tunnel === args.name)
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined
      return { ok: true, items: limit === undefined ? items : items.slice(0, limit), limit: 100 }
    },
  }
}

function makeReq(method, pathAndQuery, body, extraHeaders = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = pathAndQuery
  req.headers = { host: 'localhost:3000', ...extraHeaders }
  if (method !== 'GET' && method !== 'HEAD' && req.headers['content-type'] === undefined) {
    req.headers['content-type'] = 'application/json'
  }
  if (body !== undefined) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    process.nextTick(() => {
      req.emit('data', Buffer.from(payload))
      req.emit('end')
    })
  }
  return req
}

async function call(api, method, pathAndQuery, body, extraHeaders) {
  const res = { status: null, payload: null, headers: {}, finished: [] }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers ?? {} }
  res.on = (event, listener) => { if (event === 'finish') res.finished.push(listener) }
  res.end = (text) => {
    res.raw = text
    try { res.payload = JSON.parse(text) } catch { res.payload = null }
    for (const listener of res.finished) listener()
  }
  await api.handle(makeReq(method, pathAndQuery, body, extraHeaders), res)
  return res
}

function makeApi(overrides = {}) {
  const tunnelsApi = makeTunnelsApi()
  const api = createApi({
    tunnelsApi,
    readUi: overrides.readUi ?? (() => ({ aiTools: true })),
    updateUi: overrides.updateUi ?? ((body) => {
      if (typeof body?.aiTools !== 'boolean') throw new Error('aiTools 须为布尔')
      return { ok: true, ui: { aiTools: body.aiTools } }
    }),
    lanOrigin: overrides.lanOrigin ?? (() => 'http://192.168.1.7:3000'),
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

test('PATCH tunnels/:name 合法更新, 业务错误 400', async () => {
  const { api } = makeApi()
  await call(api, 'POST', '/api/tunnel/tunnels', { name: 'app', targetPort: 80 })
  const ok = await call(api, 'PATCH', '/api/tunnel/tunnels/app', { enabled: false })
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.enabled, false)
  const missing = await call(api, 'PATCH', '/api/tunnel/tunnels/nope', { enabled: true })
  assert.equal(missing.status, 400)
  assert.match(missing.payload.error, /不存在/)
})

test('GET ports 与 probe 透传业务面', async () => {
  const { api } = makeApi()
  const ports = await call(api, 'GET', '/api/tunnel/ports?all=1&refresh=1')
  assert.equal(ports.status, 200)
  assert.equal(ports.payload.items[0].process, 'collectord.exe')
  const probe = await call(api, 'GET', '/api/tunnel/probe?port=8090')
  assert.equal(probe.status, 200)
  assert.equal(probe.payload.listening, true)
  const bad = await call(api, 'GET', '/api/tunnel/probe?port=70000')
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /1..65535/)
})

test('GET logs 透传过滤与 limit, 非法数值不抛错', async () => {
  const { api } = makeApi()
  const all = await call(api, 'GET', '/api/tunnel/logs')
  assert.equal(all.status, 200)
  assert.equal(all.headers['cache-control'], 'no-store')
  assert.equal(all.payload.items.length, 3)
  assert.equal(all.payload.limit, 100)
  const filtered = await call(api, 'GET', '/api/tunnel/logs?name=web&limit=1')
  assert.deepEqual(filtered.payload.items.map((item) => item.path), ['/p/web/b'])
  const badLimit = await call(api, 'GET', '/api/tunnel/logs?limit=abc')
  assert.equal(badLimit.status, 200)
  assert.equal(badLimit.payload.items.length, 3)
})

test('GET status 携带 ui 与 total', async () => {
  const { tunnelsApi, api } = makeApi()
  tunnelsApi.open({ name: 'a', targetPort: 80 })
  tunnelsApi.open({ name: 'b', targetPort: 81 })
  const res = await call(api, 'GET', '/api/tunnel/status')
  assert.deepEqual(res.payload, { ui: { aiTools: true }, total: 2, lanOrigin: 'http://192.168.1.7:3000' })
})

test('POST ui-settings 合法回写, 非法 400', async () => {
  const seen = []
  const { api } = makeApi({
    updateUi: (body) => {
      if (typeof body?.aiTools !== 'boolean') throw new Error('aiTools 须为布尔')
      seen.push(body.aiTools)
      return { ok: true, ui: { aiTools: body.aiTools } }
    },
  })
  const ok = await call(api, 'POST', '/api/tunnel/ui-settings', { aiTools: true })
  assert.deepEqual(ok.payload, { ok: true, ui: { aiTools: true } })
  assert.deepEqual(seen, [true])
  const bad = await call(api, 'POST', '/api/tunnel/ui-settings', { aiTools: 'yes' })
  assert.equal(bad.status, 400)
  assert.match(bad.payload.error, /布尔/)
})

test('POST ui-settings 服务缺失降级: updateUi 返回 ok:false 时 200 透传', async () => {
  const { api } = makeApi({
    updateUi: () => ({ ok: false, error: '设置服务不可用' }),
  })
  const res = await call(api, 'POST', '/api/tunnel/ui-settings', { aiTools: true })
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

test('跨源写路由 403: 浏览器 CSRF 防线(Origin 与 Host 同源比对)', async () => {
  const { tunnelsApi, api } = makeApi()
  const cross = await call(api, 'POST', '/api/tunnel/tunnels', { name: 'app', targetPort: 80 }, { origin: 'http://evil.example' })
  assert.equal(cross.status, 403)
  assert.match(cross.payload.error, /跨源/)
  assert.equal(tunnelsApi.rows.size, 0, '跨源写不得落库')
  const same = await call(api, 'POST', '/api/tunnel/tunnels', { name: 'app', targetPort: 80 }, { origin: 'http://localhost:3000' })
  assert.equal(same.status, 200)
  const crossDelete = await call(api, 'DELETE', '/api/tunnel/tunnels/app', undefined, { origin: 'http://evil.example' })
  assert.equal(crossDelete.status, 403)
  assert.equal(tunnelsApi.rows.size, 1)
})

test('写路由强制 JSON: text/plain 简单请求 400(预检外的唯一跨站写入通道)', async () => {
  const { tunnelsApi, api } = makeApi()
  const res = await call(api, 'POST', '/api/tunnel/tunnels', JSON.stringify({ name: 'app', targetPort: 80 }), { 'content-type': 'text/plain' })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /application\/json/)
  assert.equal(tunnelsApi.rows.size, 0)
})

test('写路由 content-type 按 essence 精确比较: 子串伪装一律 400, 大小写/参数归一放行', async () => {
  const { tunnelsApi, api } = makeApi()
  const body = JSON.stringify({ name: 'app', targetPort: 80 })
  for (const contentType of ['application/jsonp', 'text/plain; application/json', 'application/jsonx', 'application/vnd.api+json']) {
    const res = await call(api, 'POST', '/api/tunnel/tunnels', body, { 'content-type': contentType })
    assert.equal(res.status, 400, `${contentType} 不得被当作 JSON`)
    assert.match(res.payload.error, /application\/json/)
  }
  assert.equal(tunnelsApi.rows.size, 0, '伪装 content-type 不得落库')
  for (const [index, contentType] of ['application/json', 'application/json; charset=utf-8', 'Application/JSON'].entries()) {
    const accepted = await call(api, 'POST', '/api/tunnel/tunnels', JSON.stringify({ name: `ok${index}`, targetPort: 80 }), { 'content-type': contentType })
    assert.equal(accepted.status, 200, `${contentType} 是合法 JSON essence`)
  }
  assert.equal(tunnelsApi.rows.size, 3)
})

test('读路由不受跨源卫影响: GET 携带 Origin 照常 200', async () => {
  const { api } = makeApi()
  const res = await call(api, 'GET', '/api/tunnel/tunnels', undefined, { origin: 'http://evil.example' })
  assert.equal(res.status, 200)
})

// 请求体超限: 旧实现先 reject 再 req.destroy(), 连接随响应一起死, 413 文案送不出
test('请求体超限: Given 单块即破上限 Then 暂停流入, 响应收尾后才销毁请求', async () => {
  const { api } = makeApi()
  const req = {
    method: 'POST',
    url: '/api/tunnel/tunnels',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    paused: false,
    destroyed: false,
    on(name, listener) {
      if (name === 'data') listener(Buffer.alloc(65 * 1024))
      return req
    },
    pause() { req.paused = true },
    destroy() { req.destroyed = true },
  }
  const res = { status: null, payload: null, finishListeners: [] }
  res.writeHead = (status) => { res.status = status }
  res.on = (event, listener) => { if (event === 'finish') res.finishListeners.push(listener) }
  res.end = (text) => {
    try { res.payload = JSON.parse(text) } catch { res.payload = null }
  }
  await api.handle(req, res)
  assert.equal(res.status, 413)
  assert.equal(res.payload.error, MESSAGES.bodyTooLarge)
  assert.equal(req.paused, true, '超限须暂停流入')
  assert.equal(req.destroyed, false, '响应未收尾前不得销毁 socket(否则 413 送不出)')
  for (const listener of res.finishListeners) listener()
  assert.equal(req.destroyed, true, '响应收尾后销毁请求, 防已暂停的流入悬挂 socket')
})

// 真实 socket 端到端: 413 必须被客户端真正收到(而不是连接重置)
test('请求体超限: Given 真实 socket 上突破 64KB Then 客户端收到 413 与中文文案', { timeout: 10 * 1000 }, async () => {
  const { api } = makeApi()
  const server = http.createServer((req, res) => { api.handle(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  try {
    const body = 'x'.repeat(70 * 1024)
    const outcome = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/tunnel/tunnels',
        method: 'POST',
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
        response.on('aborted', () => resolve({ status: response.statusCode, aborted: true }))
      })
      req.on('error', (error) => resolve({ error: error.message }))
      req.end(body)
    })
    assert.equal(outcome.error, undefined, `超限响应不得以连接错误收场: ${JSON.stringify(outcome)}`)
    assert.equal(outcome.status, 413)
    assert.match(JSON.parse(outcome.body).error, /超过上限/)
  } finally {
    server.closeAllConnections()
    await once(server.close(), 'close')
  }
})
