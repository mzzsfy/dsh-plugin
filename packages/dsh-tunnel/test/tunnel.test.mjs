// dsh-tunnel 行为测试: mock webServer(三 Map + fallback + 官方注册语义)与 mock ctx,
// 转发/升级用真实 http/net 端到端; 持久化落在临时目录。
// 规格源 docs/调研-路径穿透插件.md「方案设计 (v1 路径模式)」节。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

const DEFAULT_CONNECT_TIMEOUT = 10 * 1000
const PORT_MAX = 65535

class MockWebServer {
  exact = new Map()
  prefixes = new Map()
  upgrades = new Map()
  fallback = undefined

  host = '127.0.0.1'
  port = 3080

  register(route) {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    table.set(route.path, route)
    return () => table.delete(route.path)
  }

  registerUpgrade(route) {
    if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    this.upgrades.set(route.path, route)
    return () => this.upgrades.delete(route.path)
  }

  registerFallback(handler) {
    if (this.fallback !== undefined) throw new Error('webserver: fallback already registered')
    this.fallback = handler
    return () => { this.fallback = undefined }
  }
}

function createCtx(webServer, tools = undefined) {
  const toolsService = tools ?? { registered: [], register(tool) { this.registered.push(tool); return () => {} } }
  const ctx = {
    webServer,
    get: () => undefined,
    on: () => () => {},
    inject(names, cb) {
      cb({ tools: toolsService, effect: (fn) => fn() })
    },
  }
  return { ctx, toolsService }
}

// 缺省 dataDir 逐场景独立, 统一登记, 进程退出一次清理(避免跨场景污染与目录泄漏)
const tempDataDirs = new Set()
const defaultDataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-test-'))
  tempDataDirs.add(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tempDataDirs) rmSync(dir, { recursive: true, force: true })
})

async function applyPlugin(webServer, options = {}) {
  const { apply } = await import('../src/index.js')
  const { ctx, toolsService } = createCtx(webServer)
  const dataDir = options.dataDir ?? defaultDataDir()
  const config = { connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT, dataDir }
  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let dispose
  try {
    dispose = apply(ctx, config)
  } finally {
    console.warn = origWarn
  }
  const tools = Object.fromEntries(toolsService.registered.map((tool) => [tool.name, tool]))
  return { webServer, tools, dataDir, warnings, dispose, ctx }
}

function toolOf(plugin, name) {
  const tool = plugin.tools[name]
  assert.ok(tool, `工具未注册: ${name}`)
  return tool
}

async function open(plugin, args) {
  return toolOf(plugin, 'tunnel_open').execute(args)
}

async function list(plugin) {
  return toolOf(plugin, 'tunnel_list').execute({})
}

async function close(plugin, name) {
  return toolOf(plugin, 'tunnel_close').execute({ name })
}

// 真实端到端: 外层服务器把请求交给本插件的路由 handler, 模拟官方 webServer 分发;
// 用 http.request 而非 fetch(可控 Host 头, 不自动跟随重定向)
async function requestVia(webServer, path, options = {}) {
  const prefixRoute = [...webServer.prefixes.values()].find((route) => path === route.path || path.startsWith(route.path + '/'))
  const outer = http.createServer((req, res) => {
    if (prefixRoute) return prefixRoute.handler(req, res)
    res.writeHead(404)
    res.end()
  })
  await once(outer.listen(0), 'listening')
  try {
    const port = outer.address().port
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, resolve)
      req.on('error', reject)
      req.end()
    })
    const chunks = []
    for await (const chunk of res) chunks.push(chunk)
    return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }
  } finally {
    outer.closeAllConnections()
    await once(outer.close(), 'close')
  }
}

function startTarget(handler) {
  const server = http.createServer(handler)
  return { server, ready: once(server.listen(0), 'listening'), get port() { return server.address().port } }
}

async function stopTarget(target) {
  const server = target.server ?? target
  server.closeAllConnections()
  await once(server.close(), 'close')
}

