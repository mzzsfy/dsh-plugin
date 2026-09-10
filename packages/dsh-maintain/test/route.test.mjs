// host 路由集成测试:stub 宿主 ctx 后经 apply 挂载,直接调用捕获的 handler。
// 覆盖:方法守卫 405、跨源守卫 403、各路由业务分支(400/409/500)、
// restart 依赖 appExit、readBody 超限。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, RESTART_DELAY_MS, AUTO_RESTART_DELAY_MS, UPGRADE_LOCK_PATH, collectActiveWork } from '../src/index.js'
import { rmSync, readFileSync } from 'node:fs'

// 锁文件是固定共享路径:测试进程中断可能残留幽灵锁毒化后续运行,用例前预热清理
rmSync(UPGRADE_LOCK_PATH, { force: true })

// 全局 fetch 拦截:core.fetchDistTags 默认绑定全局 fetch,测试期返回与 dist-tags.test
// 同形的流式响应(tags 就绪),防止启动检查/refresh 触发真实网络请求
const MOCK_TAGS = { latest: '9.9.9', next: '10.0.0' }

// 与文件顶部全局 fetch 拦截同形的流式响应体
function tagsBody(tags) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        const chunks = [new TextEncoder().encode(JSON.stringify(tags))]
        return {
          read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
          cancel: async () => {},
        }
      },
    },
  }
}

globalThis.fetch = async () => tagsBody(MOCK_TAGS)

function makeCtx({ appExit, settingsStore, timerAvailable = true, services = {} } = {}) {
  const routes = new Map()
  let tick = null
  const store = settingsStore ?? {}
  const calls = { exits: [], registered: [], disposers: [] }
  const ctx = {
    calls,
    get(name) {
      if (name === 'appExit') return appExit
      if (name === 'settings') return settingsService
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      return undefined
    },
    // effect 桩:执行装配函数并捕获其返回的 disposer,供测试模拟 fiber 停用
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') calls.disposers.push(disposer)
    },
    inject(deps, fn) {
      // timer 服务桩:模拟宿主 timer 激活后的 interval(返回 disposer 同官方契约);
      // timerAvailable=false 模拟服务缺失
      fn({
        settings: settingsService,
        interval: timerAvailable
          ? (intervalFn) => {
              tick = intervalFn
              return () => { if (tick === intervalFn) tick = null }
            }
          : undefined,
      })
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        calls.registered.push(route.path)
      },
    },
    fireTick() {
      if (tick) tick()
    },
    disposeEffects() {
      for (const disposer of calls.disposers) disposer()
    },
  }
  const settingsService = {
    register() {},
    get() {
      return store
    },
    async update(ns, patch) {
      Object.assign(store, patch)
    },
  }
  return { ctx, routes }
}

function makeReq({ method = 'POST', body, headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000', ...headers }
  req.destroy = () => {
    req.destroyed = true
  }
  // 无 body 也须发 end:路由侧读体(如 restart 的 force)对空体解析为空对象
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function makeRes() {
  const res = { status: null, payload: null }
  res.writeHead = (status) => {
    res.status = status
  }
  res.end = (text) => {
    res.payload = text ? JSON.parse(text) : null
  }
  return res
}

async function call(routes, path, req) {
  const handler = routes.get(path)
  assert.ok(handler, '路由未注册: ' + path)
  const res = makeRes()
  await handler(req, res)
  return res
}

const post = (routes, path, body, headers) => call(routes, path, makeReq({ method: 'POST', body, headers }))
const get = (routes, path) => call(routes, path, makeReq({ method: 'GET' }))

// 排空微任务链(setImmediate 为宏任务,先于其执行的全部微任务此后必已完成)
const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve))
// 真实时间等待:mock timers 域内 setTimeout 不再真实计时,以 setImmediate 自旋让出事件循环
const realSleep = (ms) => new Promise((resolve) => {
  const start = Date.now()
  const spin = () => { if (Date.now() - start >= ms) resolve(); else setImmediate(spin) }
  setImmediate(spin)
})

