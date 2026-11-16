// Desktop(dsh-app://)总线退化 BDD:页面源为自定义协议、WebSocket 构造必抛、
// 公共总线永远不就绪时,client 半区不得崩溃,必须以周期拉取兜底并留下一次性告警。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ subscribeThrows = false } = {}) {
  const definitions = new Map()
  const requests = []
  const shown = []
  const warnings = []
  const timers = new Map()
  const storage = new Map()
  const subscriptions = []
  let timerId = 0, now = 0, socketAttempts = 0, calls = 0, busSetupCalls = 0
  class Clock extends Date { static now() { return now } }
  const window = {
    location: { href: 'dsh-app://app/', protocol: 'dsh-app:' },
    __ModuleLoader__: { load: definition => definitions.set(definition.id, definition) },
    localStorage: {
      get length() { return storage.size }, key: index => [...storage.keys()][index] ?? null,
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key),
    },
    addEventListener() {}, removeEventListener() {},
  }
  const document = {
    hidden: false, title: 'dsh', hasFocus: () => true,
    createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} },
  }
  // 桌面壳页面源不是 http(s):WebSocket 构造必然抛语法错误(Chromium 行为同构)
  class ThrowingWebSocket {
    constructor() {
      socketAttempts += 1
      throw new SyntaxError("Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'.")
    }
  }
  const pending = []
  const fetch = async (path) => {
    requests.push({ path })
    calls += 1
    if (path.indexOf('/sounds') >= 0) return { ok: true, json: async () => ({ sounds: [] }) }
    return new Promise(resolve => { pending.push(resolve) })
  }
  const bus = {
    subscribe(listener, { onReset } = {}) {
      if (subscribeThrows) throw new Error('bus unavailable')
      const record = { listener, onReset }
      subscriptions.push(record)
      return () => { const index = subscriptions.indexOf(record); if (index >= 0) subscriptions.splice(index, 1) }
    },
  }
  const tools = {
    createSnapshotRefresh: load => ({ refresh: () => { load() }, dispose() {} }),
    setupCommonTools: () => { busSetupCalls += 1; return bus },
    toast: { show: (text, options) => { shown.push({ text, options }); return shown.length } },
  }
  const react = { useState: value => [value, () => {}], useEffect() {}, useCallback: fn => fn }
  const setTimeout = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId }
  const clearTimeout = id => timers.delete(id)
  new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'WebSocket', 'Date', 'console', source)(
    window, document, fetch, setTimeout, clearTimeout, setTimeout, clearTimeout, ThrowingWebSocket, Clock,
    { warn: message => warnings.push(message) },
  )
  const mod = definitions.get('@mzzsfy/dsh-turn-notify').factory(name => name === 'react' ? react : tools)
  const services = {
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    uiWorkspace: undefined,
  }
  const advance = (ms) => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.delay <= ms) { timers.delete(id); timer.fn() }
    }
  }
  const respond = (payload) => { const resolve = pending.shift(); resolve({ ok: true, json: async () => payload }) }
  return {
    mod, bus, requests, shown, warnings, services, advance, respond, subscriptions,
    get socketAttempts() { return socketAttempts },
    get busSetupCalls() { return busSetupCalls },
    get pendingCount() { return pending.length },
  }
}

const snapshot = (version, units = []) => ({ version, units, soundMapping: {} })
const unit = { id: 'n1', category: 'completed', text: '任务完成', sessionId: 's1' }

test('Given dsh-app:// 源且 WebSocket 构造抛错 When 总线不就绪 Then 不崩溃、告警一次且周期拉取触发通知', async () => {
  const f = fixture()
  const dispose = f.mod.__test.start(f.bus, f.services)
  await flush()
  assert.equal(f.subscriptions.length, 1, '仍尝试订阅公共总线')
  assert.equal(f.socketAttempts, 0, '本包不自建 WebSocket')
  f.advance(3 * 1000)
  await flush()
  assert.equal(f.pendingCount, 1, '看门狗到期即发起兜底拉取')
  f.respond(snapshot(0))
  await flush()
  f.advance(10 * 1000)
  await flush()
  f.respond(snapshot(1, [unit]))
  await flush()
  assert.deepEqual(f.shown.map(item => item.text), ['任务完成'], '兜底拉取驱动页内通知')
  const degraded = f.warnings.filter(message => message.indexOf('推送总线未就绪') >= 0)
  assert.equal(degraded.length, 1, '总线降级告警只发一次')
  dispose()
})

test('Given 总线就绪 When 运行超过看门狗窗口 Then 不启用周期拉取', async () => {
  const f = fixture()
  const dispose = f.mod.__test.start(f.bus, f.services)
  await flush()
  f.subscriptions[0].onReset()
  await flush()
  const afterReset = f.requests.length
  f.advance(60 * 1000)
  await flush()
  assert.equal(f.requests.length, afterReset, '总线就绪后不得双跑轮询')
  assert.equal(f.warnings.filter(message => message.indexOf('推送总线') >= 0).length, 0)
  dispose()
})

test('Given 订阅即抛错 When 启动 Then 不崩溃且退化为周期拉取', async () => {
  const f = fixture({ subscribeThrows: true })
  const dispose = f.mod.__test.start(f.bus, f.services)
  await flush()
  assert.equal(f.warnings.filter(message => message.indexOf('推送总线不可用') >= 0).length, 1)
  f.advance(3 * 1000)
  await flush()
  assert.equal(f.pendingCount, 1, '订阅失败仍按看门狗兜底拉取')
  f.respond(snapshot(0))
  dispose()
})

test('Given 兜底轮询在途 When 代际卸载 Then 定时器清空且不再拉取', async () => {
  const f = fixture()
  const dispose = f.mod.__test.start(f.bus, f.services)
  await flush()
  f.advance(3 * 1000)
  await flush()
  f.respond(snapshot(0))
  dispose()
  const after = f.requests.length
  f.advance(60 * 1000)
  await flush()
  assert.equal(f.requests.length, after, '卸载后不得继续拉取')
})