// 官方分发全镜像: exact → 最长前缀 → fallback; upgrade 仅 exact。子域名场景用
// (Host 可控, 全路由面参与分发)
async function dispatchVia(webServer, { host, path, headers = {}, upgrade = false }) {
  const outer = http.createServer((req, res) => {
    const exact = webServer.exact.get(req.url.split('?')[0])
    if (exact) return exact.handler(req, res)
    let best
    for (const route of webServer.prefixes.values()) {
      if ((req.url === route.path || req.url.startsWith(route.path + '/')) && (!best || route.path.length > best.path.length)) best = route
    }
    if (best) return best.handler(req, res)
    if (typeof webServer.fallback === 'function') return webServer.fallback(req, res)
    res.writeHead(404)
    res.end()
  })
  outer.on('upgrade', (req, socket, head) => {
    const route = webServer.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (route) return route.handler(req, socket, head)
    socket.destroy()
  })
  await once(outer.listen(0), 'listening')
  try {
    const port = outer.address().port
    if (upgrade) {
      const request = http.request({
        host: '127.0.0.1',
        port,
        path,
        headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers },
      })
      request.end()
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: 'upgrade 超时' }), 2000)
        request.once('upgrade', (res, socket) => {
          socket.write('probe-frame')
          socket.once('data', (chunk) => {
            clearTimeout(timer)
            socket.destroy()
            resolve({ ok: res.statusCode === 101 && chunk.toString() === 'probe-frame', status: res.statusCode })
          })
        })
        request.once('error', (error) => {
          clearTimeout(timer)
          resolve({ ok: false, error: error.message })
        })
      })
      return result
    }
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, headers: { host, ...headers } }, resolve)
      req.on('error', reject)
      req.end()
    })
    const chunks = []
    for await (const chunk of res) chunks.push(chunk)
    return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }
  } finally {
    outer.closeAllConnections()
    await once(outer.close(), 'close')
  }
}

// 隧道表行数; 文件不存在/损坏按 0
function storeCount(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'tunnels.json'), 'utf8')).length
  } catch {
    return 0
  }
}

test('场景1 工具注册: Given apply Then 注册 tunnel_open/list/close 三件', async () => {
  const plugin = await applyPlugin(new MockWebServer())
  assert.deepEqual(Object.keys(plugin.tools).sort(), ['tunnel_close', 'tunnel_list', 'tunnel_open'])
})

test('场景2 open: Given 合法参数与 wsPaths Then prefix 路由与两形态 upgrade 注册并持久化', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  const outcome = await open(plugin, { name: 'app', targetPort: PORT_MAX - 1, wsPaths: ['/'] })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.path, '/p/app')
  assert.deepEqual(plugin.webServer.prefixes.get('/p/app').path, '/p/app')
  assert.ok(plugin.webServer.upgrades.has('/p/app'))
  assert.ok(plugin.webServer.upgrades.has('/p/app/'))
  const persisted = JSON.parse(readFileSync(join(plugin.dataDir, 'tunnels.json'), 'utf8'))
  assert.deepEqual(persisted.map((row) => row.name), ['app'])
})

test('场景3 校验: Given 非法名或越界端口 Then 拒收且不注册不落盘', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  for (const args of [{ name: 'App', targetPort: 80 }, { name: 'a.b', targetPort: 80 }, { name: 'ok', targetPort: 0 }, { name: 'ok', targetPort: PORT_MAX + 1 }]) {
    const outcome = await open(plugin, args)
    assert.equal(outcome.ok, false, JSON.stringify(args))
    assert.equal(typeof outcome.error, 'string')
  }
  assert.equal(plugin.webServer.prefixes.size, 0)
  assert.equal(storeCount(plugin.dataDir), 0)
})

test('场景4 wsPaths: Given 白名单外项或非 / 开头项 Then 整体拒收; Given 重复尾斜杠项 Then 归一去重', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  for (const wsPaths of [['foo'], ['/x?'], ['/a', '/b ']]) {
    const outcome = await open(plugin, { name: 'app', targetPort: 80, wsPaths })
    assert.equal(outcome.ok, false, JSON.stringify(wsPaths))
    assert.equal(plugin.webServer.prefixes.size, 0)
  }
  // 数组项类型违规由工具框架参数校验先行拦截
  await assert.rejects(open(plugin, { name: 'app', targetPort: 80, wsPaths: [5] }), /wsPaths/)
  assert.equal(plugin.webServer.prefixes.size, 0)
  const outcome = await open(plugin, { name: 'app', targetPort: 80, wsPaths: ['/x/', '/x', '/y'] })
  assert.equal(outcome.ok, true)
  assert.deepEqual([...plugin.webServer.upgrades.keys()].sort(), ['/p/app/x', '/p/app/x/', '/p/app/y', '/p/app/y/'])
})

