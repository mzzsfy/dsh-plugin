import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, until } from './_ws-fixture.mjs'
import { once } from 'node:events'
import { setupCommonTools, __test } from '../src/host.js'
import NodeWebSocket from 'ws'

test('Given 两插件通道 When 双向推送 Then 自动身份隔离且共享一条真实WS', async t => {
  const f = await fixture(t), names = ['@mzzsfy/a', '@mzzsfy/b']
  const hosts = names.map(name => setupCommonTools(f.context(name)))
  const contexts = names.map(name => f.context(name))
  const clients = contexts.map(ctx => f.load().setupCommonTools(ctx))
  const down = [[], []], up = [[], []], resets = []
  hosts.forEach((bus, i) => bus.subscribe(data => up[i].push(data)))
  clients.forEach((bus, i) => bus.subscribe(data => down[i].push(data), { onReset: () => resets.push(i) }))
  await until(() => resets.length === 2)
  hosts[0].publish({ text: '甲' }); hosts[1].publish({ text: '乙' })
  await until(() => down.every(items => items.length === 1))
  assert.deepEqual(down, [[{ text: '甲' }], [{ text: '乙' }]])
  clients[0].publish({ command: 'a' }); clients[1].publish({ command: 'b' })
  await until(() => up.every(items => items.length === 1))
  assert.deepEqual(up, [[{ command: 'a' }], [{ command: 'b' }]])
  assert.equal(down[0].length, 1, '上行不自动回广播')
  assert.equal(f.stats().total, 1)
  assert.equal((await fetch(f.base + '/snapshot')).status, 200)
  assert.equal((await fetch(f.base + '/api/bus/events')).status, 404)
  for (const ctx of contexts) ctx.dispose()
  await until(() => f.sockets.size === 0)
})

test('Given presence回调同步publish When 订阅确认 Then 对账总在业务消息之前', async t => {
  const f = await fixture(t), host = setupCommonTools(f.context()), order = []
  host.onPresence(n => { if (n > 0) host.publish({ online: true }) })
  const client = f.load().setupCommonTools(f.context())
  client.subscribe(() => order.push('message'), { onReset: () => order.push('reset') })
  await until(() => order.length === 2)
  assert.deepEqual(order, ['reset', 'message'])
})

test('Given 同插件多接收实例 When 部分退订和卸载 Then presence仅按接收空间计数', async t => {
  const f = await fixture(t), host = setupCommonTools(f.context()), presence = [], resets = []
  host.onPresence(n => presence.push(n))
  const first = f.context(), second = f.context()
  const a = f.load().setupCommonTools(first), b = f.load().setupCommonTools(second)
  const offA = a.subscribe(() => {}, { onReset: () => resets.push('a') })
  const offB = b.subscribe(() => {}, { onReset: () => resets.push('b') })
  await until(() => resets.length === 2)
  assert.deepEqual(presence, [0, 1])
  offA(); first.dispose()
  assert.equal(presence.at(-1), 1)
  offB()
  await until(() => presence.at(-1) === 0)
  assert.equal(f.sockets.size, 1, '纯发送实例仍持有连接')
  second.dispose()
  await until(() => f.sockets.size === 0)
  assert.equal(f.stats().peak, 1)
})

test('Given 活跃实例 When 同步卸载重建 Then 旧连接关闭后才新建连接', async t => {
  const f = await fixture(t)
  setupCommonTools(f.context())
  const first = f.context(), bus = f.load().setupCommonTools(first)
  let resets = 0
  bus.subscribe(() => {}, { onReset: () => resets++ })
  await until(() => resets === 1)
  first.dispose()
  f.load().setupCommonTools(f.context()).subscribe(() => {}, { onReset: () => resets++ })
  await until(() => resets === 2)
  assert.equal(f.stats().peak, 1)
})

test('Given 高版本接管 When 客户端重连 Then 旧host门面与监听继续可用', async t => {
  const f = await fixture(t), host = __test.install(f.context(), '1.0.0'), up = [], down = [], resets = []
  host.subscribe(data => up.push(data))
  const client = f.load().setupCommonTools(f.context())
  client.subscribe(data => down.push(data), { onReset: () => resets.push('reset') })
  await until(() => resets.length === 1)
  __test.install(f.context('@mzzsfy/b'), '2.0.0')
  await until(() => resets.length === 2)
  host.publish('down'); client.publish('up')
  await until(() => down.length === 1 && up.length === 1)
  assert.deepEqual(down, ['down']); assert.deepEqual(up, ['up'])
})

test('Given 分发回调同步卸载另一实例 When 同帧继续分发 Then 跳过已移除消息和presence监听', async t => {
  const f = await fixture(t), first = setupCommonTools(f.context()), secondCtx = f.context(), second = setupCommonTools(secondCtx)
  const received = [], presence = []
  first.subscribe(() => secondCtx.dispose())
  second.subscribe(data => received.push(data))
  const presenceCtx = f.context(), other = setupCommonTools(presenceCtx)
  first.onPresence(n => { if (n > 0) presenceCtx.dispose() })
  other.onPresence(n => presence.push(n))
  const client = f.load().setupCommonTools(f.context()), resets = []
  client.subscribe(() => {}, { onReset: () => resets.push(true) })
  await until(() => resets.length === 1)
  client.publish('message')
  await until(() => { try { second.publish(); return false } catch { return true } })
  assert.deepEqual(received, [])
  assert.deepEqual(presence, [0])
})

test('Given 明确跨源WS When 不订阅直接上行 Then 连接可达但写入被拒绝', async t => {
  const f = await fixture(t), received = []
  setupCommonTools(f.context()).subscribe(data => received.push(data))
  const socket = new NodeWebSocket(f.base.replace('http:', 'ws:') + '/api/bus/ws', { headers: { Origin: 'https://attacker.example' } })
  t.after(() => socket.terminate())
  await once(socket, 'open')
  const closed = once(socket, 'close')
  socket.send(JSON.stringify({ type: 'publish', plugin: '@mzzsfy/a', payload: { changed: true } }))
  const [code] = await closed
  assert.equal(code, 1008)
  assert.deepEqual(received, [])
})
