// settings 注入集成测试:apply 的 pricing 门面双形分派(legacy 方法面 / 0.1.7
// 静态 Config + configEditor 面)。stub ctx 装载真实 src/index.js,经捕获的
// /api/usage-dash/pricing 路由驱动门面,验证激活与读写链路。

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { CLIENT_BODY } from './client-eval.mjs'

const { apply } = await import('../src/index.js')
// client 半区出厂默认值:与宿主 SETTINGS_SCHEMA.statsLine 默认逐项对拍(双实现同源)
const { STATS_LINE_DEFAULT_PREFS } = new Function(`${CLIENT_BODY}\nreturn { STATS_LINE_DEFAULT_PREFS }`)()

const PATH_PRICING = '/api/usage-dash/pricing'
const DEFAULT_MINUTE_RETENTION_DAYS = 7

const RULE = {
  model: 'default/deepseek-chat',
  currency: '¥',
  price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  conditions: [],
}

const CONFIGURED_RULES = [RULE, { ...RULE, model: '*/*', price: { ...RULE.price, input: 5 } }]

// sharedStore/sharedPricingStore 单例按 storageDomain 缓存:每例独立 facility
// 防串扰;表为内存 Map,断言直接读行,不落盘
const tableHandle = (rows) => ({
  get: (key) => rows.get(key),
  entries: () => rows.entries(),
  keys: () => rows.keys(),
  get size() { return rows.size },
  put: async (key, value) => { rows.set(key, value) },
  delete: async (key) => rows.delete(key),
  update: async (key, fn) => {
    if (!rows.has(key)) throw new Error(`no record ${key} to update`)
    const next = fn(rows.get(key))
    rows.set(key, next)
    return next
  },
})