test('场景5 转发: Given 目标服务 When GET /p/app/a?b=c Then strip 转发且保留 Host 附 x-forwarded 三件套', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  const seen = []
  const target = startTarget((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, fwdHost: req.headers['x-forwarded-host'], fwdFor: Boolean(req.headers['x-forwarded-for']), fwdProto: req.headers['x-forwarded-proto'] })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('target-body')
  })
  await target.ready
  try {
    await open(plugin, { name: 'app', targetPort: target.port })
    const response = await requestVia(plugin.webServer, '/p/app/a?b=c', { headers: { host: 'entry.example:3080', 'x-custom': '1' } })
    assert.equal(response.status, 200)
    assert.equal(response.body, 'target-body')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, '/a?b=c')
    assert.equal(seen[0].host, 'entry.example:3080')
    assert.equal(seen[0].fwdHost, 'entry.example:3080')
    assert.ok(seen[0].fwdFor)
    assert.equal(seen[0].fwdProto, 'http')
  } finally {
    await stopTarget(target)
  }
})

test('场景6 拒连: Given 无监听端口 Then 502 JSON 且 ok 为 false', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  await open(plugin, { name: 'app', targetPort: 1 })
  const response = await requestVia(plugin.webServer, '/p/app/x')
  assert.equal(response.status, 502)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, false)
  assert.equal(typeof body.error, 'string')
})

test('场景7 响应头等待超时: Given 目标只接受不响应与短超时 Then 快速 504 不悬挂', async (t) => {
  const plugin = await applyPlugin(new MockWebServer(), { connectTimeoutMs: 100 })
  const sink = net.createServer(() => {})
  await once(sink.listen(0), 'listening')
  try {
    await open(plugin, { name: 'app', targetPort: sink.address().port })
    const started = Date.now()
    const response = await requestVia(plugin.webServer, '/p/app/x')
    assert.equal(response.status, 504)
    assert.ok(Date.now() - started < 5 * 1000, '应在注入超时内返回')
  } finally {
    sink.close()
  }
})

test('场景8 Location 改写: Given 3xx 同源根绝对路径 Then 补前缀; 协议相对与跨源与已带前缀则不动', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  const target = startTarget((req, res) => {
    res.writeHead(302, { location: req.headers['x-case'] })
    res.end()
  })
  await target.ready
  try {
    await open(plugin, { name: 'app', targetPort: target.port })
    const cases = [
      ['/login', '/p/app/login'],
      ['//evil.example/x', '//evil.example/x'],
      ['http://other.example/y', 'http://other.example/y'],
      ['/p/app/x', '/p/app/x'],
    ]
    for (const [location, expected] of cases) {
      const response = await requestVia(plugin.webServer, '/p/app/a', { headers: { 'x-case': location } })
      assert.equal(response.headers.location, expected, location)
    }
  } finally {
    await stopTarget(target)
  }
})

test('场景9 close: Given 已开隧道 Then 路由摘除条目删除且幂等', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  await open(plugin, { name: 'app', targetPort: 80 })
  const outcome = await close(plugin, 'app')
  assert.deepEqual(outcome, { ok: true, removed: true })
  assert.equal(plugin.webServer.prefixes.size, 0)
  assert.equal(plugin.webServer.upgrades.size, 0)
  assert.equal(storeCount(plugin.dataDir), 0)
  const again = await close(plugin, 'app')
  assert.deepEqual(again, { ok: true, removed: false })
})

test('场景10 重启恢复: Given 已持久化隧道与新 apply Then 路由重注册且 list 可见', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-test-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const first = await applyPlugin(new MockWebServer(), { dataDir })
  await open(first, { name: 'app', targetPort: 80, wsPaths: ['/ws'] })

  const second = await applyPlugin(new MockWebServer(), { dataDir })
  assert.ok(second.webServer.prefixes.has('/p/app'))
  assert.ok(second.webServer.upgrades.has('/p/app/ws'), 'wsPaths 的 upgrade 路由应随恢复重注册')
  const outcome = await list(second)
  assert.deepEqual(outcome.tunnels.map((row) => row.name), ['app'])
})

