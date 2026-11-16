// dsh-tunnel 行为测试: 宿主面一律走 support/fake-host.mjs 的真实 http.Server 替身,
// 逐条复刻 @deepseek-ai/dsh-host-webserver 0.2.x 的分发语义(exact → 最长前缀 → fallback;
// upgrade 仅 exact 且 miss 即销毁; resource 形态 fallback 只受理 GET/HEAD)。
// 规格源: docs/设计-隧道改造.md(§2 分发模型 / §3 缺陷修复 / §4 BDD)。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'

import { FakeHost, RESOURCE_FALLBACK, FUNCTION_FALLBACK, startTarget } from './support/fake-host.mjs'
import {
  applyPlugin, close, list, open, storeRows, tempDataDir, tunnelPrefixCount, PORT_MAX,
} from './support/plugin.mjs'

const WS_HEADERS = {
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
}

/** 建一条保持打开的 upgrade 连接, 供跨信任面回收用例断言 close。 */
function openPersistentUpgrade(host, hostHeader, path = '/ws') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: host.port, path, headers: { host: hostHeader, ...WS_HEADERS },
    })
    const timer = setTimeout(() => { req.destroy(); reject(new Error('upgrade timeout')) }, 3000)
    req.once('upgrade', (res, socket) => { clearTimeout(timer); resolve(socket) })
    req.once('response', (res) => { clearTimeout(timer); reject(new Error(`status ${res.statusCode}`)) })
    req.once('error', (error) => { clearTimeout(timer); reject(error) })
    req.end()
  })
}

/** 在已建立连接上发一帧并等回环。 */
function probeSocket(socket, frame) {
  return new Promise((resolve) => {
    socket.once('data', (chunk) => resolve(chunk.toString()))
    socket.write(frame)
  })
}

/** 打一发真实 HTTP 请求到宿主监听面(Host 可任意指定, 不自动跟随重定向)。 */
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
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** 打一发 upgrade 握手并在建立后回环一帧; 被宿主销毁返回 { upgraded:false }。 */
function upgrade(host, path, options = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: host.port,
      path,
      headers: { host: options.host ?? `127.0.0.1:${host.port}`, ...WS_HEADERS },
    })
    const timer = setTimeout(() => { req.destroy(); resolve({ upgraded: false, error: 'timeout' }) }, 3000)
    req.once('upgrade', (res, socket, head) => {
      const finish = (chunk) => {
        clearTimeout(timer)
        socket.destroy()
        resolve({ upgraded: true, status: res.statusCode, echo: chunk.toString() })
      }
      // 服务端与 101 同包写下的字节落在 head 里, 不会再有 data 事件
      if (head && head.length > 0) return finish(head)
      socket.once('data', finish)
      socket.write('probe-frame')
    })
    req.once('response', (res) => { clearTimeout(timer); resolve({ upgraded: false, status: res.statusCode }) })
    req.once('error', (error) => { clearTimeout(timer); resolve({ upgraded: false, error: error.message }) })
    req.end()
  })
}

/** 裸升级目标: 记录收到的请求行与完整头块后回 101 并回环; net.Server 无 closeAllConnections, 自持 socket。 */
async function startWsTarget(received, heads = []) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', (chunk) => {
      const text = chunk.toString()
      received.push(text.split('\r\n')[0])
      heads.push(text)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
      socket.pipe(socket)
    })
  })
  await once(server.listen(0, '127.0.0.1'), 'listening')
  return {
    port: server.address().port,
    async stop() {
      for (const socket of sockets) socket.destroy()
      await once(server.close(), 'close')
    },
  }
}

/** 原始 socket 发升级握手: 可携带 Node 客户端会规范化/拒绝的头组合(CL 与 TE 须分请求)。 */
function rawUpgrade(host, path, headerLines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: host.port })
    const chunks = []
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw upgrade timeout')) }, 3000)
    socket.on('connect', () => {
      socket.write([`GET ${path} HTTP/1.1`, ...headerLines, '', ''].join('\r\n'))
    })
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const text = Buffer.concat(chunks).toString()
      if (!text.includes('\r\n\r\n')) return
      clearTimeout(timer)
      socket.destroy()
      resolve(text)
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

/** 把原始头块解析成小写名 -> 值(重复头以数组保留)。 */
function parseRawHead(head) {
  const map = new Map()
  for (const line of head.split('\r\n').slice(1)) {
    if (line === '') break
    const at = line.indexOf(':')
    if (at === -1) continue
    const key = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    map.set(key, map.has(key) ? [].concat(map.get(key), value) : value)
  }
  return map
}

async function startedHost(options) {
  const host = new FakeHost(options)
  await host.listen()
  return host
}

/** 起一套「宿主 + 目标应用 + 已装载插件」的完整场景。 */
async function scenario(options = {}) {
  const host = await startedHost({ fallbackShape: options.fallbackShape ?? FUNCTION_FALLBACK })
  if (options.hostRoutes !== false) {
    host.register({ kind: 'prefix', path: '/api', handler: (req, res) => { res.writeHead(200); res.end('host-api') } })
    host.installFallback(options.fallbackBody ?? 'host-fallback')
  }
  const plugin = await applyPlugin(host, options.plugin)
  return { host, plugin }
}

const cleanup = []
test.after(async () => {
  const pending = cleanup.reverse()
  for (const [index, dispose] of pending.entries()) {
    const outcome = await Promise.race([
      Promise.resolve(dispose()).then(() => 'ok'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ])
    if (outcome === 'timeout') console.error(`[cleanup] #${index} 未在 3s 内收敛: ${dispose.toString().slice(0, 80)}`)
  }
})

test('场景1 工具注册: Given apply Then 注册 tunnel_open/list/ports/close 四件', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.deepEqual(Object.keys(plugin.tools).sort(), ['tunnel_close', 'tunnel_list', 'tunnel_open', 'tunnel_ports'])
})

