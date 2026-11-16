// 宿主闸门:插件路由必须回问 connection,未认证请求不得进业务面
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { busStub, resetBusStub } from './_mocks.common-tools.mjs'
import { rejectUnadmitted, withHostGate } from '../src/route-gate.mjs'
import { apply } from '../src/index.js'

function ctxWith(connection) {
  return { get: (name) => (name === 'connection' ? connection : undefined) }
}

function makeRes() {
  const res = { status: null, body: null, headers: null, ended: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body) => {
    res.ended = true
    res.body = body
  }
  return res
}

test('G1 无 connection 服务时放行', () => {
  const res = makeRes()
  assert.equal(rejectUnadmitted(ctxWith(undefined), { headers: {} }, res), false)
  assert.equal(res.ended, false)
})

test('G2 宿主拒绝时按状态码回纯文本', () => {
  for (const [status, text] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const res = makeRes()
    assert.equal(rejectUnadmitted(ctxWith({ requestRejection: () => status }), { headers: {} }, res), true)
    assert.equal(res.status, status)
    assert.equal(res.body, text)
  }
})

test('G3 闸门抛错按拒绝处理,不把故障当认证通过', () => {
  const res = makeRes()
  const ctx = ctxWith({ requestRejection: () => { throw new Error('boom') } })
  assert.equal(rejectUnadmitted(ctx, { headers: {} }, res), true)
  assert.equal(res.status, 403)
})

test('G5 11 条插件路由逐条回问宿主闸门:401 时不进业务面', async () => {
  const routes = new Map()
  const settings = {
    register: () => ({ get: () => ({}), watch: () => () => {} }),
    get: () => ({}),
    update: async () => {},
  }
  const ctx = {
    on() {},
    get(key) {
      if (key === 'connection') return { requestRejection: () => 401 }
      if (key === 'settings') return settings
      return undefined
    },
    inject(names, fn) { fn({ settings }) },
    effect(thunk) { thunk() },
    webServer: { register(route) { routes.set(route.path, { handler: route.handler, kind: route.kind }); return () => {} } },
  }
  resetBusStub()
  apply(ctx)
  const calls = [
    ['GET', '/api/turn-notify/projection'],
    ['GET', '/api/turn-notify/sounds'],
    ['POST', '/api/turn-notify/upload'],
    ['GET', '/api/turn-notify/sound'],
    ['PUT', '/api/turn-notify/sound'],
    ['DELETE', '/api/turn-notify/sound'],
    ['POST', '/api/turn-notify/mapping'],
    ['GET', '/api/turn-notify/config'],
    ['POST', '/api/turn-notify/config'],
    ['POST', '/api/turn-notify/test-webhook'],
    ['POST', '/api/turn-notify/focus-desktop'],
    ['POST', '/api/turn-notify/test-host'],
    ['GET', '/api/turn-notify/im-targets'],
    ['POST', '/api/turn-notify/test-im'],
  ]
  assert.deepEqual([...routes.keys()].sort(), [...new Set(calls.map(([, path]) => path))].sort(), '路由清单须与断言清单一致')
  for (const [method, path] of calls) {
    const res = makeRes()
    await routes.get(path).handler({ method, url: path, headers: { host: '127.0.0.1:3080' } }, res)
    assert.equal(res.status, 401, method + ' ' + path + ' 必须由宿主闸门拒绝')
    assert.equal(res.body, 'unauthorized')
  }
})
