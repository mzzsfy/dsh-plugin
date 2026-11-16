import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Agent, createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_VERSION, DEFAULT_CONFIG } from '../src/config.mjs'
import { DIAG_DIR_ENV, DIAG_FILE_NAME } from '../src/diag-file.mjs'
import { apply, Config, name } from '../src/index.js'

// 每个用例注入独立诊断目录: 不读写宿主真实 home, 也不落全局 tmp 共享文件
let diagDir
beforeEach(() => {
  diagDir = mkdtempSync(join(tmpdir(), 'dsh-bug-perf-test-'))
  process.env[DIAG_DIR_ENV] = diagDir
})
afterEach(() => {
  delete process.env[DIAG_DIR_ENV]
  rmSync(diagDir, { recursive: true, force: true })
})

function makeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  }
}

function makeCtx({ server, registerError, sessionController, settings, configEditor, fiberEntry } = {}) {
  const registrations = []
  const disposed = []
  const ctx = {
    fiber: { entry: fiberEntry },
    get: (service) => {
      if (service === 'webServer') return server
      if (service === 'sessionController') return sessionController
      if (service === 'settings') return settings
      if (service === 'configEditor') return configEditor
      return undefined
    },
    effect: (factory) => {
      const dispose = factory()
      ctx.effects.push(dispose)
      return dispose
    },
    inject: (services, callback) => {
      const scope = {
        get: ctx.get,
        get sessionController() { return sessionController },
        get settings() { return settings },
        on: () => {},
        effect: (factory) => {
          ctx.effects.push(factory())
        },
      }
      if (services.includes('sessionController') && sessionController !== undefined) callback(scope)
      if (services.includes('settings') && settings !== undefined) callback(scope)
    },
    effects: [],
    registrations,
    disposed,
  }
  if (server !== undefined) {
    server.register = (route) => {
      if (registerError !== undefined) throw registerError
      registrations.push(route)
      return () => disposed.push(route.path)
    }
  }
  return ctx
}

async function request(route, config) {
  const res = makeRes()
  await route.handler({ url: '/api/dsh-bug-perf/config', method: 'GET' }, res)
  return res
}

async function requestDiag(route, body = '', headers = { 'content-type': 'application/json' }) {
  const res = makeRes()
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  await route.handler({
    url: '/api/dsh-bug-perf/diag',
    method: 'POST',
    headers,
    on(event, callback) {
      if (event === 'data') callback(Buffer.from(payload))
      else if (event === 'end') callback()
    },
    destroy() {},
  }, res)
  return res
}

const diagFilePath = () => join(diagDir, DIAG_FILE_NAME)
const readDiagFile = () => {
  try {
    return readFileSync(diagFilePath(), 'utf8')
  } catch {
    return ''
  }
}
const diagMarker = (tag) => `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`

// 真实 socket: 用实际 HTTP server 承接 withRouteGate 包装后的路由, 验证状态码与响应可达
async function withRealRoute(route, run) {
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const { port } = server.address()
    return await run(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function socketRequest(port, { method = 'POST', path = '/api/dsh-bug-perf/diag', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// keep-alive 探针: 显式复用 socket; 新建连接会掩盖 413 后连接被废弃的问题
function keepAliveCall(agent, options, body) {
  return new Promise((resolve) => {
    const req = httpRequest({ ...options, agent }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), socket: req.socket }))
    })
    req.on('error', (error) => resolve({ error: error.code || String(error) }))
    req.end(body)
  })
}

// 原始 socket 探针: 可在请求体远未写完时读取响应, 覆盖慢速/超大声明体
function rawHttpCall(port, { head, chunks = [], waitMs = 3000 }) {
  return new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(head)
      for (const chunk of chunks) socket.write(chunk)
    })
    let data = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done({ timeout: true, data }), waitMs)
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.includes('\r\n\r\n') && data.includes('\r\n0\r\n\r\n')) done({ data })
    })
    socket.on('error', (error) => done({ error: error.code || String(error), data }))
    socket.on('close', () => done({ closed: true, data }))
  })
}

// Given 插件声明注入, When 装载器解析, Then 等待 webServer 就绪后再激活(不是同步探测)
test('宿主_注入声明_等待webServer', async () => {
  const index = await import('../src/index.js')
  assert.deepEqual(index.inject, ['webServer'])
})

