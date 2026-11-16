// 宿主闸门 + 写路由同源守卫:插件路由必须回问 connection,POST 必须同源且 JSON
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rejectCrossOrigin, rejectNonJson, rejectUnadmitted, withHostGate, withRouteGate } from '../src/route-gate.mjs'

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

function req(method, headers) {
  return { method, headers: headers || {} }
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

test('G4 withRouteGate 拒绝时业务不执行,放行时透传', async () => {
  let called = 0
  const blocked = withRouteGate(ctxWith({ requestRejection: () => 401 }), async () => { called += 1 })
  await blocked(req('POST', { 'content-type': 'application/json' }), makeRes())
  assert.equal(called, 0)
  const seen = []
  const pass = withRouteGate(ctxWith(undefined), async (request, response) => { seen.push(request, response) })
  const request = req('GET', {})
  const res = makeRes()
  await pass(request, res)
  assert.deepEqual(seen, [request, res])
})

test('C1 无 Origin 的非浏览器请求放行', () => {
  const res = makeRes()
  assert.equal(rejectCrossOrigin(req('POST', { host: '127.0.0.1:3080' }), res), false)
})

test('G5 withHostGate 保持纯宿主闸门语义(其余包共用副本)', async () => {
  let called = 0
  const handler = withHostGate(ctxWith(undefined), async () => { called += 1 })
  await handler(req('POST', { origin: 'http://evil.example' }), makeRes())
  assert.equal(called, 1, 'withHostGate 不做写守卫,只回问宿主闸门')
})

test('C2 Origin 与 Host 同源放行(大小写不敏感)', () => {
  const res = makeRes()
  assert.equal(rejectCrossOrigin(req('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), res), false)
  assert.equal(rejectCrossOrigin(req('POST', { host: 'LOCALHOST:3080', origin: 'http://localhost:3080' }), res), false)
})

test('C3 跨源或非法 Origin 一律 403', () => {
  for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:9999', 'not a url']) {
    const res = makeRes()
    assert.equal(rejectCrossOrigin(req('POST', { host: '127.0.0.1:3080', origin }), res), true, origin)
    assert.equal(res.status, 403)
  }
})

test('C4 POST 非 JSON content-type 一律 400', () => {
  for (const contentType of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'text/plain; charset=utf-8']) {
    const res = makeRes()
    assert.equal(rejectNonJson(req('POST', contentType === undefined ? {} : { 'content-type': contentType }), res), true, String(contentType))
    assert.equal(res.status, 400)
  }
  for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
    const res = makeRes()
    assert.equal(rejectNonJson(req('POST', { 'content-type': contentType }), res), false, contentType)
  }
})

test('C6 content-type 按 essence 精确比较:子串混入的伪装形态一律 400', () => {
  // 旧实现 includes('application/json') 会放行这些跨站简单请求可构造的形态
  for (const contentType of ['application/jsonp', 'text/plain; application/json', 'application/jsonx', 'application/vnd.api+json']) {
    const res = makeRes()
    assert.equal(rejectNonJson(req('POST', { 'content-type': contentType }), res), true, contentType)
    assert.equal(res.status, 400)
  }
  // essence 后参数不影响判定(大小写/空白/参数均归一)
  for (const contentType of [' application/json ; charset=utf-8', 'application/json; boundary=x']) {
    const res = makeRes()
    assert.equal(rejectNonJson(req('POST', { 'content-type': contentType }), res), false, contentType)
  }
})

test('C5 withRouteGate:POST 跨源先于业务;GET 不受 Origin/JSON 约束', async () => {
  let called = 0
  const handler = withRouteGate(ctxWith(undefined), async () => { called += 1 })
  const cross = makeRes()
  await handler(req('POST', { host: '127.0.0.1:3080', origin: 'http://evil.example', 'content-type': 'application/json' }), cross)
  assert.equal(cross.status, 403)
  const nonJson = makeRes()
  await handler(req('POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'text/plain' }), nonJson)
  assert.equal(nonJson.status, 400)
  assert.equal(called, 0, '被拒绝的写请求不得进入业务')
  const get = makeRes()
  await handler(req('GET', { origin: 'http://evil.example' }), get)
  assert.equal(called, 1, 'GET 不走写守卫')
})
