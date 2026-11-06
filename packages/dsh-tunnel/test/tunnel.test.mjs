// dsh-tunnel 行为测试: 宿主面一律走 support/fake-host.mjs 的真实 http.Server 替身,
// 逐条复刻 @deepseek-ai/dsh-host-webserver 0.2.x 的分发语义(exact → 最长前缀 → fallback;
// upgrade 仅 exact 且 miss 即销毁; resource 形态 fallback 只受理 GET/HEAD)。
// 规格源: docs/设计-隧道改造.md(§2 分发模型 / §3 缺陷修复 / §4 BDD)。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { writeFileSync } from 'node:fs'
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

/** 裸升级目标: 记录收到的请求行后回 101 并回环; net.Server 无 closeAllConnections, 自持 socket。 */
async function startWsTarget(received) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.once('data', (chunk) => {
      received.push(chunk.toString().split('\r\n')[0])
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

test('场景1 工具注册: Given apply Then 注册 tunnel_open/list/close 三件', async () => {
  const { host, plugin } = await scenario()
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  assert.deepEqual(Object.keys(plugin.tools).sort(), ['tunnel_close', 'tunnel_list', 'tunnel_open'])
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
  const closed = await host.dispose()
  assert.equal(closed, 'closed', '拦截的 upgrade 连接必须登记进 upgradedSockets, 否则 server.close 挂死')
  plugin.dispose()
  assert.equal(held.destroyed, true)
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