// Given 宿主提供 webServer, When 插件激活, Then 注册配置读写路由且路径固定
test('宿主_激活_注册配置路由', () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  assert.equal(name, 'dsh-bug-perf')
  assert.equal(ctx.registrations.length, 2)
  assert.equal(ctx.registrations[0].kind, 'exact')
  assert.equal(ctx.registrations[0].path, '/api/dsh-bug-perf/config')
  assert.equal(ctx.registrations[1].path, '/api/dsh-bug-perf/diag')
  assert.equal(ctx.registrations[1].write, true)
})

// Given 行配置为缺省, When 客户端读取配置, Then 返回默认配置 JSON
test('宿主_缺省配置_返回默认值', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const res = await request(ctx.registrations[0])
  assert.equal(res.status, 200)
  const json = JSON.parse(res.body)
  assert.deepEqual(json.config, DEFAULT_CONFIG)
})

// Given 行配置部分覆盖, When 客户端读取, Then 覆盖项生效且其余为默认
test('宿主_部分覆盖_返回归一化结果', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, { restartCoalesce: { enabled: false }, terminalWatchdog: { stallMs: 12000 } })
  const json = JSON.parse((await request(ctx.registrations[0])).body)
  assert.equal(json.config.restartCoalesce.enabled, false)
  assert.equal(json.config.restartCoalesce.windowMs, 100)
  assert.equal(json.config.terminalWatchdog.stallMs, 12000)
})

async function postConfig(route, body) {
  const res = makeRes()
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  const req = {
    url: '/api/dsh-bug-perf/config',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(event, callback) {
      if (event === 'data') callback(Buffer.from(payload))
      else if (event === 'end') callback()
    },
    destroy() {},
  }
  await route.handler(req, res)
  return res
}

class FakeRequest extends EventEmitter {
  constructor() {
    super()
    this.url = '/api/dsh-bug-perf/config'
    this.method = 'POST'
    this.headers = { 'content-type': 'application/json' }
    this.complete = false
    this.destroyed = false
    this.paused = false
    this.resumed = false
  }
  pause() { this.paused = true }
  resume() { this.paused = false; this.resumed = true }
  destroy() { this.destroyed = true }
}

// 等待 handler 把 readBody 的监听挂上再发请求体事件
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve))

// Given 旧宿主 settings 命名空间可用, When POST 配置, Then 归一化后持久化并可读回
test('宿主_配置保存_settings持久化', async () => {
  const settings = {
    stored: undefined,
    registered: undefined,
    register(namespace, schema, options) { this.registered = { namespace, schema, options } },
    get() { return this.stored },
    async update(_namespace, patch) { this.stored = { ...(this.stored ?? {}), ...patch } },
  }
  const ctx = makeCtx({ server: {}, settings })
  apply(ctx, undefined)
  assert.equal(settings.registered.namespace, 'bug-perf')
  const res = await postConfig(ctx.registrations[0], { config: { listSlim: { enabled: false } } })
  assert.equal(res.status, 200)
  const saved = JSON.parse(res.body).config
  assert.equal(saved.listSlim.enabled, false)
  assert.equal(settings.stored.listSlim.enabled, false)
  const read = JSON.parse((await request(ctx.registrations[0])).body)
  assert.equal(read.config.listSlim.enabled, false)
})

// Given legacy settings 只存 diag, When 读取配置, Then diag 节也参与已存判断
test('宿主_配置读取_settings仅diag_生效', async () => {
  const settings = {
    stored: { diag: { enabled: true, reportEvery: 2 } },
    register() {},
    get() { return this.stored },
    async update() {},
  }
  const ctx = makeCtx({ server: {}, settings })
  apply(ctx, undefined)
  const read = JSON.parse((await request(ctx.registrations[0])).body)
  assert.deepEqual(read.config.diag, { enabled: true, reportEvery: 2 })
})

