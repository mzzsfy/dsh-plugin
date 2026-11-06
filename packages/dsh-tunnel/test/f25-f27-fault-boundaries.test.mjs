// F25/F26/F27 回归守护(可失败行为测试):隧道故障边界三面。
// F25 = 上游响应中断必须联动终止下游(Content-Length 与 chunked 两形态),后续请求不受影响;
// F26 = 根 WS(wsPaths ['/'])归一为 '' 后必须能持久化往返,dispose/reapply 恢复两形态 upgrade;
// F27 = 目标指向宿主监听端口(自代理环)在 open 与激活恢复两面都必须拒绝且不建立代理连接。
// 与 tunnel.test.mjs 同构的 mock webServer + 真实 http 端到端,持久化落临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

const tempDataDirs = new Set()
const defaultDataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-f-'))
  tempDataDirs.add(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tempDataDirs) rmSync(dir, { recursive: true, force: true })
})

function createCtx(webServer) {
  const effectDisposers = []
  const runEffect = (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') effectDisposers.push(disposer)
    return disposer
  }
  const toolsService = {
    registered: [],
    register(tool) {
      this.registered.push(tool)
      return () => {}
    },
  }
  const ctx = {
    webServer,
    get: () => undefined,
    on: () => () => {},
    effect: runEffect,
    inject: (names, cb) => cb({ tools: toolsService, settings: undefined, effect: runEffect }),
  }
  return { ctx, effectDisposers, toolsService }
}

async function applyPlugin(webServer, options = {}) {
  const { apply } = await import('../src/index.js')
  const { ctx, effectDisposers, toolsService } = createCtx(webServer)
  const dataDir = options.dataDir ?? defaultDataDir()
  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let dispose
  try {
    dispose = apply(ctx, { connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT, dataDir })
  } finally {
    console.warn = origWarn
  }
  const tools = Object.fromEntries(toolsService.registered.map((tool) => [tool.name, tool]))
  const disposeAll = () => {
    dispose()
    for (const disposer of effectDisposers.reverse()) disposer()
  }
  return { webServer, tools, dataDir, warnings, dispose: disposeAll }
}

function toolOf(plugin, name) {
  const tool = plugin.tools[name]
  assert.ok(tool, `工具未注册: ${name}`)
  return tool
}
const open = (plugin, args) => toolOf(plugin, 'tunnel_open').execute(args)
const list = (plugin) => toolOf(plugin, 'tunnel_list').execute({})
const close = (plugin, name) => toolOf(plugin, 'tunnel_close').execute({ name })

const tunnelPrefixCount = (webServer) => [...webServer.prefixes.keys()].filter((path) => path.startsWith('/p/')).length

function storeRows(dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'tunnels.json'), 'utf8'))
  } catch {
    return []
  }
}

/** 外层分发服务器:镜像官方 webServer 的 prefix 分发,供真实 http 客户端打穿隧道。 */
async function startOuter(webServer) {
  const outer = http.createServer((req, res) => {
    let best
    for (const route of webServer.prefixes.values()) {
      const path = req.url.split('?')[0]
      if ((path === route.path || path.startsWith(route.path + '/')) && (!best || route.path.length > best.path.length)) best = route
    }
    if (best) return best.handler(req, res)
    res.writeHead(404)
    res.end()
  })
  await once(outer.listen(0), 'listening')
  return {
    port: outer.address().port,
    async stop() {
      outer.closeAllConnections()
      await once(outer.close(), 'close')
    },
  }
}

/** 打一发请求,返回「这发响应如何收尾」:end 完整 / aborted|error 中断 / hung 悬挂。 */
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
      res.on('error', (error) => done({ kind: 'error', status: res.statusCode, error: error.message, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', (error) => done({ kind: 'error', error: error.message }))
    const timer = setTimeout(() => done({ kind: 'hung' }), timeoutMs)
    timer.unref()
    req.end()
  })
}

test('F25 上游中断联动下游:Content-Length 与 chunked 两形态都有界中断,随后健康请求仍 200', { timeout: 20 * 1000 }, async () => {
  const plugin = await applyPlugin(new MockWebServer())
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
    // chunked:无 content-length
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('0123456789')
    setImmediate(() => res.socket.destroy())
  })
  await once(target.listen(0), 'listening')
  const outer = await startOuter(plugin.webServer)
  try {
    const opened = await open(plugin, { name: 'app', targetPort: target.address().port })
    assert.equal(opened.ok, true)

    const truncated = await requestOutcome(outer.port, '/p/app/cut-length')
    assert.notEqual(truncated.kind, 'end', `截断响应不得伪装成完整收尾: ${JSON.stringify(truncated)}`)
    assert.notEqual(truncated.kind, 'hung', `下游必须在有界时间内中断,实际悬挂: ${JSON.stringify(truncated)}`)
    assert.ok(truncated.elapsedMs < 2000, `中断须及时,实际 ${truncated.elapsedMs}ms`)

    const truncatedChunked = await requestOutcome(outer.port, '/p/app/cut-chunked')
    assert.notEqual(truncatedChunked.kind, 'end', `chunked 截断不得伪装成完整收尾: ${JSON.stringify(truncatedChunked)}`)
    assert.notEqual(truncatedChunked.kind, 'hung', `chunked 下游必须在有界时间内中断: ${JSON.stringify(truncatedChunked)}`)

    const healthy = await requestOutcome(outer.port, '/p/app/ok')
    assert.deepEqual([healthy.kind, healthy.status, healthy.body], ['end', 200, 'healthy'], '一次中断不得污染后续转发')
  } finally {
    await outer.stop()
    target.closeAllConnections()
    await once(target.close(), 'close')
  }
})

