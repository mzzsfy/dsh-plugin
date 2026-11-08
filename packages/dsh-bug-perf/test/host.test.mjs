import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../src/config.mjs'
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

function makeCtx({ server, registerError } = {}) {
  const registrations = []
  const disposed = []
  const ctx = {
    get: (service) => (service === 'webServer' ? server : undefined),
    effect: (factory) => {
      const dispose = factory()
      ctx.effects.push(dispose)
      return dispose
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

// Given 宿主提供 webServer, When 插件激活, Then 注册只读配置路由且路径固定
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
})

// Given 浏览器上报采样, When 宿主收到合法载荷, Then 返回 ok 并落盘
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