// Given 旧版设置页保存过默认值, When 读取配置, Then 旧默认值按版本复写为当前默认值
test('宿主_配置读取_旧版本迁移', async () => {
  const settings = {
    stored: { stuckSession: { enabled: true, checkMs: 2000, stallMs: 8000, reconnect: true, maxReconnectAttempts: 5, reconnectIntervalMs: 15000 } },
    register() {},
    get() { return this.stored },
    async update() {},
  }
  const ctx = makeCtx({ server: {}, settings })
  apply(ctx, undefined)
  const read = JSON.parse((await request(ctx.registrations[0])).body)
  assert.equal(read.config.configVersion, CONFIG_VERSION)
  assert.equal(read.config.stuckSession.checkMs, DEFAULT_CONFIG.stuckSession.checkMs)
  assert.equal(read.config.stuckSession.stallMs, DEFAULT_CONFIG.stuckSession.stallMs)
  assert.equal(read.config.stuckSession.maxReconnectAttempts, DEFAULT_CONFIG.stuckSession.maxReconnectAttempts)
  assert.equal(read.config.stuckSession.reconnectIntervalMs, DEFAULT_CONFIG.stuckSession.reconnectIntervalMs)
})

// Given 保存值越界, When POST, Then 上限收敛后再落盘
test('宿主_配置保存_数值收敛', async () => {
  const settings = {
    stored: undefined,
    register() {},
    get() { return this.stored },
    async update(_namespace, patch) { this.stored = patch },
  }
  const ctx = makeCtx({ server: {}, settings })
  apply(ctx, undefined)
  const res = await postConfig(ctx.registrations[0], { config: { terminalWatchdog: { stallMs: 99999999 } } })
  assert.equal(JSON.parse(res.body).config.terminalWatchdog.stallMs, 600000)
  assert.equal(settings.stored.terminalWatchdog.stallMs, 600000)
})

// Given 已存配置含同节其它显式值, When 只提交该节一个字段, Then 深合并保留同节其它值
test('宿主_配置保存_按节深合并', async () => {
  const settings = {
    stored: {
      terminalWatchdog: { enabled: false, checkMs: 2500, stallMs: 12000, cooldownMs: 90000 },
      restartCoalesce: { enabled: false, windowMs: 250 },
    },
    register() {},
    get() { return this.stored },
    async update(_namespace, patch) { this.stored = patch },
  }
  const ctx = makeCtx({ server: {}, settings })
  apply(ctx, undefined)
  const res = await postConfig(ctx.registrations[0], { config: { terminalWatchdog: { enabled: true } } })
  assert.equal(res.status, 200)
  const saved = JSON.parse(res.body).config
  assert.equal(saved.terminalWatchdog.enabled, true)
  assert.equal(saved.terminalWatchdog.checkMs, 2500)
  assert.equal(saved.terminalWatchdog.stallMs, 12000)
  assert.equal(saved.terminalWatchdog.cooldownMs, 90000)
  assert.equal(saved.restartCoalesce.enabled, false)
  assert.equal(saved.restartCoalesce.windowMs, 250)
})

// Given 0.1.7 行配置编辑器可用, When POST, Then 通过 editor.edit 写当前 fiber 条目
test('宿主_配置保存_行配置编辑器', async () => {
  const edits = []
  const configEditor = {
    async edit(entry, update) {
      const next = update({ restartCoalesce: { enabled: true, windowMs: 100 } })
      edits.push({ entry, next })
    },
  }
  const entry = { id: 'dsh-bug-perf' }
  const ctx = makeCtx({ server: {}, configEditor, fiberEntry: entry })
  apply(ctx, undefined)
  const res = await postConfig(ctx.registrations[0], { config: { restartCoalesce: { windowMs: 250 } } })
  assert.equal(res.status, 200)
  assert.equal(edits.length, 1)
  assert.equal(edits[0].entry, entry)
  assert.equal(edits[0].next.restartCoalesce.windowMs, 250)
})

// Given 坏 JSON 或非法 config, When POST, Then 400 且不写
test('宿主_配置保存_拒绝坏载荷', async () => {
  let updates = 0
  const settings = {
    register() {},
    get() { return undefined },
    async update() { updates += 1 },
  }
  const ctx = makeCtx({ server: {}, settings })
  apply(ctx, undefined)
  assert.equal((await postConfig(ctx.registrations[0], 'not-json')).status, 400)
  assert.equal((await postConfig(ctx.registrations[0], { config: null })).status, 400)
  assert.equal((await postConfig(ctx.registrations[0], { config: [] })).status, 400)
  assert.equal(updates, 0)
})

