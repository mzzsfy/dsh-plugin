// 装配测试:数据目录解析 + webServer prefix 注册 + settings/timer 接线 + 装配后请求可用。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

const mod = await import('../src/index.js')
const { apply, resolveDataDir } = mod

test('index:数据目录默认 ~/.dsh/cron-board,env 可覆盖', () => {
  assert.equal(resolveDataDir({}), join(homedir(), '.dsh', 'cron-board'))
  assert.equal(resolveDataDir({ DSH_CRON_BOARD_DATA_DIR: 'X:\\tmp\\cb' }), 'X:\\tmp\\cb')
  // 空白覆盖不生效,回默认
  assert.equal(resolveDataDir({ DSH_CRON_BOARD_DATA_DIR: '   ' }), join(homedir(), '.dsh', 'cron-board'))
})

test('index:apply 注册 prefix 路由且请求走通(列表接口)', async () => {
  // Given webServer 桩:收集注册路由(sessionController 经 get 桩供给,就绪等待同步完成)
  const routes = new Map()
  const sessionController = {
    create: async () => ({ sessionId: 's-x' }),
    // 镜像宿主 facade 契约:prompt 准入首行非可选链校验 signal
    prompt: async (args, signal) => {
      signal.throwIfAborted()
      return { accepted: true }
    },
  }
  const ctx = {
    effect(fn, label) {
      if (label === 'cron-board session wait') { fn(); return }
      fn()
    },
    inject() {},
    get(name) {
      if (name === 'sessionController') return sessionController
      return undefined
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  }
  // When apply(装配)
  apply(ctx)
  // Then prefix 路由已注册
  const handler = routes.get('/api/cron-board')
  assert.ok(handler)
  // When 调用未匹配的子路径(数据目录未初始化也可得到 404 JSON)
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = JSON.parse(text) }
  const req = { method: 'GET', url: 'http://localhost/api/cron-board/__nope__' }
  await handler(req, res)
  assert.equal(res.status, 404)
  assert.ok(res.payload.error)
})

