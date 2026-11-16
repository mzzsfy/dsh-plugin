// 客户端补丁的生命周期契约:每个安装入口都返回还原句柄,apply 把它们收进一个 ctx.effect,
// HMR/禁用/同页重放时定时器、观察器、DOM 监听与宿主方法包装都必须被摘掉,不能按代数叠加。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const GATEWAY_CLIENT_ID = '@deepseek-ai/dsh-api-gateway/client'

function loadPlugin({ modules = {}, window: fakeWindow } = {}) {
  let registered
  const window = fakeWindow ?? {}
  window.__ModuleLoader__ = { load: (entry) => { registered = entry } }
  new Function('window', source)(window)
  const requireImpl = (id) => {
    if (Object.hasOwn(modules, id)) return modules[id]
    throw new Error(`module not registered: ${id}`)
  }
  return registered.factory(requireImpl)
}

function fakeClock() {
  let now = 0
  let nextId = 0
  const intervals = new Map()
  const timeouts = new Map()
  return {
    now: () => now,
    setInterval: (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, every: ms, at: now + ms }); return id },
    clearInterval: (id) => { intervals.delete(id) },
    setTimeout: (fn, ms) => { const id = ++nextId; timeouts.set(id, { fn, at: now + ms }); return id },
    clearTimeout: (id) => { timeouts.delete(id) },
    advance(ms) {
      const target = now + ms
      while (true) {
        const due = [...timeouts.values(), ...intervals.values()].map((timer) => timer.at).filter((at) => at <= target)
        if (due.length === 0) break
        now = Math.min(...due)
        for (const [id, timer] of [...timeouts]) {
          if (timer.at <= now) {
            timeouts.delete(id)
            timer.fn()
          }
        }
        for (const [id, timer] of [...intervals]) {
          if (timer.at <= now) {
            timer.at = now + timer.every
            timer.fn()
          }
        }
      }
      now = target
    },
    intervalCount: () => intervals.size,
    timeoutCount: () => timeouts.size,
    fireIntervals: () => { for (const timer of [...intervals.values()]) timer.fn() },
  }
}

function fakeNode(tag) {
  const node = {
    tag,
    attrs: {},
    children: [],
    listeners: [],
    textContent: '',
    className: '',
    setAttribute(key, value) { node.attrs[key] = String(value) },
    appendChild(child) { node.children.push(child); child.parent = node; return child },
    remove() { const parent = node.parent; if (parent !== undefined) parent.children = parent.children.filter((item) => item !== node) },
    addEventListener(type, fn) { node.listeners.push({ type, fn }) },
    removeEventListener(type, fn) { node.listeners = node.listeners.filter((item) => item.type !== type || item.fn !== fn) },
    get childElementCount() { return node.children.length },
    get lastElementChild() { return node.children.at(-1) ?? null },
    hasAttribute(name) { return node.attrs[name] !== undefined },
    getAttribute(name) { return node.attrs[name] ?? null },
    closest() { return null },
    querySelectorAll() { return [] },
    querySelector() { return null },
  }
  return node
}

function fakeDocument({ stalled = false } = {}) {
  const head = fakeNode('head')
  const body = fakeNode('body')
  // 停滞判定: 会话流容器里没有有效消息行, 直接子节点文本与加载提示完全一致
  const flow = fakeNode('div')
  if (stalled) {
    const hint = fakeNode('div')
    hint.textContent = '载入历史…'
    flow.appendChild(hint)
  }
  const doc = {
    head,
    body,
    flow,
    visibilityState: 'visible',
    createElement: (tag) => fakeNode(tag),
    querySelector: (selector) => (selector === '[data-chat-flow]' ? flow : null),
    querySelectorAll: () => ({ length: 0 }),
    getElementById: (id) => [...body.children, ...head.children].find((node) => node.attrs.id === id) ?? null,
    addEventListener(type, fn) { doc.listeners.push({ type, fn }) },
    removeEventListener(type, fn) { doc.listeners = doc.listeners.filter((item) => item.type !== type || item.fn !== fn) },
    listeners: [],
  }
  return doc
}

