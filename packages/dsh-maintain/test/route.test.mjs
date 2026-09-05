// host 路由集成测试:stub 宿主 ctx 后经 apply 挂载,直接调用捕获的 handler。
// 覆盖:方法守卫 405、跨源守卫 403、各路由业务分支(400/409/500)、
// restart 依赖 appExit、readBody 超限。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, RESTART_DELAY_MS } from '../src/index.js'

// 全局 fetch 拦截:core.fetchDistTags 默认绑定全局 fetch,测试期返回与 dist-tags.test
// 同形的流式响应(tags 就绪),防止启动检查/refresh 触发真实网络请求
const MOCK_TAGS = { latest: '9.9.9', next: '10.0.0' }
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  body: {
    getReader: () => {
      const chunks = [new TextEncoder().encode(JSON.stringify(MOCK_TAGS))]
      return {
        read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
        cancel: async () => {},
      }
    },
  },
})

function makeCtx({ appExit, settingsStore, timerAvailable = true } = {}) {
  const routes = new Map()
  let tick = null
  const store = settingsStore ?? {}
  const calls = { exits: [], registered: [], disposers: [] }
  const ctx = {
    calls,
    get(name) {
      if (name === 'appExit') return appExit
      if (name === 'settings') return settingsService
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
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    })
  }
  return req
}

function makeRes() {
  const res = { status: null, payload: null }
  res.writeHead = (status) => {
    res.status = status
  }
  res.end = (text, onFlushed) => {
    res.payload = text ? JSON.parse(text) : null
    if (typeof onFlushed === 'function') onFlushed()
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

test('upgrade:空白模板经 upgrade-template 路由拒绝', async () => {
  // 默认模板是真实 npm install 命令,POST upgrade 的默认路径禁止在测试中触发;
  // 门闩语义由"真实挂起命令"用例覆盖,此处锁定保存侧空白拒绝
  const store = {}
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const blank = await post(routes, '/api/maintain/upgrade-template', { template: '   ' })
  assert.equal(blank.status, 400)
  assert.equal(store.upgradeCommandTemplate, undefined)
})

test('upgrade:真实挂起命令触达门闩,二次 409', async () => {
  const store = { upgradeCommandTemplate: 'node -e "setTimeout(() => {}, 2000)"' }
  const { ctx, routes } = makeCtx({ settingsStore: store })
  apply(ctx)
  const first = await post(routes, '/api/maintain/upgrade')
  assert.equal(first.status, 200)
  assert.equal(first.payload.upgrade.running, true)
  const second = await post(routes, '/api/maintain/upgrade')
  assert.equal(second.status, 409)
  // 等挂起命令自然退出,避免测试运行器等待子进程树
  await new Promise((resolve) => setTimeout(resolve, 3000))
})

test('restart:缺失 appExit 500;响应立即返回,冲刷完成后延迟退出', async () => {
  const withoutExit = makeCtx()
  apply(withoutExit.ctx)
  const denied = await post(withoutExit.routes, '/api/maintain/restart')
  assert.equal(denied.status, 500)

  const exits = []
  const { ctx, routes } = makeCtx({ appExit: (code) => exits.push(code) })
  apply(ctx)
  const ok = await post(routes, '/api/maintain/restart')
  assert.equal(ok.status, 200)
  assert.equal(ok.payload.restarting, true)
  // 响应交付瞬间宿主必须仍在:exit 只能在冲刷回调触发的延迟之后执行
  assert.deepEqual(exits, [], '响应返回时 exit 不得已触发')
  await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS + 100))
  assert.deepEqual(exits, [0])
})

test('restart:延迟窗口内重复请求幂等,exit 仅调度一次', async () => {
  const exits = []
  const { ctx, routes } = makeCtx({ appExit: (code) => exits.push(code) })
  apply(ctx)
  const first = await post(routes, '/api/maintain/restart')
  assert.equal(first.status, 200)
  const second = await post(routes, '/api/maintain/restart')
  assert.equal(second.status, 200)
  assert.equal(second.payload.restarting, true)
  await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS + 100))
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