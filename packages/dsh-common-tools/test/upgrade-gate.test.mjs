import test from 'node:test'
import assert from 'node:assert/strict'
import { setupCommonTools, __test } from '../src/host.js'

const ROUTE = '/api/bus/ws'
const { rejectionStatus } = __test

// 最小宿主:闸门实现按用例注入,registerUpgrade 捕获真实注册的 upgrade 路由
function gate(t, requestRejection) {
  delete globalThis.__dshCommonTools
  const upgrades = new Map(), cleanups = []
  const ctx = {
    fiber: { entry: { options: { name: '@mzzsfy/gate' } } },
    webServer: {
      registerUpgrade(route) {
        assert.equal(upgrades.has(route.path), false)
        upgrades.set(route.path, route)
        return () => upgrades.delete(route.path)
      },
    },
    get: service => (service === 'connection' ? { requestRejection } : undefined),
    effect(fn) { cleanups.push(fn()) },
    dispose() { while (cleanups.length) cleanups.pop()() },
  }
  t.after(() => { ctx.dispose(); delete globalThis.__dshCommonTools })
  setupCommonTools(ctx)
  const route = upgrades.get(ROUTE)
  assert.ok(route, 'upgrade 路由应已注册')
  return route
}

// 假 socket:拒绝面只该写状态行并销毁,任一路径进入 handleUpgrade 都会因缺 socket 语义抛错
function fakeSocket() {
  const socket = { written: [], write(chunk) { socket.written.push(chunk) }, destroy() { socket.destroyed = true } }
  return socket
}

test('Given 闸门非错误码返回值 When 收敛状态码 Then 一律 403 且 undefined 放行', () => {
  assert.equal(rejectionStatus(undefined), undefined)
  for (const value of [401, 403, 499, 500, 503, 599]) assert.equal(rejectionStatus(value), value, `rejection=${value} 应按码`)
  // null/0/对象/Promise/NaN 拼进状态行会产出非法 HTTP 状态行,须收敛为 403
  for (const value of [null, 0, {}, [], NaN, '403', '401', true, false, 399, 600, Infinity, Promise.resolve(401)]) {
    assert.equal(rejectionStatus(value), 403, `rejection=${String(value)} 应收敛为 403`)
  }
})

test('Given 宿主闸门返回 null/0/对象/NaN When upgrade Then 状态行是 403 且销毁 socket', t => {
  const route = gate(t, req => req.gate)
  for (const rejection of [null, 0, {}, NaN]) {
    const socket = fakeSocket()
    route.handler({ headers: {}, gate: rejection }, socket, null)
    assert.deepEqual(socket.written, ['HTTP/1.1 403 Forbidden\r\n\r\n'], `rejection=${String(rejection)} 的状态行`)
    assert.equal(socket.destroyed, true)
  }
})

test('Given 宿主闸门返回整数状态 When upgrade Then 按码回状态行且 401 用 Unauthorized', t => {
  const route = gate(t, req => req.gate)
  const expected = [[401, 'HTTP/1.1 401 Unauthorized\r\n\r\n'], [403, 'HTTP/1.1 403 Forbidden\r\n\r\n'], [503, 'HTTP/1.1 503 Forbidden\r\n\r\n']]
  for (const [rejection, line] of expected) {
    const socket = fakeSocket()
    route.handler({ headers: {}, gate: rejection }, socket, null)
    assert.deepEqual(socket.written, [line])
    assert.equal(socket.destroyed, true)
  }
})