const OPTIONS_WATCHDOG = { checkMs: 2000, stallMs: 8000, cooldownMs: 60000 }
const OPTIONS_STUCK = { checkMs: 3000, stallMs: 60000, reconnect: true, maxReconnectAttempts: 2, reconnectIntervalMs: 120000 }

// Given 合并窗口内有在途尾随重启, When 卸载, Then 原型恢复原名且尾随定时器被取消
test('生命周期_重启合并_卸载还原原型', () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  class RemoteStream {}
  RemoteStream.prototype.restart = function restart() { this.restarts = (this.restarts ?? 0) + 1 }
  const proto = RemoteStream.prototype
  const originalRestart = proto.restart
  const installed = plugin.__test.installRestartCoalesce({ RemoteStream, windowMs: 100, timers: clock })
  assert.equal(installed.installed, true)
  const stream = new RemoteStream()
  stream.restart()
  stream.restart()
  assert.equal(stream.restarts, 1)
  assert.equal(clock.timeoutCount(), 1)
  installed.dispose()
  assert.equal(proto.restart, originalRestart)
  assert.equal(clock.timeoutCount(), 0)
  clock.advance(500)
  assert.equal(stream.restarts, 1)
  // 卸载后可重新安装:标记随本代一起撤销
  assert.equal(plugin.__test.installRestartCoalesce({ RemoteStream, windowMs: 100, timers: clock }).installed, true)
})

// Given 看门狗已监控若干视图, When 卸载, Then 检查节拍全停且 holder.view 回到原实现
test('生命周期_终端看门狗_卸载还原视图入口', () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const view = {
    sessionId: 'session-a',
    id: 'term-a',
    revision: 1,
    stream: {},
    lifetime: { signal: { addEventListener() {} } },
    state: { getSnapshot: () => ({ phase: 'connected', writable: true }) },
    connect() { this.connects = (this.connects ?? 0) + 1 },
  }
  const holder = { view: () => view, views: new Map() }
  const originalView = holder.view
  const installed = plugin.__test.installTerminalWatchdog({ holder, options: OPTIONS_WATCHDOG, timers: clock, isVisible: () => true })
  assert.equal(installed.installed, true)
  assert.notEqual(holder.view, originalView)
  holder.view('session-a', 'tab-1', 'content-1')
  assert.equal(clock.intervalCount(), 1)
  installed.dispose()
  assert.equal(holder.view, originalView)
  assert.equal(clock.intervalCount(), 0)
  const again = plugin.__test.installTerminalWatchdog({ holder, options: OPTIONS_WATCHDOG, timers: clock, isVisible: () => true })
  assert.equal(again.installed, true)
  again.dispose()
})

// Given 停滞兜底已装并已显示提示条, When 卸载, Then 停表、移除提示与样式并允许重装
test('生命周期_停滞兜底_卸载清定时器与提示', () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const doc = fakeDocument({ stalled: true })
  const win = { document: doc, location: { reload() {} } }
  const installed = plugin.__test.installStuckSession({ win, options: OPTIONS_STUCK, clock, connection: { reconnect() {} } })
  assert.equal(installed.installed, true)
  assert.equal(clock.intervalCount(), 1)
  assert.ok(doc.getElementById('dsh-bug-perf-stuck-style') !== null)
  installed.dispose()
  assert.equal(clock.intervalCount(), 0)
  assert.equal(doc.getElementById('dsh-bug-perf-stuck-style'), null)
  // 卸载后可重装: 用尽重连次数后出现提示条, 再卸载时提示条一并摘掉
  const connection = { calls: 0, reconnect() { connection.calls += 1 } }
  const options = { ...OPTIONS_STUCK, maxReconnectAttempts: 1, reconnectIntervalMs: 1000 }
  const second = plugin.__test.installStuckSession({ win, options, clock, connection })
  assert.equal(second.installed, true)
  clock.advance(3000 * 45)
  assert.equal(connection.calls, 1)
  assert.ok(doc.getElementById('dsh-bug-perf-stuck') !== null)
  second.dispose()
  assert.equal(doc.getElementById('dsh-bug-perf-stuck'), null)
  assert.equal(doc.getElementById('dsh-bug-perf-stuck-style'), null)
  assert.equal(clock.intervalCount(), 0)
})

