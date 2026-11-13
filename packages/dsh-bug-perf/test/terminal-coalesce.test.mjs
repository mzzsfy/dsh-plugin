import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalCoalescer, installTerminalCoalesce } from '../src/terminal-coalesce.mjs'

const WINDOW_MS = 5
const settle = (ms = WINDOW_MS * 4) => new Promise((resolve) => setTimeout(resolve, ms))

// 假终端:原型 output 记录收到的数据,空字符串按宿主语义直接忽略
function makeTerminal({ followers = 1, exited = false } = {}) {
  const calls = []
  const proto = {
    async output(data) {
      if (data.length === 0) return
      calls.push(data)
    },
  }
  const terminal = Object.create(proto)
  terminal.followers = new Set(Array.from({ length: followers }, () => ({})))
  terminal.exited = exited
  terminal.calls = calls
  return terminal
}

const makeCoalescer = (options = {}) => createTerminalCoalescer({ readWindow: () => WINDOW_MS, ...options })

// Given 有订阅者且连续到达多个小块,When 窗口内合并,Then 底层只收到一次拼接后的数据
test('Given a subscribed terminal receiving small chunks, When the window elapses, Then they merge into one output call', async () => {
  const terminal = makeTerminal()
  const coalescer = makeCoalescer()
  try {
    assert.equal(coalescer.install(terminal), true)
    terminal.output('a')
    terminal.output('b')
    terminal.output('c')
    assert.deepEqual(terminal.calls, [])
    await settle()
    assert.deepEqual(terminal.calls, ['abc'])
  } finally {
    coalescer.dispose()
  }
})

// Given 没有订阅者,When 写入,Then 不缓冲直接透传
test('Given an unsubscribed terminal, When writing, Then each chunk passes straight through', () => {
  const terminal = makeTerminal({ followers: 0 })
  const coalescer = makeCoalescer()
  try {
    coalescer.install(terminal)
    terminal.output('x')
    terminal.output('y')
    assert.deepEqual(terminal.calls, ['x', 'y'])
  } finally {
    coalescer.dispose()
  }
})

// Given 终端已退出且有未发出的数据,When 再写入,Then 立即排空而不等窗口
test('Given an exited terminal with pending bytes, When writing again, Then the buffer flushes immediately', async () => {
  const terminal = makeTerminal()
  const coalescer = makeCoalescer()
  try {
    coalescer.install(terminal)
    terminal.output('tail-1')
    terminal.exited = true
    await terminal.output('tail-2')
    assert.deepEqual(terminal.calls, ['tail-1tail-2'])
  } finally {
    coalescer.dispose()
  }
})

// Given 累积字节达到背压阈值,When 继续写入,Then 返回排空 Promise 并保住顺序
test('Given pending bytes at the cap, When writing, Then it flushes and resolves after delivery', async () => {
  const terminal = makeTerminal()
  const coalescer = makeCoalescer({ maxPendingBytes: 4 })
  try {
    coalescer.install(terminal)
    await terminal.output('abcd')
    assert.deepEqual(terminal.calls, ['abcd'])
  } finally {
    coalescer.dispose()
  }
})

// Given 有未发出的数据,When 收到收尾的空串,Then 先排空再按原语义忽略空串
test('Given pending bytes, When the closing empty chunk arrives, Then pending output is delivered first', async () => {
  const terminal = makeTerminal()
  const coalescer = makeCoalescer()
  try {
    coalescer.install(terminal)
    terminal.output('last')
    await terminal.output('')
    assert.deepEqual(terminal.calls, ['last'])
    terminal.output('')
    assert.deepEqual(terminal.calls, ['last'])
  } finally {
    coalescer.dispose()
  }
})

// Given 合并器已安装,When 卸载,Then 原型恢复且未发出的数据先被写出
test('Given an installed coalescer, When disposed, Then the prototype is restored and pending output delivered', async () => {
  const terminal = makeTerminal()
  const original = terminal.output
  const coalescer = makeCoalescer()
  coalescer.install(terminal)
  terminal.output('pending')
  coalescer.dispose()
  assert.equal(terminal.output, original)
  await settle()
  assert.deepEqual(terminal.calls, ['pending'])
})

// Given 同一原型上已有别的 output 包装,When 合并器安装,Then 它包装的是上一个包装而不是原始方法
test('Given an existing output wrapper, When installed, Then it wraps the current method', async () => {
  const terminal = makeTerminal()
  const inner = terminal.output
  const seen = []
  Object.getPrototypeOf(terminal).output = function outer(data) {
    seen.push('outer')
    return inner.call(this, data)
  }
  const coalescer = makeCoalescer()
  try {
    coalescer.install(terminal)
    terminal.output('after')
    await settle()
    assert.deepEqual(seen, ['outer'])
    assert.deepEqual(terminal.calls, ['after'])
  } finally {
    coalescer.dispose()
  }
})

// Given 多个终端实例共享原型,When 各自写入,Then 缓冲区按实例隔离
test('Given two terminals sharing a prototype, When both write, Then their buffers stay separate', async () => {
  const first = makeTerminal()
  const second = makeTerminal()
  const coalescer = makeCoalescer()
  try {
    coalescer.install(first)
    first.output('one')
    second.output('two')
    await settle()
    assert.deepEqual(first.calls, ['one'])
    assert.deepEqual(second.calls, ['two'])
  } finally {
    coalescer.dispose()
  }
})

// Given 开关关闭,When 安装入口被调用,Then 不 patch 原型
test('Given the feature disabled, When installing, Then the prototype is left untouched', () => {
  const terminal = makeTerminal()
  const proto = Object.getPrototypeOf(terminal)
  const original = proto.output
  const fakeCtx = {
    effect: (fn) => { fn() },
    get: (name) => (name === 'terminalController' ? { owners: new Map([['s', { terminals: new Map([['t', terminal]]) }]]) } : undefined),
  }
  installTerminalCoalesce(fakeCtx, { isEnabled: () => false, readWindow: () => WINDOW_MS })
  assert.equal(proto.output, original)
})

// Given 开关开启且已有终端,When 安装入口被调用,Then 原型被 patch 且卸载可还原
test('Given the feature enabled and a terminal present, When installing, Then the prototype is patched', () => {
  const terminal = makeTerminal()
  const proto = Object.getPrototypeOf(terminal)
  const original = proto.output
  const fakeCtx = {
    effect: (fn) => { fn() },
    get: (name) => (name === 'terminalController' ? { owners: new Map([['s', { terminals: new Map([['t', terminal]]) }]]) } : undefined),
  }
  const dispose = installTerminalCoalesce(fakeCtx, { isEnabled: () => true, readWindow: () => WINDOW_MS })
  assert.notEqual(proto.output, original)
  dispose()
  assert.equal(proto.output, original)
})