// 装配桩:webServer + settings + timer + 会话服务,记录注册与 interval 形态
function makeFullCtx({ timerAvailable = true } = {}) {
  const routes = new Map()
  const registered = []
  let value = {}
  const settingsService = {
    register(ns, schema, options) {
      registered.push(ns)
      return { get: () => value, watch() {} }
    },
    get: () => value,
  }
  const sessions = new Map()
  let nextId = 0
  const sessionController = {
    async create() {
      const sessionId = 's-' + (++nextId)
      sessions.set(sessionId, { id: sessionId, status: 'running' })
      return { sessionId }
    },
    async prompt(args, signal) {
      // 镜像宿主 facade 契约:prompt 准入首行非可选链校验 signal
      signal.throwIfAborted()
      queueMicrotask(() => {
        const entry = sessions.get(args.sessionId)
        if (entry) entry.status = 'idle'
      })
      return { accepted: true }
    },
  }
  const intervals = []
  const ctx = {
    effect(fn, label) {
      // 会话等待 effect 是真实定时器轮询形态,桩跳过直接执行体;controller 经 get 即可判
      if (label === 'cron-board session wait') { fn(); return }
      fn()
    },
    get(name) {
      if (name === 'settings') return settingsService
      if (name === 'sessionController') return sessionController
      if (name === 'agents') return { get: (id) => sessions.get(id) }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (name === 'agentPresets') return { defaultId: '', list: async () => [] }
      if (name === 'sessionQuery') {
        return {
          // 镜像宿主最严准入契约:守护 driver 总是传信号(真实宿主各版本为可选链);
          // 记录形态镜像官方 SessionRecord(dsh-session-query):id 在 header.id
          listSessions: async (signal) => {
            signal.throwIfAborted()
            return [...sessions.values()].map((entry) => ({ header: { id: entry.id }, live: true, persisted: false }))
          },
        }
      }
      return undefined
    },
    inject(deps, fn) {
      if (deps[0] === 'timer') {
        fn({
          interval(intervalFn, ms) {
            intervals.push({ fn: intervalFn, ms })
            return () => {}
          },
        })
      }
      if (deps[0] === 'settings') {
        fn({ settings: settingsService })
      }
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  }
  return { ctx, routes, registered, intervals, settingsService, sessions }
}

test('index:inject 仅声明 webServer(sessionController 异步就绪等待,不进 inject)', async () => {
  // Given sessionController 由 dsh-web-app 条目异步挂载:inject 声明在 0.1.1-rc.2 上
  // 永久 pending 拖死 boot,apply 内同步探测又抢在挂载前误判(0.1.2-rc.1 实测 404)
  // Then 静态锁定 inject 声明;就绪语义由 effect 内轮询等待 + 超时禁用承担
  assert.deepEqual(mod.inject, ['webServer'])
})

test('index:sessionController 恒缺失时超时干净禁用会话通道(脚本任务不受影响)', async () => {
  // Given 无 sessionController 的宿主上下文(等价 0.1.1-rc.2)
  const routes = new Map()
  const warnings = []
  const effects = []
  const ctx = {
    effect(fn, label) {
      if (label === 'cron-board session wait') effects.push(fn)
      else fn()
    },
    inject() {},
    logger: { warn: (line) => warnings.push(line) },
    get: () => undefined,
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  }
  // When apply(路由同步注册,会话等待 effect 挂起)
  apply(ctx)
  // Then 路由已注册(脚本任务可用),等待 effect 在列
  assert.equal(routes.size, 1)
  assert.equal(effects.length, 1)
  // When 超时轮询终结(缩短等待:直接跑完等待窗)
  effects[0]()
})

test('index:settings 注册 cron-board 命名空间且 timer 承载默认周期 tick', async () => {
  // Given 全服务桩
  const { ctx, registered, intervals } = makeFullCtx()
  // When apply
  apply(ctx)
  // Then 命名空间注册,默认周期 30s 的 interval 建立
  assert.deepEqual(registered, ['cron-board'])
  assert.deepEqual(intervals.map((entry) => entry.ms), [30 * 1000])
})

test('index:settings.update 异步拒绝(镜像 rc.1 无命名空间条目)被路由级 catch 接住降级 400,不打崩进程', async () => {
  // Given settings.update 返回 rejected promise 的宿主形态(0.1.7-rc.1 L3 实测:
  // "No configurable plugin entry 'cron-board'" 在异步段抛出,不 await 时逃逸成
  // uncaughtException 打崩宿主;await 后由 api.handle 路由级 catch 接住)
  const { ctx, settingsService } = makeFullCtx()
  settingsService.update = () => Promise.reject(new Error("No configurable plugin entry 'cron-board'"))
  delete settingsService.get
  const captured = []
  const ctx2 = {
    ...ctx,
    get(name) {
      if (name === 'settings') return settingsService
      return ctx.get(name)
    },
    webServer: { register(route) { captured.push(route); return () => {} } },
  }
  apply(ctx2)
  const route = captured[0]
  assert.ok(route)
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = JSON.parse(text) }
  const req = { method: 'POST', url: 'http://localhost/api/cron-board/ui-settings', headers: { 'content-type': 'application/json' } }
  req.on = (event, fn) => { if (event === 'data') setImmediate(() => fn(Buffer.from(JSON.stringify({ sidebarTab: true })))); if (event === 'end') setImmediate(fn) }
  await route.handler(req, res)
  // Then 路由级 catch 接住,降级 400 系统级错误响应,进程存活(测试正常走完即证)
  assert.equal(res.status, 400)
  assert.ok(res.payload.error)
})

test('index:tickSeconds 设置变更经 watch 重建 interval', async () => {
  // Given 全服务桩,settings.register 的 watch 回调被捕获
  let watchFn = null
  const { ctx, intervals, settingsService } = makeFullCtx()
  settingsService.register = () => ({ get: () => ({}), watch(fn) { watchFn = fn } })
  apply(ctx)
  assert.deepEqual(intervals.map((entry) => entry.ms), [30 * 1000])
  // When 设置变更触发 watch
  watchFn()
  // Then interval 重建
  assert.equal(intervals.length, 2)
})