test('场景2 路径模式 open: Given 合法参数 Then 注册 /p/<名> 前缀路由并落盘, 不再有 wsPaths', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  const outcome = await open(plugin, { name: 'app', targetPort: PORT_MAX - 1 })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.path, '/p/app')
  assert.equal(outcome.entry, 'path')
  assert.equal(tunnelPrefixCount(host), 1)
  assert.equal(host.upgrades.size, 0, 'WS 由监听层分发, 不再逐条注册 upgrade 路由')
  const rows = storeRows(plugin.dataDir)
  assert.deepEqual(rows.map(({ name, entry, targetPort }) => ({ name, entry, targetPort })), [
    { name: 'app', entry: 'path', targetPort: PORT_MAX - 1 },
  ])
  assert.equal('wsPaths' in rows[0], false, '持久化不再携带 wsPaths')
})

test('场景3 子域名模式 open: Given entry=subdomain Then 不注册任何路由且返回 host', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  const outcome = await open(plugin, { name: 'web', targetPort: 1, entry: 'subdomain' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.host, 'web.localhost')
  assert.equal(tunnelPrefixCount(host), 0)
  assert.equal(host.upgrades.size, 0)
  assert.equal(storeRows(plugin.dataDir)[0].entry, 'subdomain')
})

test('场景4 校验: Given 非法名/越界端口/纯数字名/重名 Then 拒收且不注册不落盘', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  const rejected = [
    { name: 'App', targetPort: 80 },
    { name: 'a.b', targetPort: 80 },
    { name: '127', targetPort: 80 },
    { name: '192', targetPort: 80, entry: 'subdomain' },
    { name: 'ok', targetPort: 0 },
    { name: 'ok', targetPort: PORT_MAX + 1 },
    { name: 'ok', targetPort: 80, entry: 'port' },
  ]
  for (const args of rejected) {
    const outcome = await open(plugin, args)
    assert.equal(outcome.ok, false, JSON.stringify(args))
    assert.equal(typeof outcome.error, 'string')
  }
  assert.equal(tunnelPrefixCount(host), 0)
  assert.equal(storeRows(plugin.dataDir).length, 0)
  assert.equal((await open(plugin, { name: 'ok', targetPort: 80 })).ok, true)
  assert.equal((await open(plugin, { name: 'ok', targetPort: 81, entry: 'subdomain' })).ok, false, '名字跨形态唯一')
})

test('场景5 路径转发: Given GET /p/app/a?b=c Then strip 转发并保留 Host, 附 x-forwarded 三件套', async () => {
  const seen = []
  const target = await startTarget((req, res) => {
    seen.push({
      url: req.url,
      host: req.headers.host,
      fwdHost: req.headers['x-forwarded-host'],
      fwdFor: req.headers['x-forwarded-for'],
      fwdProto: req.headers['x-forwarded-proto'],
      forged: req.headers['x-forwarded-evil'],
      proxyAuth: req.headers['proxy-authorization'],
      te: req.headers.te,
    })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('target-body')
  })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  const response = await request(host, '/p/app/a?b=c', {
    host: 'entry.example:3080',
    headers: { 'x-forwarded-evil': '1', 'proxy-authorization': 'Basic Zm9v', te: 'trailers' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body, 'target-body')
  assert.deepEqual(seen, [{
    url: '/a?b=c',
    host: 'entry.example:3080',
    fwdHost: 'entry.example:3080',
    fwdFor: seen[0].fwdFor,
    fwdProto: 'http',
    forged: undefined,
    proxyAuth: undefined,
    te: undefined,
  }])
  assert.ok(seen[0].fwdFor, 'x-forwarded-for 必须由插件重建')
  assert.equal(host.protocol, 'http:')
})

test('场景6 x-forwarded-proto 跟随宿主协议: Given TLS 宿主 Then https', async () => {
  const seen = []
  const target = await startTarget((req, res) => {
    seen.push(req.headers['x-forwarded-proto'])
    res.writeHead(200)
    res.end('ok')
  })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  host.protocol = 'https:'
  await request(host, '/p/app/x')
  host.protocol = 'http:'
  await request(host, '/p/app/x')
  assert.deepEqual(seen, ['https', 'http'])
})

test('场景7 子域名全路径透传: Given 隧道 Host Then 无 strip, 且宿主同名前缀路由被完全隔离', async () => {
  const seen = []
  const target = await startTarget((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('target')
  })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })
  for (const path of ['/', '/deep/path?q=1', '/api/whatever', '/plugins/x', '/open-in-app/open']) {
    const response = await request(host, path, { host: 'app.example.com' })
    assert.equal(response.status, 200, path)
    assert.equal(response.body, 'target', path)
  }
  assert.deepEqual(seen, ['/', '/deep/path?q=1', '/api/whatever', '/plugins/x', '/open-in-app/open'])
})

test('场景8 非隧道 Host 零影响: Given 任意 Host Then 宿主前缀路由与 fallback 原样应答', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: PORT_MAX - 1, entry: 'subdomain' })
  assert.equal((await request(host, '/api/x')).body, 'host-api')
  assert.equal((await request(host, '/other')).body, 'host-fallback')
  // 首标签前缀相同的其它域名不得被吸走
  assert.equal((await request(host, '/', { host: 'app2.example.com' })).body, 'host-fallback')
})

