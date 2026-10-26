import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
function environment() {
  const instances = [], timers = new Map(), warns = []
  let timerId = 0
  class Socket {
    static OPEN = 1
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; instances.push(this) }
    send(text) { this.sent.push(JSON.parse(text)) }
    close() { this.readyState = 3; this.closed = true; this.onclose?.() }
    open() { this.readyState = 1; this.onopen() }
    frame(value) { this.onmessage({ data: JSON.stringify(value) }) }
    ready() { const request = this.sent.filter(frame => frame.type === 'subscribe').at(-1); this.frame({ type: 'ready', plugins: request.plugins, revision: request.revision }) }
  }
  const window = { location: { href: 'https://example.test/' }, __ModuleLoader__: { load: module => { window.module = module } } }
  function load() {
    new Function('window', 'document', 'console', 'WebSocket', 'setTimeout', 'clearTimeout', source)(
      window, {}, { warn: message => warns.push(message) }, Socket,
      (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId }, id => timers.delete(id),
    )
    return window.module.factory(() => ({}))
  }
  function owner(name = 'a') {
    const cleanups = []
    const ctx = { fiber: { entry: { options: { name } } }, effect(fn) { cleanups.push(fn()) }, dispose() { while (cleanups.length) cleanups.pop()() } }
    return { ctx, bus: load().setupCommonTools(ctx), dispose: ctx.dispose }
  }
  const fireTimer = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); return timer.ms }
  return { load, owner, instances, warns, timers, fireTimer }
}
const message = (plugin, payload = null) => ({ type: 'message', plugin, payload })

test('Given 多插件多个实例 When 收帧 Then 按上下文空间分发并复用单条WS', () => {
  const f = environment(), seen = []
  f.owner('a').bus.subscribe(data => seen.push(['a', data]))
  f.owner('b').bus.subscribe(data => seen.push(['b', data]))
  assert.equal(f.instances.length, 1)
  const socket = f.instances[0]
  assert.equal(socket.url, 'wss://example.test/api/bus/ws')
  socket.open(); socket.ready()
  socket.frame(message('a', { a: 1 })); socket.frame(message('b', { b: 1 }))
  socket.frame(message('other'))
  assert.deepEqual(seen, [['a', { a: 1 }], ['b', { b: 1 }]])
})

test('Given 同空间多个接收者 When 部分退订 Then 不关闭实例连接且迟到订阅只对账一次', () => {
  const f = environment(), owner = f.owner(), bus = owner.bus, resets = []
  const offA = bus.subscribe(() => {}, { onReset: () => resets.push('a') })
  const socket = f.instances[0]
  socket.open(); socket.ready()
  const offB = bus.subscribe(() => {}, { onReset: () => resets.push('b') })
  assert.deepEqual(resets, ['a', 'b'])
  offA(); offA(); socket.ready()
  assert.deepEqual(resets, ['a', 'b'])
  offB()
  assert.equal(socket.closed, undefined)
  assert.doesNotThrow(() => bus.publish('sender-only'))
  owner.dispose()
  assert.equal(socket.closed, true)
  assert.equal(f.timers.size, 0)
})

test('Given 网络断开 When 退避重连 Then ready后重新对账且不重放断线发送', () => {
  const f = environment(), owner = f.owner(), bus = owner.bus, resets = []
  bus.subscribe(() => {}, { onReset: () => resets.push('reset') })
  f.instances[0].open(); f.instances[0].ready()
  f.instances[0].close()
  assert.throws(() => bus.publish('lost'), /未就绪/)
  const delay = f.fireTimer()
  assert.ok(delay >= 500 && delay <= 1000)
  const next = f.instances[1]
  next.open()
  assert.deepEqual(resets, ['reset'])
  next.ready()
  assert.deepEqual(resets, ['reset', 'reset'])
  assert.equal(next.sent.filter(frame => frame.type === 'publish').length, 0)
  bus.publish({ sent: true })
  assert.deepEqual(next.sent.at(-1), { type: 'publish', plugin: 'a', payload: { sent: true } })
  owner.dispose()
})

test('Given 接收空间移除后重新订阅 When 过期ready抵达 Then 新订阅等待当前确认', () => {
  const f = environment(), a = f.owner('a'), b = f.owner('b'), resets = []
  const offA = a.bus.subscribe(() => {})
  b.bus.subscribe(() => {})
  const socket = f.instances[0]
  socket.open(); socket.ready()
  offA()
  const obsolete = socket.sent.at(-1)
  a.bus.subscribe(() => {}, { onReset: () => resets.push('a') })
  socket.frame({ type: 'ready', revision: obsolete.revision, plugins: obsolete.plugins })
  assert.deepEqual(resets, [])
  assert.doesNotThrow(() => a.bus.publish(), '发送独立于接收确认')
  socket.ready()
  assert.deepEqual(resets, ['a'])
})