// Given 采样已启动, When 卸载, Then 采样/探测定时器、观察器与 error 监听全部撤销
test('生命周期_诊断采样_卸载撤销观察器与监听', () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const doc = fakeDocument()
  const disconnected = []
  class FakeObserver {
    constructor() {}
    observe() {}
    disconnect() { disconnected.push(true) }
  }
  const errorListeners = new Set()
  const win = {
    document: doc,
    performance: {},
    setTimeout: () => 1,
    PerformanceObserver: FakeObserver,
    addEventListener: (type, fn) => { if (type === 'error') errorListeners.add(fn) },
    removeEventListener: (type, fn) => { if (type === 'error') errorListeners.delete(fn) },
    fetch: () => Promise.resolve({ ok: true }),
  }
  const diag = plugin.__test.createDiag(clock)
  const sampling = plugin.__test.startDiagSampling({ win, clock, diag, doc })
  assert.equal(clock.intervalCount(), 2)
  assert.equal(errorListeners.size, 1)
  const reporting = plugin.__test.startDiagReporting({ win, clock, diag, options: { enabled: true, reportEvery: 2 } })
  assert.equal(clock.intervalCount(), 3)
  sampling.dispose()
  reporting.dispose()
  assert.equal(clock.intervalCount(), 0)
  assert.equal(errorListeners.size, 0)
  assert.deepEqual(disconnected, [true])
  assert.equal(diag.enabled, false)
})

// Given 任务流上限已接管 watchRows, When 卸载, Then 还原原方法、摘点击监听并允许重新接管
test('生命周期_任务流上限_卸载还原watchRows', () => {
  const plugin = loadPlugin()
  let watched = 0
  const jobs = { watchRows() { watched += 1; return () => {} } }
  const originalWatchRows = jobs.watchRows
  const doc = fakeDocument()
  const installed = plugin.__test.installJobStreamLimit({
    jobs,
    options: { enabled: true, base: 4, max: 8 },
    workspacesOf: () => undefined,
    uiSessionOf: () => undefined,
    doc,
  })
  assert.equal(installed.installed, true)
  assert.notEqual(jobs.watchRows, originalWatchRows)
  assert.equal(doc.listeners.length, 1)
  installed.dispose()
  assert.equal(jobs.watchRows, originalWatchRows)
  assert.equal(doc.listeners.length, 0)
  const again = plugin.__test.installJobStreamLimit({
    jobs,
    options: { enabled: true, base: 4, max: 8 },
    workspacesOf: () => undefined,
    uiSessionOf: () => undefined,
    doc,
  })
  assert.equal(again.installed, true)
  again.dispose()
})

// ---------------- apply 级: 世代不叠加 ----------------

function fakeEnv() {
  const doc = fakeDocument()
  const window = {
    document: doc,
    location: { pathname: '/chat', href: 'https://dsh.example/', reload() {} },
    performance: { memory: { usedJSHeapSize: 64 * 1024 * 1024 } },
    WebSocket: class NativeSocket {},
    setTimeout: () => 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    fetch: () => Promise.resolve({ ok: true }),
  }
  return { window, doc }
}

