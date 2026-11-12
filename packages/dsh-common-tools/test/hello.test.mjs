import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
// 版本面从 manifest 取:测试不重复声明发版号,发布改版本不会瓦解断言
const { version: PKG_VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// 连接首帧必须报 hello:host 回支持集则协商为 ok;无交集停用总线;
// 旧 host 视未知帧为非法帧关连接时,客户端降级为老帧模式重连一次。
function environment() {
  const instances = [], timers = new Map(), warns = []
  let timerId = 0
  class Socket {
    static OPEN = 1
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; instances.push(this) }
    send(text) { this.sent.push(JSON.parse(text)) }
    close(code = 1000) { this.readyState = 3; this.closed = true; this.onclose?.({ code }) }
    open() { this.readyState = 1; this.onopen?.() }
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const window = { location: { href: 'https://example.test/' }, __ModuleLoader__: { load: module => { window.module = module } } }
  const load = () => {
    new Function('window', 'document', 'console', 'WebSocket', 'setTimeout', 'clearTimeout', source)(
      window, {}, { warn: message => warns.push(message) }, Socket,
      (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId }, id => timers.delete(id),
    )
    return window.module.factory(() => ({}))
  }
  const owner = (name = 'a') => {
    const cleanups = []
    const ctx = { fiber: { entry: { options: { name } } }, effect(fn) { cleanups.push(fn()) }, dispose() { while (cleanups.length) cleanups.pop()() } }
    return { ctx, bus: load().setupCommonTools(ctx) }
  }
  // 按注册顺序取第一个满足条件的定时器并执行
  const fire = predicate => {
    for (const [id, timer] of timers) {
      if (!predicate(timer)) continue
      timers.delete(id)
      timer.fn()
      return true
    }
    return false
  }
  return { load, owner, instances, warns, timers, fire, state: () => window.__dshCommonToolsBus }
}

test('Given 新 host 协议有交集 When 收到 hello Then 协商为 ok 且不告警', () => {
  const f = environment()
  f.owner().bus.subscribe(() => {})
  const socket = f.instances[0]
  socket.open()
  assert.deepEqual(socket.sent[0], { type: 'hello', protocol: 1, version: PKG_VERSION })
  socket.frame({ type: 'hello', protocol: 1, protocols: [1], version: PKG_VERSION })
  assert.equal(f.state().hello, 'ok')
  assert.deepEqual(f.warns, [])
})

test('Given host 协议无交集 When 收到 hello Then 告警一次、关闭连接且不再重连', () => {
  const f = environment()
  f.owner().bus.subscribe(() => {})
  const socket = f.instances[0]
  socket.open()
  socket.frame({ type: 'hello', protocol: 9, protocols: [9], version: '9.0.0' })
  assert.equal(f.state().hello, 'unsupported')
  assert.equal(socket.closed, true)
  assert.equal(f.warns.length, 1)
  assert.match(f.warns[0], /协议不兼容/)
  assert.equal(f.fire(timer => timer.ms < 10000), false, '停用后不得安排重连')
})

test('Given 旧 host 以 1008 关连接 When 重连 Then 降级老帧模式且订阅仍成功', () => {
  const f = environment()
  f.owner().bus.subscribe(() => {})
  const first = f.instances[0]
  first.open()
  first.close(1008)
  assert.equal(f.state().hello, 'legacy')
  assert.ok(f.fire(timer => timer.ms < 10000), '应安排重连')
  const second = f.instances[1]
  second.open()
  assert.deepEqual(second.sent.map(frame => frame.type), ['subscribe'])
  second.frame({ type: 'ready', plugins: ['a'], revision: 2 })
  assert.deepEqual(f.state().ready, new Set(['a']))
})

test('Given 快速关闭但关闭码不是 1008 When 重连 Then 不判老 host 并重新协商', () => {
  const f = environment()
  f.owner().bus.subscribe(() => {})
  const first = f.instances[0]
  first.open()
  // 1006 是异常断开(宿主重启/代理断链),与旧 host 判非法帧无关
  first.close(1006)
  assert.equal(f.state().hello, 'idle')
  assert.ok(f.fire(timer => timer.ms < 10000), '应安排重连')
  const second = f.instances[1]
  second.open()
  assert.deepEqual(second.sent.map(frame => frame.type), ['hello', 'subscribe'])
})

test('Given 1008 关闭发生在宽限窗之外 When 判定 Then 不误判老 host', () => {
  const f = environment()
  f.owner().bus.subscribe(() => {})
  const first = f.instances[0]
  first.open()
  f.state().helloAt = Date.now() - 10 * 1000
  first.close(1008)
  assert.equal(f.state().hello, 'idle')
})

test('Given 连接未 open 即关闭 When 重连 Then 不误判老 host 且继续报 hello', () => {
  const f = environment()
  f.owner().bus.subscribe(() => {})
  const first = f.instances[0]
  first.close()
  assert.equal(f.state().hello, 'idle')
  assert.ok(f.fire(timer => timer.ms < 10000), '应安排重连')
  const second = f.instances[1]
  second.open()
  assert.equal(second.sent[0].type, 'hello')
})

test('Given 连接打开后超宽限窗仍无回应 When 关闭重连 Then 回到 idle 并重试协商', () => {
  const f = environment()
  f.owner().bus.subscribe(() => {})
  const first = f.instances[0]
  first.open()
  first.sent.length = 0
  // 模拟宽限窗之后才断(例如 10s 连接超时或网络抖动):不得判定老 host
  f.state().helloAt = Date.now() - 10 * 1000
  first.close()
  assert.equal(f.state().hello, 'idle')
  assert.ok(f.fire(timer => timer.ms < 10000), '应安排重连')
  const second = f.instances[1]
  second.open()
  assert.deepEqual(second.sent.map(frame => frame.type), ['hello', 'subscribe'])
})

test('Given 协议不兼容已停用 When 新 owner 挂载 Then 不再重探连接', () => {
  const f = environment()
  f.owner().bus.subscribe(() => {})
  const socket = f.instances[0]
  socket.open()
  socket.frame({ type: 'hello', protocols: [9] })
  assert.equal(f.state().hello, 'unsupported')
  assert.equal(f.instances.length, 1)
  f.owner('b').bus.subscribe(() => {})
  assert.equal(f.instances.length, 1, '停用后新 owner 不得新建连接')
  assert.equal(f.state().socket, null)
})
