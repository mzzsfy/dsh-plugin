import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, until } from './_ws-fixture.mjs'
import { setupCommonTools } from '../src/host.js'

function owner(name) {
  const cleanups = []
  return { fiber: { entry: { options: { name } } }, effect(fn) { cleanups.push(fn()) }, dispose() { while (cleanups.length) cleanups.pop()() } }
}

test('Given 插件上下文 When 只创建发送端不订阅 Then 可上行且不记接收者presence', async t => {
  const f = await fixture(t), name = '@mzzsfy/dsh-a'
  const hostCtx = Object.assign(owner(name), { webServer: f.context().webServer })
  t.after(() => hostCtx.dispose())
  const host = setupCommonTools(hostCtx), received = [], presence = []
  host.subscribe(data => received.push(data)); host.onPresence(n => presence.push(n))
  const clientCtx = owner(name)
  t.after(() => clientCtx.dispose())
  const bus = f.load().setupCommonTools(clientCtx)
  await until(() => f.sockets.size === 1)
  await until(() => { try { bus.publish({ text: '甲' }); return true } catch { return false } })
  await until(() => received.length === 1)
  assert.deepEqual(received, [{ text: '甲' }])
  assert.deepEqual(presence, [0])
  clientCtx.dispose()
  await until(() => f.sockets.size === 0)
  assert.throws(() => bus.publish('late'), /卸载/)
})

test('Given 同页两个插件 When 相同payload双向发送 Then 按上下文空间隔离且退订不丢发送能力', async t => {
  const f = await fixture(t), names = ['@mzzsfy/dsh-a', '@mzzsfy/dsh-b'], received = [[], []], uplink = [[], []], resets = []
  const hosts = names.map((name, i) => {
    const ctx = Object.assign(owner(name), { webServer: f.context().webServer })
    t.after(() => ctx.dispose())
    const bus = setupCommonTools(ctx); bus.subscribe(data => uplink[i].push(data)); return bus
  })
  const contexts = names.map(name => owner(name))
  for (const ctx of contexts) t.after(() => ctx.dispose())
  const clients = contexts.map(ctx => f.load().setupCommonTools(ctx))
  const stops = clients.map((bus, i) => bus.subscribe(data => received[i].push(data), { onReset: () => resets.push(i) }))
  await until(() => resets.length === 2)
  hosts[0].publish({ same: true })
  await until(() => received[0].length === 1)
  assert.deepEqual(received, [[{ same: true }], []])
  stops[0](); stops[0]()
  clients[0].publish({ same: true })
  await until(() => uplink[0].length === 1)
  assert.deepEqual(uplink, [[{ same: true }], []])
  assert.equal(f.sockets.size, 1)
  contexts[0].dispose()
  hosts[1].publish('b')
  await until(() => received[1].length === 1)
  assert.deepEqual(received[1], ['b'])
  contexts[1].dispose()
  await until(() => f.sockets.size === 0)
  assert.equal(f.stats().peak, 1)
})