test('index:tick 到期任务被调度执行(端到端装配)', async (t) => {
  // Given 全服务桩 + 临时数据目录 + 一个已到期任务
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-idx-'))
  t.after(async () => {
    delete process.env.DSH_CRON_BOARD_DATA_DIR
    // 运行终态可见后执行链仍有后台落盘(任务卡回填/日志写),与目录删除竞态,有界重试消解
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  process.env.DSH_CRON_BOARD_DATA_DIR = dir
  const { ctx, routes, intervals } = makeFullCtx()
  const { apply: applyFresh } = await import('../src/index.js?' + Date.now())
  applyFresh(ctx)
  const handler = routes.get('/api/cron-board')
  const post = (path, body) => {
    const res = { status: null, payload: null }
    res.writeHead = (status) => { res.status = status }
    res.end = (text) => { res.payload = JSON.parse(text) }
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = 'http://localhost' + path
    // 装配层初始化后才挂读体监听:桩事件须延后发射(真实 http 流自带缓冲,无此问题)
    setTimeout(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    }, 80)
    return handler(req, res).then(() => res)
  }
  await post('/api/cron-board/jobs', {
    name: 'idx-e2e', kind: 'shell',
    command: `${process.execPath} -e "console.log('idx-marker')"`,
    schedule: '* * * * *', enabled: true, nextRunAt: Date.now() - 100,
  })
  // When 触发一次 tick(等价 timer 到点回调)
  assert.equal(intervals.length, 1)
  intervals[0].fn()
  // Then cron 触发记录产生且状态终态
  const record = await waitForRecord(() => pollRuns(handler))
  assert.equal(record.trigger, 'cron')
  assert.equal(record.status, 'success')
})

async function pollRuns(handler) {
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = JSON.parse(text) }
  const req = { method: 'GET', url: 'http://localhost/api/cron-board/runs' }
  await handler(req, res)
  return res.payload.items
}

function waitForRecord(poll, timeoutMs = 10 * 1000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      void poll().then((items) => {
        const row = items.find((item) => item.trigger === 'cron')
        if (row && row.status !== 'queued' && row.status !== 'running') {
          resolve(row)
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('waitForRecord 超时'))
          return
        }
        setTimeout(tick, 50)
      }).catch(reject)
     }
     tick()
   })
}

// --- 0.1.7 settings 面双形适配(maintain a913c2c 同构) ---

// 0.1.7 形态装配桩:settings 无 register/get(宿主已移除),config 为整节单 ref 桩,
// configEditor 桩经 change 合并后原样写回(模拟 loader 仅 volatile 变化的原地热更)
function makeRc17Ctx({ configStore = {}, configEditorAvailable = true, configureAvailable = true } = {}) {
  const routes = new Map()
  const calls = { editCalls: [], configureCalls: [], registerCalls: [] }
  const config = { get: () => ({ ...configStore }) }
  const settingsService = {}
  if (configureAvailable) {
    settingsService.configure = (presentation, owner) => {
      calls.configureCalls.push({ presentation, owner })
      return () => {}
    }
  }
  const configEditor = {
    async edit(entry, change) {
      calls.editCalls.push(entry)
      const next = change({ ...configStore }, {})
      for (const [key, value] of Object.entries(next)) configStore[key] = value
    },
  }
  const effects = []
  const ctx = {
    calls,
    fiber: { entry: { options: { id: 'cron-board', name: '@mzzsfy/dsh-cron-board' } } },
    effect(fn, label) {
      // 会话等待轮询为真实定时器形态:桩跳过(与 makeFullCtx 同款),其余同步执行
      if (label === 'cron-board session wait') return
      effects.push(fn)
      fn()
    },
    get(name) {
      if (name === 'settings') return settingsService
      if (name === 'configEditor') return configEditorAvailable ? configEditor : undefined
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionQuery') return { listSessions: async () => [] }
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (name === 'agentPresets') return { defaultId: '', list: async () => [] }
      return undefined
    },
    inject(deps, fn) {
      if (deps[0] === 'timer') {
        fn({ interval(intervalFn) { return () => {} } })
      }
      if (deps[0] === 'settings') {
        fn({
          settings: settingsService,
          effect(stubEffect) {
            const disposer = stubEffect()
            if (typeof disposer === 'function') effects.push(disposer)
          },
        })
      }
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
  }
  return { ctx, routes, config, configStore, calls, effects }
}

// ui-settings 请求走 prefix 路由(api.handle 按 method+segments 分发);
// 需真实数据目录(getRuntime 装配 store),env 注入临时目录
async function callApi(routes, path, body) {
  const handler = routes.get('/api/cron-board')
  assert.ok(handler, 'prefix 路由未注册')
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = text ? JSON.parse(text) : null }
  const req = new EventEmitter()
  req.method = body === undefined ? 'GET' : 'POST'
  req.url = 'http://localhost' + path
  req.headers = { 'content-type': 'application/json' }
  // 装配层初始化后才挂读体监听:桩事件须延后发射(与既有 post 桩同款)
  setTimeout(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  }, 80)
  await handler(req, res)
  return res
}