test('场景9 resource 形态 fallback 下子域名仍生效(0.2.2 回归锁)', async () => {
  const target = await startTarget((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('target:' + req.url)
  })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario({ fallbackShape: RESOURCE_FALLBACK })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })
  assert.equal((await request(host, '/deep/path?q=1', { host: 'app.example.com' })).body, 'target:/deep/path?q=1')
  assert.equal((await request(host, '/')).body, 'host-fallback')
  // resource fallback 只受理 GET/HEAD, 宿主的 405 语义保持不变
  assert.equal((await request(host, '/x', { method: 'POST' })).status, 405)
})

test('场景10 Location 改写: Given 路径模式 3xx 同源根路径 Then 补前缀; 协议相对/跨源/已带前缀不动', async () => {
  const target = await startTarget((req, res) => {
    const map = {
      '/a': '/login',
      '/b': '//evil.example/x',
      '/c': 'https://evil.example/x',
      '/d': '/p/app/already',
    }
    res.writeHead(302, { location: map[req.url] ?? '/' })
    res.end()
  })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  assert.equal((await request(host, '/p/app/a')).headers.location, '/p/app/login')
  assert.equal((await request(host, '/p/app/b')).headers.location, '//evil.example/x')
  assert.equal((await request(host, '/p/app/c')).headers.location, 'https://evil.example/x')
  assert.equal((await request(host, '/p/app/d')).headers.location, '/p/app/already')
})

test('场景11 子域名不改写 Location: Given 子域名模式 3xx 根路径 Then 原样透传', async () => {
  const target = await startTarget((req, res) => {
    res.writeHead(302, { location: '/login' })
    res.end()
  })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })
  assert.equal((await request(host, '/x', { host: 'app.example.com' })).headers.location, '/login')
})

test('场景12 错误路径: Given 目标拒连/响应头超时 Then 502/504 JSON', async () => {
  const { host, plugin } = await scenario({ plugin: { connectTimeoutMs: 100 } })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  const sinkSockets = new Set()
  const sink = net.createServer((socket) => {
    sinkSockets.add(socket)
    socket.on('close', () => sinkSockets.delete(socket))
  })
  await once(sink.listen(0, '127.0.0.1'), 'listening')
  cleanup.push(async () => {
    for (const socket of sinkSockets) socket.destroy()
    await once(sink.close(), 'close')
  })
  await open(plugin, { name: 'dead', targetPort: 1 })
  await open(plugin, { name: 'slow', targetPort: sink.address().port })
  const refused = await request(host, '/p/dead/x')
  assert.equal(refused.status, 502)
  assert.equal(JSON.parse(refused.body).ok, false)
  const timedOut = await request(host, '/p/slow/x')
  assert.equal(timedOut.status, 504)
})

test('场景13 路径模式 WebSocket: Given 任意路径(未声明) Then strip 透传', async () => {
  const echoed = []
  const wsTarget = await startWsTarget(echoed)
  cleanup.push(() => wsTarget.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: wsTarget.port })
  for (const path of ['/p/app/', '/p/app/ws', '/p/app/api/kernels/9f8e7d6c-1234-4321-abcd-001122334455/channels']) {
    const result = await upgrade(host, path)
    assert.equal(result.upgraded, true, path)
    assert.equal(result.status, 101, path)
    assert.equal(result.echo, 'probe-frame', path)
  }
  assert.deepEqual(echoed, [
    'GET / HTTP/1.1',
    'GET /ws HTTP/1.1',
    'GET /api/kernels/9f8e7d6c-1234-4321-abcd-001122334455/channels HTTP/1.1',
  ])
})

test('场景14 子域名 WebSocket: Given 随机段路径 Then 无 strip 透传', async () => {
  const paths = []
  const wsTarget = await startWsTarget(paths)
  cleanup.push(() => wsTarget.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'jup', targetPort: wsTarget.port, entry: 'subdomain' })
  const result = await upgrade(host, '/api/kernels/abc/channels', { host: 'jup.example.com' })
  assert.equal(result.upgraded, true)
  assert.equal(result.echo, 'probe-frame')
  assert.deepEqual(paths, ['GET /api/kernels/abc/channels HTTP/1.1'])
})

test('场景14b 升级头收敛: Given 原始 socket 带 CL/TE/逐跳/Connection 点名头 Then 目标只收握手头与端到端头', async () => {
  const lines = []
  const heads = []
  const wsTarget = await startWsTarget(lines, heads)
  cleanup.push(() => wsTarget.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: wsTarget.port })
  const base = [
    'host: entry.example:3080',
    'connection: Upgrade, x-drop-me',
    'upgrade: websocket',
    'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
    'sec-websocket-version: 13',
    'proxy-authorization: Basic Zm9v',
    'trailer: x-trailer',
    'keep-alive: timeout=5',
    'te: trailers',
    'x-drop-me: secret',
    'x-end-to-end: keep',
    'x-forwarded-evil: 1',
  ]
  // Node 解析器拒绝 CL+TE 同请求, 两种 framing 头分别探针
  const first = await rawUpgrade(host, '/p/app/ws', [...base, 'content-length: 5'])
  const second = await rawUpgrade(host, '/p/app/ws', [...base, 'transfer-encoding: chunked'])
  assert.match(first, /^HTTP\/1\.1 101 /)
  assert.match(second, /^HTTP\/1\.1 101 /)
  assert.deepEqual(lines, ['GET /ws HTTP/1.1', 'GET /ws HTTP/1.1'])
  assert.equal(heads.length, 2)
  for (const head of heads) {
    const headers = parseRawHead(head)
    for (const dropped of ['content-length', 'transfer-encoding', 'proxy-authorization', 'trailer', 'keep-alive', 'te', 'x-drop-me', 'x-forwarded-evil']) {
      assert.equal(headers.has(dropped), false, `${dropped} 不得透传到升级目标`)
    }
    assert.equal(headers.get('x-end-to-end'), 'keep', '端到端头必须保留')
    assert.equal(headers.get('upgrade'), 'websocket')
    assert.match(headers.get('connection') ?? '', /upgrade/i)
    assert.equal(headers.get('sec-websocket-key'), 'dGhlIHNhbXBsZSBub25jZQ==')
    assert.equal(headers.get('sec-websocket-version'), '13')
    assert.equal(headers.get('x-forwarded-host'), 'entry.example:3080')
    assert.equal(headers.get('x-forwarded-proto'), 'http')
    assert.ok(headers.get('x-forwarded-for'), 'x-forwarded-for 必须由插件重建')
  }
})

