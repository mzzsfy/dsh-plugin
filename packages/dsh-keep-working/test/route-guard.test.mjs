import { test } from 'node:test'
import assert from 'node:assert/strict'

import { guardWrite, rejectCrossOrigin, rejectNonJson } from '../src/route-guard.mjs'

function fakeRes() {
  const calls = []
  return { calls, statusCode: 0, body: undefined, send: (status, payload) => calls.push({ status, payload }) }
}

const sendJson = (res, status, payload) => res.send(status, payload)
const req = (headers) => ({ headers, method: 'POST' })

test('R1 同源 Origin 放行', () => {
  const res = fakeRes()
  assert.equal(guardWrite(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }), res, sendJson), false)
  assert.equal(res.calls.length, 0)
})

test('R2 跨源 Origin 拒绝(403)', () => {
  const res = fakeRes()
  assert.equal(guardWrite(req({ host: '127.0.0.1:3080', origin: 'http://evil.example', 'content-type': 'application/json' }), res, sendJson), true)
  assert.equal(res.calls[0].status, 403)
})

test('R3 无 Origin 的非浏览器调用放行', () => {
  const res = fakeRes()
  assert.equal(rejectCrossOrigin(req({ host: '127.0.0.1:3080' }), res, sendJson), false)
})

test('R4 非法 Origin 按跨源拒绝', () => {
  const res = fakeRes()
  assert.equal(rejectCrossOrigin(req({ host: '127.0.0.1:3080', origin: 'null' }), res, sendJson), true)
})

test('R5 text/plain 载荷拒绝(415)', () => {
  const res = fakeRes()
  assert.equal(guardWrite(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-type': 'text/plain' }), res, sendJson), true)
  assert.equal(res.calls[0].status, 415)
})

test('R6 application/json 带 charset 放行;缺 content-type 放行', () => {
  assert.equal(rejectNonJson(req({ 'content-type': 'application/json; charset=utf-8' }), fakeRes(), sendJson), false)
  assert.equal(rejectNonJson(req({}), fakeRes(), sendJson), false)
})

test('R7 同源但非 JSON 仍拒绝', () => {
  const res = fakeRes()
  assert.equal(guardWrite(req({ host: 'a:1', origin: 'http://a:1', 'content-type': 'application/x-www-form-urlencoded' }), res, sendJson), true)
  assert.equal(res.calls[0].status, 415)
})
