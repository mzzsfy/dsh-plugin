// 「允许 ai 使用」开关注册面 BDD: 开关决定 tunnel_open/list/close 是否向 ai 注册,
// 关闭即注销(干净禁用), GUI/REST 同表不受影响。覆盖双形态读写:
// legacy 设置节(watch 回写)与 0.1.7+ volatile ref(loader 原地热更 + loader/volatile-update)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TOOL_NAMES = ['tunnel_open', 'tunnel_list', 'tunnel_close']

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
    this.upgrades.set(route.path, route)
    return () => this.upgrades.delete(route.path)
  }

  registerFallback(handler) {
    this.fallback = handler
    return () => { this.fallback = undefined }
  }
}

function createToolsService() {
  const registered = new Map()
  return {
    registered,
    names: () => [...registered.keys()],
    register(tool) {
      registered.set(tool.name, tool)
      return () => registered.delete(tool.name)
    },
  }
}

function createCtx({ tools, settings, configEditor, fiber } = {}) {
  const events = new Map()
  const effectDisposers = []
  const runEffect = (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') effectDisposers.push(disposer)
    return disposer
  }
  const ctx = {
    webServer: undefined,
    fiber,
    get: (name) => (name === 'configEditor' ? configEditor : undefined),
    on: (event, handler) => {
      if (!events.has(event)) events.set(event, [])
      events.get(event).push(handler)
      return () => { events.set(event, events.get(event).filter((cb) => cb !== handler)) }
    },
    effect: runEffect,
    inject(names, cb) { cb({ tools, settings, effect: runEffect }) },
  }
  return { ctx, events, effectDisposers }
}

// legacy mock settings: 与 tunnel.test.mjs 同款语义(内存存储 + watch 登记 + 手动触发)
function createSettingsService(initial = {}) {
  const store = { tunnel: { ...initial } }
  const watchers = []
  return {
    store,
    service: {
      get: (ns) => store[ns],
      update: (ns, patch) => { store[ns] = { ...(store[ns] ?? {}), ...patch } },
      register: (ns) => ({ watch: (cb) => watchers.push(cb) }),
    },
    setTunnel(patch) { store.tunnel = { ...store.tunnel, ...patch }; for (const cb of watchers) cb() },
  }
}

function volatileRef(value) {
  return { get: () => (typeof value === 'function' ? value() : value) }
}

const tempDataDirs = new Set()
const defaultDataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tunnel-ai-'))
  tempDataDirs.add(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of tempDataDirs) rmSync(dir, { recursive: true, force: true })
})

async function applyPlugin(config = {}, services = {}) {
  const { apply } = await import('../src/index.js')
  const tools = services.tools ?? createToolsService()
  const webServer = new MockWebServer()
  const { ctx, events, effectDisposers } = createCtx({ ...services, tools })
  ctx.webServer = webServer
  const full = { connectTimeoutMs: 10 * 1000, dataDir: defaultDataDir(), ...config }
  const dispose = apply(ctx, full)
  const disposeAll = () => {
    dispose()
    for (const disposer of effectDisposers.reverse()) disposer()
  }
  return { webServer, tools, events, dispose: disposeAll }
}

async function callApi(webServer, method, path, body) {
  const route = webServer.prefixes.get('/api/tunnel')
  assert.ok(route, 'REST 前缀路由未注册')
  const req = new EventEmitter()
  req.method = method
  req.url = '/api/tunnel' + path
  req.headers = { host: 'localhost:3080' }
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => {
    try { res.payload = JSON.parse(text) } catch { res.payload = null }
  }
  const done = route.handler(req, res)
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  await done
  return res
}

const openTunnel = (webServer) => callApi(webServer, 'POST', '/tunnels', { name: 'app', targetPort: 80 })

test('默认注册三件工具, status 暴露 aiTools 开', async () => {
  const { webServer, tools, dispose } = await applyPlugin()
  try {
    assert.deepEqual(tools.names().sort(), [...TOOL_NAMES].sort())
    const status = await callApi(webServer, 'GET', '/status')
    assert.equal(status.payload.ui.aiTools, true)
  } finally { dispose() }
})

test('config.aiTools=false 不注册工具, 看板 REST 增删照常', async () => {
  const { webServer, tools, dispose } = await applyPlugin({ aiTools: false })
  try {
    assert.deepEqual(tools.names(), [])
    const opened = await openTunnel(webServer)
    assert.equal(opened.payload.ok, true)
    const listed = await callApi(webServer, 'GET', '/tunnels')
    assert.deepEqual(listed.payload.items.map((row) => row.name), ['app'])
    const status = await callApi(webServer, 'GET', '/status')
    assert.equal(status.payload.ui.aiTools, false)
  } finally { dispose() }
})

test('legacy 设置节运行时翻转: 关闭注销, 重开恢复', async () => {
  const settings = createSettingsService()
  const { tools, dispose } = await applyPlugin({}, { settings: settings.service })
  try {
    assert.deepEqual(tools.names().sort(), [...TOOL_NAMES].sort())
    settings.setTunnel({ aiTools: false })
    assert.deepEqual(tools.names(), [])
    settings.setTunnel({ aiTools: true })
    assert.deepEqual(tools.names().sort(), [...TOOL_NAMES].sort())
  } finally { dispose() }
})

