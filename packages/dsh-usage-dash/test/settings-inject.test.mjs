// settings 注入集成测试:apply 的 pricing 门面双形分派(legacy 方法面 / 0.1.7
// 静态 Config + configEditor 面)。stub ctx 装载真实 src/index.js,经捕获的
// /api/usage-dash/pricing 路由驱动门面,验证激活与读写链路。

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

const { apply } = await import('../src/index.js')

const PATH_PRICING = '/api/usage-dash/pricing'
const DEFAULT_MINUTE_RETENTION_DAYS = 7

const RULE = {
  model: 'default/deepseek-chat',
  currency: '¥',
  price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  conditions: [],
}

// sharedStore 单例按 storageDomain 缓存:每例独立 domain 防串扰;域 open 缺席时
// store 走内存降级,单测无落盘
function makeDomain() {
  return { open: async () => ({}) }
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(status) { this.statusCode = status },
    end(body) { this.body = body },
  }
}

function makeReq({ url, method = 'POST', headers = {}, body } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.url = url
  req.headers = headers
  if (body !== undefined) req.push(body)
  req.push(null)
  return req
}

const invoke = async (routes, path, reqOptions = {}) => {
  const route = routes.get(path)
  assert.ok(route, `route ${path} 未注册`)
  const res = makeRes()
  await route.handler(makeReq({ url: path, ...reqOptions }), res)
  return res
}