test('F26 根 WS 归一往返:wsPaths ["/"] 持久化为 "" 且 dispose/reapply 恢复两形态 upgrade', async () => {
  const webServer = new MockWebServer()
  const dataDir = defaultDataDir()
  const first = await applyPlugin(webServer, { dataDir })
  const opened = await open(first, { name: 'app', targetPort: PORT_MAX - 1, wsPaths: ['/'] })
  assert.equal(opened.ok, true)
  assert.ok(webServer.upgrades.has('/p/app'), '首代应注册根路径 upgrade')
  assert.ok(webServer.upgrades.has('/p/app/'), '首代应注册带尾斜杠根路径 upgrade')
  assert.deepEqual(storeRows(dataDir)[0].wsPaths, [''], '落盘形态即规范化形态(根 = 空串)')

  first.dispose()
  assert.equal(webServer.upgrades.has('/p/app'), false, 'dispose 应摘除路由')

  const second = await applyPlugin(webServer, { dataDir })
  const restored = (await list(second)).tunnels.find((row) => row.name === 'app')
  assert.equal(restored?.wsPaths.length, 1, '重启后隧道行必须恢复 WS 声明')
  assert.ok(webServer.upgrades.has('/p/app'), '重启后根 upgrade(无尾斜杠)必须恢复')
  assert.ok(webServer.upgrades.has('/p/app/'), '重启后根 upgrade(带尾斜杠)必须恢复')
})

test('F27 自代理环:open 与激活恢复两面都拒绝指向宿主监听端口的目标,且不建立任何代理连接', async () => {
  // 让「宿主监听端口」是一个真实可连端口:若实现放行,连接数会真的涨上去
  const hostHits = { connections: 0 }
  const hostServer = http.createServer((req, res) => {
    hostHits.connections += 1
    res.writeHead(200)
    res.end('host')
  })
  hostServer.on('connection', () => { hostHits.connections += 1 })
  await once(hostServer.listen(0), 'listening')
  const hostPort = hostServer.address().port

  const webServer = new MockWebServer()
  webServer.port = hostPort
  const dataDir = defaultDataDir()
  const plugin = await applyPlugin(webServer, { dataDir })
  try {
    const refused = await open(plugin, { name: 'loop', targetPort: hostPort })
    assert.equal(refused.ok, false, '指向宿主监听端口必须拒收')
    assert.match(refused.error, /自代理环/)
    assert.equal(tunnelPrefixCount(webServer), 0, '拒收不得留下路由')
    assert.equal(storeRows(dataDir).length, 0, '拒收不得落盘')

    // 恢复面:持久化行指向监听端口(另一台机器迁移/手改文件形态)
    writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
      { name: 'loop2', entry: 'path', targetPort: hostPort, wsPaths: [], createdAt: new Date().toISOString() },
    ]))
    const restarted = new MockWebServer()
    restarted.port = hostPort
    const second = await applyPlugin(restarted, { dataDir })
    assert.deepEqual((await list(second)).tunnels, [], '恢复面必须跳过自代理环')
    assert.equal(tunnelPrefixCount(restarted), 0, '恢复面不得注册自代理路由')
    assert.ok(second.warnings.some((line) => line.includes('自代理环')), '恢复面跳过须留可观测告警')
    assert.equal(hostHits.connections, 0, '被拒的自代理目标不得收到任何连接')
  } finally {
    hostServer.closeAllConnections()
    await once(hostServer.close(), 'close')
  }
})

test('F27-b 停止/清理:close 幂等摘除路由与持久行,重复 close 仍 ok', async () => {
  const webServer = new MockWebServer()
  const dataDir = defaultDataDir()
  const plugin = await applyPlugin(webServer, { dataDir })
  const opened = await open(plugin, { name: 'stopme', targetPort: PORT_MAX - 2, wsPaths: ['/ws'] })
  assert.equal(opened.ok, true)
  assert.equal(tunnelPrefixCount(webServer), 1)

  assert.deepEqual(await close(plugin, 'stopme'), { ok: true, removed: true })
  assert.equal(tunnelPrefixCount(webServer), 0, 'close 必须摘除 prefix 路由')
  assert.equal(webServer.upgrades.size, 0, 'close 必须摘除 upgrade 路由')
  assert.equal(storeRows(dataDir).length, 0, 'close 必须删除持久行')
  assert.deepEqual(await close(plugin, 'stopme'), { ok: true, removed: false }, 'close 幂等')
})
