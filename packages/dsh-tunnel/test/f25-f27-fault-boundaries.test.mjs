// 故障边界回归: F25 上游响应中断必须联动终止下游; F27 自代理环必须拒建。
// F26(wsPaths 根路径归一往返)随 wsPaths 参数一起退役——升级握手改由监听层按前缀分发,
// 不再有「声明哪些 WS 路径」这回事;该编号改为守护升级连接的双向回收。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FakeHost } from './support/fake-host.mjs'
import { applyPlugin, close, list, open, tempDataDir, tunnelPrefixCount, PORT_MAX } from './support/plugin.mjs'

const WS_HEADERS = {
  connection: 'Upgrade', upgrade: 'websocket',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
}

const cleanup = []
test.after(async () => {
  for (const dispose of cleanup.reverse()) await Promise.race([
    Promise.resolve(dispose()),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
})

async function startedHost() {
  const host = new FakeHost()
  await host.listen()
  host.installFallback('host-fallback')
  cleanup.push(() => host.dispose())
  return host
}

/** 打一发请求, 返回「这发响应如何收尾」: end 完整 / aborted|error 中断 / hung 悬挂。 */
function requestOutcome(port, path, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const done = (outcome) => {
      if (settled) return
      settled = true
      resolve({ ...outcome, elapsedMs: Date.now() - started })
    }
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => done({ kind: 'end', status: res.statusCode, body: Buffer.concat(chunks).toString() }))
      res.on('aborted', () => done({ kind: 'aborted', status: res.statusCode, body: Buffer.concat(chunks).toString() }))
      res.on('error', (error) => done({ kind: 'error', status: res.statusCode, error: error.message }))
    })
    req.on('error', (error) => done({ kind: 'error', error: error.message }))
    const timer = setTimeout(() => done({ kind: 'hung' }), timeoutMs)
    timer.unref()
    req.end()
  })
}

/** 升级目标: 记录并保持连接, 由用例决定何时销毁。 */
async function startWsTarget() {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', () => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
      socket.pipe(socket)
    })
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await once(server.close(), 'close')
  })
  return { port: server.address().port, sockets }
}

test('F25 上游截断联动下游: Content-Length 与 chunked 两形态都有界中断, 后续健康请求不受影响', { timeout: 20 * 1000 }, async () => {
  const target = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('healthy')
      return
    }
    if (req.url === '/cut-length') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '64' })
      res.write('0123456789')
      res.flushHeaders()
      setImmediate(() => res.socket.destroy())
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('0123456789')
    setImmediate(() => res.socket.destroy())
  })
  target.listen(0, '127.0.0.1')
  await once(target, 'listening')
  cleanup.push(async () => {
    target.closeAllConnections()
    await once(target.close(), 'close')
  })
  const host = await startedHost()
  const plugin = await applyPlugin(host)
  cleanup.push(() => plugin.dispose())
  assert.equal((await open(plugin, { name: 'app', targetPort: target.address().port })).ok, true)

  const truncated = await requestOutcome(host.port, '/p/app/cut-length')
  assert.notEqual(truncated.kind, 'end', `截断响应不得伪装成完整收尾: ${JSON.stringify(truncated)}`)
  assert.notEqual(truncated.kind, 'hung', `下游必须在有界时间内中断, 实际悬挂: ${JSON.stringify(truncated)}`)
  assert.ok(truncated.elapsedMs < 2000, `中断须及时, 实际 ${truncated.elapsedMs}ms`)

  const truncatedChunked = await requestOutcome(host.port, '/p/app/cut-chunked')
  assert.notEqual(truncatedChunked.kind, 'end', `chunked 截断不得伪装成完整收尾: ${JSON.stringify(truncatedChunked)}`)
  assert.notEqual(truncatedChunked.kind, 'hung', `chunked 下游必须在有界时间内中断: ${JSON.stringify(truncatedChunked)}`)

  const healthy = await requestOutcome(host.port, '/p/app/ok')
  assert.deepEqual([healthy.kind, healthy.status, healthy.body], ['end', 200, 'healthy'])
})

test('F26-a 升级连接回收: Given 客户端断开 Then 目标侧连接在有界时间内销毁', { timeout: 10 * 1000 }, async () => {
  const target = await startWsTarget()
  const host = await startedHost()
  const plugin = await applyPlugin(host)
  cleanup.push(() => plugin.dispose())
  await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })

  const client = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: host.port, path: '/ws', headers: { host: 'app.example.com', ...WS_HEADERS } })
    req.once('upgrade', (res, socket) => resolve(socket))
    req.once('error', () => resolve(undefined))
    req.end()
  })
  assert.ok(client, 'upgrade 应已建立')
  assert.equal(target.sockets.size, 1)
  const [targetSocket] = [...target.sockets]
  client.destroy()
  await Promise.race([
    once(targetSocket, 'close'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
  ])
  assert.equal(targetSocket.destroyed, true, '客户端断开后目标侧连接必须回收')
})

test('F26-b 升级连接回收: Given 目标断开 Then 客户端连接被同步关闭', { timeout: 10 * 1000 }, async () => {
  const target = await startWsTarget()
  const host = await startedHost()
  const plugin = await applyPlugin(host)
  cleanup.push(() => plugin.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })

  const client = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: host.port, path: '/p/app/ws', headers: { host: `127.0.0.1:${host.port}`, ...WS_HEADERS } })
    req.once('upgrade', (res, socket) => resolve(socket))
    req.once('error', () => resolve(undefined))
    req.end()
  })
  assert.ok(client, 'upgrade 应已建立')
  for (const socket of target.sockets) socket.destroy()
  await Promise.race([
    once(client, 'close'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
  ])
  assert.equal(client.destroyed, true, '目标断开后客户端连接必须同步关闭')
})

test('F27 自代理环: Given targetPort 为宿主监听端口 Then 两面都拒且不建立任何代理连接', { timeout: 10 * 1000 }, async () => {
  const dataDir = tempDataDir()
  const host = await startedHost()
  const plugin = await applyPlugin(host, { dataDir })
  cleanup.push(() => plugin.dispose())

  const refused = await open(plugin, { name: 'loop', targetPort: host.port })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /自代理环/)
  assert.equal(tunnelPrefixCount(host), 0)
  assert.equal((await requestOutcome(host.port, '/p/loop/x')).body, 'host-fallback', '未注册即不转发')

  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'loop2', entry: 'subdomain', targetPort: host.port, createdAt: 't1' },
  ]))
  plugin.dispose()
  const restored = await applyPlugin(host, { dataDir })
  cleanup.push(() => restored.dispose())
  assert.deepEqual((await list(restored)).tunnels, [])
  assert.ok(restored.warnings.some((line) => line.includes('自代理环')))
})

test('F27-b 停止/清理: close 幂等摘除路由与持久行', async () => {
  const host = await startedHost()
  const plugin = await applyPlugin(host)
  cleanup.push(() => plugin.dispose())
  assert.equal((await open(plugin, { name: 'stopme', targetPort: PORT_MAX - 2 })).ok, true)
  assert.equal(tunnelPrefixCount(host), 1)
  assert.deepEqual(await close(plugin, 'stopme'), { ok: true, removed: true })
  assert.equal(tunnelPrefixCount(host), 0)
  assert.deepEqual(await close(plugin, 'stopme'), { ok: true, removed: false })
})