test('场景11 损坏文件: Given 非法 JSON Then 按空表处理告警且激活不抛', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-test-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  writeFileSync(join(dataDir, 'tunnels.json'), 'not-json')
  const plugin = await applyPlugin(new MockWebServer(), { dataDir })
  assert.equal(plugin.webServer.prefixes.size, 0)
  assert.ok(plugin.warnings.some((line) => line.includes('dsh-tunnel')))
  const outcome = await list(plugin)
  assert.deepEqual(outcome.tunnels, [])
})

test('场景12 激活冲突回滚: Given 持久化隧道与已占用前缀 Then 冲突隧道回滚其余照常且激活不失败', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-test-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'app', targetPort: 80, wsPaths: [], createdAt: 't' },
    { name: 'good', targetPort: 80, wsPaths: [], createdAt: 't' },
  ]))
  const webServer = new MockWebServer()
  webServer.register({ kind: 'prefix', path: '/p/app', handler: () => {} })
  const plugin = await applyPlugin(webServer, { dataDir })
  assert.ok(webServer.prefixes.has('/p/app'), '预注册路由保持原样')
  assert.ok(webServer.prefixes.has('/p/good'), '无冲突隧道照常注册')
  assert.ok(plugin.warnings.some((line) => line.includes('app')))
  // 冲突隧道已回滚不入活动表; 持久化条目仍在(由场景10/16覆盖恢复与保留语义)
  const outcome = await list(plugin)
  assert.deepEqual(outcome.tunnels.map((row) => row.name), ['good'])
})

test('场景13 upgrade 转发: Given 声明 wsPaths 的隧道 Then 两形态注册且握手字节双向透传', { timeout: 10 * 1000 }, async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  const target = http.createServer(() => {})
  target.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
    socket.pipe(socket)
  })
  await once(target.listen(0), 'listening')
  try {
    await open(plugin, { name: 'app', targetPort: target.address().port, wsPaths: ['/ws'] })
    assert.ok(plugin.webServer.upgrades.has('/p/app/ws'), '无尾斜杠形态应注册')
    assert.ok(plugin.webServer.upgrades.has('/p/app/ws/'), '带尾斜杠形态应注册')

    // 外层 http server 的 upgrade 分发与官方 webServer 同构: exact 匹配则交本插件 handler
    const outer = http.createServer(() => {})
    outer.on('upgrade', (req, socket, head) => {
      const route = plugin.webServer.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
      if (route) return route.handler(req, socket, head)
      socket.destroy()
    })
    await once(outer.listen(0), 'listening')
    try {
      const request = http.request({
        host: '127.0.0.1',
        port: outer.address().port,
        path: '/p/app/ws',
        headers: { host: 'entry.example', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
      })
      request.end()
      const res = await once(request, 'upgrade')
      const [proxyRes, proxySocket] = res
      assert.equal(proxyRes.statusCode, 101, '应透传目标 101 握手')
      proxySocket.write('frame-1')
      const echoed = await once(proxySocket, 'data')
      assert.equal(echoed[0].toString(), 'frame-1', '应回环透传帧')
      proxySocket.destroy()
    } finally {
      outer.closeAllConnections()
      await once(outer.close(), 'close')
    }
  } finally {
    target.closeAllConnections()
    await once(target.close(), 'close')
  }
})

test('场景14 缺省 wsPaths: Given 纯 HTTP 隧道 Then 不注册任何 upgrade', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  await open(plugin, { name: 'app', targetPort: 80 })
  assert.equal(plugin.webServer.upgrades.size, 0)
})

test('场景15 patch 形态: Given bundle patch Then insert 行指向本包', async (t) => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname } = await import('node:path')
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const patchText = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patchText, /- insert:\n    - id: dsh-tunnel\n      name: '@mzzsfy\/dsh-tunnel'/)
})

test('场景17 SSE 断开回收: Given 目标持续推流 When 客户端断开 Then 上游连接被回收', { timeout: 10 * 1000 }, async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  let targetSockets = new Set()
  const target = startTarget((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: hello\n\n')
    res.socket.on('close', () => targetSockets.delete(res.socket))
  })
  target.server.on('connection', (socket) => targetSockets.add(socket))
  await target.ready
  try {
    await open(plugin, { name: 'app', targetPort: target.port })
    // 通过外层服务器拿真实 res, 手动断开模拟客户端离开
    const prefixRoute = plugin.webServer.prefixes.get('/p/app')
    const outer = http.createServer((req, res) => prefixRoute.handler(req, res))
    await once(outer.listen(0), 'listening')
    const clientReq = http.request({ host: '127.0.0.1', port: outer.address().port, path: '/p/app/stream' }, (res) => {
      res.once('data', () => clientReq.destroy())
    })
    clientReq.end()
    await once(clientReq, 'close')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(targetSockets.size, 0, '客户端断开后上游连接应被回收')
    outer.closeAllConnections()
    await once(outer.close(), 'close')
  } finally {
    await stopTarget(target)
  }
})

