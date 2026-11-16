import test from 'node:test'
import assert from 'node:assert/strict'
import { DISABLED_INSTALL_WATCH_MS, INSTALL_RETRY_MS, createTerminalCoalescer, installTerminalCoalesce } from '../src/terminal-coalesce.mjs'

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

// Given 终端正在输出, When 收到空 chunk, Then 不被当成收尾, 仍继续跟踪并接受后续输出
test('Given a running terminal, When an empty chunk arrives, Then it is not treated as closing', async () => {
  const terminal = makeTerminal()
  const coalescer = makeCoalescer()
  try {
    coalescer.install(terminal)
    terminal.output('first')
    await terminal.output('')
    assert.equal(coalescer.tracked, 1)
    terminal.output('second')
    assert.equal(coalescer.tracked, 1)
    await settle()
    assert.deepEqual(terminal.calls, ['first', 'second'])
  } finally {
    coalescer.dispose()
  }
})

// Given 终端已退出, When 收到收尾的空 chunk, Then 排空待发数据并摘除跟踪
test('Given an exited terminal, When the closing empty chunk arrives, Then it is no longer tracked', async () => {
  const terminal = makeTerminal()
  const coalescer = makeCoalescer()
  try {
    coalescer.install(terminal)
    terminal.output('tail')
    assert.equal(coalescer.tracked, 1)
    terminal.exited = true
    await terminal.output('')
    assert.equal(coalescer.tracked, 0)
    assert.deepEqual(terminal.calls, ['tail'])
  } finally {
    coalescer.dispose()
  }
})

// Given 终端已退出, When 仍有数据到达, Then 立即排空并同时摘除跟踪
test('Given an exited terminal, When more output arrives, Then it flushes and untracks', async () => {
  const terminal = makeTerminal()
  const coalescer = makeCoalescer()
  try {
    coalescer.install(terminal)
    terminal.output('before')
    terminal.exited = true
    await terminal.output('after')
    assert.equal(coalescer.tracked, 0)
    assert.deepEqual(terminal.calls, ['beforeafter'])
  } finally {
    coalescer.dispose()
  }
})

// Given 同一原型上的多个终端各自写过输出, When 卸载, Then 每个待发缓冲都被排空且跟踪集合清空
test('Given several tracked terminals, When disposed, Then all buffers flush and tracking is cleared', async () => {
  const proto = {
    async output(data) {
      if (data.length === 0) return
      this.calls.push(data)
    },
  }
  const makeShared = () => {
    const terminal = Object.create(proto)
    terminal.followers = new Set([{}])
    terminal.exited = false
    terminal.calls = []
    return terminal
  }
  const first = makeShared()
  const second = makeShared()
  const coalescer = makeCoalescer()
  coalescer.install(first)
  first.output('a')
  second.output('b')
  assert.equal(coalescer.tracked, 2)
  coalescer.dispose()
  assert.equal(coalescer.tracked, 0)
  await settle()
  assert.deepEqual(first.calls, ['a'])
  assert.deepEqual(second.calls, ['b'])
})

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

// Given 合并器已启用并缓冲了输出, When 运行中关闭, Then 先排空旧缓冲, 后续输出直通且不再等待窗口
test('Given the coalescer enabled, When disabled at runtime, Then pending output flushes and later chunks pass through', async () => {
  let enabled = true
  const terminal = makeTerminal()
  const coalescer = makeCoalescer({ isEnabled: () => enabled })
  try {
    coalescer.install(terminal)
    terminal.output('a')
    terminal.output('b')
    assert.deepEqual(terminal.calls, [])
    enabled = false
    terminal.output('c')
    await settle()
    assert.deepEqual(terminal.calls, ['ab', 'c'])
    terminal.output('d')
    assert.deepEqual(terminal.calls, ['ab', 'c', 'd'])
  } finally {
    coalescer.dispose()
  }
})

