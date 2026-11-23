// 请求日志集成 BDD: HTTP/WS 埋点、502/504、滚动容量、隧道过滤、REST 面。
// 规格: docs/设计-隧道请求日志.md。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'

import { FakeHost, FUNCTION_FALLBACK, startTarget } from './support/fake-host.mjs'
import { applyPlugin, createSettingsService, open, toolOf } from './support/plugin.mjs'

const WS_HEADERS = {
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
}

function request(host, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: host.port,
      path,
      method: options.method ?? 'GET',
      headers: { host: options.host ?? `127.0.0.1:${host.port}`, ...options.headers },
    }, async (res) => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
    })
    req.on('error', reject)
    req.end()
  })
}

function upgrade(host, path, options = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: host.port,
      path,
      headers: { host: options.host ?? `127.0.0.1:${host.port}`, ...WS_HEADERS },
    })
    const timer = setTimeout(() => { req.destroy(); resolve({ upgraded: false, error: 'timeout' }) }, 3000)
    req.once('upgrade', (res, socket) => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ upgraded: true, status: res.statusCode })
    })
    req.once('response', (res) => { clearTimeout(timer); resolve({ upgraded: false, status: res.statusCode }) })
    req.once('error', (error) => { clearTimeout(timer); resolve({ upgraded: false, error: error.message }) })
    req.end()
  })
}

async function scenario(options = {}) {
  const host = new FakeHost({ fallbackShape: FUNCTION_FALLBACK })
  await host.listen()
  host.installFallback('host-fallback')
  const plugin = await applyPlugin(host, options)
  return { host, plugin }
}

const cleanup = []
test.after(async () => {
  for (const dispose of cleanup.reverse()) await dispose()
})

const logsOf = (plugin, args = {}) => toolOf(plugin, 'tunnel_logs').execute(args)

async function firstLog(plugin) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [entry] = (await logsOf(plugin)).items
    if (entry !== undefined) return entry
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return undefined
}

test('Given 路径隧道指向在线目标 When 一次 GET Then 日志记录方法/原始路径/状态/耗时', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  await request(host, '/p/app/a?b=c', { host: 'entry.example:3080' })
  const outcome = await logsOf(plugin)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.items.length, 1)
  const [entry] = outcome.items
  assert.equal(entry.tunnel, 'app')
  assert.equal(entry.kind, 'http')
  assert.equal(entry.method, 'GET')
  assert.equal(entry.path, '/p/app/a?b=c', '记录客户端可见的原始路径')
  assert.equal(entry.status, 200)
  assert.equal(typeof entry.ms, 'number')
  assert.ok(entry.ms >= 0)
  assert.ok(!Number.isNaN(Date.parse(entry.at)), 'at 必须可解析为时间')
})

test('Given 目标返回 404 When 请求 Then 日志保留真实上游状态', async () => {
  const target = await startTarget((req, res) => { res.writeHead(404); res.end('missing') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  await request(host, '/p/app/missing')
  const [entry] = (await logsOf(plugin)).items
  assert.equal(entry.status, 404)
})

test('Given 目标拒连 When 请求 Then 日志记录 502 与错误原因', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'dead', targetPort: 1 })
  const response = await request(host, '/p/dead/x')
  assert.equal(response.status, 502)
  const [entry] = (await logsOf(plugin)).items
  assert.equal(entry.tunnel, 'dead')
  assert.equal(entry.status, 502)
  assert.match(entry.error, /ECONNREFUSED|connect/i)
})

test('Given 目标不回头 When 响应头超时 Then 日志记录 504', async () => {
  const { host, plugin } = await scenario({ connectTimeoutMs: 100 })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  const sockets = new Set()
  const sink = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await once(sink.listen(0, '127.0.0.1'), 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await once(sink.close(), 'close')
  })
  await open(plugin, { name: 'slow', targetPort: sink.address().port })
  const response = await request(host, '/p/slow/x')
  assert.equal(response.status, 504)
  const [entry] = (await logsOf(plugin)).items
  assert.equal(entry.status, 504)
})

test('Given 子域名隧道 When WebSocket 握手成功 Then 日志记录 kind=ws 与 101', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'jup', targetPort: target.port, entry: 'subdomain' })
  const result = await upgrade(host, '/api/kernels/abc/channels', { host: 'jup.example.com' })
  assert.equal(result.upgraded, true)
  const [entry] = (await logsOf(plugin)).items
  assert.equal(entry.tunnel, 'jup')
  assert.equal(entry.kind, 'ws')
  assert.equal(entry.path, '/api/kernels/abc/channels')
  assert.equal(entry.status, 101)
})

test('Given 已有 3 条日志 When 设置下调容量到 2 Then 物理裁剪, 调回 5 不复现', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const settings = createSettingsService({ requestLogLimit: 5 })
  const { host, plugin } = await scenario({ requestLogLimit: 5, settings: settings.service })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  for (const suffix of ['a', 'b', 'c']) await request(host, `/p/app/${suffix}`, { host: 'entry.example:3080' })
  settings.setTunnel({ requestLogLimit: 2 })
  assert.equal((await logsOf(plugin)).items.length, 2)
  settings.setTunnel({ requestLogLimit: 5 })
  assert.deepEqual((await logsOf(plugin)).items.map((item) => item.path), ['/p/app/c', '/p/app/b'], '调高容量不得恢复已裁剪条目')
  settings.setTunnel({ requestLogLimit: 0 })
  assert.deepEqual((await logsOf(plugin)).items, [])
  settings.setTunnel({ requestLogLimit: 5 })
  assert.deepEqual((await logsOf(plugin)).items, [], '关闭后重开不得恢复旧条目')
})

