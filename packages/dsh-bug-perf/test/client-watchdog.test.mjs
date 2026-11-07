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

function fakeTimers() {
  let now = 0
  let nextId = 0
  const intervals = new Map()
  return {
    now: () => now,
    setInterval: (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, every: ms, at: now + ms }); return id },
    clearInterval: (id) => { intervals.delete(id) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...intervals]) {
        if (timer.at <= now) {
          timer.at = now + timer.every
          timer.fn()
        }
      }
    },
    intervalCount: () => intervals.size,
  }
}

function fakeView({ writable = false, phase = 'connected', revision = 1, pendingRender, hasStream = true } = {}) {
  const snapshot = { phase, writable }
  return {
    sessionId: 'session-a',
    id: 'term-a',
    revision,
    pendingRender,
    stream: hasStream ? {} : undefined,
    connects: 0,
    lifetime: { signal: { addEventListener() {} } },
    state: { getSnapshot: () => snapshot },
    snapshot,
    connect() { this.connects += 1 },
  }
}

const OPTIONS = { checkMs: 2000, stallMs: 8000, cooldownMs: 60000 }

function stateFor(view, now = 0) {
  return { revision: view.revision, changedAt: now, armed: false, healedAt: -Infinity }
}

// Given 视图从未可写(旁观只读), When 长时间无输出, Then 不触发重连
test('看门狗_未武装_不触发', () => {
  const plugin = loadPlugin()
  const view = fakeView({ writable: false })
  const state = stateFor(view)
  const result = plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 30000, visible: true })
  assert.equal(result, 'idle')
  assert.equal(state.armed, false)
})

// Given 视图曾接管输入随后卡住, When 停滞超过阈值, Then 触发一次重连并释放武装
test('看门狗_已武装停滞_触发重连', () => {
  const plugin = loadPlugin()
  const view = fakeView({ writable: true })
  const state = stateFor(view)
  assert.equal(plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 1000, visible: true }), 'progress')
  assert.equal(state.armed, true)
  view.snapshot.writable = false
  assert.equal(plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 5000, visible: true }), 'idle')
  assert.equal(plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 10500, visible: true }), 'heal')
  assert.equal(state.armed, false)
  assert.equal(state.healedAt, 10500)
})

// Given 视图持续有新帧, When 每轮检查, Then 只报进度不触发
test('看门狗_持续有新帧_不触发', () => {
  const plugin = loadPlugin()
  const view = fakeView({ writable: true })
  const state = stateFor(view)
  for (let i = 1; i <= 6; i++) {
    view.revision = i
    const result = plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: i * 10000, visible: true })
    assert.equal(result, 'progress')
  }
})

// Given 刚自愈过, When 再次停滞进入冷却期, Then 不重复重连
test('看门狗_冷却期_不重复', () => {
  const plugin = loadPlugin()
  const view = fakeView({ writable: true })
  const state = stateFor(view)
  plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 1000, visible: true })
  view.snapshot.writable = false
  assert.equal(plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 9500, visible: true }), 'heal')
  state.armed = true
  assert.equal(plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 20000, visible: true }), 'cooldown')
})

// Given 页面隐藏, When 停滞判定到期, Then 不触发(隐藏期的停顿不是故障)
test('看门狗_页面隐藏_不触发', () => {
  const plugin = loadPlugin()
  const view = fakeView({ writable: true })
  const state = stateFor(view)
  assert.equal(plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 1000, visible: true }), 'progress')
  view.snapshot.writable = false
  assert.equal(plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 20000, visible: false }), 'hidden')
})

// Given 视图正在等渲染或没有 attach 流, When 检查, Then 不当作冻结处理
test('看门狗_待渲染或无流_不触发', () => {
  const plugin = loadPlugin()
  const pending = fakeView({ writable: true, pendingRender: {} })
  const pendingState = stateFor(pending)
  plugin.__test.watchdogTick({ view: pending, state: pendingState, options: OPTIONS, now: 1000, visible: true })
  pending.snapshot.writable = false
  assert.equal(plugin.__test.watchdogTick({ view: pending, state: pendingState, options: OPTIONS, now: 20000, visible: true }), 'pending-render')

  const detached = fakeView({ writable: true, hasStream: false })
  const detachedState = stateFor(detached)
  plugin.__test.watchdogTick({ view: detached, state: detachedState, options: OPTIONS, now: 1000, visible: true })
  detached.snapshot.writable = false
  assert.equal(plugin.__test.watchdogTick({ view: detached, state: detachedState, options: OPTIONS, now: 20000, visible: true }), 'no-stream')
})

// Given 视图已断开重连中, When 检查, Then 只报未连接, 不叠加重连
test('看门狗_未连接_不触发', () => {
  const plugin = loadPlugin()
  const view = fakeView({ writable: true, phase: 'connecting' })
  const state = stateFor(view)
  plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 1000, visible: true })
  view.snapshot.writable = false
  assert.equal(plugin.__test.watchdogTick({ view, state, options: OPTIONS, now: 20000, visible: true }), 'not-connected')
})

// Given 新视图由官方服务创建, When 看门狗安装后推进到停滞阈值, Then 自动调用 connect 恢复输出
test('看门狗_新建视图_自动重连', () => {
  const plugin = loadPlugin()
  const timers = fakeTimers()
  const holder = { view() { return this.created }, created: fakeView({ writable: true }), views: new Map() }
  const result = plugin.__test.installTerminalWatchdog({ holder, options: OPTIONS, timers, isVisible: () => true })
  assert.equal(result.installed, true)
  const view = holder.view('session-a', 'tab-1', 'content-1')
  timers.advance(2000)
  view.snapshot.writable = false
  timers.advance(8000)
  assert.equal(view.connects, 1)
})

// Given 已存在的视图, When 安装时遍历 views, Then 同样进入监控
test('看门狗_既有视图_进入监控', () => {
  const plugin = loadPlugin()
  const timers = fakeTimers()
  const existing = fakeView({ writable: true })
  const holder = { view: () => existing, views: new Map([['session-a', new Map([['tab-1', existing]])]]) }
  plugin.__test.installTerminalWatchdog({ holder, options: OPTIONS, timers, isVisible: () => true })
  timers.advance(2000)
  existing.snapshot.writable = false
  timers.advance(8000)
  assert.equal(existing.connects, 1)
})

// Given 宿主版本没有 webTerminals.view, When 安装, Then 跳过并不抛错
test('看门狗_服务结构缺失_跳过不抛', () => {
  const plugin = loadPlugin()
  const missing = plugin.__test.installTerminalWatchdog({ holder: {}, options: OPTIONS, timers: fakeTimers(), isVisible: () => true })
  assert.equal(missing.installed, false)
  const alsoMissing = plugin.__test.installTerminalWatchdog({ holder: undefined, options: OPTIONS, timers: fakeTimers(), isVisible: () => true })
  assert.equal(alsoMissing.installed, false)
})

// Given 已安装, When 再次安装, Then 幂等不重复挂定时器
test('看门狗_重复安装_幂等', () => {
  const plugin = loadPlugin()
  const timers = fakeTimers()
  const holder = { view: () => fakeView({ writable: true }), views: new Map() }
  plugin.__test.installTerminalWatchdog({ holder, options: OPTIONS, timers, isVisible: () => true })
  const again = plugin.__test.installTerminalWatchdog({ holder, options: OPTIONS, timers, isVisible: () => true })
  assert.equal(again.installed, false)
  assert.equal(timers.intervalCount() <= 1, true)
})