test('Given revision交错 When 旧确认后的业务帧抵达 Then 尚未对账的订阅不收变更', () => {
  const f = environment(), order = []
  f.owner('a').bus.subscribe(() => order.push('change'), { onReset: () => order.push('reset') })
  const socket = f.instances[0]
  socket.open()
  const previous = socket.sent.at(-1)
  f.owner('b').bus.subscribe(() => {})
  socket.frame({ type: 'ready', plugins: previous.plugins, revision: previous.revision })
  socket.frame(message('a'))
  socket.ready()
  assert.deepEqual(order, ['reset'])
  socket.frame(message('a'))
  assert.deepEqual(order, ['reset', 'change'])
})

test('Given 旧连接迟到帧与消费回调异常 When 分发 Then 隔离旧代和异常', async () => {
  const f = environment(), oldOwner = f.owner(), seen = []
  oldOwner.bus.subscribe(() => {})
  const old = f.instances[0], late = old.onmessage
  oldOwner.dispose()
  const bus = f.owner().bus
  bus.subscribe(() => { throw Error('sync') }, { onReset() { throw Error('reset') } })
  bus.subscribe(async () => { throw Error('async') })
  bus.subscribe(data => seen.push(data))
  late({ data: JSON.stringify(message('a', 'late')) })
  const socket = f.instances[1]
  socket.open(); socket.ready()
  for (const data of ['null', '{', '{"type":"message"}']) socket.onmessage({ data })
  assert.deepEqual(seen, [])
  socket.frame(message('a', 'fresh'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(seen, ['fresh'])
  assert.equal(f.warns.length, 3)
})

test('Given 连接握手不完成 When 超时 Then 关闭退避且最后实例卸载取消重连', () => {
  const f = environment(), owner = f.owner()
  f.fireTimer()
  assert.equal(f.instances[0].closed, true)
  assert.equal(f.timers.size, 1)
  owner.dispose()
  assert.equal(f.timers.size, 0)
})

test('Given 缓冲超界或非法payload When publish Then 同步拒绝且不发送', () => {
  const f = environment(), bus = f.owner().bus
  const socket = f.instances[0]
  socket.open(); socket.ready()
  socket.bufferedAmount = 1024 * 1024
  assert.throws(() => bus.publish(1), /上限/)
  socket.bufferedAmount = 0
  for (const payload of [() => {}, Symbol('x'), { toJSON: () => undefined }]) assert.throws(() => bus.publish(payload), /payload/)
  assert.equal(socket.sent.filter(frame => frame.type === 'publish').length, 0)
})

test('Given 接收确认在途 When 后续订阅因背压失败 Then 原确认仍有效且无残留订阅', () => {
  const f = environment(), a = f.owner('a'), b = f.owner('b'), c = f.owner('c'), resets = [], seen = []
  a.bus.subscribe(() => {})
  const socket = f.instances[0]
  socket.open(); socket.ready()
  b.bus.subscribe(() => {}, { onReset: () => resets.push('b') })
  socket.bufferedAmount = 1024 * 1024
  assert.throws(() => c.bus.subscribe(data => seen.push(data)), /上限/)
  socket.bufferedAmount = 0
  socket.ready()
  assert.deepEqual(resets, ['b'])
  socket.frame(message('c', 'must-not-deliver'))
  assert.deepEqual(seen, [])
  a.dispose(); b.dispose(); c.dispose()
  assert.equal(socket.closed, true)
})

test('Given 多实例接收 When 一个ctx卸载 Then 只清其资源并拒绝旧门面操作', () => {
  const f = environment(), a = f.owner(), b = f.owner(), seen = []
  a.bus.subscribe(() => seen.push('a'))
  b.bus.subscribe(() => seen.push('b'))
  const socket = f.instances[0]
  socket.open(); socket.ready()
  a.dispose(); socket.ready(); socket.frame(message('a'))
  assert.deepEqual(seen, ['b'])
  assert.throws(() => a.bus.publish(), /卸载/)
  assert.throws(() => a.bus.subscribe(() => {}), /卸载/)
  assert.equal(socket.closed, undefined)
  b.dispose()
  assert.equal(socket.closed, true)
  assert.throws(() => f.load().setupCommonTools({}), /entry.options.name/)
})