test('场景15 分发未命中: Given 未开隧道 Then 宿主原语义(fallback / destroy)', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await request(host, '/p/none/x')).body, 'host-fallback')
  assert.equal((await request(host, '/p/none/x', { host: 'none.example.com' })).body, 'host-fallback')
  assert.equal((await upgrade(host, '/p/none/ws')).upgraded, false)
})

test('场景16 隧道 Host 全隔离: Given 宿主已注册 upgrade 路由 Then 隧道 Host 走隧道, 入口 Host 走宿主', async () => {
  const received = []
  const wsTarget = await startWsTarget(received)
  cleanup.push(() => wsTarget.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  host.registerUpgrade({ path: '/api/remote.mux', handler: (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\nhost-mux')
  } })
  await open(plugin, { name: 'app', targetPort: wsTarget.port, entry: 'subdomain' })
  const viaTunnel = await upgrade(host, '/api/remote.mux', { host: 'app.example.com' })
  assert.equal(viaTunnel.upgraded, true)
  assert.equal(viaTunnel.echo, 'probe-frame', '隧道 Host 必须全隔离')
  const viaEntry = await upgrade(host, '/api/remote.mux')
  assert.equal(viaEntry.upgraded, true)
  assert.equal(viaEntry.echo, 'host-mux', '入口 Host 的宿主路由不受影响')
})

test('场景17 close: Given 已开隧道 Then 路由摘除/条目删除/幂等', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: PORT_MAX - 1 })
  assert.equal(tunnelPrefixCount(host), 1)
  assert.deepEqual(await close(plugin, 'app'), { ok: true, removed: true })
  assert.equal(tunnelPrefixCount(host), 0)
  assert.equal(storeRows(plugin.dataDir).length, 0)
  assert.deepEqual(await close(plugin, 'app'), { ok: true, removed: false })
})

test('场景18 停用: Given dispose Then 监听层纯穿透, 请求回宿主且不再转发', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('target') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })
  assert.equal((await request(host, '/x', { host: 'app.example.com' })).body, 'target')
  plugin.dispose()
  assert.equal((await request(host, '/x', { host: 'app.example.com' })).body, 'host-fallback')
  assert.equal((await request(host, '/api/x')).body, 'host-api')
})

test('场景19 恢复: Given 混合形态持久化 Then 两类都恢复; 失败行留在磁盘且标记 active:false', async () => {
  const dataDir = tempDataDir()
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('target') })
  cleanup.push(() => target.stop())
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'pat', entry: 'path', targetPort: target.port, createdAt: 't1' },
    { name: 'sub', entry: 'subdomain', targetPort: target.port, createdAt: 't2' },
    { name: 'clash', entry: 'path', targetPort: target.port, createdAt: 't3' },
  ]))
  const host = await startedHost()
  host.register({ kind: 'prefix', path: '/api', handler: (req, res) => { res.writeHead(200); res.end('host-api') } })
  host.register({ kind: 'prefix', path: '/p/clash', handler: (req, res) => { res.writeHead(200); res.end('occupied') } })
  host.installFallback('host-fallback')
  const plugin = await applyPlugin(host, { dataDir })
  cleanup.push(() => plugin.dispose(), () => host.dispose())

  const listed = (await list(plugin)).tunnels
  assert.deepEqual(listed.map((row) => [row.name, row.active]).sort(), [['clash', false], ['pat', true], ['sub', true]])
  assert.match(listed.find((row) => row.name === 'clash').error, /duplicate/)
  assert.equal((await request(host, '/p/pat/x')).body, 'target')
  assert.equal((await request(host, '/x', { host: 'sub.example.com' })).body, 'target')

  // 失败行必须留在磁盘: 一次无关 open 不得把它抹掉
  await open(plugin, { name: 'other', targetPort: target.port })
  const rows = storeRows(dataDir).map((row) => row.name).sort()
  assert.deepEqual(rows, ['clash', 'other', 'pat', 'sub'])
  assert.ok(plugin.warnings.some((line) => line.includes('clash')), '恢复失败须留告警')
})