test('场景18 WS 空闲存活: Given 握手完成后的长静默 When 超过连接超时 Then 连接不断开', { timeout: 10 * 1000 }, async (t) => {
  const plugin = await applyPlugin(new MockWebServer(), { connectTimeoutMs: 100 })
  const target = startTarget(() => {})
  target.server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
    socket.pipe(socket)
  })
  await target.ready
  const outer = http.createServer(() => {})
  outer.on('upgrade', (req, socket, head) => {
    const route = plugin.webServer.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (route) return route.handler(req, socket, head)
    socket.destroy()
  })
  await once(outer.listen(0), 'listening')
  try {
    await open(plugin, { name: 'app', targetPort: target.port, wsPaths: ['/'] })
    const request = http.request({
      host: '127.0.0.1', port: outer.address().port, path: '/p/app',
      headers: { host: 'entry.example', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
    })
    request.end()
    const [res, socket] = await once(request, 'upgrade')
    assert.equal(res.statusCode, 101)
    // 先经历超过注入超时(100ms)的静默, 再验证连接存活——否则测试对空闲误杀无证明力
    await new Promise((resolve) => setTimeout(resolve, 200))
    socket.write('still-alive')
    const echoed = await once(socket, 'data')
    assert.equal(echoed[0].toString(), 'still-alive', '静默超过注入超时后连接应仍存活')
    socket.destroy()
  } finally {
    outer.closeAllConnections()
    await once(outer.close(), 'close')
    await stopTarget(target)
  }
})

test('场景19 同名拒收与 open 期回滚: Given 已占用名或注册冲突 Then 拒收且不留半注册路由', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  await open(plugin, { name: 'app', targetPort: 80 })
  const again = await open(plugin, { name: 'app', targetPort: 81 })
  assert.equal(again.ok, false)
  assert.match(again.error, /已占用/)
  assert.equal(plugin.webServer.prefixes.get('/p/app')?.route, undefined)
  assert.ok(plugin.webServer.prefixes.has('/p/app'))

  // open 期事务回滚: 预占一个 upgrade 路径, open 携同路径应整体失败且 prefix 不残留
  plugin.webServer.registerUpgrade({ path: '/p/dup/ws', handler: () => {} })
  const conflict = await open(plugin, { name: 'dup', targetPort: 80, wsPaths: ['/ws'] })
  assert.equal(conflict.ok, false)
  assert.ok(plugin.webServer.prefixes.has('/p/app'))
  assert.ok(!plugin.webServer.prefixes.has('/p/dup'), '失败隧道的 prefix 不应残留')
})

test('场景20 x-forwarded 剥离与无 Host 请求: Given 入站伪造 forwarded 头或缺 Host Then 剥离伪造且不抛错', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  const seen = []
  const target = startTarget((req, res) => {
    seen.push({ fwdHost: req.headers['x-forwarded-host'], fwdFor: req.headers['x-forwarded-for'] })
    res.writeHead(200)
    res.end('ok')
  })
  await target.ready
  try {
    await open(plugin, { name: 'app', targetPort: target.port })
    await requestVia(plugin.webServer, '/p/app/a', { headers: { 'x-forwarded-host': 'evil', 'x-forwarded-for': '1.2.3.4' } })
    assert.notEqual(seen[0].fwdHost, 'evil', '入站伪造头应被剥离重写')
    assert.match(seen[0].fwdHost, /^127\.0\.0\.1/, '重写为真实入口 Host')
    assert.notEqual(seen[0].fwdFor, '1.2.3.4')

    // 无 Host 头(HTTP/1.0 形态)不抛错, 转发照常
    const prefixRoute = plugin.webServer.prefixes.get('/p/app')
    const outer = http.createServer((req, res) => prefixRoute.handler(req, res))
    await once(outer.listen(0), 'listening')
    const client = net.connect(outer.address().port, '127.0.0.1')
    await once(client, 'connect')
    client.write('GET /p/app/b HTTP/1.0\r\n\r\n')
    const raw = await once(client, 'data')
    assert.ok(raw[0].toString().startsWith('HTTP/1.1 200'), '无 Host 请求应照常转发')
    client.destroy()
    outer.closeAllConnections()
    await once(outer.close(), 'close')
  } finally {
    await stopTarget(target)
  }
})