test('Config 导出契约:根级 volatile 包装,validate 产整节单 ref,默认值对拍', () => {
  // Given 静态 Config 导出(0.1.7 节表单事实源)
  assert.ok(mod.Config, 'Config 导出必须在场')
  // When 空配置校验
  const resolved = mod.Config['~standard'].validate({})
  // Then 产整节单 ref(get 协议),字段为 schema 默认值
  assert.equal(resolved.issues, undefined)
  const section = resolved.value.get()
  assert.equal(section.tickSeconds, 30)
  assert.equal(section.maxConcurrent, 2)
  assert.equal(section.logKeepPerJob, 200)
  assert.equal(section.maskEnvInPrompt, false)
  assert.equal(section.sidebarTab, false)
  // When 显式值校验
  // Then 值透传
  const provided = mod.Config['~standard'].validate({ sidebarTab: true }).value.get()
  assert.equal(provided.sidebarTab, true)
})

test('0.1.7 形态:ui-settings GET 读 config 节值(ref 解包),非默认值', async (t) => {
  // Given settings 无 register/get 的宿主 + config ref 携带用户值
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-rc17-'))
  t.after(async () => {
    delete process.env.DSH_CRON_BOARD_DATA_DIR
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  process.env.DSH_CRON_BOARD_DATA_DIR = dir
  const { ctx, routes, config } = makeRc17Ctx({ configStore: { sidebarTab: true, tickSeconds: 60 } })
  apply(ctx, config)
  // When GET ui-settings
  const res = await callApi(routes, '/api/cron-board/status')
  // Then 返回 config 节值
  assert.equal(res.status, 200)
  assert.equal(res.payload.ui.sidebarTab, true)
})

test('0.1.7 形态:ui-settings POST 经 configEditor.edit 落 fiber.entry 且持久合并', async (t) => {
  // Given configEditor 桩记录 edit 调用
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-rc17-'))
  t.after(async () => {
    delete process.env.DSH_CRON_BOARD_DATA_DIR
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  process.env.DSH_CRON_BOARD_DATA_DIR = dir
  const { ctx, routes, config, configStore, calls } = makeRc17Ctx({ configStore: { tickSeconds: 60 } })
  apply(ctx, config)
  // When POST 写 sidebarTab
  const res = await callApi(routes, '/api/cron-board/ui-settings', { sidebarTab: true })
  // Then edit 定位本条目,合并写回,响应 200 携新值
  assert.equal(res.status, 200)
  assert.equal(calls.editCalls.length, 1)
  assert.equal(calls.editCalls[0].options.id, 'cron-board')
  assert.equal(configStore.sidebarTab, true)
  assert.equal(configStore.tickSeconds, 60)
  assert.equal(res.payload.ui.sidebarTab, true)
})

test('0.1.7 形态:configEditor 缺失即 200 ok:false 拒写,不崩溃', async (t) => {
  // Given configEditor 服务缺席
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-rc17-'))
  t.after(async () => {
    delete process.env.DSH_CRON_BOARD_DATA_DIR
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  process.env.DSH_CRON_BOARD_DATA_DIR = dir
  const { ctx, routes, config } = makeRc17Ctx({ configEditorAvailable: false })
  apply(ctx, config)
  // When POST 写设置
  const res = await callApi(routes, '/api/cron-board/ui-settings', { sidebarTab: true })
  // Then ok:false 拒写(api 层 persisted=false 语义),进程存活(测试走完即证)
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, false)
})

test('0.1.7 形态:settings.configure 在场即关闭原生自动页,缺席静默跳过', () => {
  // Given configure 在场
  const { ctx, calls, config } = makeRc17Ctx()
  apply(ctx, config)
  // Then 关闭自动页,owner 为本插件 fiber
  assert.deepEqual(calls.configureCalls, [{ presentation: { auto: false }, owner: ctx.fiber }])
  // Given configure 缺席
  const bare = makeRc17Ctx({ configureAvailable: false })
  // When apply
  // Then 不抛错(测试走完即证)
  apply(bare.ctx, bare.config)
})

test('0.1.7 形态:settings 注入回调不因 register 缺失抛错', () => {
  // Given settings 桩全空方法面(比真实宿主更严)
  const { ctx, config } = makeRc17Ctx({ configureAvailable: false })
  // When apply
  // Then 注入回调静默返回,无异常
  apply(ctx, config)
})