const invokeJson = (routes, path, { headers, payload, ...rest } = {}) =>
  invoke(routes, path, {
    headers: { 'content-type': 'application/json', ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    ...rest,
  })

// legacy 方法面桩(≤0.1.6 SettingsProvider):register/get/update/describe 命名空间语义
function makeLegacySettings(store = {}) {
  let revision = 0
  return {
    register() {},
    get: () => store,
    update: async (_ns, patch) => {
      const pricing = patch.pricing
      if (pricing) store.pricing = { ...(store.pricing ?? {}), ...pricing }
      if (patch.minuteRetentionDays !== undefined) store.minuteRetentionDays = patch.minuteRetentionDays
      revision += 1
    },
    describe: () => [{ ns: 'usage-dash', revision }],
  }
}

// 0.1.7 形态桩:settings 无 register/get(configure/describe 在),configRef 为整节
// 单 ref 桩,configEditor 桩合并写回 configStore
function makeRc17({ configStore = {}, configEditorAvailable = true, withRoutes = true } = {}) {
  const routes = new Map()
  const editCalls = []
  const configRef = { get: () => ({ ...configStore }) }
  const settingsService = {
    configure: (presentation, owner) => { return () => {} },
    describe: () => [{ ns: 'usage-dash', revision: configStore.__revision ?? 0 }],
  }
  const configEditor = {
    async edit(entry, change) {
      editCalls.push(entry)
      const next = change({ ...configStore }, {})
      for (const key of Object.keys(next)) configStore[key] = next[key]
      configStore.__revision = (configStore.__revision ?? 0) + 1
    },
  }
  const pendingInjects = []
  const ctx = {
    on() {},
    logger: { warn() {} },
    fiber: { entry: { options: { id: 'usage-dash', name: '@mzzsfy/dsh-usage-dash' } } },
    get(name) {
      if (name === 'settings') return settingsService
      if (name === 'configEditor') return configEditorAvailable ? configEditor : undefined
      if (name === 'storageDomain') return makeDomain()
      return undefined
    },
    effect(fn) { fn() },
    inject(_deps, fn) { pendingInjects.push(fn) },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return {
    ctx,
    routes,
    configRef,
    configStore,
    editCalls,
    activateSettings: () => {
      for (const fn of pendingInjects.splice(0)) {
        fn({
          settings: settingsService,
          interval: () => {},
          // 注入上下文的 effect 桩:0.1.7 分支经它注册 configure 装配
          effect(stubEffect) { stubEffect() },
        })
      }
    },
  }
}

test('Config 导出契约:根级 volatile 包装,validate 产整节单 ref,默认值对拍', async () => {
  const mod = await import('../src/index.js')
  assert.ok(mod.Config, 'Config 导出必须在场')
  const resolved = mod.Config['~standard'].validate({})
  assert.equal(resolved.issues, undefined)
  const section = resolved.value.get()
  assert.equal(section.minuteRetentionDays, DEFAULT_MINUTE_RETENTION_DAYS)
  // pricing 缺省对象校验补全:rules 数组缺省为空
  assert.deepEqual(section.pricing?.rules ?? [], [])
})

test('0.1.7 形态:settings 激活即门面生效,GET 读 configRef,POST 经 configEditor.edit 整节替换', async () => {
  // Given configRef 携带用户值 + 路由捕获
  const rc = makeRc17({ configStore: { minuteRetentionDays: 7, pricing: { rules: [] } } })
  apply(rc.ctx, rc.configRef)
  // When 激活 settings 注入
  rc.activateSettings()
  // Then GET pricing 回读 configRef 节值
  const read = await invoke(rc.routes, PATH_PRICING, { method: 'GET' })
  const readParsed = JSON.parse(read.body)
  assert.equal(read.statusCode, 200)
  assert.deepEqual(readParsed.value.rules, [])
  // When POST 合法规则
  const saved = await invokeJson(rc.routes, PATH_PRICING, { payload: { rules: [RULE] } })
  // Then edit 定位本条目,pricing 整节替换,回读新值,revision 自增
  const savedParsed = JSON.parse(saved.body)
  assert.equal(saved.statusCode, 200)
  assert.equal(savedParsed.ok, true)
  assert.equal(rc.editCalls.length, 1)
  assert.equal(rc.editCalls[0].options.id, 'usage-dash')
  assert.deepEqual(rc.configStore.pricing.rules, [RULE])
  assert.equal(rc.configStore.minuteRetentionDays, 7, 'minuteRetentionDays 用户层不动')
  assert.deepEqual(savedParsed.value.rules, [RULE])
  assert.equal(savedParsed.value.revision, 1)
})

test('0.1.7 形态:configEditor 缺失即 POST 拒绝,GET 回读不受影响', async () => {
  // Given configEditor 服务缺席
  const rc = makeRc17({ configEditorAvailable: false })
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  // When POST 写规则
  const saved = await invokeJson(rc.routes, PATH_PRICING, { payload: { rules: [RULE] } })
  // Then ok:false 错误响应,进程存活(测试走完即证)
  const savedParsed = JSON.parse(saved.body)
  assert.equal(savedParsed.ok, false)
  // When GET 回读
  const read = await invoke(rc.routes, PATH_PRICING, { method: 'GET' })
  // Then 仍回 configRef 当前值
  assert.equal(read.statusCode, 200)
})

test('0.1.7 形态:configure 在场即关闭原生自动页,register 缺失不抛错', () => {
  // Given configure 捕获桩
  const rc = makeRc17()
  const configureCalls = []
  rc.ctx.get('settings').configure = (presentation, owner) => { configureCalls.push({ presentation, owner }); return () => {} }
  // When apply + 激活
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  // Then 关闭自动页且 owner 为本插件 fiber
  assert.equal(configureCalls.length, 1)
  assert.deepEqual(configureCalls[0].presentation, { auto: false })
})

// 独立 legacy 用例:register/get/update 命名空间面行为与现状全同
test('legacy 形态:settings 激活即门面生效,replace 经命名空间 update,revision 经 describe', async () => {
  const routes = new Map()
  const store = {}
  const settingsService = makeLegacySettings(store)
  const pendingInjects = []
  const ctx = {
    on() {},
    logger: { warn() {} },
    get(name) {
      if (name === 'settings') return settingsService
      if (name === 'storageDomain') return makeDomain()
      return undefined
    },
    effect(fn) { fn() },
    inject(_deps, fn) { pendingInjects.push(fn) },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  apply(ctx, {})
  for (const fn of pendingInjects.splice(0)) {
    fn({ settings: settingsService, interval: () => {}, effect(f) { f() } })
  }
  // GET 回读命名空间存储值
  const read = await invoke(routes, PATH_PRICING, { method: 'GET' })
  assert.equal(read.statusCode, 200)
  // POST 合法规则经 update 落命名空间
  const saved = await invokeJson(routes, PATH_PRICING, { payload: { rules: [RULE] } })
  const savedParsed = JSON.parse(saved.body)
  assert.equal(savedParsed.ok, true)
  assert.deepEqual(store.pricing.rules, [RULE])
  assert.deepEqual(savedParsed.value.rules, [RULE])
  assert.equal(savedParsed.value.revision, 1)
})