test('场景16 dispose: Given 已开隧道 Then dispose 摘除全部路由且持久化文件保留', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-test-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const plugin = await applyPlugin(new MockWebServer(), { dataDir })
  await open(plugin, { name: 'app', targetPort: 80 })
  plugin.dispose()
  assert.equal(plugin.webServer.prefixes.size, 0)
  assert.equal(storeCount(plugin.dataDir), 1)
})

test('场景21 包装安装: Given apply Then 现存路由加标记且非隧道 Host 穿透原 handler', async (t) => {
  const webServer = new MockWebServer()
  webServer.register({ kind: 'exact', path: '/api/x', handler: (req, res) => { res.writeHead(200); res.end('exact') } })
  webServer.registerFallback((req, res) => { res.writeHead(200); res.end('fb') })
  const plugin = await applyPlugin(webServer)
  assert.ok(webServer.exact.get('/api/x').handler.dshTunnelWrapped, '现存 exact 应被包装')
  assert.ok(webServer.fallback.dshTunnelWrapped, '现存 fallback 应被包装')
  webServer.register({ kind: 'exact', path: '/api/new', handler: () => {} })
  assert.ok(webServer.exact.get('/api/new').handler.dshTunnelWrapped, 'shadow 后新注册应被包装')

  const viaExact = await dispatchVia(webServer, { host: 'gui.example.com', path: '/api/x' })
  assert.equal(viaExact.body, 'exact', '非隧道 Host 走原 exact')
  const viaFallback = await dispatchVia(webServer, { host: 'gui.example.com', path: '/other' })
  assert.equal(viaFallback.body, 'fb', '非隧道 Host 走原 fallback')
})

test('场景22 子域名 HTTP: Given entry=subdomain Then 无路由注册且任意路径无 strip 透传', async (t) => {
  const webServer = new MockWebServer()
  webServer.registerFallback((req, res) => { res.writeHead(200); res.end('fb') })
  const plugin = await applyPlugin(webServer)
  const seen = []
  const target = startTarget((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, fwdHost: req.headers['x-forwarded-host'] })
    res.writeHead(200)
    res.end('target:' + req.url)
  })
  await target.ready
  try {
    const outcome = await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.entry, 'subdomain')
    assert.equal(outcome.host, 'app.localhost')
    assert.equal(plugin.webServer.prefixes.size, 0, '子域名不注册 prefix 路由')
    assert.equal(plugin.webServer.upgrades.size, 0, '子域名不注册 upgrade 路由')

    const deep = await dispatchVia(plugin.webServer, { host: 'app.localhost:3080', path: '/deep/path?q=1' })
    assert.equal(deep.body, 'target:/deep/path?q=1', '全路径透传不 strip(miss 经 fallback 座包装进入分发)')
    assert.equal(seen[0].host, 'app.localhost:3080', '原 Host 头保留')
    assert.equal(seen[0].fwdHost, 'app.localhost:3080', 'x-forwarded-host 为入口 Host')

    const listed = await list(plugin)
    assert.deepEqual(listed.tunnels, [{ name: 'app', entry: 'subdomain', access: 'app.*', targetPort: target.port, wsPaths: [] }])
  } finally {
    await stopTarget(target)
  }
})

test('场景23 子域名 WS: Given 动态随机路径 upgrade Then 无需 wsPaths 即 101 透传', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  const target = startTarget(() => {})
  target.server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
    socket.pipe(socket)
  })
  await target.ready
  try {
    await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })
    const result = await dispatchVia(plugin.webServer, {
      host: 'app.localhost',
      path: '/api/kernels/9f8e7d6c-1234-4321-abcd-001122334455/channels',
      upgrade: true,
    })
    assert.ok(result.ok, `动态内核 WS 路径应全透传: ${result.error ?? ''}`)
    assert.equal(result.status, 101)
    // 表替换后宿主 miss 语义保持: 非隧道 Host 的无路由 upgrade 仍销毁
    const miss = await dispatchVia(plugin.webServer, { host: 'other.localhost', path: '/random/ws', upgrade: true })
    assert.equal(miss.ok, false, '非隧道 Host 无路由 upgrade 应被销毁')
  } finally {
    await stopTarget(target)
  }
})

