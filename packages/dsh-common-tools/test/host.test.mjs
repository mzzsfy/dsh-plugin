import test from 'node:test'
import assert from 'node:assert/strict'
import { setupCommonTools, __test } from '../src/host.js'

function context(name = '@mzzsfy/a') {
  const cleanups = [], upgrades = new Map()
  return {
    fiber: { entry: { options: { name } } },
    webServer: { registerUpgrade(route) { assert.equal(upgrades.has(route.path), false); upgrades.set(route.path, route); return () => upgrades.delete(route.path) } },
    upgrades,
    effect(fn) { cleanups.push(fn()) },
    dispose() { while (cleanups.length) cleanups.pop()() },
  }
}
function isolate(t) {
  delete globalThis.__dshCommonTools
  const contexts = []
  t.after(() => { for (const ctx of contexts) ctx.dispose(); delete globalThis.__dshCommonTools })
  return name => { const ctx = context(name); contexts.push(ctx); return ctx }
}

test('Given 同插件多实例 When 一个卸载 Then 另一实例仍可发布且最后卸载清路由', t => {
  const ctx = isolate(t), a = ctx(), b = ctx()
  const first = setupCommonTools(a), second = setupCommonTools(b)
  first.publish('x')
  a.dispose()
  assert.throws(() => first.publish('x'), /卸载/)
  assert.doesNotThrow(() => second.publish('x'))
  assert.equal(a.upgrades.size, 1)
  b.dispose()
  assert.equal(a.upgrades.size, 0)
})

test('Given 非JSON或超界消息 When publish Then 同步拒绝且仍可发送合法数据', t => {
  const ctx = isolate(t), tools = setupCommonTools(ctx())
  const cycle = {}; cycle.self = cycle
  assert.throws(() => tools.publish(cycle), /circular/i)
  assert.throws(() => tools.publish('x'.repeat(1024 * 1024)), /上限/)
  for (const payload of [() => {}, Symbol('x'), { toJSON: () => undefined }]) assert.throws(() => tools.publish(payload), /payload/)
  assert.doesNotThrow(() => tools.publish({ text: '甲' }))
})

test('Given 低版本在服 When 高版本接管 Then 旧门面仍可用且低版本后到不接管', t => {
  const ctx = isolate(t), oldCtx = ctx(), nextCtx = ctx('@mzzsfy/b')
  const old = __test.install(oldCtx, '1.0.0')
  const next = __test.install(nextCtx, '2.0.0')
  assert.equal(oldCtx.upgrades.size, 0)
  assert.equal(nextCtx.upgrades.size, 1)
  assert.doesNotThrow(() => old.publish('x'))
  assert.doesNotThrow(() => next.publish('x'))
  __test.install(ctx('@mzzsfy/c'), '1.1.0')
  assert.equal(nextCtx.upgrades.size, 1)
})

test('Given 同版本多消费方 When setup Then 不重复注册且监听随卸载失效', t => {
  const ctx = isolate(t), a = ctx(), b = ctx('@mzzsfy/b'), seen = []
  const tools = setupCommonTools(a)
  setupCommonTools(b)
  assert.equal(b.upgrades.size, 0)
  const off = tools.onPresence(n => seen.push(n))
  assert.deepEqual(seen, [0])
  off(); off()
  assert.equal(typeof tools.subscribe(() => {}), 'function')
  a.dispose()
  assert.throws(() => tools.subscribe(() => {}), /卸载/)
})

test('Given presence首次回调同步卸载 When 另一实例仍在 Then 不残留已卸载监听', t => {
  const ctx = isolate(t), a = ctx(), b = ctx('@mzzsfy/b')
  const tools = setupCommonTools(a)
  setupCommonTools(b)
  const stop = tools.onPresence(() => a.dispose())
  assert.equal(globalThis.__dshCommonTools.state.presence.has('@mzzsfy/a'), false)
  stop(); stop()
})

test('Given 缺少宿主WS能力 When setup Then 干净停用且不注册资源', () => {
  const tools = setupCommonTools({ fiber: { entry: { options: { name: '@mzzsfy/a' } } } })
  assert.equal(tools.publish(), undefined)
  assert.equal(typeof tools.subscribe(() => {}), 'function')
})

test('Given 缺失身份或非法listener When setup或订阅 Then 明确拒绝', t => {
  const ctx = isolate(t), tools = setupCommonTools(ctx())
  assert.throws(() => setupCommonTools({}), /entry.options.name/)
  assert.throws(() => tools.subscribe(null), /listener/)
  assert.throws(() => tools.onPresence(null), /listener/)
})