test('场景19b path 占位释放: Given 恢复失败的 path 行 When 占位释放且 list Then 自动重激活', async () => {
  const dataDir = tempDataDir()
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('target') })
  cleanup.push(() => target.stop())
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'pat', entry: 'path', targetPort: target.port, createdAt: 't1' },
  ]))
  const host = await startedHost()
  host.installFallback('host-fallback')
  const release = host.register({ kind: 'prefix', path: '/p/pat', handler: (req, res) => {
    res.writeHead(200); res.end('occupied')
  } })
  const plugin = await applyPlugin(host, { dataDir })
  cleanup.push(() => plugin.dispose(), () => host.dispose())

  let row = (await list(plugin)).tunnels.find((item) => item.name === 'pat')
  assert.equal(row.active, false)
  assert.match(row.error, /duplicate/)
  assert.equal((await request(host, '/p/pat/x')).body, 'occupied')

  // 占位释放后 list 的核对必须把 path 行重新激活,不得永久停在 active:false
  release()
  row = (await list(plugin)).tunnels.find((item) => item.name === 'pat')
  assert.equal(row.active, true)
  assert.equal(row.error, undefined)
  assert.equal((await request(host, '/p/pat/x')).body, 'target')
})

test('场景19c path 占位释放: Given 未激活 path 行 When 同名 open Then 原地重激活并采用新目标端口', async () => {
  const dataDir = tempDataDir()
  const first = await startTarget((req, res) => { res.writeHead(200); res.end('first') })
  const second = await startTarget((req, res) => { res.writeHead(200); res.end('second') })
  cleanup.push(() => first.stop(), () => second.stop())
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'app', entry: 'path', targetPort: first.port, createdAt: 't1' },
  ]))
  const host = await startedHost()
  host.installFallback('host-fallback')
  const release = host.register({ kind: 'prefix', path: '/p/app', handler: (req, res) => {
    res.writeHead(200); res.end('occupied')
  } })
  const plugin = await applyPlugin(host, { dataDir })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await list(plugin)).tunnels.find((item) => item.name === 'app').active, false)

  // 占位仍在时同名 open 必须失败且保留原持久化目标, 不得把死条目改成半成品
  const blocked = await open(plugin, { name: 'app', targetPort: PORT_MAX - 1 })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /duplicate/)
  assert.deepEqual(
    storeRows(dataDir).map(({ name, entry, targetPort }) => ({ name, entry, targetPort })),
    [{ name: 'app', entry: 'path', targetPort: first.port }],
  )

  release()
  const outcome = await open(plugin, { name: 'app', targetPort: second.port })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.path, '/p/app')
  assert.equal((await request(host, '/p/app/x')).body, 'second')
  assert.deepEqual(
    storeRows(dataDir).map(({ name, entry, targetPort }) => ({ name, entry, targetPort })),
    [{ name: 'app', entry: 'path', targetPort: second.port }],
  )

  // 已激活行仍然占用名字,同名 open 不得再次改写目标
  const again = await open(plugin, { name: 'app', targetPort: PORT_MAX - 1 })
  assert.equal(again.ok, false)
  assert.match(again.error, /占用/)
})

test('场景20 旧字段兼容: Given 持久化行带 wsPaths 与非法 entry Then 忽略字段/跳过非法行', async () => {
  const dataDir = tempDataDir()
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'legacy', entry: 'path', targetPort: PORT_MAX - 1, wsPaths: ['/ws'], createdAt: 't1' },
    { name: 'bad', entry: 'port', targetPort: PORT_MAX - 2, createdAt: 't2' },
    { name: '127', entry: 'subdomain', targetPort: PORT_MAX - 3, createdAt: 't3' },
  ]))
  const host = await startedHost()
  host.installFallback('host-fallback')
  const plugin = await applyPlugin(host, { dataDir })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  const listed = (await list(plugin)).tunnels
  assert.deepEqual(listed.map((row) => [row.name, row.active]), [['legacy', true]])
  assert.ok(plugin.warnings.some((line) => line.includes('bad')))
  assert.ok(plugin.warnings.some((line) => line.includes('127')))
})

test('场景20b 隧道表原子写: Given 旧固定 .tmp 名被占 Then 独立临时文件照常落盘且无残留', async () => {
  const dataDir = tempDataDir()
  // 同 home 的旧实例崩溃后可能留下固定名临时文件/目录: 共用固定名会直接写失败
  mkdirSync(join(dataDir, 'tunnels.json.tmp'))
  const { host, plugin } = await scenario({ plugin: { dataDir } })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  const outcome = await open(plugin, { name: 'app', targetPort: PORT_MAX - 1 })
  assert.equal(outcome.ok, true)
  assert.deepEqual(storeRows(dataDir).map((row) => row.name), ['app'])
  assert.equal(plugin.warnings.some((line) => line.includes('写盘失败')), false, '固定名被占不得影响本实例写盘')
  const leftovers = readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '临时文件按写入者唯一, 成功后必须清理')
})

test('场景21 自代理环: Given targetPort 为宿主监听端口 Then open 与恢复两面都拒', async () => {
  const dataDir = tempDataDir()
  const host = await startedHost()
  host.installFallback('host-fallback')
  const plugin = await applyPlugin(host, { dataDir })
  cleanup.push(() => host.dispose())
  const refused = await open(plugin, { name: 'loop', targetPort: host.port })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /自代理环/)
  assert.equal(tunnelPrefixCount(host), 0)
  assert.equal(storeRows(dataDir).length, 0)

  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'loop2', entry: 'subdomain', targetPort: host.port, createdAt: 't1' },
  ]))
  plugin.dispose()
  const second = await applyPlugin(host, { dataDir })
  cleanup.push(() => second.dispose())
  assert.deepEqual((await list(second)).tunnels, [])
  assert.ok(second.warnings.some((line) => line.includes('自代理环')))
})