// Given 合并器启动时关闭, When 运行中开启, Then 无需重装即可恢复合并
test('Given the coalescer disabled, When enabled at runtime, Then later chunks merge without reinstall', async () => {
  let enabled = false
  const terminal = makeTerminal()
  const coalescer = makeCoalescer({ isEnabled: () => enabled })
  try {
    coalescer.install(terminal)
    terminal.output('a')
    terminal.output('b')
    assert.deepEqual(terminal.calls, ['a', 'b'])
    enabled = true
    terminal.output('c')
    terminal.output('d')
    assert.deepEqual(terminal.calls, ['a', 'b'])
    await settle()
    assert.deepEqual(terminal.calls, ['a', 'b', 'cd'])
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

// Given 有未发出的数据,When 收到空串,Then 先排空再按原语义忽略空串且继续跟踪
test('Given pending bytes, When an empty chunk arrives, Then pending output is delivered first', async () => {
  const terminal = makeTerminal()
  const coalescer = makeCoalescer()
  try {
    coalescer.install(terminal)
    terminal.output('last')
    await terminal.output('')
    assert.deepEqual(terminal.calls, ['last'])
    assert.equal(coalescer.tracked, 1)
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

// Given 开关关闭且已有终端,When 安装入口被调用,Then 先 patch 以便热开启但输出直通,且无探测定时器
test('Given the feature disabled, When installing, Then the wrapper is installed but output passes through', async () => {
  let enabled = false
  const terminal = makeTerminal()
  const proto = Object.getPrototypeOf(terminal)
  const original = proto.output
  const clock = fakeTimeoutClock()
  const fakeCtx = {
    effect: (fn) => { fn() },
    get: (name) => (name === 'terminalController' ? { owners: new Map([['s', { terminals: new Map([['t', terminal]]) }]]) } : undefined),
  }
  const dispose = installTerminalCoalesce(fakeCtx, { isEnabled: () => enabled, readWindow: () => WINDOW_MS, timers: clock })
  try {
    assert.notEqual(proto.output, original)
    assert.equal(clock.timerCount(), 0)
    terminal.output('a')
    terminal.output('b')
    assert.deepEqual(terminal.calls, ['a', 'b'])

    enabled = true
    terminal.output('c')
    terminal.output('d')
    assert.deepEqual(terminal.calls, ['a', 'b'])
    await settle()
    assert.deepEqual(terminal.calls, ['a', 'b', 'cd'])
  } finally {
    dispose()
  }
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

// Given 安装时开启并已缓冲输出, When 运行中关闭, Then 安装入口传入的开关在每次派发生效并直通
test('Given installed while enabled, When the switch turns off, Then later output passes through', async () => {
  let enabled = true
  const terminal = makeTerminal()
  const fakeCtx = {
    effect: (fn) => { fn() },
    get: (name) => (name === 'terminalController' ? { owners: new Map([['s', { terminals: new Map([['t', terminal]]) }]]) } : undefined),
  }
  const dispose = installTerminalCoalesce(fakeCtx, { isEnabled: () => enabled, readWindow: () => WINDOW_MS })
  try {
    terminal.output('a')
    terminal.output('b')
    enabled = false
    terminal.output('c')
    await settle()
    assert.deepEqual(terminal.calls, ['ab', 'c'])
  } finally {
    dispose()
  }
})

function fakeTimeoutClock() {
  let nextId = 0
  const timers = new Map()
  return {
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id },
    clearTimeout: (id) => timers.delete(id),
    timerCount: () => timers.size,
    delay: () => [...timers.values()][0]?.ms,
    fire() {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, timer] of pending) timer.fn()
    },
  }
}

// Given 启动时关闭且当前无终端, When 运行中开启并出现终端, Then 探测先降频再安装, 安装后停止
test('Given the feature disabled while waiting, When enabled and a terminal appears, Then it installs and stops watching', () => {
  let enabled = false
  let controller
  const terminal = makeTerminal()
  const proto = Object.getPrototypeOf(terminal)
  const original = proto.output
  const clock = fakeTimeoutClock()
  const fakeCtx = {
    effect: (fn) => { fn() },
    get: (name) => (name === 'terminalController' ? controller : undefined),
  }
  const dispose = installTerminalCoalesce(fakeCtx, { isEnabled: () => enabled, readWindow: () => WINDOW_MS, timers: clock })
  assert.equal(proto.output, original)
  assert.equal(clock.delay(), DISABLED_INSTALL_WATCH_MS)

  enabled = true
  clock.fire()
  assert.equal(proto.output, original)
  assert.equal(clock.delay(), INSTALL_RETRY_MS)

  controller = { owners: new Map([['s', { terminals: new Map([['t', terminal]]) }]]) }
  clock.fire()
  assert.notEqual(proto.output, original)
  assert.equal(clock.timerCount(), 0)

  dispose()
  assert.equal(proto.output, original)
})

// Given 注入的 FinalizationRegistry 收到回收回调, When 回调触发, Then 死引用从跟踪集合移除
test('Given an injected FinalizationRegistry, When it reports collection, Then the weak ref is dropped', () => {
  const instances = []
  class FakeFinalizationRegistry {
    constructor(callback) {
      this.callback = callback
      this.entries = new Map()
      instances.push(this)
    }
    register(_target, held, token) { this.entries.set(token, held) }
    unregister(token) { this.entries.delete(token) }
  }
  const terminal = makeTerminal()
  const coalescer = createTerminalCoalescer({
    readWindow: () => WINDOW_MS,
    finalizationRegistry: FakeFinalizationRegistry,
  })
  try {
    coalescer.install(terminal)
    terminal.output('alive')
    assert.equal(coalescer.tracked, 1)
    const registry = instances[0]
    assert.equal(registry.entries.size, 1)
    const [held] = registry.entries.values()
    registry.callback(held)
    assert.equal(coalescer.tracked, 0)
  } finally {
    coalescer.dispose()
  }
})

// Given 同一原型上两代并存, When 旧代仍持包装, Then 新代不把他代 marker 当已安装; 旧代卸载后新代接管
test('Given two generations share one prototype, When the old one disposes, Then the new one takes over', async () => {
  const terminal = makeTerminal()
  const proto = Object.getPrototypeOf(terminal)
  const original = proto.output
  const oldGeneration = makeCoalescer()
  const newGeneration = makeCoalescer()
  try {
    assert.equal(oldGeneration.install(terminal), true)
    assert.equal(newGeneration.install(terminal), false)
    assert.equal(newGeneration.installed, false)
    terminal.output('a')
    terminal.output('b')
    await settle()
    assert.deepEqual(terminal.calls, ['ab'])

    oldGeneration.dispose()
    assert.equal(proto.output, original)
    assert.equal(newGeneration.install(terminal), true)
    assert.equal(newGeneration.installed, true)
    terminal.output('c')
    terminal.output('d')
    await settle()
    assert.deepEqual(terminal.calls, ['ab', 'cd'])
  } finally {
    newGeneration.dispose()
  }
  assert.equal(proto.output, original)
})

// Given 新代在旧代卸载前 apply, When 旧代随后卸载, Then 新代按探测重试补装并恢复合并
test('Given a new generation applied while the old holds the patch, When the old disposes, Then the retry installs it', async () => {
  const terminal = makeTerminal()
  const proto = Object.getPrototypeOf(terminal)
  const original = proto.output
  const controller = { owners: new Map([['session', { terminals: new Map([['terminal', terminal]]) }]]) }
  const ctx = {
    effect: (factory) => { factory() },
    get: (name) => (name === 'terminalController' ? controller : undefined),
  }
  const oldDispose = installTerminalCoalesce(ctx, { isEnabled: () => true, readWindow: () => WINDOW_MS })
  assert.notEqual(proto.output, original)
  const retryClock = fakeTimeoutClock()
  const newDispose = installTerminalCoalesce(ctx, { isEnabled: () => true, readWindow: () => WINDOW_MS, timers: retryClock })
  try {
    assert.equal(retryClock.delay(), INSTALL_RETRY_MS)
    terminal.output('a')
    terminal.output('b')
    await settle()
    assert.deepEqual(terminal.calls, ['ab'])

    oldDispose()
    assert.equal(proto.output, original)
    retryClock.fire()
    assert.notEqual(proto.output, original)
    assert.equal(retryClock.timerCount(), 0)
    terminal.output('c')
    terminal.output('d')
    assert.deepEqual(terminal.calls, ['ab'])
    await settle()
    assert.deepEqual(terminal.calls, ['ab', 'cd'])
  } finally {
    newDispose()
    oldDispose()
  }
  assert.equal(proto.output, original)
})

// Given 旧代在共享外层包装之下卸载, When 外层随后卸载, Then 新代绕过僵尸旧包装直接接管
test('Given a disposed generation under a shared outer wrapper, When the outer unloads, Then the new generation takes over', async () => {
  const terminal = makeTerminal()
  const proto = Object.getPrototypeOf(terminal)
  const base = proto.output
  const oldGeneration = makeCoalescer()
  assert.equal(oldGeneration.install(terminal), true)
  const oldPatched = proto.output
  // 另一个插件的外层包装持有旧代包装
  proto.output = function outer(data) { return oldPatched.call(this, data) }
  const newGeneration = makeCoalescer()
  try {
    assert.equal(newGeneration.install(terminal), false)

    oldGeneration.dispose()
    // 外层仍在顶部: 旧代必须透传, 不能调用被置空的 original
    terminal.output('a')
    terminal.output('b')
    await settle()
    assert.deepEqual(terminal.calls, ['a', 'b'])
    // 外层未卸载前新代不得覆盖, 否则外层卸载会回滚到旧包装
    assert.equal(newGeneration.install(terminal), false)

    // 外层卸载: 它把捕获的旧包装还原为顶部
    proto.output = oldPatched
    assert.equal(newGeneration.install(terminal), true)
    terminal.output('c')
    terminal.output('d')
    assert.deepEqual(terminal.calls, ['a', 'b'])
    await settle()
    assert.deepEqual(terminal.calls, ['a', 'b', 'cd'])
  } finally {
    newGeneration.dispose()
  }
  assert.equal(proto.output, base)
})

// Given 共享外层包装挡住接管, When 旧代卸载且外层随后卸载, Then 新代探测重试接替而非叠成僵尸链
test('Given an outer wrapper blocks takeover, When the old and then the outer unload, Then the waiting generation installs', async () => {
  const terminal = makeTerminal()
  const proto = Object.getPrototypeOf(terminal)
  const base = proto.output
  const controller = { owners: new Map([['session', { terminals: new Map([['terminal', terminal]]) }]]) }
  const ctx = {
    effect: (factory) => { factory() },
    get: (name) => (name === 'terminalController' ? controller : undefined),
  }
  const oldDispose = installTerminalCoalesce(ctx, { isEnabled: () => true, readWindow: () => WINDOW_MS })
  const oldPatched = proto.output
  proto.output = function outer(data) { return oldPatched.call(this, data) }
  const retryClock = fakeTimeoutClock()
  const newDispose = installTerminalCoalesce(ctx, { isEnabled: () => true, readWindow: () => WINDOW_MS, timers: retryClock })
  try {
    assert.equal(retryClock.delay(), INSTALL_RETRY_MS)
    oldDispose()
    retryClock.fire()
    assert.ok(retryClock.timerCount() > 0, '外层未卸载前必须继续探测')
    proto.output = oldPatched
    retryClock.fire()
    assert.equal(retryClock.timerCount(), 0)
    terminal.output('a')
    terminal.output('b')
    await settle()
    assert.deepEqual(terminal.calls, ['ab'])
  } finally {
    newDispose()
    oldDispose()
  }
  assert.equal(proto.output, base)
})

// Given 终端正常退出, When 摘除跟踪, Then 同步注销 FinalizationRegistry 注册
test('Given an exited terminal, When it is untracked, Then the registry registration is removed', async () => {
  const instances = []
  class FakeFinalizationRegistry {
    constructor(callback) {
      this.callback = callback
      this.entries = new Map()
      instances.push(this)
    }
    register(_target, held, token) { this.entries.set(token, held) }
    unregister(token) { this.entries.delete(token) }
  }
  const terminal = makeTerminal()
  const coalescer = createTerminalCoalescer({
    readWindow: () => WINDOW_MS,
    finalizationRegistry: FakeFinalizationRegistry,
  })
  try {
    coalescer.install(terminal)
    terminal.output('tail')
    terminal.exited = true
    await terminal.output('after')
    assert.equal(coalescer.tracked, 0)
    assert.equal(instances[0].entries.size, 0)
  } finally {
    coalescer.dispose()
  }
})