test('legacy 设置节初值 false: 激活后保持注销', async () => {
  const settings = createSettingsService({ aiTools: false })
  const { tools, dispose } = await applyPlugin({}, { settings: settings.service })
  try {
    assert.deepEqual(tools.names(), [])
  } finally { dispose() }
})

test('0.1.7 形态: volatile ref 初值生效, volatile-update 驱动翻转', async () => {
  let aiValue = false
  const { tools, events, dispose } = await applyPlugin({
    aiTools: volatileRef(() => aiValue),
    sidebarTab: volatileRef(false),
    connectTimeoutMs: volatileRef(5 * 1000),
  })
  try {
    assert.deepEqual(tools.names(), [])
    aiValue = true
    for (const handler of events.get('loader/volatile-update') ?? []) handler()
    assert.deepEqual(tools.names().sort(), [...TOOL_NAMES].sort())
    aiValue = false
    for (const handler of events.get('loader/volatile-update') ?? []) handler()
    assert.deepEqual(tools.names(), [])
  } finally { dispose() }
})

test('REST ui-settings 翻转 aiTools: 工具注销且回写 ui(legacy 通道)', async () => {
  const settings = createSettingsService()
  const { webServer, tools, dispose } = await applyPlugin({}, { settings: settings.service })
  try {
    const flipped = await callApi(webServer, 'POST', '/ui-settings', { aiTools: false })
    assert.equal(flipped.status, 200)
    assert.equal(flipped.payload.ok, true)
    assert.equal(flipped.payload.ui.aiTools, false)
    assert.deepEqual(settings.store.tunnel.aiTools, false)
    assert.deepEqual(tools.names(), [])
    const restored = await callApi(webServer, 'POST', '/ui-settings', { aiTools: true })
    assert.equal(restored.payload.ui.aiTools, true)
    assert.deepEqual(tools.names().sort(), [...TOOL_NAMES].sort())
  } finally { dispose() }
})

test('0.1.7 写路径: aiTools 经 configEditor 落 profile 条目, ref 写穿后注册面跟随', async () => {
  // mock loader updateVolatile 语义: edit 落条目 → volatile ref 原地换值 → 偏好重读生效
  const entry = { aiTools: true }
  const configEditor = {
    edit: async (_entry, change) => { Object.assign(entry, change({ ...entry })) },
  }
  const { webServer, tools, dispose } = await applyPlugin({
    aiTools: volatileRef(() => entry.aiTools),
  }, { configEditor, fiber: { entry: { id: 'row-1' } } })
  try {
    const flipped = await callApi(webServer, 'POST', '/ui-settings', { aiTools: false })
    assert.equal(flipped.payload.ok, true)
    assert.deepEqual(entry, { aiTools: false })
    assert.deepEqual(tools.names(), [])
  } finally { dispose() }
})

test('ui-settings 校验: 非布尔 400, 空补丁 400', async () => {
  const { webServer, dispose } = await applyPlugin()
  try {
    const bad = await callApi(webServer, 'POST', '/ui-settings', { aiTools: 'yes' })
    assert.equal(bad.status, 400)
    assert.match(bad.payload.error, /aiTools 须为布尔/)
    const empty = await callApi(webServer, 'POST', '/ui-settings', {})
    assert.equal(empty.status, 400)
    assert.match(empty.payload.error, /须为布尔/)
  } finally { dispose() }
})

test('写路径服务缺失降级: updateUi 返回 ok:false', async () => {
  const { webServer, tools, dispose } = await applyPlugin()
  try {
    const res = await callApi(webServer, 'POST', '/ui-settings', { aiTools: false })
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, false)
    assert.match(res.payload.error, /设置服务不可用/)
    assert.deepEqual(tools.names().sort(), [...TOOL_NAMES].sort(), '写失败不得翻转注册面')
  } finally { dispose() }
})

test('插件停用回收工具注册', async () => {
  const { tools, dispose } = await applyPlugin()
  assert.deepEqual(tools.names().sort(), [...TOOL_NAMES].sort())
  dispose()
  assert.deepEqual(tools.names(), [])
})

test('Config volatile 标记面: 三个偏好字段 live, dataDir 不进 UI', async () => {
  const { Config, SETTINGS_SCHEMA } = await import('../src/index.js')
  assert.equal(Config.dict.aiTools.meta.volatile, true)
  assert.equal(Config.dict.sidebarTab.meta.volatile, true)
  assert.equal(Config.dict.connectTimeoutMs.meta.volatile, true)
  assert.equal(Config.dict.dataDir.meta.volatile, undefined)
  assert.equal(SETTINGS_SCHEMA.dict.aiTools.meta.default, true)
  assert.equal(SETTINGS_SCHEMA.dict.dataDir, undefined, 'legacy 设置节不收环境路径')
})