test('挂载:8 条路由注册,启动检查后快照就绪', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  assert.equal(routes.size, 8)
  assert.deepEqual(
    [...routes.keys()].sort(),
    [
      '/api/maintain/channel',
      '/api/maintain/poll-interval',
      '/api/maintain/refresh',
      '/api/maintain/registry-base',
      '/api/maintain/restart',
      '/api/maintain/status',
      '/api/maintain/upgrade',
      '/api/maintain/upgrade-template',
    ],
  )
  // 启动检查是异步链(mock fetch 微任务 + resolveHostVersion 真实文件读),
  // 轮询等快照落定后再断言
  let snapshotReady = false
  for (let waited = 0; waited < 5000; waited += 25) {
    const poll = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
    if (poll.payload.checkedAt !== null) {
      snapshotReady = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(snapshotReady, '启动检查 5 秒内未完成')
  const res = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
  assert.equal(res.status, 200)
  assert.equal(res.payload.packageName, '@deepseek-ai/dsh')
  assert.equal(res.payload.channel, 'latest')
  assert.deepEqual(res.payload.tags, MOCK_TAGS, '启动检查后 dist-tags 必须就绪')
  assert.equal(res.payload.checkError, null)
  assert.ok(res.payload.checkedAt !== null)
  assert.equal(res.payload.pollRunning, true, 'timer 服务激活时自动轮询应武装')
})

test('timer 服务缺失:自动轮询降级,面板状态照常响应', async () => {
  const { ctx, routes } = makeCtx({ timerAvailable: false })
  apply(ctx)
  const res = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
  assert.equal(res.status, 200)
  assert.equal(res.payload.pollRunning, false)
  // 手动检查通道不受影响:refresh 仍可拉取 dist-tags
  const refreshed = await call(routes, '/api/maintain/refresh', makeReq({ body: {} }))
  assert.equal(refreshed.status, 200)
  assert.ok(refreshed.payload.checkedAt !== null)
})

test('interval dispose 回归:fiber 停用后轮询 tick 失效(防双 interval 回归)', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  assert.equal(ctx.calls.disposers.length > 0, true, 'interval dispose 必须经 ctx.effect 挂回插件 fiber')
  // 等启动检查落定,排除其 checkedAt 变化对断言的干扰
  let baseline = null
  for (let waited = 0; waited < 5000; waited += 25) {
    const poll = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
    if (poll.payload.checkedAt !== null) { baseline = poll.payload.checkedAt; break }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(baseline !== null, '启动检查 5 秒内未完成')
  ctx.disposeEffects()
  ctx.fireTick()
  const res = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
  assert.equal(res.payload.checkedAt, baseline, 'dispose 后 fireTick 不得触发新一轮检查')
})

test('方法守卫:全部路由错误方法一律 405', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  for (const path of routes.keys()) {
    const expected = path === '/api/maintain/status' ? 'POST' : 'GET'
    const res = await call(routes, path, makeReq({ method: expected }))
    assert.equal(res.status, 405, path + ' 应拒绝 ' + expected)
  }
})

test('跨源守卫:Origin 与 Host 不符即 403;同源放行;Host 大小写归一', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const evil = await post(routes, '/api/maintain/refresh', undefined, { origin: 'https://evil.example', host: 'localhost:3000' })
  assert.equal(evil.status, 403)
  const ok = await post(routes, '/api/maintain/refresh', undefined, { origin: 'http://localhost:3000' })
  assert.equal(ok.status, 200)
  const upper = await post(routes, '/api/maintain/refresh', undefined, { origin: 'http://LOCALHOST:3000', host: 'LOCALHOST:3000' })
  assert.equal(upper.status, 200, 'Host 头大小写不影响同源判定')
})

test('refresh:触发检查并返回 200 快照', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = await post(routes, '/api/maintain/refresh')
  assert.equal(res.status, 200)
  assert.ok(res.payload.checkedAt !== null)
})

test('channel:空值 400;非法字符 400;不在 tags 400;合法通道走白名单放行', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)

  const empty = await post(routes, '/api/maintain/channel', { channel: '  ' })
  assert.equal(empty.status, 400)

  const malicious = await post(routes, '/api/maintain/channel', { channel: 'latest; rm -rf /' })
  assert.equal(malicious.status, 400)
  assert.match(malicious.payload.error, /非法字符/, '白名单与不在 tags 两条拒绝路径文案可区分')
  assert.equal(store.channel, undefined, '非法通道不得落盘')

  const ghost = await post(routes, '/api/maintain/channel', { channel: 'ghosttag' })
  assert.equal(ghost.status, 400)
  assert.match(ghost.payload.error, /不在当前 dist-tags/, 'tags 就绪时白名单分支生效')

  const ok = await post(routes, '/api/maintain/channel', { channel: 'next' })
  assert.equal(ok.status, 200)
  assert.equal(store.channel, 'next')
})

test('upgrade-template:空值 400;合法值持久化', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const empty = await post(routes, '/api/maintain/upgrade-template', { template: '' })
  assert.equal(empty.status, 400)
  const blank = await post(routes, '/api/maintain/upgrade-template', { template: '   ' })
  assert.equal(blank.status, 400, '空白模板与空值同判,不得落盘')
  assert.equal(store.upgradeCommandTemplate, undefined, '空白模板不得经路由落盘')
  const ok = await post(routes, '/api/maintain/upgrade-template', { template: 'npm i -g pkg@{tag}' })
  assert.equal(ok.status, 200)
  assert.equal(store.upgradeCommandTemplate, 'npm i -g pkg@{tag}')
})