// Given 宿主没有 settings 与 configEditor, When POST, Then 503 且不抛
test('宿主_配置保存_服务缺失返回503', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const res = await postConfig(ctx.registrations[0], { config: { listSlim: { enabled: false } } })
  assert.equal(res.status, 503)
})

// Given 非 GET/POST 方法, When 请求配置路由, Then 405 且不读不写
test('宿主_配置路由_拒绝未知方法', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const res = makeRes()
  await ctx.registrations[0].handler({
    url: '/api/dsh-bug-perf/config',
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
  }, res)
  assert.equal(res.status, 405)
})

// Given 0.1.7 宿主把整节配置包成 volatile ref, When 读取, Then 解箱后返回
test('宿主_volatile配置_解箱', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, { get: () => ({ terminalWatchdog: { enabled: false } }) })
  const json = JSON.parse((await request(ctx.registrations[0])).body)
  assert.equal(json.config.terminalWatchdog.enabled, false)
})

// Given 宿主没有 webServer 服务, When 插件激活, Then 不注册不抛错(旧宿主/无 web 场景)
test('宿主_无webServer_干净跳过', () => {
  const ctx = makeCtx()
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.equal(ctx.registrations.length, 0)
  assert.equal(ctx.effects.length, 0)
})

// Given 路由注册抛错, When 插件激活, Then 错误被记录而不是拖垮页面
test('宿主_注册失败_不抛', () => {
  const ctx = makeCtx({ server: {}, registerError: new Error('route table frozen') })
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.equal(ctx.registrations.length, 0)
})

// Given 插件导出 Config, When 取各节默认值, Then 与共享默认值一致(设置页与运行时同源)
test('宿主_Config默认值_与共享默认一致', () => {
  const restart = Config.dict.restartCoalesce({})
  const watchdog = Config.dict.terminalWatchdog({})
  assert.equal(restart.enabled, DEFAULT_CONFIG.restartCoalesce.enabled)
  assert.equal(restart.windowMs, DEFAULT_CONFIG.restartCoalesce.windowMs)
  assert.equal(watchdog.enabled, DEFAULT_CONFIG.terminalWatchdog.enabled)
  assert.equal(watchdog.checkMs, DEFAULT_CONFIG.terminalWatchdog.checkMs)
  assert.equal(watchdog.stallMs, DEFAULT_CONFIG.terminalWatchdog.stallMs)
  assert.equal(watchdog.cooldownMs, DEFAULT_CONFIG.terminalWatchdog.cooldownMs)
  assert.deepEqual(Config.dict.listSlim({}), DEFAULT_CONFIG.listSlim)
  assert.deepEqual(Config.dict.sessionWindow({}), DEFAULT_CONFIG.sessionWindow)
  assert.deepEqual(Config.dict.diag({}), DEFAULT_CONFIG.diag)
  assert.equal(Config.dict.diag({}).enabled, false)
})

// Given sessionController 就绪, When 插件激活并调用列表接口, Then 投影按白名单裁剪且第二次命中缓存
test('宿主_列表瘦身_按配置接管列表接口', async () => {
  let built = 0
  const controller = {
    list: async () => {
      built += 1
      return { items: [{ sessionId: 'a', projections: { kind: 'cached', values: { title: 'A', contextHeaders: [1] } } }] }
    },
  }
  const ctx = makeCtx({ server: {}, sessionController: controller })
  apply(ctx, undefined)
  const first = await controller.list({}, undefined)
  const second = await controller.list({}, undefined)
  assert.equal(built, 1)
  assert.deepEqual(Object.keys(first.items[0].projections.values), ['title'])
  assert.equal(second, first)
})

// Given 行配置关闭列表瘦身, When 调用列表接口, Then 原样透传且不缓存
test('宿主_列表瘦身_关闭时原样透传', async () => {
  let built = 0
  const controller = {
    list: async () => {
      built += 1
      return { items: [{ sessionId: 'a', projections: { values: { contextHeaders: [1] } } }] }
    },
  }
  const ctx = makeCtx({ server: {}, sessionController: controller })
  apply(ctx, { listSlim: { enabled: false } })
  await controller.list({}, undefined)
  const value = await controller.list({}, undefined)
  assert.equal(built, 2)
  assert.deepEqual(value.items[0].projections.values, { contextHeaders: [1] })
})

