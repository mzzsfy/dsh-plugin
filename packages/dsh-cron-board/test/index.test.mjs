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
      if (name === 'sessionQuery') return { listSessions: async () => [...sessions.values()].map((entry) => ({ id: entry.id })) }
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
    await rm(dir, { recursive: true, force: true })
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