test('poll-interval:负数 400;合法值持久化', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const bad = await post(routes, '/api/maintain/poll-interval', { seconds: -1 })
  assert.equal(bad.status, 400)
  const wide = await post(routes, '/api/maintain/poll-interval', { seconds: '60' })
  assert.equal(wide.status, 400, '字符串宽转必须拒绝')
  const ok = await post(routes, '/api/maintain/poll-interval', { seconds: 0 })
  assert.equal(ok.status, 200)
  assert.equal(store.pollIntervalSec, 0)
})

test('registry-base:非法 scheme 400;合法值持久化', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const bad = await post(routes, '/api/maintain/registry-base', { base: 'ftp://mirror.example' })
  assert.equal(bad.status, 400)
  const ok = await post(routes, '/api/maintain/registry-base', { base: 'https://mirror.example' })
  assert.equal(ok.status, 200)
  assert.equal(store.registryBase, 'https://mirror.example')
})

test('upgrade:运行版本已是通道最新 409 拒绝(防降级),unknown 放行', async () => {
  const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
  // 版本探测注入受控值:CI 无 dsh 本体,真实盘读回 null 会把 verdict 打成 unknown,
  // 防降级门控(核心断言)在 CI 恒不触发
  const { ctx, routes } = makeCtx({
    settingsStore: store,
    services: { hostVersionProbe: () => Promise.resolve('5.4.3') },
  })
  apply(ctx)
  // 注入运行版本远低于假目标版本:verdict 应转 up-to-date,升级入口拒绝
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => tagsBody({ latest: '0.0.1', next: '0.0.2' })
  try {
    const refreshed = await post(routes, '/api/maintain/refresh')
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.payload.verdict, 'up-to-date', '前置:注入运行版本应高于 0.0.1 假目标')
    const denied = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
    assert.equal(denied.status, 409)
    assert.match(denied.payload.error, /已是通道最新版/)
    assert.equal(store.upgradeCommandTemplate, 'node -e "process.exit(0)"', '拒绝路径不得触发升级')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('upgrade:verdict unknown 放行(tags 未就绪不得 409 误拒)', async () => {
  const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
  // fetch 在 apply 前替换:启动检查即失败,tags 保持 null,verdict 恒 unknown
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const { ctx, routes } = makeCtx({ settingsStore: store })
    apply(ctx)
    let snapshot = null
    for (let waited = 0; waited < 5000 && snapshot === null; waited += 25) {
      const poll = await get(routes, '/api/maintain/status').then((r) => r.payload)
      if (poll.checkedAt !== null) snapshot = poll
      else await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(snapshot, '启动检查 5 秒内未完成')
    assert.equal(snapshot.tags, null, '前置:registry 不可达,tags 未就绪')
    assert.equal(snapshot.verdict, 'unknown', '前置:verdict 应为 unknown')
    const allowed = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
    assert.equal(allowed.status, 200, 'verdict unknown 必须放行,不得 409 误拒')
    assert.equal(allowed.payload.upgrade.running, true)
    // 等假命令落定:防残留升级锁毒化后续用例
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const s = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (s && s.upgrade && s.upgrade.running === false && s.upgrade.last !== null) break
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('upgrade:空白模板经 upgrade-template 路由拒绝', async () => {  // 默认模板是真实 npm install 命令,POST upgrade 的默认路径禁止在测试中触发;
  // 门闩语义由"真实挂起命令"用例覆盖,此处锁定保存侧空白拒绝
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const blank = await post(routes, '/api/maintain/upgrade-template', { template: '   ' })
  assert.equal(blank.status, 400)
  assert.equal(store.upgradeCommandTemplate, undefined)
})

test('upgrade:真实挂起命令触达门闩,二次 409,结束后自动重查', async () => {
  const store = { upgradeCommandTemplate: 'node -e "setTimeout(() => {}, 2000)"' }
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const baseline = await get(routes, '/api/maintain/status').then((r) => r.payload)
  const first = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
  assert.equal(first.status, 200)
  assert.equal(first.payload.upgrade.running, true)
  assert.equal(first.payload.upgradeLockHeld, true, '升级期间锁文件持有效力')
  const second = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
  assert.equal(second.status, 409)
  // 等挂起命令自然退出(轮询而非固定 sleep,兼做落定状态显式断言)
  let settled = null
  for (let i = 0; i < 50 && settled === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
    if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
  }
  assert.ok(settled, '升级应在挂起命令退出后落定')
  assert.equal(settled.upgrade.last.ok, true)
  assert.equal(settled.upgradeLockHeld, false, '升级结束后锁文件应删除')
  assert.notEqual(settled.checkedAt, baseline.checkedAt, '升级落定后自动重查链应已刷新 checkedAt')
  assert.ok(settled.checkedAt !== null)
})

test('upgrade:托管+勾选自动重启,命令成功即调度关机且落定钩子零网络零读盘', async (t) => {
  const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
  const exits = []
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    fetchCalls += 1
    return originalFetch(...args)
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { ctx, routes } = makeCtx({ settingsStore: store, appExit: (code) => exits.push(code) })
    apply(ctx)
    // 等启动检查落定,固定网络请求基线(mock timers 域内以 realSleep 自旋让出事件循环)
    let baseline = null
    for (let waited = 0; waited < 5000 && baseline === null; waited += 25) {
      const poll = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (poll && poll.checkedAt !== null) baseline = fetchCalls
      else await realSleep(25)
    }
    assert.ok(baseline !== null, '启动检查 5 秒内未完成')
    const first = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
    assert.equal(first.status, 200)
    let settled = null
    for (let i = 0; i < 50 && settled === null; i += 1) {
      await realSleep(30)
      const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
    }
    assert.ok(settled, '升级应在假命令退出后落定')
    assert.equal(settled.upgrade.last.ok, true)
    // 关机路径零复读:版本复读属升级后磁盘读取,是明确的故障源,砍掉
    assert.equal(settled.upgrade.last.installedVersion, null, '关机路径禁止复读磁盘版本')
    assert.equal(settled.upgrade.last.stale, null, '关机路径无 stale 判定')
    assert.equal(settled.upgrade.last.requiresManualRestart, undefined)
    assert.equal(settled.autoRestartScheduled, true, '命令成功即调度关机(stale 不再抑制)')
    assert.equal(settled.upgradeLockHeld, false, '升级结束后锁文件应删除')
    assert.ok(typeof settled.runtimeEnv === 'object' && typeof settled.runtimeEnv.kind === 'string', 'runtimeEnv 必须进 status')
    // 落定钩子零网络:观察窗口内 fetch 计数不得增长(runCheck 已随关机路径移除)
    await realSleep(300)
    assert.equal(fetchCalls, baseline, '落定钩子禁止网络请求')
    // 关机动作与确认重启同源:延迟窗口后 exit(0),窗口内不得提前
    assert.deepEqual(exits, [], '延迟窗口内不得提前退出')
    t.mock.timers.tick(AUTO_RESTART_DELAY_MS + 1)
    assert.deepEqual(exits, [0], '延迟窗口过后必须调度宿主退出')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(UPGRADE_LOCK_PATH, { force: true })
  }
})

test('restart:升级进行中 409 拒绝且不调度退出', async () => {
  const store = { upgradeCommandTemplate: 'node -e "setTimeout(() => {}, 2000)"' }
  const exits = []
  const { ctx, routes } = makeCtx({ settingsStore: store, appExit: (code) => exits.push(code) })
  apply(ctx)
  const upgrade = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
  assert.equal(upgrade.status, 200)
  const denied = await post(routes, '/api/maintain/restart')
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /升级进行中/)
  // 等挂起命令退出后确认 exit 未被调度(轮询上限 5s)
  let running = true
  for (let i = 0; i < 50 && running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
    running = Boolean(status && status.upgrade && status.upgrade.running)
  }
  assert.deepEqual(exits, [], '409 拒绝路径不得调度 exit')
})

test('upgrade:重启调度后触发升级 409(双向互斥)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { ctx, routes } = makeCtx({ appExit: (code) => exits.push(code) })
  apply(ctx)
  const restart = await post(routes, '/api/maintain/restart')
  assert.equal(restart.status, 200)
  const denied = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /重启已调度/)
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  assert.deepEqual(exits, [0])
})

test('upgrade:重启调度窗口内 refresh 409,registry-base 保存但不发起检查', async (t) => {
  // 关机延迟窗口内网络请求与磁盘读取都是半写状态风险:refresh 全拒,registry-base 只落盘
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = { registryBase: 'https://registry.npmjs.org' }
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    fetchCalls += 1
    return originalFetch(...args)
  }
  try {
    const exits = []
    const { ctx, routes } = makeCtx({ settingsStore: store, appExit: (code) => exits.push(code) })
    apply(ctx)
    let baseline = null
    for (let waited = 0; waited < 5000 && baseline === null; waited += 25) {
      const poll = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (poll && poll.checkedAt !== null) baseline = fetchCalls
      else await realSleep(25)
    }
    assert.ok(baseline !== null, '启动检查 5 秒内未完成')
    const restart = await post(routes, '/api/maintain/restart')
    assert.equal(restart.status, 200)
    const refresh = await post(routes, '/api/maintain/refresh')
    assert.equal(refresh.status, 409, '关机窗口内检查更新必须拒绝')
    const saved = await post(routes, '/api/maintain/registry-base', { base: 'https://mirror.example.org' })
    assert.equal(saved.status, 200, '镜像地址保存照常落盘')
    assert.equal(store.registryBase, 'https://mirror.example.org')
    assert.equal(saved.payload.registryBase, 'https://mirror.example.org', 'status 回显新地址')
    assert.equal(fetchCalls, baseline, '关机窗口内不得发起任何网络检查')
    t.mock.timers.tick(RESTART_DELAY_MS + 1)
    assert.deepEqual(exits, [0])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('status:快照携带 bootAt 实例代际', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const status = await get(routes, '/api/maintain/status')
  assert.equal(status.status, 200)
  assert.equal(typeof status.payload.bootAt, 'number')
  assert.ok(Number.isFinite(status.payload.bootAt) && status.payload.bootAt > 0)
})

test('status:运行版本与已装版本双字段,verdict 以运行版本为准', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  // 等启动检查落定:installedVersion 由检查快照填充
  let ready = null
  for (let waited = 0; waited < 5000 && ready === null; waited += 25) {
    const poll = await call(routes, '/api/maintain/status', makeReq({ method: 'GET' }))
    if (poll.payload.checkedAt !== null) ready = poll.payload
    else await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(ready, '启动检查 5 秒内未完成')
  assert.ok('runningVersion' in ready, 'status 必须返回 runningVersion')
  assert.ok('installedVersion' in ready, 'status 必须返回 installedVersion')
  assert.equal(ready.currentVersion, undefined, '旧 currentVersion 字段移除,不保留兼容层')
  // 静态磁盘下两读一致;磁盘领先运行版本(升级后未重启)才置 restartPending
  assert.equal(ready.installedVersion, ready.runningVersion)
  assert.equal(ready.restartPending, false)
  // 运行版本与已装版本来源不同(apply 缓存 vs 检查快照):缺失时 verdict 未知
  if (ready.runningVersion === null) {
    assert.equal(ready.verdict, 'unknown')
  }
})

test('poll-interval:超上界 400(秒转毫秒溢出防护)', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const huge = await post(routes, '/api/maintain/poll-interval', { seconds: 1e308 })
  assert.equal(huge.status, 400)
  assert.equal(store.pollIntervalSec, undefined, '超上界值不得落盘')
})

test('upgrade:未勾选自动重启,升级成功落定继续运行并标 stale', async (t) => {
  const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
  const exits = []
  const { ctx, routes } = makeCtx({
    settingsStore: store,
    appExit: (code) => exits.push(code),
    // 探针恒读旧版:模拟假命令不改磁盘,复读版本与触发前快照一致即 stale
    services: { hostVersionProbe: () => Promise.resolve('1.0.0') },
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  apply(ctx)
  // 排空启动期微任务链,探针读序此后稳定
  await drainMicrotasks()
  const trigger = await post(routes, '/api/maintain/upgrade', { autoRestart: false })
  assert.equal(trigger.status, 200)
  let settled = null
  try {
    for (let i = 0; i < 50 && settled === null; i += 1) {
      await realSleep(30)
      const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
    }
    assert.ok(settled, '升级应在假命令退出后落定')
    assert.equal(settled.upgrade.last.ok, true)
    // 假命令不改磁盘,复读版本与触发前快照一致 → stale
    assert.equal(settled.upgrade.last.stale, true, '继续运行路径必须复读并标注 stale')
    assert.ok(typeof settled.upgrade.last.reason === 'string' && settled.upgrade.last.reason.length > 0, 'stale 必须带原因')
    assert.equal(settled.autoRestartScheduled, false, '未勾选不得置调度标记')
    assert.equal(settled.upgrade.last.requiresManualRestart, undefined, '托管环境未勾选不标手动指引')
    // 推过完整调度延迟:若误调度,延迟窗口内 exit 必被调用
    t.mock.timers.tick(AUTO_RESTART_DELAY_MS + 1)
    assert.deepEqual(exits, [], '未勾选自动重启时禁止调度任何宿主退出')
  } finally {
    rmSync(UPGRADE_LOCK_PATH, { force: true })
  }
})

test('upgrade:勾选自动重启+落定,延迟窗口后调度宿主退出', async (t) => {
  const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
  const exits = []
  const { ctx, routes } = makeCtx({
    settingsStore: store,
    appExit: (code) => exits.push(code),
    // 关机路径零读盘:探针返回值不影响断言,恒读旧版即可
    services: { hostVersionProbe: () => Promise.resolve('1.0.0') },
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  apply(ctx)
  await drainMicrotasks()
  const trigger = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
  assert.equal(trigger.status, 200)
  let settled = null
  try {
    for (let i = 0; i < 50 && settled === null; i += 1) {
      await realSleep(30)
      const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
    }
    assert.ok(settled, '升级应在假命令退出后落定')
    assert.equal(settled.upgrade.last.ok, true)
    assert.equal(settled.upgrade.last.stale, null, '关机路径零复读,stale 不再判定')
    // 落定可见与调度置位之间隔 runtimeEnvReady 的 await:await 一次 status 让微任务链走完再断言
    const scheduled = await get(routes, '/api/maintain/status').then((r) => r.payload)
    assert.equal(scheduled.autoRestartScheduled, true, '勾选自动重启时升级成功必须调度')
    assert.deepEqual(exits, [], '调度延迟窗口内不得提前退出')
    t.mock.timers.tick(AUTO_RESTART_DELAY_MS + 1)
    assert.deepEqual(exits, [0], '延迟窗口过后必须调度宿主退出')
  } finally {
    rmSync(UPGRADE_LOCK_PATH, { force: true })
  }
})

test('upgrade:autoRestart 缺失或非 boolean 一律 400', async () => {
  // 假命令兜底:本用例期待 400,但若校验意外放行,真实默认模板会当场触发 npm install
  const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const missing = await post(routes, '/api/maintain/upgrade')
  assert.equal(missing.status, 400, '缺失 autoRestart 必须拒绝,防静默翻转关机行为')
  const stringInput = await post(routes, '/api/maintain/upgrade', { autoRestart: 'true' })
  assert.equal(stringInput.status, 400, '字符串宽转必须拒绝')
  const status = await get(routes, '/api/maintain/status').then((r) => r.payload)
  assert.equal(status.upgrade.running, false, '非法输入不得触发升级')
  assert.equal(status.upgrade.last, null, '非法输入不得产生升级记录')
})

test('upgrade:body 校验先于门控,门控命中时非法 body 仍 400', async (t) => {
  // 锁定 handler 顺序:readBody 在全部门控之前,门控到置位之间零 await
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
  const { ctx, routes } = makeCtx({ settingsStore: store, appExit: () => {} })
  apply(ctx)
  await post(routes, '/api/maintain/restart')
  const denied = await post(routes, '/api/maintain/upgrade')
  assert.equal(denied.status, 400, 'body 非法时即使门控(重启已调度)命中也必须 400')
})

test('registry-base:带 query 或 hash 的输入 400', async () => {
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const withQuery = await post(routes, '/api/maintain/registry-base', { base: 'https://example.com?mirror=1' })
  assert.equal(withQuery.status, 400)
  const withHash = await post(routes, '/api/maintain/registry-base', { base: 'https://example.com#frag' })
  assert.equal(withHash.status, 400)
  assert.equal(store.registryBase, undefined)
})

test('restart:缺失 appExit 500;响应立即返回,延迟退出', async (t) => {
  const withoutExit = makeCtx()
  apply(withoutExit.ctx)
  const denied = await post(withoutExit.routes, '/api/maintain/restart')
  assert.equal(denied.status, 500)

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { ctx, routes } = makeCtx({ appExit: (code) => exits.push(code) })
  apply(ctx)
  const ok = await post(routes, '/api/maintain/restart')
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.restarting, true)
  // 响应交付瞬间宿主必须仍在:exit 只能在延迟窗口之后执行
  assert.deepEqual(exits, [], '响应返回时 exit 不得已触发')
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  assert.deepEqual(exits, [0])
})

test('restart:延迟窗口内重复请求幂等,exit 仅调度一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { ctx, routes } = makeCtx({ appExit: (code) => exits.push(code) })
  apply(ctx)
  const first = await post(routes, '/api/maintain/restart')
  assert.equal(first.status, 200)
  const second = await post(routes, '/api/maintain/restart')
  assert.equal(second.status, 200)
  assert.equal(second.payload.restarting, true)
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  assert.deepEqual(exits, [0], '重复请求不得叠加调度 exit')
})

test('readBody 超限:路由归一 400', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const req = makeReq({ method: 'POST' })
  const res = makeRes()
  const done = routes.get('/api/maintain/channel')(req, res)
  req.emit('data', Buffer.alloc(64 * 1024 + 1, 'x'))
  await done
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /上限/)
})

// ---- 活跃工作门控(S10)----

test('collectActiveWork:agents/jobs/terminals 计活与去重', () => {
  const terminals = {
    list: (owner) => owner && owner.id === 'a1'
      ? [{ sessionId: 't1', status: { kind: 'running' } }, { sessionId: 't3', status: { kind: 'exited' } }]
      : [{ sessionId: 't1', status: { kind: 'running' } }, { sessionId: 't2', status: { kind: 'running' } }],
  }
  const agentA = { id: 'a1', status: 'running', ctx: { get: (n) => (n === 'terminals' ? terminals : undefined) } }
  const agentB = { id: 'a2', status: 'idle' }
  const agents = { list: () => [agentA, agentB] }
  const jobs = {
    list: (caller) => caller === undefined
      ? [{ id: 'j1', status: 'running' }]
      : [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'stopping' }, { id: 'j3', status: 'done' }],
  }
  const result = collectActiveWork({ get: (n) => (n === 'agents' ? agents : n === 'jobs' ? jobs : n === 'terminals' ? terminals : undefined) })
  // agents:a1 running;a jobs:j1 双 caller 去重计一,j2 stopping 计活,j3 不计;terminals:t1 去重,t2 计,t3 非运行不计
  assert.deepEqual({ agents: result.agents, jobs: result.jobs, terminals: result.terminals }, { agents: 1, jobs: 2, terminals: 2 })
  assert.equal(result.total, 5)
  assert.equal(result.detectionAvailable, true)
})