test('场景24 隔离优先级: Given 隧道域名命中 Then /api 等宿主路由全进隧道', async (t) => {
  const webServer = new MockWebServer()
  webServer.register({ kind: 'exact', path: '/api/gw', handler: (req, res) => { res.writeHead(200); res.end('dsh-gw') } })
  const plugin = await applyPlugin(webServer)
  const target = startTarget((req, res) => { res.writeHead(200); res.end('target-gw') })
  await target.ready
  try {
    await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })
    const tunneled = await dispatchVia(webServer, { host: 'app.localhost', path: '/api/gw' })
    assert.equal(tunneled.body, 'target-gw', '隧道域名上宿主 exact 被绕过')
    const normal = await dispatchVia(webServer, { host: 'gui.example.com', path: '/api/gw' })
    assert.equal(normal.body, 'dsh-gw', '非隧道域名宿主路由不受影响')
  } finally {
    await stopTarget(target)
  }
})

test('场景25 关闭恢复: Given close 子域名隧道 Then Host 回落原路由且持久化行删除', async (t) => {
  const webServer = new MockWebServer()
  webServer.registerFallback((req, res) => { res.writeHead(200); res.end('fb') })
  const plugin = await applyPlugin(webServer)
  const target = startTarget((req, res) => { res.writeHead(200); res.end('t') })
  await target.ready
  try {
    await open(plugin, { name: 'app', targetPort: target.port, entry: 'subdomain' })
    assert.equal(storeCount(plugin.dataDir), 1)
    const closed = await close(plugin, 'app')
    assert.deepEqual(closed, { ok: true, removed: true })
    const after = await dispatchVia(webServer, { host: 'app.localhost', path: '/x' })
    assert.equal(after.body, 'fb', '关闭后子域名应回落 fallback')
    assert.equal(storeCount(plugin.dataDir), 0)
  } finally {
    await stopTarget(target)
  }
})

test('场景26 恢复: Given 混合 entry 持久化 Then 子域名进分发且路径模式照常注册路由', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-test-'))
  const firstServer = new MockWebServer()
  const plugin = await applyPlugin(firstServer, { dataDir })
  await open(plugin, { name: 'sub1', targetPort: 81, entry: 'subdomain' })
  await open(plugin, { name: 'pat1', targetPort: 82 })
  plugin.dispose()
  const secondServer = new MockWebServer()
  secondServer.registerFallback((req, res) => { res.writeHead(200); res.end('fb') })
  const second = await applyPlugin(secondServer, { dataDir })
  const hit = await dispatchVia(secondServer, { host: 'sub1.localhost', path: '/any' })
  assert.equal(hit.status, 502, '子域名恢复后命中分发(目标未启动按 502 错误路径)')
  assert.ok(secondServer.prefixes.has('/p/pat1'), '路径模式照常注册路由')
  const listed = await list(second)
  assert.deepEqual(listed.tunnels.map((row) => [row.name, row.entry]).sort(), [['pat1', 'path'], ['sub1', 'subdomain']])
  rmSync(dataDir, { recursive: true, force: true })
})

test('场景27 entry 校验: Given 非法或缺省 entry 与 subdomain 带 wsPaths Then 各按语义处理', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  const bad = await open(plugin, { name: 'app', targetPort: 80, entry: 'host' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /entry/)
  assert.equal(plugin.webServer.prefixes.size, 0)
  const byDefault = await open(plugin, { name: 'app', targetPort: 80 })
  assert.equal(byDefault.entry, 'path')
  assert.ok(plugin.webServer.prefixes.has('/p/app'))
  await close(plugin, 'app')
  const sub = await open(plugin, { name: 'web', targetPort: 80, entry: 'subdomain', wsPaths: ['/_x'] })
  assert.equal(sub.ok, true)
  const rows = JSON.parse(readFileSync(join(plugin.dataDir, 'tunnels.json'), 'utf8'))
  assert.deepEqual(rows.find((row) => row.name === 'web'), { name: 'web', targetPort: 80, entry: 'subdomain', wsPaths: [], createdAt: rows.find((row) => row.name === 'web').createdAt })
})

