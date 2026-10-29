import test from 'node:test'
import assert from 'node:assert/strict'
import { busStub, resetBusStub } from './_mocks.common-tools.mjs'
import { apply } from '../src/index.js'

const PROJECTION_PATH = '/api/turn-notify/projection'
const FOCUS_DESKTOP_PATH = '/api/turn-notify/focus-desktop'

// 路由注册表是服务边界:保留注册直到注销,不允许覆盖既有路由。
function makeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      assert.equal(routes.has(route.path), false, `webserver duplicate exact route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
}

function mount(webServer) {
  const cleanups = []
  const handlers = new Map()
  const ctx = {
    webServer,
    get() {},
    inject() {},
    on(event, handler) { handlers.set(event, handler) },
    effect(thunk) { cleanups.push(thunk()) },
  }
  apply(ctx)
  return {
    handlers,
    dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      handlers.clear()
    },
  }
}

async function readProjection(webServer) {
  const res = {
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
  await webServer.routes.get(PROJECTION_PATH)({ method: 'GET' }, res)
  assert.equal(res.status, 200)
  return res.body
}

function notify(mounted) {
  mounted.handlers.get('session/event')({ id: 'main', header: {} }, {
    type: 'tool/call', data: { name: 'ask_user_question' },
  })
}

test('Given 已注册投影路由 When 插件卸载 Then 路由与在场订阅全部释放', async (t) => {
  resetBusStub()
  const webServer = makeWebServer()
  const mounted = mount(webServer)
  t.after(() => mounted.dispose())
  assert.ok(webServer.routes.has(PROJECTION_PATH))
  assert.ok(webServer.routes.has(FOCUS_DESKTOP_PATH), 'macOS 桌面唤起路由随插件注册')
  assert.equal(busStub.presence.size, 1)
  notify(mounted)
  assert.equal((await readProjection(webServer)).units.length, 1)

  mounted.dispose()

  assert.equal(webServer.routes.has(PROJECTION_PATH), false, '卸载必须释放 projection 路由')
  assert.equal(webServer.routes.has(FOCUS_DESKTOP_PATH), false, '卸载必须释放 focus-desktop 路由')
  assert.equal(webServer.routes.size, 0)
  assert.equal(busStub.presence.size, 0)
})

test('Given 插件已卸载 When 在同一webServer再次apply Then 无重复路由且新投影可继续收事件', async (t) => {
  resetBusStub()
  const webServer = makeWebServer()
  const first = mount(webServer)
  t.after(() => first.dispose())
  notify(first)
  first.dispose()

  const second = mount(webServer)
  t.after(() => second.dispose())

  assert.deepEqual((await readProjection(webServer)).units, [], '重新启用应使用新投影')
  notify(second)
  const snapshot = await readProjection(webServer)
  assert.equal(snapshot.units.length, 1)
  assert.equal(snapshot.units[0].category, 'ask')
  assert.equal(busStub.presence.size, 1)
})
