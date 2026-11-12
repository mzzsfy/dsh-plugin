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
