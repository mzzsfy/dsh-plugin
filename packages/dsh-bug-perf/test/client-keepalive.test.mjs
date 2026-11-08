import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function loadPlugin() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  new Function('window', source)(window)
  return registered.factory(() => { throw new Error('no modules') })
}

function fakeClock() {
  let now = 0
  let nextId = 0
  const intervals = new Map()
  const fireDue = () => {
    for (const [id, timer] of [...intervals]) {
      if (timer.at <= now) {
        timer.at = now + timer.every
        timer.fn()
      }
    }
  }
  return {
    now: () => now,
    setInterval: (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, every: ms, at: now + ms }); return id },
    clearInterval: (id) => { intervals.delete(id) },
    advance(ms) {
      const target = now + ms
      while (true) {
        const due = [...intervals.values()].map((timer) => timer.at).filter((at) => at <= target)
        if (due.length === 0) break
        now = Math.min(...due)
        fireDue()
      }
      now = target
    },
    intervalCount: () => intervals.size,
  }
}

function fakeWebSocketClass() {
  return class FakeSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url) {
      this.url = String(url)
      this.readyState = 1
      this.sent = []
      this.listeners = new Map()
    }
    send(data) { this.sent.push(String(data)) }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) ?? []
      this.listeners.set(type, list.filter((item) => item !== fn))
    }
    dispatch(type, event) {
      for (const fn of this.listeners.get(type) ?? []) fn(event)
    }
  }
}

function install({ intervalMs = 1500, enabled = true } = {}) {
  const plugin = loadPlugin()
  const FakeSocket = fakeWebSocketClass()
  const win = { WebSocket: FakeSocket, location: { href: 'https://dsh.example/' } }
  const clock = fakeClock()
  const disabled = []
  const result = plugin.__test.installSocketKeepAlive({
    win,
    options: { enabled, intervalMs },
    clock,
    onDisabled: (reason) => disabled.push(reason),
  })
  return { plugin, win, clock, result, Native: FakeSocket, disabled }
}

const keepaliveFrames = (socket) => socket.sent.filter((raw) => raw.includes('dsh-bug-perf-keepalive'))

// Given 页面创建 /api/remote.mux 连接, When 空闲到达保活间隔, Then 发出一条合法 item 帧
test('保活_空闲_发出合法item帧', () => {
  const { win, clock } = install()
  const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
  assert.equal(socket.sent.length, 0)
  clock.advance(1500)
  const frames = keepaliveFrames(socket)
  assert.equal(frames.length, 1)
  const frame = JSON.parse(frames[0])
  assert.equal(frame.type, 'item')
  assert.equal(typeof frame.streamId, 'string')
  assert.ok(frame.streamId.length > 0)
})

// Given 保活已生效, When 继续空闲多个间隔, Then 每个间隔各一条,持续保活
test('保活_持续_按间隔重复发送', () => {
  const { win, clock } = install()
  const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
  clock.advance(1500)
  clock.advance(1500)
  clock.advance(1500)
  const frames = keepaliveFrames(socket)
  assert.equal(frames.length, 3)
  assert.equal(new Set(frames.map((raw) => JSON.parse(raw).streamId)).size, 3)
})

// Given 连接上客户端自己刚发过上行帧, When 尚未到保活间隔, Then 不补保活帧
test('保活_有上行活动_不补帧', () => {
  const { win, clock } = install()
  const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
  socket.send('{"type":"open"}')
  clock.advance(1000)
  assert.equal(keepaliveFrames(socket).length, 0)
  clock.advance(1000)
  assert.equal(keepaliveFrames(socket).length, 1)
})

// Given 配置改了保活间隔, When 连接已存在, Then 既有连接按新间隔发送,不需要重建
test('保活_间隔重配_既有连接生效', () => {
  const { win, clock, result } = install()
  const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
  result.setIntervalMs(4000)
  clock.advance(2500)
  assert.equal(keepaliveFrames(socket).length, 0)
  clock.advance(2000)
  assert.equal(keepaliveFrames(socket).length, 1)
})

// Given 连接不在 OPEN 态, When 到达检查点, Then 不发送
test('保活_非OPEN_不发送', () => {
  const { win, clock } = install()
  const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
  socket.readyState = 3
  clock.advance(1500)
  assert.equal(socket.sent.length, 0)
})

// Given 非 remote.mux 连接, When 空闲到达间隔, Then 不发送(只补会话流)
test('保活_其他连接_不发送', () => {
  const { win, clock } = install()
  const socket = new win.WebSocket('wss://dsh.example/api/bus/ws')
  clock.advance(1500)
  assert.equal(socket.sent.length, 0)
})

// Given 开关关闭, When 创建连接, Then 全局 WebSocket 不被包装且无任何帧
test('保活_关闭_不包装', () => {
  const { win, clock, Native } = install({ enabled: false })
  assert.equal(win.WebSocket, Native)
  clock.advance(5000)
})

// Given 连接关闭, When 连接已断, Then 保活定时器随连接清理,不再发送
test('保活_连接关闭_清理定时器', () => {
  const { win, clock, result } = install()
  const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
  socket.dispatch('close', { code: 1000 })
  clock.advance(5000)
  assert.equal(socket.sent.length, 0)
  assert.equal(result.state.timers.size, 0)
})

// Given 普通断线与主动关闭, When 连续发生多次, Then 不计入熔断,补丁继续工作
test('保活_普通断线_不熔断', () => {
  const { win, clock, Native, disabled } = install()
  for (const code of [1000, 1001, 1006, 1006]) {
    const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
    clock.advance(1500)
    socket.dispatch('close', { code })
  }
  assert.equal(win.WebSocket === Native, false)
  assert.deepEqual(disabled, [])
})

// Given 宿主以协议错误码关闭连接, When 连续命中熔断阈值, Then 补丁自行禁用并恢复原始构造器
test('保活_协议关闭_熔断', () => {
  const { win, clock, Native, disabled } = install()
  for (let round = 0; round < 2; round++) {
    const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
    clock.advance(1500)
    assert.equal(keepaliveFrames(socket).length, 1)
    socket.dispatch('close', { code: 1008 })
  }
  assert.equal(win.WebSocket, Native)
  assert.equal(disabled.length, 1)
  clock.advance(9000)
})

// Given 连接从未发过保活帧, When 以协议错误码关闭, Then 不计入熔断(与应用自身协议错误区分)
test('保活_未发保活帧_协议关闭不计数', () => {
  const { win, clock, Native } = install()
  for (let round = 0; round < 3; round++) {
    const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
    socket.dispatch('close', { code: 1008 })
  }
  assert.equal(win.WebSocket === Native, false)
  clock.advance(5000)
})

// Given 连接健康存活超过恢复窗口, When 之后才发生协议关闭, Then 历史累计已清零
test('保活_健康存活_清零累计', () => {
  const { win, clock, Native } = install()
  const first = new win.WebSocket('wss://dsh.example/api/remote.mux')
  clock.advance(1500)
  first.dispatch('close', { code: 1008 })
  const second = new win.WebSocket('wss://dsh.example/api/remote.mux')
  clock.advance(20000)
  second.dispatch('close', { code: 1008 })
  assert.equal(win.WebSocket === Native, false)
})

// Given 已被包装的连接, When 查看全局构造器, Then 仍是 WebSocket 语义且实例可判定
test('保活_包装后_保持实例语义', () => {
  const { win, Native } = install()
  const socket = new win.WebSocket('wss://dsh.example/api/remote.mux')
  assert.ok(socket instanceof Native)
  assert.ok(socket instanceof win.WebSocket)
  assert.equal(win.WebSocket.OPEN, 1)
})