test('collectActiveWork:服务缺失或异常 fail-open 降级', () => {
  const empty = collectActiveWork({ get: () => undefined })
  assert.deepEqual([empty.agents, empty.jobs, empty.terminals], [0, 0, 0])
  assert.equal(empty.detectionAvailable, false)
  const throwing = { get: () => ({ list: () => { throw new Error('boom') } }) }
  const degraded = collectActiveWork(throwing)
  assert.equal(degraded.total, 0)
  assert.equal(degraded.detectionAvailable, false)
  // 根作用域 terminals 缺失但 agent realm 有,不算降级(realm 隔离常态)
  const agent = { id: 'a1', status: 'idle', ctx: { get: (n) => (n === 'terminals' ? { list: () => [{ sessionId: 't1', status: { kind: 'running' } }] } : undefined) } }
  const realmOnly = collectActiveWork({ get: (n) => (n === 'agents' ? { list: () => [agent] } : n === 'jobs' ? { list: () => [] } : undefined) })
  assert.equal(realmOnly.terminals, 1)
  assert.equal(realmOnly.detectionAvailable, true)
})

test('upgrade:存在活跃工作 409 拒绝,不可越', async () => {
  const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
  const agents = { list: () => [{ id: 'a1', status: 'running' }] }
  const jobs = { list: () => [] }
  const terminals = { list: () => [] }
  const { ctx, routes } = makeCtx({ settingsStore: store, services: { agents, jobs, terminals } })
  apply(ctx)
  const denied = await post(routes, '/api/maintain/upgrade', { autoRestart: true })
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /活跃工作/)
  assert.equal(denied.payload.items.agents, 1)
  assert.equal(denied.payload.detectionAvailable, true)
  const status = await get(routes, '/api/maintain/status').then((r) => r.payload)
  assert.equal(status.upgrade.running, false, '拒绝路径不得触发升级')
})