test('场景22 宿主关闭: Given 隧道上挂着 upgrade 连接 Then host.close 在超时内收敛', async () => {
  const wsTarget = await startWsTarget([])
  cleanup.push(() => wsTarget.stop())
  const { host, plugin } = await scenario()
  await open(plugin, { name: 'app', targetPort: wsTarget.port, entry: 'subdomain' })
  const held = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: host.port, path: '/ws', headers: { host: 'app.example.com', ...WS_HEADERS } })
    req.once('upgrade', (res, socket) => resolve(socket))
    req.once('error', () => resolve(undefined))
    req.end()
  })
  assert.ok(held, 'upgrade 应已建立')
  // 客户端侧终结以 close 事件为准: destroyed 只反映本地是否调过 destroy(),
  // 远端关闭经 FIN(优雅)或 RST(error)到达, 两条路径都发 close 但仅后者置 destroyed;
  // 传播是异步的, 等待窗口只覆盖 I/O 物理时延
  let clientClosed = false
  held.once('close', () => { clientClosed = true })
  const closed = await host.dispose()
  assert.equal(closed, 'closed', '拦截的 upgrade 连接必须登记进 upgradedSockets, 否则 server.close 挂死')
  plugin.dispose()
  const settled = await new Promise((resolve) => {
    if (clientClosed) return resolve(true)
    held.once('close', () => { clearTimeout(timer); resolve(true) })
    const timer = setTimeout(() => resolve(false), 3000)
  })
  assert.equal(settled, true, '宿主关闭应终结客户端侧 upgrade 连接')
})

test('场景23 总线通知: Given 增删 Then publish() 每次变更一发', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.deepEqual(plugin.published, [], '装载期无变更不发布')
  await open(plugin, { name: 'a', targetPort: PORT_MAX - 1 })
  await open(plugin, { name: 'b', targetPort: PORT_MAX - 2, entry: 'subdomain' })
  await close(plugin, 'a')
  assert.equal(plugin.published.length, 3)
})

test('场景24 代际令牌: 新代已接管分发载体时, 旧代 dispose 不得清空新代', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => host.dispose())
  const nextGeneration = () => undefined
  host.dshTunnelDispatch = nextGeneration
  plugin.dispose()
  assert.equal(host.dshTunnelDispatch, nextGeneration, '旧代回收必须认令牌')
})

// ── P2-44 入口域首标签 ───────────────────────────────────────────────────────
// 子域名隧道按 Host 首标签分流, 且分流先于宿主全部路由(含 /api/*): 名等于入口域首标签
// 即把整个 GUI 劫持到隧道目标, 且按盘恢复后不自愈——open 必须拒收。

test('场景25 入口域首标签冲突: Given GUI 经 dsh.example.com 访问 Then 子域名名 dsh 被拒且入口不被劫持', async () => {
  const { host, plugin } = await scenario({ plugin: { connection: { trustedHosts: ['dsh.example.com:3080'] } } })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  const refused = await open(plugin, { name: 'dsh', targetPort: PORT_MAX - 1, entry: 'subdomain' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /入口域首标签冲突/)
  assert.match(refused.error, /dsh\.example\.com/)
  assert.equal(tunnelPrefixCount(host), 0)
  assert.equal(storeRows(plugin.dataDir).length, 0, '冲突名不得落盘(否则重启按盘恢复继续劫持)')

  // 管理 REST 同一判据, 走 400 而不是静默成功
  const rest = await request(host, '/api/tunnel/tunnels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'dsh', targetPort: PORT_MAX - 1, entry: 'subdomain' }),
  })
  assert.equal(rest.status, 400)
  assert.match(JSON.parse(rest.body).error, /入口域首标签冲突/)

  // 入口 Host 仍由宿主应答: GUI 与 /api/* 不被隧道吞掉
  assert.equal((await request(host, '/api/x', { host: 'dsh.example.com' })).body, 'host-api')
  assert.equal((await request(host, '/', { host: 'dsh.example.com' })).body, 'host-fallback')

  // 路径入口只在 /p/<名> 下, 不按 Host 分流: 无此冲突
  const pathEntry = await open(plugin, { name: 'dsh', targetPort: PORT_MAX - 1 })
  assert.equal(pathEntry.ok, true)
  assert.equal(tunnelPrefixCount(host), 1)
})

test('场景26 入口域取值: Given trustedHosts 含 localhost/IP 与多级域名 Then 只拦真正撞首标签的名字', async () => {
  const { host, plugin } = await scenario({
    plugin: { connection: { trustedHosts: ['localhost:3080', '127.0.0.1:3080', '[::1]:3080', 'gui.a.example.com'] } },
  })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await open(plugin, { name: 'app', targetPort: PORT_MAX - 1, entry: 'subdomain' })).ok, true,
    '无点主机/IP 不产生首标签, 未撞即放行')
  const refused = await open(plugin, { name: 'gui', targetPort: PORT_MAX - 2, entry: 'subdomain' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /gui\.a\.example\.com/, '多级域名取首标签, 与 client 侧 entryLabelOf 同构')
})

test('场景27 入口域比对服务缺失: Given 无 connection 服务 Then 与原行为一致(放行)', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await open(plugin, { name: 'dsh', targetPort: PORT_MAX - 1, entry: 'subdomain' })).ok, true)
})

