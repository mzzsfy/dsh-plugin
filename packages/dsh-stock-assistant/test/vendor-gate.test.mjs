import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'
import { VENDOR_PREFIX } from '../src/serve-vendor.mjs'
import { memoryStorage } from './helpers.mjs'

function response() {
  const out = { status: null, headers: null, body: null, ended: false }
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers }
  out.end = body => { out.body = body; out.ended = true }
  out.on = () => {}
  out.removeListener = () => {}
  return out
}

test('P1-12 vendor prefix 路由经 effect 注册, 首行过宿主闸门且可注销', async () => {
  const registered = [], disposers = [], effects = []
  const ctx = {
    credentials: null,
    storageDomain: memoryStorage(),
    webServer: {
      register(route) { registered.push(route); return () => { const index = registered.indexOf(route); if (index >= 0) registered.splice(index, 1) } },
      registerUpgrade() { return () => {} },
    },
    effect(fn) { const stop = fn(); if (typeof stop === 'function') disposers.push(stop); effects.push(fn); return () => {} },
    get(name) { return name === 'connection' ? { requestRejection: () => 401 } : undefined },
    logger: { warn() {} },
    fiber: { entry: { options: { name: '@mzzsfy/dsh-stock-assistant' } } },
  }
  await apply(ctx)
  const vendor = registered.find(route => route.kind === 'prefix' && route.path === VENDOR_PREFIX)
  assert.ok(vendor, 'vendor prefix 路由必须注册')
  assert.equal(registered.filter(route => route.path === VENDOR_PREFIX).length, 1, '不得重复注册')
  const res = response()
  await vendor.handler({ url: `${VENDOR_PREFIX}/lightweight-charts.standalone.production.js`, headers: {} }, res)
  assert.equal(res.status, 401, '无会话请求必须先被宿主闸门拒绝')
  assert.equal(res.body, 'unauthorized')
  for (const stop of disposers.reverse()) await stop?.()
  assert.equal(registered.some(route => route.path === VENDOR_PREFIX), false, '禁用/热重载时 disposer 必须注销 vendor 路由')
})