test('Given 客户端在响应前断开 When 关闭请求 Then 日志 status=0, 不误记上游状态', async () => {
  let targetStarted
  const started = new Promise((resolve) => { targetStarted = resolve })
  const target = await startTarget(() => { targetStarted() })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  const req = http.request({ host: '127.0.0.1', port: host.port, path: '/p/app/slow', headers: { host: 'entry.example:3080' } })
  req.on('error', () => {})
  req.end()
  await started
  req.destroy()
  const entry = await firstLog(plugin)
  assert.equal(entry?.kind, 'http')
  assert.equal(entry?.status, 0)
})

test('Given WS 目标拒连 When upgrade Then 日志 status=502 且只有一条', async () => {
  const probe = net.createServer()
  await once(probe.listen(0, '127.0.0.1'), 'listening')
  const closedPort = probe.address().port
  await once(probe.close(), 'close')
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'jup', targetPort: closedPort, entry: 'subdomain' })
  await upgrade(host, '/ws', { host: 'jup.example.com' })
  const entry = await firstLog(plugin)
  assert.equal(entry?.kind, 'ws')
  assert.equal(entry?.status, 502)
  assert.equal((await logsOf(plugin)).items.length, 1)
})

test('Given WS 目标不回头 When 握手超时 Then 日志 status=504', async () => {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await once(server.close(), 'close')
  })
  const { host, plugin } = await scenario({ connectTimeoutMs: 100 })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'jup', targetPort: server.address().port, entry: 'subdomain' })
  await upgrade(host, '/ws', { host: 'jup.example.com' })
  const entry = await firstLog(plugin)
  assert.equal(entry?.kind, 'ws')
  assert.equal(entry?.status, 504)
})

test('Given 客户端在 WS 握手前断开 When 关闭请求 Then 日志 status=0', async () => {
  let seen
  const targetSeen = new Promise((resolve) => { seen = resolve })
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => seen())
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await once(server.close(), 'close')
  })
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'jup', targetPort: server.address().port, entry: 'subdomain' })
  const req = http.request({ host: '127.0.0.1', port: host.port, path: '/ws', headers: { host: 'jup.example.com', ...WS_HEADERS } })
  req.on('error', () => {})
  req.end()
  await targetSeen
  req.destroy()
  const entry = await firstLog(plugin)
  assert.equal(entry?.kind, 'ws')
  assert.equal(entry?.status, 0)
})

test('Given 目标拒绝升级 When WS 握手返回 404 Then 日志保留真实状态而不是 101', async () => {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => {
      socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
    })
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await once(server.close(), 'close')
  })
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'jup', targetPort: server.address().port, entry: 'subdomain' })
  const result = await upgrade(host, '/ws', { host: 'jup.example.com' })
  assert.equal(result.upgraded, false)
  assert.equal(result.status, 404)
  const [entry] = (await logsOf(plugin)).items
  assert.equal(entry.kind, 'ws')
  assert.equal(entry.status, 404)
})

test('Given requestLogLimit=2 When 三次请求 Then 只保留最后两条且新请求在前', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario({ requestLogLimit: 2 })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  for (const suffix of ['one', 'two', 'three']) await request(host, `/p/app/${suffix}`)
  const outcome = await logsOf(plugin)
  assert.equal(outcome.limit, 2)
  assert.deepEqual(outcome.items.map((item) => item.path), ['/p/app/three', '/p/app/two'])
})

test('Given requestLogLimit=0 When 请求 Then 代理正常但日志为空', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario({ requestLogLimit: 0 })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  assert.equal((await request(host, '/p/app/x')).body, 'ok')
  const outcome = await logsOf(plugin)
  assert.equal(outcome.limit, 0)
  assert.deepEqual(outcome.items, [])
})

test('Given 两条隧道 When 按名字过滤 Then 只返回该隧道条目', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  await open(plugin, { name: 'web', targetPort: target.port })
  await request(host, '/p/app/a')
  await request(host, '/p/web/b')
  const filtered = await logsOf(plugin, { name: 'web' })
  assert.deepEqual(filtered.items.map((item) => item.tunnel), ['web'])
  assert.deepEqual((await logsOf(plugin, { name: 'missing' })).items, [])
})

test('Given 设置热更 requestLogLimit When 记录 Then 新容量立即生效', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const settings = createSettingsService({ requestLogLimit: 3 })
  const { host, plugin } = await scenario({ settings: settings.service })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  for (const suffix of ['one', 'two']) await request(host, `/p/app/${suffix}`)
  assert.equal((await logsOf(plugin)).items.length, 2)
  settings.setTunnel({ requestLogLimit: 1 })
  await request(host, '/p/app/three')
  const outcome = await logsOf(plugin)
  assert.equal(outcome.limit, 1)
  assert.deepEqual(outcome.items.map((item) => item.path), ['/p/app/three'])
})

test('Given 已有日志 When GET /api/tunnel/logs Then 返回条目与容量, 支持过滤与 limit', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario({ requestLogLimit: 5 })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  await request(host, '/p/app/x')
  const all = await request(host, '/api/tunnel/logs')
  assert.equal(all.status, 200)
  const payload = JSON.parse(all.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.limit, 5)
  assert.equal(payload.items.length, 1)
  const filtered = JSON.parse((await request(host, '/api/tunnel/logs?name=app&limit=1')).body)
  assert.equal(filtered.items.length, 1)
  assert.equal(JSON.parse((await request(host, '/api/tunnel/logs?name=none')).body).items.length, 0)
})