// ── P3 Location 前缀边界 ────────────────────────────────────────────────────
test('场景28 Location 前缀边界: Given 目标回 /p/app2/... Then 仍补本隧道前缀(同前缀的别的隧道不算自己)', async () => {
  const target = await startTarget((req, res) => {
    const map = {
      '/near': '/p/app2/elsewhere',
      '/self': '/p/app',
      '/self-deep': '/p/app/deep',
      '/root': '/',
    }
    res.writeHead(302, { location: map[req.url] ?? '/' })
    res.end()
  })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  assert.equal((await request(host, '/p/app/near')).headers.location, '/p/app/p/app2/elsewhere')
  assert.equal((await request(host, '/p/app/self')).headers.location, '/p/app')
  assert.equal((await request(host, '/p/app/self-deep')).headers.location, '/p/app/deep')
  assert.equal((await request(host, '/p/app/root')).headers.location, '/p/app/')
})

test('场景29 Location 带查询串/锚点: Given 已带前缀 Then 按 pathname 段判定且 search/hash 原样保留', async () => {
  const target = await startTarget((req, res) => {
    const map = {
      '/login': '/login?next=%2Fdashboard#top',
      '/self-query': '/p/app?x=1&y=%2F#frag',
      '/self-frag': '/p/app#anchor',
      '/root-query': '/?q=1#h',
    }
    res.writeHead(302, { location: map[req.url] ?? '/' })
    res.end()
  })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: target.port })
  assert.equal((await request(host, '/p/app/login')).headers.location, '/p/app/login?next=%2Fdashboard#top', '补前缀不得丢查询串/锚点')
  assert.equal((await request(host, '/p/app/self-query')).headers.location, '/p/app?x=1&y=%2F#frag', '? 不是路径段边界,不得二次补前缀')
  assert.equal((await request(host, '/p/app/self-frag')).headers.location, '/p/app#anchor', '# 不是路径段边界,不得二次补前缀')
  assert.equal((await request(host, '/p/app/root-query')).headers.location, '/p/app/?q=1#h')
})

test('场景30 恢复首标签冲突: Given 盘上子域名行撞晚就绪信任面 Then active:false+error 且入口不被劫持', async () => {
  const dataDir = tempDataDir()
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'dsh', entry: 'subdomain', targetPort: PORT_MAX - 1, createdAt: 't1' },
    { name: 'safe', entry: 'subdomain', targetPort: PORT_MAX - 2, createdAt: 't2' },
  ]))
  const host = await startedHost()
  host.register({ kind: 'prefix', path: '/api', handler: (req, res) => { res.writeHead(200); res.end('host-api') } })
  host.installFallback('host-fallback')
  const plugin = await applyPlugin(host, { dataDir, connection: { trustedHosts: ['dsh.example.com:3080'] } })
  cleanup.push(() => plugin.dispose(), () => host.dispose())

  const listed = (await list(plugin)).tunnels
  const conflict = listed.find((row) => row.name === 'dsh')
  assert.equal(conflict.active, false, '冲突行不得激活')
  assert.match(conflict.error, /入口域首标签冲突/)
  assert.match(conflict.error, /dsh\.example\.com/)
  assert.equal(listed.find((row) => row.name === 'safe').active, true, '其它行照常恢复')
  assert.equal((await request(host, '/', { host: 'dsh.example.com' })).body, 'host-fallback', '入口必须仍归宿主')
  assert.equal((await request(host, '/api/x', { host: 'dsh.example.com' })).body, 'host-api')
  assert.ok(plugin.warnings.some((line) => line.includes('dsh')), '冲突行须留告警')

  // 失败行留在磁盘: 一次无关 open 不得把它抹掉
  await open(plugin, { name: 'other', targetPort: PORT_MAX - 3 })
  assert.deepEqual(storeRows(dataDir).map((row) => row.name).sort(), ['dsh', 'other', 'safe'])
})

test('场景31 晚信任: Given 信任面后补入口域 Then 既有子域名隧道立即停止劫持入口', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('target') })
  cleanup.push(() => target.stop())
  const connection = { trustedHosts: [] }
  const { host, plugin } = await scenario({ plugin: { connection } })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await open(plugin, { name: 'dsh', targetPort: target.port, entry: 'subdomain' })).ok, true,
    '信任面未就绪时不得凭猜测拒绝')
  assert.equal((await request(host, '/', { host: 'dsh.example.com' })).body, 'target')
  // 宿主异步加载完成/用户新增信任域: 分流必须每次现读,不得沿用装载时快照
  connection.trustedHosts = ['dsh.example.com:3080']
  assert.equal((await request(host, '/', { host: 'dsh.example.com' })).body, 'host-fallback')
  assert.equal((await request(host, '/api/x', { host: 'dsh.example.com' })).body, 'host-api')
})

test('场景32 socket 代际: Given 新代已接入 upgrade Then 旧代 dispose 不得回收新代连接', async () => {
  const wsTarget = await startWsTarget([])
  cleanup.push(() => wsTarget.stop())
  const host = await startedHost()
  host.installFallback('host-fallback')
  cleanup.push(() => host.dispose())
  const first = await applyPlugin(host)
  await open(first, { name: 'old', targetPort: wsTarget.port, entry: 'subdomain' })

  const openSocket = (hostHeader) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('upgrade timeout')) }, 3000)
    const req = http.request({
      host: '127.0.0.1', port: host.port, path: '/ws', headers: { host: hostHeader, ...WS_HEADERS },
    })
    req.once('upgrade', (res, socket) => { clearTimeout(timer); resolve(socket) })
    req.once('response', (res) => { clearTimeout(timer); reject(new Error(`status ${res.statusCode}`)) })
    req.once('error', (error) => { clearTimeout(timer); reject(error) })
    req.end()
  })
  const probe = (socket) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 1000)
    socket.once('data', (chunk) => { clearTimeout(timer); resolve(chunk.toString()) })
    socket.write('probe-frame')
  })

  const oldSocket = await openSocket('old.example.com')
  // 模拟 HMR 新代: 只替换分发载体与它自己的 socket 集合(宿主不允许同路径重复注册)
  const nextDispatch = () => ({ record: { targetPort: wsTarget.port }, url: '/ws' })
  nextDispatch.sockets = new Set()
  host.dshTunnelDispatch = nextDispatch
  const newSocket = await openSocket('next.example.com')
  assert.equal(nextDispatch.sockets.size, 1, '新代连接须登记到新代集合')

  first.dispose()
  assert.equal(await probe(newSocket), 'probe-frame', '新代 upgrade 连接不得被旧代回收')
  assert.equal(nextDispatch.sockets.size, 1, '新代连接仍须登记在册')
  oldSocket.destroy()
  newSocket.destroy()
})