// Given 0.1.7 live ref 热更新行配置, When 连续切换 listSlim 开关, Then 每次调用按当前值决定裁剪或透传
test('宿主_列表瘦身_热切换开关即时生效', async () => {
  let current = { listSlim: { enabled: false } }
  let built = 0
  const controller = {
    list: async () => {
      built += 1
      return { items: [{ sessionId: 'a', projections: { values: { title: 'A', contextHeaders: [1] } } }] }
    },
  }
  const ctx = makeCtx({ server: {}, sessionController: controller })
  apply(ctx, { get: () => current })
  const off = await controller.list({}, undefined)
  assert.deepEqual(off.items[0].projections.values.contextHeaders, [1], '关闭时透传完整投影')
  current = { listSlim: { enabled: true } }
  const on = await controller.list({}, undefined)
  assert.deepEqual(Object.keys(on.items[0].projections.values), ['title'], '开启后裁剪')
  current = { listSlim: { enabled: false } }
  const offAgain = await controller.list({}, undefined)
  assert.deepEqual(offAgain.items[0].projections.values.contextHeaders, [1], '再次关闭恢复完整投影')
  assert.equal(built, 3)
})

// Given diag 开关默认关闭, When 浏览器经真实 socket POST 合法载荷, Then 宿主不按开关拒绝, 返回 ok 并落盘
test('宿主_采样上报_接受合法载荷', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const marker = diagMarker('accepted')
  await withRealRoute(ctx.registrations[1], async (port) => {
    const res = await socketRequest(port, {
      headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ at: 1, totals: { opened: 1 }, marker }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
  })
  assert.ok(readDiagFile().includes(marker))
})

// Given 两个宿主实例各有诊断目录, When 分别上报, Then 两个文件互不污染
test('宿主_采样上报_实例目录隔离', async () => {
  const firstDir = mkdtempSync(join(tmpdir(), 'dsh-bug-perf-first-'))
  const secondDir = mkdtempSync(join(tmpdir(), 'dsh-bug-perf-second-'))
  try {
    process.env[DIAG_DIR_ENV] = firstDir
    const firstCtx = makeCtx({ server: {} })
    apply(firstCtx, undefined)
    process.env[DIAG_DIR_ENV] = secondDir
    const secondCtx = makeCtx({ server: {} })
    apply(secondCtx, undefined)
    const firstMarker = diagMarker('instance-first')
    const secondMarker = diagMarker('instance-second')
    await withRealRoute(firstCtx.registrations[1], async (port) => {
      const res = await socketRequest(port, {
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ at: 1, marker: firstMarker }),
      })
      assert.equal(res.status, 200)
    })
    await withRealRoute(secondCtx.registrations[1], async (port) => {
      const res = await socketRequest(port, {
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ at: 1, marker: secondMarker }),
      })
      assert.equal(res.status, 200)
    })
    const firstText = readFileSync(join(firstDir, DIAG_FILE_NAME), 'utf8')
    const secondText = readFileSync(join(secondDir, DIAG_FILE_NAME), 'utf8')
    assert.ok(firstText.includes(firstMarker))
    assert.equal(firstText.includes(secondMarker), false)
    assert.ok(secondText.includes(secondMarker))
    assert.equal(secondText.includes(firstMarker), false)
  } finally {
    rmSync(firstDir, { recursive: true, force: true })
    rmSync(secondDir, { recursive: true, force: true })
  }
})

