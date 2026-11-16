// 宿主闸门:插件路由必须回问 connection,未认证请求不得进业务面
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

test('G1 无 connection 服务时放行,不写响应', () => {
  const res = makeRes()
  assert.equal(rejectUnadmitted(ctxWith(undefined), { headers: {} }, res), false)
  assert.equal(res.ended, false)
})

test('G2 无 requestRejection 方法时放行', () => {
  const res = makeRes()
  assert.equal(rejectUnadmitted(ctxWith({}), { headers: {} }, res), false)
})

test('G3 宿主拒绝时按状态码回纯文本并中断', () => {
  for (const [status, text] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const res = makeRes()
    const ctx = ctxWith({ requestRejection: () => status })
    assert.equal(rejectUnadmitted(ctx, { headers: {} }, res), true)
    assert.equal(res.status, status)
    assert.equal(res.body, text)
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
  }
})

test('G4 闸门抛错按拒绝处理,不把故障当认证通过', () => {
  const res = makeRes()
  const ctx = ctxWith({ requestRejection: () => { throw new Error('boom') } })
  assert.equal(rejectUnadmitted(ctx, { headers: {} }, res), true)
  assert.equal(res.status, 403)
})

test('G5 withHostGate 拒绝时业务处理器不执行', async () => {
  let called = 0
  const handler = withHostGate(ctxWith({ requestRejection: () => 401 }), async () => { called += 1 })
  const res = makeRes()
  await handler({ headers: {} }, res)
  assert.equal(called, 0)
  assert.equal(res.status, 401)
})

test('G6 withHostGate 放行时透传 req/res', async () => {
  const seen = []
  const handler = withHostGate(ctxWith({ requestRejection: () => undefined }), async (req, res) => {
    seen.push(req, res)
  })
  const req = { headers: {} }
  const res = makeRes()
  await handler(req, res)
  assert.deepEqual(seen, [req, res])
})

function gateCtx() {
  return ctxWith({ requestRejection: () => undefined })
}

test('G7 withRouteGate:POST/PATCH/DELETE 缺 JSON content-type 一律 400,handler 不执行', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    let called = 0
    const handler = withRouteGate(gateCtx(), async () => { called += 1 })
    const res = makeRes()
    await handler({ method, headers: { host: 'localhost' } }, res)
    assert.equal(called, 0, method + ' 缺 content-type 不得进业务')
    assert.equal(res.status, 400)
  }
})

test('G8 withRouteGate:application/json 精确 essence 放行,PATCH/DELETE 同样覆盖', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    let called = 0
    const handler = withRouteGate(gateCtx(), async () => { called += 1 })
    const res = makeRes()
    await handler({ method, headers: { 'content-type': 'application/json; charset=utf-8' } }, res)
    assert.equal(called, 1, method + ' 合法 JSON 必须放行')
    assert.equal(res.status, null)
  }
})

test('G9 withRouteGate:application/jsonp 与 text/plain 混入按非 JSON 拒绝', async () => {
  for (const contentType of ['application/jsonp', 'text/plain; application/json', 'Application/JSONX']) {
    const handler = withRouteGate(gateCtx(), async () => { throw new Error('不得执行') })
    const res = makeRes()
    await handler({ method: 'POST', headers: { 'content-type': contentType } }, res)
    assert.equal(res.status, 400, contentType + ' 不得通过')
  }
})

test('G10 withRouteGate:GET 不要求 content-type;写方法跨源先于 JSON 拒绝', async () => {
  let called = 0
  const get = withRouteGate(gateCtx(), async () => { called += 1 })
  await get({ method: 'GET', headers: {} }, makeRes())
  assert.equal(called, 1)
  const post = withRouteGate(gateCtx(), async () => { called += 1 })
  const res = makeRes()
  await post({ method: 'POST', headers: { origin: 'http://evil.example', host: 'localhost', 'content-type': 'text/plain' } }, res)
  assert.equal(res.status, 403, '跨源必须优先于 JSON 拒绝')
  assert.equal(called, 1)
})
