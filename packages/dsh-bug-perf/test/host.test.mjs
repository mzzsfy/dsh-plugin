import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_VERSION, DEFAULT_CONFIG } from '../src/config.mjs'
import { apply, Config, name } from '../src/index.js'

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

async function requestDiag(route, query) {
  const res = makeRes()
  await route.handler({ url: `/api/dsh-bug-perf/diag${query}`, method: 'GET' }, res)
  return res
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
    on(event, callback) {
      if (event === 'data') callback(Buffer.from(payload))
      else if (event === 'end') callback()
    },
    destroy() {},
  }
  await route.handler(req, res)
  return res
}

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
  await ctx.registrations[0].handler({ url: '/api/dsh-bug-perf/config', method: 'DELETE' }, res)
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

// Given diag 开关默认关闭, When 浏览器仍上报合法载荷, Then 宿主不按开关拒绝, 返回 ok 并落盘
test('宿主_采样上报_接受合法载荷', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const res = await requestDiag(ctx.registrations[1], `?d=${encodeURIComponent(JSON.stringify({ at: 1, totals: { opened: 1 } }))}`)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true })
})

// Given 缺少载荷或载荷不是 JSON, When 上报, Then 返回 400 且不抛出
test('宿主_采样上报_拒绝坏载荷', async () => {
  const ctx = makeCtx({ server: {} })
  apply(ctx, undefined)
  const missing = await requestDiag(ctx.registrations[1], '')
  assert.equal(missing.status, 400)
  const broken = await requestDiag(ctx.registrations[1], '?d=not-json')
  assert.equal(broken.status, 400)
})