// Given 两个实例共用默认 DSH_HOME, When 端口不同, Then 诊断文件按端口隔离
test('宿主_采样上报_默认home双实例按端口隔离', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bug-perf-home-'))
  const previousHome = process.env.DSH_HOME
  const previousDir = process.env[DIAG_DIR_ENV]
  delete process.env[DIAG_DIR_ENV]
  process.env.DSH_HOME = home
  try {
    const firstCtx = makeCtx({ server: { port: 6101 } })
    apply(firstCtx, undefined)
    const secondCtx = makeCtx({ server: { port: 6102 } })
    apply(secondCtx, undefined)
    const firstMarker = diagMarker('home-port-first')
    const secondMarker = diagMarker('home-port-second')
    await withRealRoute(firstCtx.registrations[1], async (port) => {
      const res = await socketRequest(port, {
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ at: 1, marker: firstMarker }),
      })
      assert.equal(res.status, 200)
    })
    await withRealRoute(secondCtx.registrations[1], async (port) => {
      const res = await socketRequest(port, {
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ at: 1, marker: secondMarker }),
      })
      assert.equal(res.status, 200)
    })
    const firstText = readFileSync(join(home, 'dsh-bug-perf', 'diag-port-6101.jsonl'), 'utf8')
    const secondText = readFileSync(join(home, 'dsh-bug-perf', 'diag-port-6102.jsonl'), 'utf8')
    assert.ok(firstText.includes(firstMarker))
    assert.equal(firstText.includes(secondMarker), false)
    assert.ok(secondText.includes(secondMarker))
    assert.equal(secondText.includes(firstMarker), false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousDir === undefined) delete process.env[DIAG_DIR_ENV]
    else process.env[DIAG_DIR_ENV] = previousDir
    rmSync(home, { recursive: true, force: true })
  }
})

// Given 副作用路由已接写闸门, When 真实 socket 跨源 POST, Then 403 且不落盘
test('宿主_采样上报_真实socket跨源拒绝且不落盘', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const marker = diagMarker('cross-origin')
  await withRealRoute(ctx.registrations[1], async (port) => {
    const res = await socketRequest(port, {
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify({ marker }),
    })
    assert.equal(res.status, 403)
  })
  assert.equal(readDiagFile().includes(marker), false)
})

// Given 副作用路由要求 JSON 写请求, When 真实 socket 发送 text/plain, Then 400 且不落盘
test('宿主_采样上报_真实socket非JSON拒绝且不落盘', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const marker = diagMarker('non-json')
  await withRealRoute(ctx.registrations[1], async (port) => {
    const res = await socketRequest(port, {
      headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'text/plain' },
      body: JSON.stringify({ marker }),
    })
    assert.equal(res.status, 400)
  })
  assert.equal(readDiagFile().includes(marker), false)
})

// Given 旧的 GET 上报形态, When 真实 socket 跨源 GET 或同源 GET 带 d 查询, Then 403/405 且绝不写盘
test('宿主_采样上报_真实socketGET不写盘', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const marker = diagMarker('get')
  const path = `/api/dsh-bug-perf/diag?d=${encodeURIComponent(JSON.stringify({ marker }))}`
  await withRealRoute(ctx.registrations[1], async (port) => {
    const crossOrigin = await socketRequest(port, { method: 'GET', path, headers: { origin: 'https://evil.test' } })
    assert.equal(crossOrigin.status, 403)
    const sameOrigin = await socketRequest(port, { method: 'GET', path, headers: { origin: `http://127.0.0.1:${port}` } })
    assert.equal(sameOrigin.status, 405)
  })
  assert.equal(readDiagFile().includes(marker), false)
})

// Given 缺少载荷或载荷不是 JSON, When 上报, Then 返回 400 且不抛出
test('宿主_采样上报_拒绝坏载荷', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const missing = await requestDiag(ctx.registrations[1], '')
  assert.equal(missing.status, 400)
  const broken = await requestDiag(ctx.registrations[1], 'not-json')
  assert.equal(broken.status, 400)
  const notObject = await requestDiag(ctx.registrations[1], '[]')
  assert.equal(notObject.status, 400)
})

// Given 跨源页面发起配置保存, When POST, Then 同源比对拒绝且不触达业务面
test('宿主_配置保存_跨源拒绝', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const res = makeRes()
  await ctx.registrations[0].handler({
    url: '/api/dsh-bug-perf/config',
    method: 'POST',
    headers: { origin: 'https://evil.test', host: '127.0.0.1:3080', 'content-type': 'application/json' },
    on(event, callback) { if (event === 'end') callback() },
    destroy() {},
  }, res)
  assert.equal(res.status, 403)
})

// Given 简单表单请求(无预检), When 保存配置, Then content-type 门拒绝且不落盘
test('宿主_配置保存_非JSON拒绝', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const res = makeRes()
  await ctx.registrations[0].handler({
    url: '/api/dsh-bug-perf/config',
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    on(event, callback) { if (event === 'end') callback() },
    destroy() {},
  }, res)
  assert.equal(res.status, 400)
})