test('场景28 名字跨模式唯一: Given path 模式占用 Then subdomain 同名拒收', async (t) => {
  const plugin = await applyPlugin(new MockWebServer())
  await open(plugin, { name: 'app', targetPort: 80 })
  const clash = await open(plugin, { name: 'app', targetPort: 81, entry: 'subdomain' })
  assert.equal(clash.ok, false)
  assert.match(clash.error, /已占用/)
})

test('场景29 代际安全: Given dispose 后重挂载 Then 分发载体被新代接管且旧包装不叠加', async (t) => {
  const webServer = new MockWebServer()
  webServer.registerFallback((req, res) => { res.writeHead(200); res.end('fb') })
  const first = await applyPlugin(webServer)
  const target = startTarget((req, res) => { res.writeHead(200); res.end('t') })
  await target.ready
  try {
    await open(first, { name: 'app', targetPort: target.port, entry: 'subdomain' })
    first.dispose()
    const disposed = await dispatchVia(webServer, { host: 'app.localhost', path: '/x' })
    assert.equal(disposed.body, 'fb', 'dispose 后载体穿透')

    // 捕获点在二代 apply 之前: 引用相同才能证明标记防叠加生效
    const fbBefore = webServer.fallback
    const second = await applyPlugin(webServer)
    await open(second, { name: 'app', targetPort: target.port, entry: 'subdomain' })
    const revived = await dispatchVia(webServer, { host: 'app.localhost', path: '/x' })
    assert.equal(revived.body, 't', '重挂载后新代分发接管')
    assert.ok(webServer.fallback === fbBefore, '标记防叠加: 第二次 apply 不再包装同一 handler')
  } finally {
    await stopTarget(target)
  }
})

test('场景31 恢复容错: Given 非法 entry 或重复名行 Then 告警并仅恢复首行', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-test-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'dup', targetPort: 80, entry: 'path', wsPaths: [], createdAt: 't1' },
    { name: 'dup', targetPort: 81, entry: 'subdomain', wsPaths: [], createdAt: 't2' },
    { name: 'bad', targetPort: 80, entry: 'host', wsPaths: [], createdAt: 't3' },
  ]), 'utf8')
  const plugin = await applyPlugin(new MockWebServer(), { dataDir })
  assert.ok(plugin.webServer.prefixes.has('/p/dup'), '重复名仅恢复首行')
  const listed = await list(plugin)
  assert.deepEqual(listed.tunnels.map((row) => row.name), ['dup'])
  assert.match(plugin.warnings.join(''), /重复名/)
  assert.match(plugin.warnings.join(''), /entry 非法/)
})

test('场景32 超时载体换代: Given 二代更短超时 Then 一代包装器按新值判 504', { timeout: 10 * 1000 }, async (t) => {
  const webServer = new MockWebServer()
  webServer.registerFallback((req, res) => { res.writeHead(200); res.end('fb') })
  // 不响应的 sink: 连接接受但永不应答, 触发响应头等待超时
  const sink = net.createServer(() => {})
  const sinkConnections = new Set()
  sink.on('connection', (conn) => {
    sinkConnections.add(conn)
    conn.on('close', () => sinkConnections.delete(conn))
  })
  await once(sink.listen(0), 'listening')
  try {
    const first = await applyPlugin(webServer)
    await open(first, { name: 'app', targetPort: sink.address().port, entry: 'subdomain' })
    first.dispose()
    const second = await applyPlugin(webServer, { connectTimeoutMs: 100 })
    await open(second, { name: 'app', targetPort: sink.address().port, entry: 'subdomain' })
    const started = Date.now()
    const res = await dispatchVia(webServer, { host: 'app.localhost', path: '/x' })
    const elapsed = Date.now() - started
    assert.equal(res.status, 504)
    assert.ok(elapsed < 2000, `应按二代 100ms 超时判 504(实际 ${elapsed}ms)`)
  } finally {
    for (const conn of sinkConnections) conn.destroy()
    sink.close()
  }
})

test('场景30 形状守卫: Given webServer 缺少分发面 Then 干净停用且不注册工具', async (t) => {
  const plugin = await applyPlugin({ port: 3080 })
  assert.deepEqual(plugin.tools, {})
  assert.equal(typeof plugin.dispose, 'function')
  assert.match(plugin.warnings.join(''), /形状不匹配/)
})
