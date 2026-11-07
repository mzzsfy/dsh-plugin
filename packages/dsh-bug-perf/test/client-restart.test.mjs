import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

// 客户端半区以模块加载器自注册,测试用最小 window 捕获 factory 后取 __test 纯逻辑
function loadPlugin({ modules = {} } = {}) {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  new Function('window', source)(window)
  const requireImpl = (id) => {
    if (Object.hasOwn(modules, id)) return modules[id]
    throw new Error(`module not registered: ${id}`)
  }
  return registered.factory(requireImpl)
}

function fakeTimers() {
  let now = 0
  let nextId = 0
  const pending = new Map()
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++nextId; pending.set(id, { fn, at: now + ms }); return id },
    clearTimeout: (id) => { pending.delete(id) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id)
          timer.fn()
        }
      }
    },
    pendingCount: () => pending.size,
  }
}

function installCoalesce(plugin, { timers, windowMs = 100 } = {}) {
  class RemoteStream {}
  RemoteStream.prototype.restart = function restart() { this.restarts = (this.restarts ?? 0) + 1 }
  const result = plugin.__test.installRestartCoalesce({ RemoteStream, windowMs, timers })
  return { result, RemoteStream }
}

// Given 同一实例在合并窗口内连续重启, When 时间推进到窗口结束, Then 只实际重开一次
test('重启合并_窗口内连发_尾随一次', () => {
  const plugin = loadPlugin()
  const timers = fakeTimers()
  const { result, RemoteStream } = installCoalesce(plugin, { timers })
  assert.equal(result.installed, true)
  const stream = new RemoteStream()
  for (let i = 0; i < 5; i++) {
    stream.restart()
    timers.advance(10)
  }
  assert.equal(stream.restarts, 1)
  timers.advance(100)
  assert.equal(stream.restarts, 2)
  assert.equal(timers.pendingCount(), 0)
})

// Given 两次重启间隔超过窗口, When 依次调用, Then 各自立即生效, 不被合并
test('重启合并_窗口外_逐次生效', () => {
  const plugin = loadPlugin()
  const timers = fakeTimers()
  const { RemoteStream } = installCoalesce(plugin, { timers })
  const stream = new RemoteStream()
  for (let i = 0; i < 3; i++) {
    stream.restart()
    timers.advance(150)
  }
  assert.equal(stream.restarts, 3)
})

// Given 两个实例各自连发, When 推进时间, Then 合并状态按实例隔离, 不互相吞掉
test('重启合并_实例隔离_各自一次', () => {
  const plugin = loadPlugin()
  const timers = fakeTimers()
  const { RemoteStream } = installCoalesce(plugin, { timers })
  const a = new RemoteStream()
  const b = new RemoteStream()
  a.restart(); b.restart()
  timers.advance(10)
  a.restart(); b.restart()
  timers.advance(120)
  assert.equal(a.restarts, 2)
  assert.equal(b.restarts, 2)
})

// Given 原型已被本插件包装, When 再次安装, Then 幂等返回未安装且不叠加包装
test('重启合并_重复安装_幂等', () => {
  const plugin = loadPlugin()
  const { result, RemoteStream } = installCoalesce(plugin, { timers: fakeTimers() })
  assert.equal(result.installed, true)
  const again = plugin.__test.installRestartCoalesce({ RemoteStream, windowMs: 100, timers: fakeTimers() })
  assert.equal(again.installed, false)
  const stream = new RemoteStream()
  stream.restart()
  assert.equal(stream.restarts, 1)
})

// Given 宿主版本没有 RemoteStream.restart, When 安装, Then 跳过且不抛错(跨版本宿主不受影响)
test('重启合并_结构缺失_跳过不抛', () => {
  const plugin = loadPlugin()
  const missing = plugin.__test.installRestartCoalesce({ RemoteStream: undefined, windowMs: 100, timers: fakeTimers() })
  assert.equal(missing.installed, false)
  const noRestart = plugin.__test.installRestartCoalesce({ RemoteStream: class {}, windowMs: 100, timers: fakeTimers() })
  assert.equal(noRestart.installed, false)
})

// Given 尾随时间触发时实例已释放并抛错, When 定时器到期, Then 错误被吞掉不影响页面
test('重启合并_释放后触发_不抛', () => {
  const plugin = loadPlugin()
  const timers = fakeTimers()
  const { RemoteStream } = installCoalesce(plugin, { timers })
  const stream = new RemoteStream()
  stream.restart()
  Object.defineProperty(stream, 'restarts', { get() { throw new Error('already disposed') }, configurable: true })
  stream.restart()
  assert.doesNotThrow(() => timers.advance(120))
})

// Given 客户端内联默认配置, When 与宿主共享配置对表, Then 两边默认值一致(防漂移)
test('配置_客户端内联_与宿主同源', async () => {
  const plugin = loadPlugin()
  const host = await import('../src/config.mjs')
  assert.deepEqual(plugin.__test.DEFAULT_CONFIG, host.DEFAULT_CONFIG)
  assert.deepEqual(plugin.__test.normalizeConfig({}), host.normalizeConfig({}))
})

// Given 远程配置缺失, When 客户端归一化, Then 落在与宿主一致的默认值上
test('配置_客户端缺失_默认值', () => {
  const plugin = loadPlugin()
  const config = plugin.__test.normalizeConfig(undefined)
  assert.equal(config.restartCoalesce.enabled, true)
  assert.equal(config.terminalWatchdog.enabled, true)
})

// Given 宿主模块表没有 gateway 客户端, When 安装合并, Then 记录原因而不是让插件装载失败
test('重启合并_缺模块_记录原因', () => {
  const plugin = loadPlugin()
  const result = plugin.__test.installRestartCoalesceFromRequire({
    requireImpl: () => { throw new Error('module not registered') },
    windowMs: 100,
    timers: fakeTimers(),
  })
  assert.equal(result.installed, false)
  assert.match(result.reason, /module not registered/)
})

// Given 模块存在, When 经 require 安装, Then 走包装且记录 installed
test('重启合并_经模块表_安装成功', () => {
  const plugin = loadPlugin()
  class RemoteStream {}
  RemoteStream.prototype.restart = function restart() { this.restarts = (this.restarts ?? 0) + 1 }
  const result = plugin.__test.installRestartCoalesceFromRequire({
    requireImpl: (id) => ({ RemoteStream }),
    windowMs: 100,
    timers: fakeTimers(),
  })
  assert.equal(result.installed, true)
})

// Given 合并窗口为 0, When 同一 tick 内连发, Then 每次都立即执行(等价关闭合并但保留开关语义)
test('重启合并_窗口为零_不合并', () => {
  const plugin = loadPlugin()
  const timers = fakeTimers()
  const { RemoteStream } = installCoalesce(plugin, { timers, windowMs: 0 })
  const stream = new RemoteStream()
  stream.restart()
  stream.restart()
  assert.equal(stream.restarts, 2)
})