test('restart:活跃工作 409,force 越过', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const agents = { list: () => [{ id: 'a1', status: 'running' }] }
  const jobs = { list: () => [] }
  const { ctx, routes } = makeCtx({ appExit: (code) => exits.push(code), services: { agents, jobs } })
  apply(ctx)
  const denied = await post(routes, '/api/maintain/restart')
  assert.equal(denied.status, 409)
  assert.match(denied.payload.error, /活跃工作/)
  assert.deepEqual(exits, [])
  const forced = await post(routes, '/api/maintain/restart', { force: true })
  assert.equal(forced.status, 200)
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  assert.deepEqual(exits, [0], 'force 越过后必须正常调度退出')
})

test('status:activeWork 概要进快照,服务缺失标 detectionAvailable=false', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const status = await get(routes, '/api/maintain/status').then((r) => r.payload)
  assert.equal(status.activeWork.total, 0)
  assert.equal(status.activeWork.detectionAvailable, false)
})

// ---- 批 2 审查建议落地 ----

test('restart:null 体按空体处理,内部形态不泄漏', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = []
  const { ctx, routes } = makeCtx({ appExit: (code) => exits.push(code) })
  apply(ctx)
  const ok = await post(routes, '/api/maintain/restart', 'null')
  assert.equal(ok.status, 200, 'null 体须按空体处理,不得以内部错误形态 400/500 泄漏')
  t.mock.timers.tick(RESTART_DELAY_MS + 1)
  assert.deepEqual(exits, [0], 'null 体等价空体:正常调度退出')
})