// Given 请求体超过上限, When 读取, Then 不销毁 socket, 413 仍可送达
test('宿主_配置保存_超限不销毁socket', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const req = new FakeRequest()
  const res = makeRes()
  const pending = ctx.registrations[0].handler(req, res)
  await flushMicrotasks()
  req.emit('data', Buffer.alloc(64 * 1024 + 1))
  req.emit('end')
  await pending
  assert.equal(req.destroyed, false)
  assert.equal(req.resumed, true)
  assert.equal(res.status, 413)
  assert.deepEqual(JSON.parse(res.body), { error: 'payload-too-large' })
})

// Given 同一条 keep-alive 连接, When 配置 POST 小超额, Then 413 后后续 GET 仍复用该 socket
test('宿主_配置保存_小超额排空后keep-alive可复用', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  await withRealRoute(ctx.registrations[0], async (port) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      // 声明体落在 keep-alive 阈值内, 排空后可复用; 明显超限走关闭路径
      const body = Buffer.alloc(64 * 1024 + 4 * 1024)
      const first = await keepAliveCall(agent, {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/dsh-bug-perf/config',
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      }, body)
      assert.equal(first.error, undefined, `超限响应必须送达,实际 ${first.error}`)
      assert.equal(first.status, 413)
      assert.deepEqual(JSON.parse(first.body), { error: 'payload-too-large' })
      // 回归: 超限体不排空时宿主在响应后废弃 socket,这里第二个请求即 ECONNRESET
      const second = await keepAliveCall(agent, {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/dsh-bug-perf/config',
        headers: { origin: `http://127.0.0.1:${port}` },
      })
      assert.equal(second.error, undefined, `413 后同连接请求不得被复位,实际 ${second.error}`)
      assert.equal(second.status, 200)
      assert.equal(second.socket, first.socket, '后续请求必须复用同一 socket,新连接掩盖 RST')
    } finally {
      agent.destroy()
    }
  })
})

// Given 真实 fetch 发送 2MB/50MB, When 请求体读完, Then 都能收到 413 且连接关闭
test('宿主_配置保存_大体积fetch收到413后关闭', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  await withRealRoute(ctx.registrations[0], async (port) => {
    for (const size of [2 * 1024 * 1024, 50 * 1024 * 1024]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/dsh-bug-perf/config`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
        body: Buffer.alloc(size),
      })
      assert.equal(response.status, 413, `${size} 字节必须收到 413`)
      assert.equal(response.headers.get('connection'), 'close')
      assert.deepEqual(await response.json(), { error: 'payload-too-large' })
    }
  })
})

// Given 无长度 chunked 体到达结束, When 超过排空上限, Then 413 后关闭连接而非无限排空
test('宿主_配置保存_chunked超限413后关闭', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  await withRealRoute(ctx.registrations[0], async (port) => {
    const chunk = `x`.repeat(128 * 1024)
    const result = await rawHttpCall(port, {
      head: `POST /api/dsh-bug-perf/config HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + `Origin: http://127.0.0.1:${port}\r\n`
        + `Content-Type: application/json\r\n`
        + `Transfer-Encoding: chunked\r\n\r\n`,
      chunks: [`${chunk.length.toString(16)}\r\n${chunk}\r\n`, '0\r\n\r\n'],
    })
    assert.equal(result.timeout, undefined)
    assert.equal(result.error, undefined)
    assert.match(result.data, /^HTTP\/1\.1 413/)
    assert.match(result.data, /connection: close/i)
    assert.match(result.data, /payload-too-large/)
  })
})

// Given 客户端在请求体读完前中止, When aborted 触发, Then 以 400 收敛而不是挂起
test('宿主_配置保存_请求中止', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const req = new FakeRequest()
  const res = makeRes()
  const pending = ctx.registrations[0].handler(req, res)
  await flushMicrotasks()
  req.emit('aborted')
  await pending
  assert.equal(res.status, 400)
  assert.deepEqual(JSON.parse(res.body), { error: 'bad-payload' })
})

// Given 请求体未 complete 连接就关闭, When close 触发, Then 以 400 收敛
test('宿主_配置保存_连接提前关闭', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const req = new FakeRequest()
  const res = makeRes()
  const pending = ctx.registrations[0].handler(req, res)
  await flushMicrotasks()
  req.emit('close')
  await pending
  assert.equal(res.status, 400)
})
