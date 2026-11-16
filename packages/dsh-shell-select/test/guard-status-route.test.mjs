// guard-status 路由注册(真机 P2):apply 时刻一次性 ctx.get('webServer') 在服务
// 未就绪时永久丢掉注册,guard-status 带 cookie 也 404。注册抽成函数后:服务已就绪
// 走原 ctx.effect;晚到经 ctx.inject 补注册;路由注销随 fiber 卸载,可撤销。
// BDD:
// - Given webServer 已就绪,When installGuard,Then 立即注册 exact 路由;
// - Given webServer 缺席,When installGuard,Then 不注册但登记 inject 待命;服务晚到
//   触发回调后补注册;
// - Given 晚注册的路由,When 子 fiber 卸载,Then 路由撤销(不留重复项);
// - 路由保留宿主闸门:connection 拒绝即按状态码结束,放行时返回状态 JSON。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installGuard } from '../src/guard.js'
import { MAIN_ROW_ID, OFFICIAL_ROW_IDS } from '../src/guard-state.mjs'

function row({ id, disabled = false, running = false }) {
  return {
    options: { id },
    get disabled() {
      return disabled
    },
    fiber: running ? { uid: 'f' } : undefined,
  }
}

// 非死态世界:主行服务中、官方两行启用 → guard 空闲(不代挂,不需要 ctx.plugin)
function liveWorld() {
  return [
    row({ id: MAIN_ROW_ID, disabled: false, running: true }),
    ...OFFICIAL_ROW_IDS.map((id) => row({ id, disabled: false, running: true })),
  ]
}

const silent = {
  importOfficial: async () => ({ apply() {} }),
  delay: async () => {},
  sweepIntervalMs: 60 * 60 * 1000,
}

function fixture({ webServerReady }) {
  const routes = []
  const disposers = []
  const injected = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }
  const services = webServerReady ? { webServer } : {}
  const makeCtx = (serviceMap, track) => ({
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    loader: {
      resolve() {
        throw new Error('not found')
      },
    },
    on: () => {},
    effect: (execute) => {
      const disposer = execute()
      track.push(disposer)
      return disposer
    },
    get: (service) => serviceMap[service],
    // 真 cordis 把服务同时挂在 ctx 属性上;注册函数读属性形态
    get webServer() {
      return serviceMap.webServer
    },
  })
  const ctx = makeCtx(services, disposers)
  // 真 cordis 的 ctx.inject(deps, cb) 在依赖就绪时执行 cb(并在服务变化时重跑);
  // 桩记录依赖与回调,由用例显式模拟"晚到"
  let lateCallback
  ctx.inject = (deps, callback) => {
    injected.push(deps)
    lateCallback = callback
    return { then: () => {} }
  }
  const rows = liveWorld()
  ctx.loader.resolve = (id) => {
    const found = rows.find((candidate) => candidate.options.id === id)
    if (found !== undefined) return found
    throw new Error('not found')
  }
  return {
    ctx,
    routes,
    disposers,
    injected,
    services,
    // 服务晚到:宿主用带 webServer 的新上下文触发 inject 回调
    arriveWebServer() {
      const lateServices = { webServer }
      const lateDisposers = []
      const lateCtx = makeCtx(lateServices, lateDisposers)
      lateCallback(lateCtx)
      return { lateServices, lateDisposers }
    },
  }
}

function responseOf() {
  const out = { status: undefined, headers: undefined, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(body) {
      out.body = body ?? ''
    },
  }
}

test('webServer 就绪:安装即注册 guard-status exact 路由', async () => {
  const world = fixture({ webServerReady: true })
  await installGuard(world.ctx, silent)
  assert.equal(world.routes.length, 1)
  assert.equal(world.routes[0].kind, 'exact')
  assert.equal(world.routes[0].path, '/api/shell-select/guard-status')
  assert.equal(world.injected.length, 0, '服务已就绪不得再登记 inject')
})

test('webServer 晚到:先登记 inject,服务就绪后补注册且状态 JSON 可读', async () => {
  // Given apply 时刻宿主还没提供 webServer
  const world = fixture({ webServerReady: false })
  await installGuard(world.ctx, silent)
  // Then 不注册任何路由,但登记 webServer 依赖待命(旧实现此处永久丢失注册)
  assert.equal(world.routes.length, 0)
  assert.deepEqual(world.injected, [['webServer']])
  // When 服务晚到、宿主执行 inject 回调;Then 路由补注册
  const late = world.arriveWebServer()
  assert.equal(world.routes.length, 1)
  // 放行路径:闸门无拒绝 → 200 + 状态字段
  const res = responseOf()
  await world.routes[0].handler({ headers: { host: '127.0.0.1:9191' } }, res)
  assert.equal(res.out.status, 200)
  const body = JSON.parse(res.out.body)
  assert.deepEqual(Object.keys(body).sort(), [
    'applyState', 'dead', 'mounted', 'mounting', 'officialRaw', 'rowScan', 'rows', 'takeover',
  ])
  assert.deepEqual(body.rows.map((entry) => entry.id), [MAIN_ROW_ID, ...OFFICIAL_ROW_IDS])
  // 闸门拒绝路径:宿主 connection 有拒绝值 → 按其状态码结束,不进业务面
  late.lateServices.connection = { requestRejection: () => 401 }
  const denied = responseOf()
  await world.routes[0].handler({ headers: {} }, denied)
  assert.equal(denied.out.status, 401)
  assert.equal(denied.out.body, 'unauthorized')
})

test('晚注册的路由随子 fiber 卸载撤销', async () => {
  const world = fixture({ webServerReady: false })
  await installGuard(world.ctx, silent)
  const late = world.arriveWebServer()
  assert.equal(world.routes.length, 1)
  // When 子 fiber 卸载(宿主停用/重载);Then 路由撤销,可再次注册不重复
  for (const dispose of late.lateDisposers) dispose()
  assert.equal(world.routes.length, 0)
})

test('webServer 在但 register 非函数(契约不可用):不挂空路由,也不登记 inject', async () => {
  const world = fixture({ webServerReady: false })
  world.services.webServer = {}
  world.ctx.inject = (deps) => {
    throw new Error(`不应登记 inject: ${deps.join(',')} 已在但不可用`)
  }
  await installGuard(world.ctx, silent)
  assert.equal(world.routes.length, 0)
})
