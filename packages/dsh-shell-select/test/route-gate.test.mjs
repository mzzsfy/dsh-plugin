// 宿主闸门:插件路由必须回问 connection,未认证请求不得进业务面;
// 写方法再叠同源与 JSON content-type(withRouteGate),读方法只过宿主闸门
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rejectUnadmitted, withHostGate, withRouteGate } from '../src/route-gate.mjs'

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

function makeReq(method, headers = {}) {
  return { method, headers: { host: '127.0.0.1:9291', ...headers } }
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

test('G4 withHostGate 拒绝时业务不执行,放行时透传', async () => {
  let called = 0
  const blocked = withHostGate(ctxWith({ requestRejection: () => 401 }), async () => { called += 1 })
  await blocked({ headers: {} }, makeRes())
  assert.equal(called, 0)
  const seen = []
  const pass = withHostGate(ctxWith(undefined), async (req, res) => { seen.push(req, res) })
  const req = { headers: {} }
  const res = makeRes()
  await pass(req, res)
  assert.deepEqual(seen, [req, res])
})

test('G5 withRouteGate:GET 只过宿主闸门(无写副作用面不加同源/CT)', async () => {
  const seen = []
  const handler = withRouteGate(ctxWith(undefined), async (req) => { seen.push(req.method) })
  const res = makeRes()
  await handler(makeReq('GET', { origin: 'http://evil.example' }), res)
  assert.deepEqual(seen, ['GET'])
  assert.equal(res.ended, false)
})

test('G6 withRouteGate:写方法 text/plain 400,Host 大小写同源 200,跨源 403', async () => {
  const seen = []
  const handler = withRouteGate(ctxWith(undefined), async (req) => { seen.push(req.method) })
  const plain = makeRes()
  await handler(makeReq('POST', { origin: 'http://127.0.0.1:9291', 'content-type': 'text/plain' }), plain)
  assert.equal(plain.status, 400)
  assert.deepEqual(seen, [], 'CT 门拒绝时业务不执行')

  const same = makeRes()
  await handler(makeReq('POST', { origin: 'http://LocalHost:9291', host: 'LOCALHOST:9291', 'content-type': 'application/json; charset=utf-8' }), same)
  assert.equal(same.ended, false, '同源 + JSON 必须放行到业务')
  assert.deepEqual(seen, ['POST'])

  const cross = makeRes()
  await handler(makeReq('POST', { origin: 'http://evil.example', 'content-type': 'application/json' }), cross)
  assert.equal(cross.status, 403)
  assert.deepEqual(seen, ['POST'], '跨源拒绝时业务不执行')
})

test('G7 withRouteGate:宿主闸门优先于同源/CT(未认证不泄露写协议细节)', async () => {
  const res = makeRes()
  let called = 0
  const handler = withRouteGate(ctxWith({ requestRejection: () => 401 }), async () => { called += 1 })
  await handler(makeReq('POST', { origin: 'http://evil.example', 'content-type': 'text/plain' }), res)
  assert.equal(res.status, 401)
  assert.equal(called, 0)
})