test('场景34 晚信任回收: Given 子域名 upgrade 已建立 Then 信任面补入口域后连接关闭且状态转 active:false+error', async () => {
  const wsTarget = await startWsTarget([])
  cleanup.push(() => wsTarget.stop())
  const connection = { trustedHosts: [] }
  const { host, plugin } = await scenario({ plugin: { connection } })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await open(plugin, { name: 'dsh', targetPort: wsTarget.port, entry: 'subdomain' })).ok, true)

  const socket = await openPersistentUpgrade(host, 'dsh.example.com')
  assert.equal(await probeSocket(socket, 'before-trust'), 'before-trust', '信任面变化前连接应可正常转发')
  const closed = new Promise((resolve) => socket.once('close', () => resolve(true)))

  connection.trustedHosts = ['dsh.example.com:3080']
  assert.equal((await request(host, '/', { host: 'dsh.example.com' })).body, 'host-fallback', '冲突后入口立即归宿主')
  const row = (await list(plugin)).tunnels.find((item) => item.name === 'dsh')
  assert.equal(row.active, false, '冲突后状态不得再报 active')
  assert.match(row.error, /入口域首标签冲突/)
  await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 2000))])
  assert.equal(socket.destroyed, true, '已建立的子域名 upgrade 连接必须被回收')
})

test('场景35 晚信任周期回收: Given 信任面变化但无新请求 Then 既有 upgrade 由周期核对关闭', async () => {
  const wsTarget = await startWsTarget([])
  cleanup.push(() => wsTarget.stop())
  const connection = { trustedHosts: [] }
  const { host, plugin } = await scenario({ plugin: { connection } })
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await open(plugin, { name: 'dsh', targetPort: wsTarget.port, entry: 'subdomain' })).ok, true)
  const socket = await openPersistentUpgrade(host, 'dsh.example.com')
  assert.equal(await probeSocket(socket, 'before-trust'), 'before-trust')
  const closed = new Promise((resolve) => socket.once('close', () => resolve(true)))

  connection.trustedHosts = ['dsh.example.com:3080']
  const closedInTime = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false), 2_500)),
  ])
  assert.equal(closedInTime, true, '无新请求时周期核对必须回收既有 upgrade')
  const row = (await list(plugin)).tunnels.find((item) => item.name === 'dsh')
  assert.equal(row.active, false)
  assert.match(row.error, /入口域首标签冲突/)
})

test('场景36 close 回收: Given 子域名 upgrade 已建立 When close Then 该隧道 socket 全部关闭', async () => {
  const wsTarget = await startWsTarget([])
  cleanup.push(() => wsTarget.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await open(plugin, { name: 'app', targetPort: wsTarget.port, entry: 'subdomain' })).ok, true)
  const socket = await openPersistentUpgrade(host, 'app.example.com')
  assert.equal(await probeSocket(socket, 'before-close'), 'before-close')
  const closed = new Promise((resolve) => socket.once('close', () => resolve(true)))

  const outcome = await close(plugin, 'app')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.removed, true)
  const closedInTime = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false), 1_500)),
  ])
  assert.equal(closedInTime, true, 'close 后既有 upgrade 必须关闭')
  assert.equal(socket.destroyed, true)
})

test('场景37 path close 回收: Given path upgrade 已建立 When close Then 该隧道 socket 全部关闭', async () => {
  const wsTarget = await startWsTarget([])
  cleanup.push(() => wsTarget.stop())
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.equal((await open(plugin, { name: 'app', targetPort: wsTarget.port, entry: 'path' })).ok, true)
  const socket = await openPersistentUpgrade(host, `127.0.0.1:${host.port}`, '/p/app/ws')
  assert.equal(await probeSocket(socket, 'before-path-close'), 'before-path-close')
  const closed = new Promise((resolve) => socket.once('close', () => resolve(true)))

  const outcome = await close(plugin, 'app')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.removed, true)
  const closedInTime = await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => resolve(false), 1_500)),
  ])
  assert.equal(closedInTime, true, 'path close 后既有 upgrade 必须关闭')
  assert.equal(socket.destroyed, true)
})

test('场景33 管理面写路由统一闸门: Given DELETE 无 JSON content-type Then 400 拒绝且不关闭隧道', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  await open(plugin, { name: 'app', targetPort: PORT_MAX - 1 })
  const blocked = await request(host, '/api/tunnel/tunnels/app', { method: 'DELETE' })
  assert.equal(blocked.status, 400)
  assert.match(JSON.parse(blocked.body).error, /application\/json/)
  assert.equal((await list(plugin)).tunnels.length, 1, '被闸门拒绝的 DELETE 不得触达业务面')
  const allowed = await request(host, '/api/tunnel/tunnels/app', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(allowed.status, 200)
  assert.equal(JSON.parse(allowed.body).removed, true)
})