test('自动重启接线:落定链消费运行环境并分流调度与手动指引(源码形态锁定)', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const settle = source.match(/const decision = judgeAutoRestart\(\{([\s\S]*?)\}\)/)
  assert.ok(settle, '落定链缺少 judgeAutoRestart 判定')
  assert.match(settle[1], /runtimeKind: runtimeEnv\.kind/, '落定判定必须消费运行环境检测结果')
  assert.match(source, /if \(decision\.requiresManualRestart === true\) last\.requiresManualRestart = true/, '手动直跑指引必须回写 last')
  assert.match(source, /if \(decision\.schedule === true\) \{[\s\S]*?last\.autoRestartScheduled = true[\s\S]*?scheduleHostExit\(\{ detail: 'reason=upgrade-ok', autoRestart: true/, '调度链必须置位标记并经统一退出入口关机')
})

test('upgrade:env 注入手动直跑环境,落定链保守分流零退出', async () => {
  process.env.DSH_MAINTAIN_RUNTIME_ENV = 'manual'
  try {
    const store = { upgradeCommandTemplate: 'node -e "process.exit(0)"' }
    const exits = []
    const { ctx, routes } = makeCtx({ settingsStore: store, appExit: (code) => exits.push(code) })
    apply(ctx)
    await post(routes, '/api/maintain/upgrade', { autoRestart: true })
    let settled = null
    for (let i = 0; i < 50 && settled === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const status = await get(routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) settled = status
    }
    assert.ok(settled, '升级应在假命令退出后落定')
    assert.equal(settled.runtimeEnv.kind, 'manual-start-likely', 'env 注入必须经 apply 检测进 status')
    assert.equal(settled.autoRestartScheduled, false, '手动直跑禁止调度自动重启')
    assert.deepEqual(exits, [], '手动直跑禁止任何宿主退出')
    // 手动直跑标环境指引:命令成功即提示手动重启(指引不再被 stale 抑制)
    assert.equal(settled.upgrade.last.requiresManualRestart, true, '手动直跑必须标手动重启指引')
  } finally {
    delete process.env.DSH_MAINTAIN_RUNTIME_ENV
  }
})

// ---- 审计日志(S12)----

test('audit:触发/落定/拒绝各留一行结构化日志', async () => {
  const warns = []
  const originalWarn = console.warn
  console.warn = (text) => warns.push(String(text))
  try {
    const agents = { list: () => [{ id: 'a1', status: 'running' }] }
    const { ctx, routes } = makeCtx({ services: { agents }, appExit: () => {} })
    apply(ctx)
    await post(routes, '/api/maintain/upgrade', { autoRestart: true })
    assert.equal(warns.some((text) => text.includes('audit endpoint=upgrade outcome=rejected reason=active-work')), true, '门控拒绝须留审计行')
    await post(routes, '/api/maintain/restart')
    assert.equal(warns.some((text) => text.includes('audit endpoint=restart outcome=rejected reason=active-work')), true, '重启门控拒绝须留审计行')
    await post(routes, '/api/maintain/restart', { force: true })
    assert.equal(warns.some((text) => /audit endpoint=restart outcome=triggered\b/.test(text) && text.includes('forced=true')), true, 'force 触发须留审计行')
  } finally {
    console.warn = originalWarn
  }
  // 升级触发与落定:假命令真实进程,落定行带 durationMs 与 code
  const plainWarns = []
  const plainCtx = makeCtx({ settingsStore: { upgradeCommandTemplate: 'node -e "process.exit(0)"' }, appExit: () => {} })
  console.warn = (text) => plainWarns.push(String(text))
  try {
    apply(plainCtx.ctx)
    await post(plainCtx.routes, '/api/maintain/upgrade', { autoRestart: true })
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const status = await get(plainCtx.routes, '/api/maintain/status').then((r) => r.payload).catch(() => null)
      if (status && status.upgrade && status.upgrade.running === false && status.upgrade.last !== null) break
    }
  } finally {
    console.warn = originalWarn
  }
  assert.equal(plainWarns.some((text) => /audit endpoint=upgrade outcome=triggered/.test(text)), true, '升级触发须留审计行')
  assert.equal(plainWarns.some((text) => /audit endpoint=upgrade outcome=(ok|failed) durationMs=[0-9]+ code=/.test(text)), true, '升级落定须留审计行')
})