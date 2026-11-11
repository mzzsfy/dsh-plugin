// 宿主闸门:插件路由必须回问 connection,未认证请求不得进业务面
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rejectUnadmitted, withHostGate } from '../src/route-gate.mjs'

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