// 单 facility 多域:域表按 `<domain>.<table>` 分行,opened 记录打开过的域名
function makeFacility() {
  const tables = new Map()
  const opened = []
  const rowsOf = (domain, table) => {
    const key = `${domain}.${table}`
    if (!tables.has(key)) tables.set(key, new Map())
    return tables.get(key)
  }
  return {
    opened,
    rows: rowsOf,
    async open(spec) {
      opened.push(spec.name)
      return { name: spec.name, table: (table) => tableHandle(rowsOf(spec.name, table)) }
    },
  }
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

// legacy 方法面桩(≤0.1.6 SettingsProvider):register/get/update/describe 命名空间语义。
// 定价规则已移出配置节,这里只承载其余节
function makeLegacySettings(store = {}) {
  let revision = 0
  return {
    register() {},
    get: () => store,
    update: async (_ns, patch) => {
      if (patch.cycle) store.cycle = { ...(store.cycle ?? {}), ...patch.cycle }
      if (patch.minuteRetentionDays !== undefined) store.minuteRetentionDays = patch.minuteRetentionDays
      revision += 1
    },
    describe: () => [{ ns: 'usage-dash', revision }],
  }
}

// 0.1.7 形态桩:settings 无 register/get(configure/describe 在),configRef 为整节
// 单 ref 桩,configEditor 桩按 entry.options.config 的当前原文整节替换写回
function makeRc17({ configStore = {}, configEditorAvailable = true } = {}) {
  const routes = new Map()
  const editCalls = []
  const facility = makeFacility()
  let revision = 0
  const configRef = { get: () => ({ ...configStore }) }
  const settingsService = {
    configure: () => () => {},
    describe: () => [{ ns: 'usage-dash', revision }],
  }
  const entry = {
    options: {
      id: 'usage-dash',
      name: '@mzzsfy/dsh-usage-dash',
      // getter 反映桩存储:迁移读原始 config,删除键后重读即为新值
      get config() { return configStore },
    },
  }
  const configEditor = {
    async edit(target, change) {
      editCalls.push(target)
      const next = change(structuredClone(target.options.config ?? {}), {})
      for (const key of Object.keys(configStore)) if (!(key in next)) delete configStore[key]
      Object.assign(configStore, next)
      revision += 1
    },
  }
  const pendingInjects = []
  const ctx = {
    on() {},
    logger: { warn() {} },
    fiber: { entry },
    storageDomain: facility,
    get(name) {
      if (name === 'settings') return settingsService
      if (name === 'configEditor') return configEditorAvailable ? configEditor : undefined
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
    facility,
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
  // 定价规则不进配置节:profile 只留零碎设置,规则表由 usage_pricing 域承载
  assert.equal(Object.hasOwn(section, 'pricing'), false, '配置节不得再出现 pricing')
  // 底栏偏好默认值与 client DEFAULT_PREFS 同源:展示增强开、替换与请求详情关
  assert.deepEqual(section.statsLine, {
    cachePrecision: true,
    tokenDetail: true,
    costDisplay: true,
    recentSpeed: true,
    replaceSpeed: false,
    requestDetails: false,
  })
  // client.js 的出厂默认值必须与宿主 schema 默认值逐项一致
  assert.deepEqual(STATS_LINE_DEFAULT_PREFS, section.statsLine, 'client/宿主出厂默认值不一致')
})

test('0.1.7 形态:定价规则读写落在 usage_pricing 域,profile 配置节不被写入', async () => {
  // Given 配置节只有零碎设置
  const rc = makeRc17({ configStore: { minuteRetentionDays: 7 } })
  apply(rc.ctx, rc.configRef)
  // When 激活 settings 注入
  rc.activateSettings()
  // Then GET pricing 空表
  const read = await invoke(rc.routes, PATH_PRICING, { method: 'GET' })
  const readParsed = JSON.parse(read.body)
  assert.equal(read.statusCode, 200)
  assert.deepEqual(readParsed.value.rules, [])
  assert.equal(rc.facility.opened.includes('usage_pricing'), true, '定价域必须打开')
  // When POST 合法规则
  const saved = await invokeJson(rc.routes, PATH_PRICING, { payload: { rules: CONFIGURED_RULES } })
  // Then 写进定价域,revision 自增,配置节与 configEditor 都不参与
  const savedParsed = JSON.parse(saved.body)
  assert.equal(saved.statusCode, 200)
  assert.equal(savedParsed.ok, true)
  assert.equal(rc.editCalls.length, 0, '定价写入不再经 configEditor')
  const row = rc.facility.rows('usage_pricing', 'rules').get('current')
  assert.deepEqual(row.rules, CONFIGURED_RULES)
  assert.equal(row.revision, 1)
  assert.deepEqual(savedParsed.value.rules, CONFIGURED_RULES)
  assert.equal(savedParsed.value.revision, 1)
  assert.equal(rc.configStore.minuteRetentionDays, 7, '其它设置不动')
  assert.equal(Object.hasOwn(rc.configStore, 'pricing'), false, '配置节不得写入定价')
})

test('0.1.7 形态:GET/POST 归一重复 */* 与同模型多条无条件', async () => {
  // Given 定价域存量规则含两条 */* 与一个精确模型,全局组排在前面
  const globalOne = { ...RULE, model: '*/*', price: { ...RULE.price, input: 1 } }
  const globalTwo = { ...RULE, model: '*/*', price: { ...RULE.price, input: 9 } }
  const exact = { ...RULE, model: 'p/m', price: { ...RULE.price, input: 3 } }
  const rc = makeRc17()
  rc.facility.rows('usage_pricing', 'rules').set('current', {
    rules: [globalOne, exact, globalTwo],
    revision: 1,
    updatedAt: 0,
  })
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  // Then GET 只保留首条 */*，其余规则保留提交顺序
  const read = JSON.parse((await invoke(rc.routes, PATH_PRICING, { method: 'GET' })).body)
  assert.deepEqual(read.value.rules.map((item) => [item.model, item.price.input]), [['*/*', 1], ['p/m', 3]])
  // When 再写一组重复规则:提交序首条 9 胜出,POST 回读同口径
  const saved = JSON.parse((await invokeJson(rc.routes, PATH_PRICING, {
    payload: { rules: [globalTwo, globalOne, exact] },
  })).body)
  assert.deepEqual(saved.value.rules.map((item) => [item.model, item.price.input]), [['*/*', 9], ['p/m', 3]])
})

test('0.1.7 形态:configEditor 缺席不影响定价写入(规则表已脱离配置槽位)', async () => {
  // Given configEditor 服务缺席
  const rc = makeRc17({ configEditorAvailable: false })
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  // When POST 写规则
  const saved = await invokeJson(rc.routes, PATH_PRICING, { payload: { rules: CONFIGURED_RULES } })
  // Then 仍写进定价域,不再依赖 profile 编辑能力
  const savedParsed = JSON.parse(saved.body)
  assert.equal(saved.statusCode, 200)
  assert.equal(savedParsed.ok, true)
  assert.deepEqual(rc.facility.rows('usage_pricing', 'rules').get('current').rules, CONFIGURED_RULES)
  assert.equal(rc.editCalls.length, 0)
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

// 独立 legacy 用例:settings 方法面照常启用其余配置,定价规则同样落独立域
test('legacy 形态:settings 激活即门面生效,定价读写走 usage_pricing 域', async () => {
  const routes = new Map()
  const store = {}
  const facility = makeFacility()
  const settingsService = makeLegacySettings(store)
  const pendingInjects = []
  const ctx = {
    on() {},
    logger: { warn() {} },
    storageDomain: facility,
    get(name) {
      if (name === 'settings') return settingsService
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
  // GET 空表
  const read = await invoke(routes, PATH_PRICING, { method: 'GET' })
  assert.equal(read.statusCode, 200)
  assert.deepEqual(JSON.parse(read.body).value.rules, [])
  // POST 合法规则落定价域,命名空间不再承载 pricing
  const saved = await invokeJson(routes, PATH_PRICING, { payload: { rules: CONFIGURED_RULES } })
  const savedParsed = JSON.parse(saved.body)
  assert.equal(savedParsed.ok, true)
  assert.deepEqual(facility.rows('usage_pricing', 'rules').get('current').rules, CONFIGURED_RULES)
  assert.equal(store.pricing, undefined)
  assert.deepEqual(savedParsed.value.rules, CONFIGURED_RULES)
  assert.equal(savedParsed.value.revision, 1)
})

// —— 存量配置迁移:profile 的 pricing 节搬进定价域后从补丁删键 ——
test('迁移:profile 存量 pricing 规则搬进定价域并从配置节删除', async () => {
  const rc = makeRc17({ configStore: { minuteRetentionDays: 7, pricing: { rules: [RULE] } } })
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  // 迁移在 apply 里异步进行:等域打开与 configEditor.edit 完成
  for (let attempt = 0; attempt < 50 && Object.hasOwn(rc.configStore, 'pricing'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.equal(Object.hasOwn(rc.configStore, 'pricing'), false, '配置节应删除 pricing')
  assert.equal(rc.configStore.minuteRetentionDays, 7, '其它设置不受影响')
  assert.equal(rc.editCalls.length, 1, '迁移只经一次 profile 编辑')
  assert.deepEqual(rc.facility.rows('usage_pricing', 'rules').get('current').rules, [RULE])
  const read = JSON.parse((await invoke(rc.routes, PATH_PRICING, { method: 'GET' })).body)
  assert.deepEqual(read.value.rules, [RULE])
})

test('迁移:定价域打开失败时不删配置节(规则不丢)', async () => {
  const rc = makeRc17({ configStore: { pricing: { rules: [RULE] } } })
  rc.ctx.storageDomain = {
    async open(spec) {
      if (spec.name === 'usage_pricing') throw new Error('backend-not-found')
      return { name: spec.name, table: () => tableHandle(new Map()) }
    },
  }
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  // 迁移因导入失败而中止:等降级告警落地后断言配置节原样保留
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(rc.editCalls.length, 0, '导入失败不得删配置节')
  assert.deepEqual(rc.configStore.pricing?.rules, [RULE])
})

test('迁移:定价域已有规则时不用旧配置覆盖(只重试删键)', async () => {
  const newer = { ...RULE, price: { ...RULE.price, input: 9 } }
  const rc = makeRc17({ configStore: { pricing: { rules: [RULE] } } })
  rc.facility.rows('usage_pricing', 'rules').set('current', { rules: [newer], revision: 3, updatedAt: 0 })
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  for (let attempt = 0; attempt < 50 && Object.hasOwn(rc.configStore, 'pricing'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.equal(Object.hasOwn(rc.configStore, 'pricing'), false)
  assert.deepEqual(rc.facility.rows('usage_pricing', 'rules').get('current').rules, [newer])
  assert.equal(rc.facility.rows('usage_pricing', 'rules').get('current').revision, 3)
})

test('降级:定价域打开失败时 GET 和 POST 均为 503', async () => {
  const rc = makeRc17({ configStore: {} })
  rc.ctx.storageDomain = {
    async open(spec) {
      if (spec.name === 'usage_pricing') throw new Error('backend-not-found')
      return { name: spec.name, table: () => tableHandle(new Map()) }
    },
  }
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  const read = await invoke(rc.routes, PATH_PRICING, { method: 'GET' })
  assert.equal(read.statusCode, 503)
  assert.match(JSON.parse(read.body).error.message, /pricing unavailable/)
  const saved = await invokeJson(rc.routes, PATH_PRICING, { payload: { rules: [RULE] } })
  const savedParsed = JSON.parse(saved.body)
  assert.equal(saved.statusCode, 503)
  assert.equal(savedParsed.ok, false)
  assert.match(savedParsed.error.message, /pricing unavailable/)
})


// —— features 与宿主投影:四个开关默认全关,开关只在 features 一节,投影到预算与哨兵 ——
test('0.1.7 形态:features 默认全关,写入落在 features 一节,预算节不落 enabled', async () => {
  const rc = makeRc17({ configStore: { budget: { daily: { limit: 100, action: 'warn' }, monthly: { limit: 0, action: 'warn' } } } })
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  // Then 默认全关
  const initial = JSON.parse((await invoke(rc.routes, '/api/usage-dash/features', { method: 'GET' })).body)
  assert.deepEqual(initial.value.features, { whatif: false, guard: false, sentinel: false, dock: false })
  // Then 额度照常存着,但预算节里没有 enabled:开关只在 features
  assert.deepEqual(rc.configStore.budget, { daily: { limit: 100, action: 'warn' }, monthly: { limit: 0, action: 'warn' } })
  // When 打开护栏
  const saved = await invokeJson(rc.routes, '/api/usage-dash/features', {
    payload: { features: { whatif: false, guard: true, sentinel: false, dock: false } },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(JSON.parse(saved.body).value.features.guard, true)
  // Then 开关写进 features 一节,预算配置一字不动
  assert.deepEqual(rc.configStore.features, { whatif: false, guard: true, sentinel: false, dock: false })
  assert.deepEqual(rc.configStore.budget, { daily: { limit: 100, action: 'warn' }, monthly: { limit: 0, action: 'warn' } })
})

test('0.1.7 形态:开关写回落在 features 一节,不动预算与哨兵阈值', async () => {
  const rc = makeRc17({ configStore: { budget: { daily: { limit: 50, action: 'block' } }, sentinel: { burnMultiplier: 4 } } })
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  await invokeJson(rc.routes, '/api/usage-dash/features', {
    payload: { features: { whatif: true, guard: false, sentinel: false, dock: true } },
  })
  assert.deepEqual(rc.configStore.features, { whatif: true, guard: false, sentinel: false, dock: true })
  assert.deepEqual(rc.configStore.budget, { daily: { limit: 50, action: 'block' } }, '预算配置不被开关写入碰到')
  assert.deepEqual(rc.configStore.sentinel, { burnMultiplier: 4 }, '哨兵阈值不被开关写入碰到')
})

// —— 计费周期门面:两代 settings 面都要能读写,未激活时 POST 拒绝 ——
test('0.1.7 形态:计费周期写入落在 cycle 一节,GET 回包窗口跟随', async () => {
  const rc = makeRc17()
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  const before = await invoke(rc.routes, '/api/usage-dash/cycle', { method: 'GET' })
  assert.equal(before.statusCode, 200)
  assert.equal(JSON.parse(before.body).value.config.kind, 'calendar')
  const saved = await invokeJson(rc.routes, '/api/usage-dash/cycle', { payload: { cycle: { kind: 'monthly', startDay: 15 } } })
  const parsed = JSON.parse(saved.body)
  assert.equal(parsed.ok, true)
  assert.deepEqual(rc.configStore.cycle, { kind: 'monthly', startDay: 15, days: 30 })
  assert.equal(parsed.value.window.from.slice(8), '15')
})

test('legacy 形态:计费周期写入经命名空间 update,GET 回读生效', async () => {
  const routes = new Map()
  const store = {}
  const settingsService = makeLegacySettings(store)
  const pendingInjects = []
  const ctx = {
    on() {},
    logger: { warn() {} },
    storageDomain: makeFacility(),
    get(name) {
      if (name === 'settings') return settingsService
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
  const saved = await invokeJson(routes, '/api/usage-dash/cycle', { payload: { cycle: { kind: 'rolling', days: 45 } } })
  assert.equal(JSON.parse(saved.body).ok, true)
  assert.deepEqual(store.cycle, { kind: 'rolling', startDay: 1, days: 45 })
  const read = await invoke(routes, '/api/usage-dash/cycle', { method: 'GET' })
  assert.equal(JSON.parse(read.body).value.config.kind, 'rolling')
})

test('0.1.7 形态:configEditor 缺失时计费周期 POST 拒绝而 GET 可用', async () => {
  const rc = makeRc17({ configEditorAvailable: false })
  apply(rc.ctx, rc.configRef)
  rc.activateSettings()
  const res = await invokeJson(rc.routes, '/api/usage-dash/cycle', { payload: { cycle: { kind: 'calendar' } } })
  assert.equal(JSON.parse(res.body).ok, false)
  const read = await invoke(rc.routes, '/api/usage-dash/cycle', { method: 'GET' })
  assert.equal(read.statusCode, 200)
})