function makeCtx(effects) {
  const scope = (deps) => {
    if (deps.includes('jobs')) return { jobs: { watchRows: () => () => {} } }
    if (deps.includes('connection')) return { connection: { reconnect() {} } }
    if (deps.includes('webTerminals')) return { webTerminals: undefined }
    return {}
  }
  return {
    effect: (factory) => { effects.push(factory()) },
    inject: (deps, callback) => { callback(scope(deps)) },
    get: () => undefined,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function withPatchedTimers(run) {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realFetch = globalThis.fetch
  const intervals = new Map()
  let nextId = 0
  globalThis.setInterval = (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, ms }); return id }
  globalThis.clearInterval = (id) => { intervals.delete(id) }
  // 配置路由不可达: 客户端退回内联默认值,补丁按默认开关安装
  globalThis.fetch = () => Promise.resolve({ ok: false })
  try {
    return await run(intervals)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    globalThis.fetch = realFetch
  }
}

const gateway = (RemoteStream) => ({ [GATEWAY_CLIENT_ID]: { RemoteStream } })

// Given 已装载的客户端插件被 effect 清理, When 清理执行, Then 所有定时器归零且宿主面回到原实现
test('生命周期_apply_effect清理还原全部补丁', async () => {
  await withPatchedTimers(async (intervals) => {
    class RemoteStream {}
    RemoteStream.prototype.restart = function restart() { this.restarts = (this.restarts ?? 0) + 1 }
    const { window } = fakeEnv()
    const plugin = loadPlugin({ modules: gateway(RemoteStream), window })
    const NativeSocket = window.WebSocket
    const effects = []
    const dispose = plugin.apply(makeCtx(effects))
    await settle()
    assert.equal(typeof dispose, 'function')
    assert.ok(intervals.size >= 2)
    assert.notEqual(window.WebSocket, NativeSocket)
    assert.notEqual(RemoteStream.prototype.restart.name, 'restart')
    assert.equal(effects.length, 1)
    effects[0]()
    assert.equal(intervals.size, 0)
    assert.equal(window.WebSocket, NativeSocket)
    assert.equal(RemoteStream.prototype.restart.name, 'restart')
    assert.equal(window.__dshBugPerf.features.stuckSession.installed, true)
  })
})

// Given apply 返回的还原句柄, When 直接调用(不经 effect), Then 同样还原全部补丁且重复调用安全
test('生命周期_apply_返回句柄可还原且幂等', async () => {
  await withPatchedTimers(async (intervals) => {
    class RemoteStream {}
    RemoteStream.prototype.restart = function restart() { this.restarts = (this.restarts ?? 0) + 1 }
    const { window } = fakeEnv()
    const plugin = loadPlugin({ modules: gateway(RemoteStream), window })
    const NativeSocket = window.WebSocket
    const dispose = plugin.apply(makeCtx([]))
    await settle()
    assert.ok(intervals.size >= 2)
    dispose()
    assert.equal(intervals.size, 0)
    assert.equal(window.WebSocket, NativeSocket)
    assert.equal(RemoteStream.prototype.restart.name, 'restart')
    // 卸载与配置关闭用不同原因, 现场能区分是 HMR 还是用户关开关
    assert.equal(window.__dshBugPerf.features.socketKeepAlive.reason, 'unloaded')
    dispose()
    assert.equal(intervals.size, 0)
  })
})

// Given 同一页面里模块被重放(上一代没有跑 effect 清理), When 新一代 apply, Then 先摘旧代再安装,定时器不翻倍
test('生命周期_同页重放_摘掉上一代', async () => {
  await withPatchedTimers(async (intervals) => {
    class RemoteStream {}
    RemoteStream.prototype.restart = function restart() { this.restarts = (this.restarts ?? 0) + 1 }
    const { window } = fakeEnv()
    const plugin = loadPlugin({ modules: gateway(RemoteStream), window })
    const firstEffects = []
    plugin.apply(makeCtx(firstEffects))
    await settle()
    const firstCount = intervals.size
    assert.ok(firstCount >= 2)
    // 不调用第一代的清理,直接重放
    const secondEffects = []
    plugin.apply(makeCtx(secondEffects))
    await settle()
    assert.equal(intervals.size, firstCount)
    assert.equal(secondEffects.length, 1)
    secondEffects[0]()
    assert.equal(intervals.size, 0)
  })
})
