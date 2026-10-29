// 全链路集成测试:加载真实 client.js 模块,注入 broken / 正常 localStorage,
// 走 pollOnce 完整链路(清理段 → 认领 → 发声),验证降级接线与每事件去重。
import test, { afterEach } from 'node:test'
const activeDisposers = new Set()
afterEach(() => { for (const dispose of activeDisposers) dispose(); activeDisposers.clear() })
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

class FakeStorage {
  constructor(seed) { this.map = new Map(Object.entries(seed || {})) }
  get length() { return this.map.size }
  key(index) { return Array.from(this.map.keys())[index] ?? null }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
}

class BrokenStorage {
  get length() { throw new Error('blocked') }
  key() { throw new Error('blocked') }
  getItem() { throw new Error('blocked') }
  setItem() { throw new Error('blocked') }
  removeItem() { throw new Error('blocked') }
}

// 以注入的 stub 加载真实 src/client.js,返回捕获的模块对象、页内通知捕获表与 window 桩。
// shortTimers:闪烁常量替换为毫秒级,配合真实定时器验证硬顶与重入(node:test mock.timers
// 拦截不到 new Function 沙箱里的 timer,不能用于本 loader)
function loadClient({ storage, payload, onFetch, fetchImpl, document: documentOverride, shortTimers, timerImpl = setTimeout, clearTimerImpl = clearTimeout, intervalImpl = setInterval, clearIntervalImpl = clearInterval, dateImpl = Date, reactImpl, indexedDB, abortSignalImpl = AbortSignal, notificationImpl, currentSessionId = null }) {
  const raw = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8').replace('__test: { poll,', '__test: { startTitleBlink, playAudible, poll,')
  assert.ok(raw.includes('__test: { startTitleBlink, playAudible, poll,'), '测试钩子注入锚点失效:src/client.js 的 __test 行格式已变,核对替换锚点')
  const source = shortTimers
    ? raw.replace('const TOAST_MS = 6 * 1000', 'const TOAST_MS = 60')
      .replace('const BLINK_MS = 1 * 1000', 'const BLINK_MS = 20')
      .replace('const BLINK_MAX_MS = 30 * 1000', 'const BLINK_MAX_MS = 200')
    : raw
  const modules = []
  const shown = []
  const windowListeners = {}
  const windowStub = {
    __ModuleLoader__: { load: (module) => { modules.push(module) } },
    addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn) },
    removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] || []).filter((f) => f !== fn) },
    listeners: windowListeners,
    localStorage: storage,
    indexedDB,
  }
  const styleTags = []
  const documentStub = {
    hasFocus: () => true,
    // 默认桩:聚焦窗口恒可见(浏览器不变式);聚焦静默判定为可见+焦点双条件
    hidden: false,
    title: 'dsh',
    createElement: () => ({ style: {}, attrs: {}, setAttribute(name, value) { this.attrs[name] = value }, remove() {} }),
    body: { appendChild: () => {} },
    head: { appendChild: (node) => { styleTags.push(node) } },
    ...documentOverride,
  }
  const reactStub = { useState: (value) => [value, () => {}], useEffect: () => {}, useSyncExternalStore: () => [] }
  const busHandlers = []
  const requireStub = (name) => {
    // 页内通知通道出口与推送总线订阅:公共依赖 @mzzsfy/dsh-common-tools 捕获桩
    if (name === '@mzzsfy/dsh-common-tools/client') {
      return {
        createSnapshotRefresh: refresh => ({ refresh, dispose() {} }),
        toast: { show: (text, opts) => { shown.push({ text, opts }); return shown.length } },
        setupCommonTools: () => ({ subscribe: (onMessage, { onReset } = {}) => {
          const handlers = { onMessage, onReset }
          busHandlers.push(handlers)
          return () => { const index = busHandlers.indexOf(handlers); if (index >= 0) busHandlers.splice(index, 1) }
        } }),
      }
    }
    return reactImpl || reactStub
  }
  const defaultFetch = async (path) => {
    if (onFetch) onFetch(path)
    if (path.endsWith('/sounds')) return { ok: true, json: async () => ({ sounds: [] }) }
    // 首拉返回空投影:真实客户端启动即冷启动对齐,既有"正常消费"语义从第二次轮询起成立
    calls += 1
    if (calls === 1) return { ok: true, json: async () => ({ units: [], soundMapping: {}, version: 0 }) }
    return { ok: true, json: async () => payload }
  }
  const factory = new Function(
    'window', 'require', 'document', 'MutationObserver', 'fetch', 'Notification', 'requestAnimationFrame', 'cancelAnimationFrame', 'AbortSignal', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
    source + '\n;return null',
  )
  let calls = 0
  factory(
    windowStub,
    requireStub,
    documentStub,
    class { observe() {} disconnect() {} },
    fetchImpl || defaultFetch,
    notificationImpl,
    fn => setTimeout(fn, 0),
    id => clearTimeout(id),
    abortSignalImpl,
    timerImpl, clearTimerImpl, intervalImpl, clearIntervalImpl, dateImpl,
  )
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  // load({id, factory}) 结构:再调 factory(require) 得到真正的模块对象
  const mod = modules[0].factory(requireStub)
  const sessionListeners = new Set(), opened = []
  let current = currentSessionId
  const services = {
    sessions: { list: { getSnapshot: () => ({ byId: current === null ? {} : { [current]: { id: current, retainedBy: { mainView: 1 } } } }),
      subscribe(fn) { sessionListeners.add(fn); return () => sessionListeners.delete(fn) } } },
    uiWorkspace: { openSession: id => opened.push(id) },
  }
  const wrapStart = module => {
    const start = module.__test.start
    module.__test.start = () => {
      const release = start(requireStub('@mzzsfy/dsh-common-tools/client').setupCommonTools(), services)
      activeDisposers.add(release)
      return release
    }
  }
  wrapStart(mod)
  return {
    mod,
    shown,
    window: windowStub,
    document: documentStub,
    styleTags,
    opened,
    setCurrentSessionId(id) { current = id; for (const fn of sessionListeners) fn() },
    subscriptionCount: () => busHandlers.length,
    emitBus: () => { for (const handlers of busHandlers) handlers.onReset?.() },
    reload() {
      const next = modules[0].factory(requireStub)
      wrapStart(next)
      return next
    },
  }
}

test('navigation registry through full factory/apply/projection click survives either unload order and shared references', async (t) => {
  for (const first of [0, 1]) for (const sameReference of [false, true]) {
    await t.test(`unload ${first === 0 ? 'A' : 'B'} first; shared service=${sameReference}`, async () => {
      const opened = [], native = [], requests = [], timers = new Map()
      let timerId = 0, focuses = 0, payload = { version: 0, units: [] }
      class NotificationStub {
        static permission = 'granted'
        constructor(text, options) { Object.assign(this, { text, options, closed: false }); native.push(this) }
        close() { this.closed = true }
      }
      const f = loadClient({ storage: new FakeStorage(), notificationImpl: NotificationStub,
        document: { hasFocus: () => false, addEventListener() {}, removeEventListener() {}, documentElement: { dataset: { platform: 'darwin' } } },
        fetchImpl: async (path, options) => { requests.push({ path, options }); return { ok: true, json: async () => path.endsWith('/projection') ? payload : path.endsWith('/sounds') ? { sounds: [] } : { ok: true } } },
        timerImpl: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId }, clearTimerImpl: id => timers.delete(id),
      })
      f.window.location = { protocol: 'dsh-app:' }
      f.window.focus = () => { focuses++ }
      const a = { openSession: id => opened.push(['A', id]) }
      const b = sameReference ? a : { openSession: id => opened.push(['B', id]) }
      const mount = navigator => {
        const cleanups = []
        let injectNavigation
        const effect = fn => { const off = fn(); if (typeof off === 'function') cleanups.push(off) }
        f.mod.apply({
          get: () => ({ list: { getSnapshot: () => ({}), subscribe: () => () => {} } }),
          slots: { inject() {} }, effect,
          inject(names, callback) {
            if (names[0] !== 'uiWorkspace') return // optional activity services absent
            injectNavigation = value => {
              let release
              callback({ get: () => value, effect: fn => { release = fn(); cleanups.push(release) } })
              return release
            }
            if (navigator) injectNavigation(navigator)
          },
        })
        return { dispose() { while (cleanups.length) cleanups.pop()() }, injectNavigation }
      }
      const owners = [mount(a), mount(b)]
      try {
        await f.mod.__test.pollOnce()
        payload = { version: 1, units: [{ id: 'nav-1', sessionId: 'target-1', session: 'not rendered', category: 'ask', text: 'first' }] }
        await f.mod.__test.pollOnce()
        assert.equal(native.length, 1)
        assert.equal(requests.filter(r => r.path.endsWith('/focus-desktop')).length, 0, 'creation never wakes App')
        native[0].onclick()
        assert.deepEqual(opened.at(-1), [sameReference ? 'A' : 'B', 'target-1'])
        assert.equal(native[0].closed, true)
        owners[first].dispose()
        assert.equal(f.subscriptionCount(), 1, 'surviving instance still owns notification subscription')
        f.shown[0].opts.onClick()
        assert.deepEqual(opened.at(-1), [sameReference || first === 1 ? 'A' : 'B', 'target-1'], 'already-shown callbacks resolve the live navigator')
        payload = { version: 2, units: [{ id: 'nav-2', sessionId: 'target-2', category: 'ask', text: 'second' }] }
        await f.mod.__test.pollOnce()
        native[1].onclick()
        assert.deepEqual(opened.at(-1), [sameReference || first === 1 ? 'A' : 'B', 'target-2'])
        owners[1 - first].dispose()
        assert.equal(f.subscriptionCount(), 0)
        const count = opened.length
        native[0].onclick()
        assert.equal(opened.length, count, 'last exit must not retain a stale navigator')
        assert.match(f.shown.at(-1).text, /尚未就绪/)
        const absent = mount(null)
        f.shown[0].opts.onClick()
        assert.equal(opened.length, count, 'missing navigation service does not revive an old instance')
        const release1 = absent.injectNavigation(a), release2 = absent.injectNavigation(a)
        release1()
        f.shown[0].opts.onClick()
        assert.deepEqual(opened.at(-1), ['A', 'target-1'], 'each injected activation has an independent token even for the same reference')
        release2()
        const finalCount = opened.length
        f.shown[0].opts.onClick()
        assert.equal(opened.length, finalCount)
        absent.dispose()
        assert.ok(focuses > 0)
        await Promise.resolve()
        assert.ok(requests.some(r => r.path.endsWith('/focus-desktop') && r.options.method === 'POST'))
      } finally { owners.forEach(owner => owner.dispose()) }
    })
  }
})

test('foregroundSystem real factory/poll preserves native silence, permissions, routes and page sound', async (t) => {
  const cases = [
    { name: 'quiet desktop', silent: true, audio: false },
    { name: 'background desktop', focus: false, audio: true },
    { name: 'hidden despite focus', hidden: true, audio: true },
    { name: 'idleAway', idle: 5 * 60 * 1000, audio: true },
    { name: 'focusQuiet off', prefs: { dnd: '0' }, audio: true },
    { name: 'sound switch off is not quiet', focus: false, prefs: { sound: '0' }, audio: false },
    { name: 'category mute is not quiet', focus: false, prefs: { 'sound-categories': '{"ask":false}' }, audio: false },
    { name: 'sound route exclusion is not quiet', focus: false, routes: ['system', 'toast'], audio: false },
    { name: 'pageSound remains independent', prefs: { 'page-sound': '1' }, silent: true, audio: true },
    { name: 'pageSound category muted', prefs: { 'page-sound': '1', 'page-sound-categories': '{"ask":false}' }, silent: true, audio: false },
    { name: 'system denied', permission: 'denied', system: false, audio: false },
    { name: 'system not granted', permission: 'default', system: false, audio: false },
    { name: 'system switch off', prefs: { system: '0' }, system: false, audio: false },
    { name: 'system route excluded', routes: ['toast'], system: false, audio: false },
    { name: 'all routes excluded', routes: [], system: false, toast: false, audio: false },
    { name: 'ordinary browser', protocol: 'https:', system: false, audio: false },
    { name: 'Windows desktop', platform: 'win32', system: false, audio: false },
    { name: 'linux desktop', platform: 'linux', system: false, audio: false },
    { name: 'Windows desktop explicit opt-in', platform: 'win32', prefs: { 'foreground-system': '1' }, silent: true, audio: false },
    { name: 'darwin explicit opt-out', prefs: { 'foreground-system': '0' }, system: false, audio: false },
    { name: 'browser explicit opt-in still gated', protocol: 'https:', prefs: { 'foreground-system': '1' }, system: false, audio: false },
    { name: 'dirty value falls back to darwin default', prefs: { 'foreground-system': 'yes' }, silent: true, audio: false },
    { name: 'dirty value falls back to win32 default', platform: 'win32', prefs: { 'foreground-system': 'yes' }, system: false, audio: false },
  ]
  for (const c of cases) await t.test(c.name, async () => {
    const native = [], played = [], timers = new Map()
    let nextTimer = 0
    class NotificationStub {
      static permission = c.permission ?? 'granted'
      constructor(text, options) { native.push({ text, options }) }
    }
    const f = loadClient({
      storage: new FakeStorage(Object.fromEntries(Object.entries(c.prefs ?? {}).map(([k, v]) => ['turn-notify:' + k, v]))),
      payload: { version: 1, units: [{ id: 'native-options', category: 'ask', text: 'test', summary: 'summary', routes: c.routes }] },
      document: { hasFocus: () => c.focus ?? true, hidden: c.hidden ?? false, documentElement: { dataset: { platform: c.platform ?? 'darwin' } }, addEventListener() {}, removeEventListener() {} },
      notificationImpl: NotificationStub,
      timerImpl: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer },
      clearTimerImpl: id => timers.delete(id),
    })
    f.window.location = { protocol: c.protocol ?? 'dsh-app:' }
    f.window.AudioContext = class {
      state = 'running'; currentTime = 0
      async resume() {} async close() {}
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
      createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, start() { played.push(1) }, stop() {} } }
    }
    const off = f.mod.__test.start()
    try {
      for (const listener of f.window.listeners.pointerdown ?? []) listener()
      f.window.__tnLastActionAt = Date.now() - (c.idle ?? 0)
      assert.equal(await f.mod.__test.poll(), true)
      assert.equal(await f.mod.__test.poll(), true)
      assert.equal(native.length, c.system === false ? 0 : 1)
      if (native.length) assert.deepEqual(native[0].options, { tag: 'native-options', body: 'summary', ...(c.silent ? { silent: true } : {}) })
      assert.equal(played.length > 0, c.audio)
      assert.equal(f.shown.length, c.toast === false ? 0 : 1)
      if (c.name === 'quiet desktop') {
        const reminder = [...timers.values()].find(timer => timer.delay === 10 * 60 * 1000)
        assert.ok(reminder, 'ask still registers a second reminder')
        reminder.fn()
        assert.equal(native.length, 1, 'second reminder uses page/audio/blink, not Notification')
        assert.equal(f.shown.length, 2)
        assert.ok(played.length > 0, 'existing second-reminder sound stays independent of focus quiet')
      }
    } finally { off() }
  })
})

test('F22 Given 每隔5秒再通知 When 到首次30秒绝对期限 Then 重入不延长且恢复原标题', () => {
  let now = 0, next = 0
  const jobs = new Map()
  class Clock extends Date { static now() { return now } }
  const timer = (fn, delay, interval = false) => { jobs.set(++next, { fn, at: now + delay, delay, interval }); return next }
  const advance = ms => {
    const target = now + ms
    while (true) {
      const entry = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!entry) break
      const [id, job] = entry
      now = job.at
      if (job.interval) job.at += job.delay
      else jobs.delete(id)
      job.fn()
    }
    now = target
  }
  const f = loadClient({ storage: new FakeStorage(), payload: {}, dateImpl: Clock,
    timerImpl: (fn, delay) => timer(fn, delay), clearTimerImpl: id => jobs.delete(id),
    intervalImpl: (fn, delay) => timer(fn, delay, true), clearIntervalImpl: id => jobs.delete(id),
  })
  f.mod.__test.startTitleBlink()
  for (let i = 0; i < 5; i++) { advance(5 * 1000); f.mod.__test.startTitleBlink() }
  advance(5 * 1000)
  assert.equal(jobs.size, 0, '首次deadline必须清理全部闪烁timer')
  assert.equal(f.document.title, 'dsh')
  f.mod.__test.startTitleBlink()
  advance(6 * 1000)
  assert.equal(jobs.size, 0, '下一轮拥有新的首次期限,无重入则正常停止')
})

function audioFixture(f) {
  const contexts = []
  f.window.AudioContext = class {
    state = 'running'
    currentTime = 0
    played = 0
    closed = 0
    constructor() { contexts.push(this) }
    async close() { this.closed++; this.state = 'closed' }
    async resume() {}
    async decodeAudioData() { return {} }
    createGain() { return { gain: { value: 1 }, connect() {} } }
    createBufferSource() { return { connect() {}, start: () => { this.played++ } } }
  }
  const click = () => { for (const listener of [...(f.window.listeners.pointerdown || [])]) listener() }
  return { contexts, click }
}

test('F30 Given factory尚未激活 When 用户pointerdown Then 不创建音频上下文', () => {
  const f = loadClient({ storage: new FakeStorage(), payload: {} })
  const audio = audioFixture(f)
  audio.click()
  assert.equal(audio.contexts.length, 0)
})

test('F30 Given 同factory两个租约已解锁并缓存音频 When 分别退出再激活 Then 最后退出关闭上下文清缓存且旧listener不复活', async () => {
  let soundFetches = 0
  const f = loadClient({ storage: new FakeStorage(), payload: {}, fetchImpl: async path => {
    if (path.includes('/sound?')) { soundFetches++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) } }
    return { ok: true, json: async () => ({ sounds: [] }) }
  } })
  const audio = audioFixture(f), offA = f.mod.__test.start(), offB = f.mod.__test.start()
  const oldListeners = [...f.window.listeners.pointerdown]
  audio.click()
  await f.mod.__test.playAudible({ kind: 'custom', id: 'audio' })
  offA()
  assert.equal(audio.contexts[0].closed, 0)
  await f.mod.__test.playAudible({ kind: 'custom', id: 'audio' })
  assert.equal(soundFetches, 1)
  offB()
  assert.equal(audio.contexts[0].closed, 1)
  for (const listener of oldListeners) listener()
  assert.equal(audio.contexts.length, 1)
  const offC = f.mod.__test.start()
  audio.click()
  await f.mod.__test.playAudible({ kind: 'custom', id: 'audio' })
  assert.equal(audio.contexts.length, 2)
  assert.equal(soundFetches, 2, '最后退出后解码cache不可跨租约复用')
  offC()
  assert.equal(audio.contexts[1].closed, 1)
})

test('F30 Given 旧代已有音频且新factory接管 When 旧listener迟到及旧租约退出 Then 仅新代可解锁且存活上下文不被关闭', () => {
  const f = loadClient({ storage: new FakeStorage(), payload: {} }), audio = audioFixture(f)
  const offA = f.mod.__test.start()
  audio.click()
  const late = [...f.window.listeners.pointerdown]
  const fresh = f.reload(), offB = fresh.__test.start()
  assert.equal(audio.contexts[0].closed, 1)
  for (const listener of late) listener()
  assert.equal(audio.contexts.length, 1)
  audio.click()
  assert.equal(audio.contexts.length, 2)
  offA()
  assert.equal(audio.contexts[1].closed, 0)
  offB()
  assert.equal(audio.contexts[1].closed, 1)
})

test('F30 Given 自定义音频decode在途 When 最后租约退出再返回 Then 不播放也不回填旧缓存', async () => {
  let decode, entered
  const decoding = new Promise(resolve => { entered = resolve })
  const f = loadClient({ storage: new FakeStorage(), payload: {}, fetchImpl: async path => path.includes('/sound?')
    ? { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }
    : { ok: true, json: async () => ({ sounds: [] }) } })
  const audio = audioFixture(f), off = f.mod.__test.start()
  audio.click()
  audio.contexts[0].decodeAudioData = () => { entered(); return new Promise(resolve => { decode = resolve }) }
  const playing = f.mod.__test.playAudible({ kind: 'custom', id: 'late' })
  await decoding
  off()
  decode({})
  const result = await playing
  assert.equal(result.ok, false)
  assert.equal(audio.contexts[0].played, 0)
})

// 仅模拟 IDB 边界：同库 readwrite 事务串行，事务完成前不发布写入。
function indexedDbFixture() {
  let rows = new Map(), initialized = false, queue = Promise.resolve(), gate = null
  const connections = []
  const factory = {
    open() {
      const request = {}
      setImmediate(() => {
        const db = {
          closed: false,
          createObjectStore() {},
          close() { this.closed = true },
          transaction() {
            if (this.closed) throw new Error('closed')
            const tx = {}, operations = []
            let draft, aborted = false
            tx.abort = () => { aborted = true }
            const requestFor = run => {
              const request = {}
              operations.push(() => { request.result = run(); request.onsuccess?.() })
              return request
            }
            tx.objectStore = () => ({
              getAll: () => requestFor(() => [...draft.values()]),
              delete: id => requestFor(() => draft.delete(id)),
              add: row => requestFor(() => {
                if (draft.has(row.id)) throw new Error('ConstraintError')
                draft.set(row.id, row)
              }),
            })
            queue = queue.then(async () => {
              if (gate) await gate.promise
              draft = new Map(rows)
              try {
                if (aborted) throw new Error('AbortError')
                while (operations.length) operations.shift()()
                rows = draft
                tx.oncomplete?.()
              } catch (error) { tx.error = error; tx.onabort?.() }
            })
            return tx
          },
        }
        connections.push(db)
        request.result = db
        if (!initialized) { initialized = true; request.onupgradeneeded?.() }
        request.onsuccess?.()
      })
      return request
    },
  }
  return { factory, connections, get rows() { return rows },
    hold() { gate = {}; gate.promise = new Promise(resolve => { gate.resolve = resolve }) },
    release() { const current = gate; gate = null; current?.resolve() },
  }
}

test('Given 双窗共享存储 When 新通知done后旧空快照抵达再追平 Then 不重复呈现', async () => {
  const storage = new FakeStorage(), idb = indexedDbFixture()
  let aPayload = { version: 0, units: [] }, bPayload = aPayload
  const a = loadClient({ storage, indexedDB: idb.factory, fetchImpl: async () => ({ ok: true, json: async () => aPayload }) })
  const b = loadClient({ storage, indexedDB: idb.factory, fetchImpl: async () => ({ ok: true, json: async () => bPayload }) })
  await a.mod.__test.poll(); await b.mod.__test.poll()
  aPayload = { version: 1, units: [{ id: 'new', category: 'ask', text: '新通知', ts: Date.now() - 10 * 60 * 1000 }] }
  await a.mod.__test.poll()
  await b.mod.__test.poll()
  bPayload = aPayload
  await b.mod.__test.poll()
  assert.equal(a.shown.length + b.shown.length, 1, '旧快照不得清除别窗新通知的权威完成标记')
})

test('Given 双窗storage读快照均为空 When 同时消费通知 Then 事务仅允许一窗呈现', async () => {
  const idb = indexedDbFixture()
  // 两窗口在事务开始前都观察不到对方的 localStorage 写入。
  const make = () => loadClient({ storage: new FakeStorage(), indexedDB: idb.factory,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: 1, units: [{ id: 'race', category: 'ask', text: '并发' }] }) }) })
  const a = make(), b = make()
  await Promise.all([a.mod.__test.poll(), b.mod.__test.poll()])
  assert.equal(a.shown.length + b.shown.length, 1)
  assert.equal(idb.rows.size, 1)
})

test('Given 冷启动静默终态 When 他窗用旧storage追平 Then 不重放且过期表被清理', async () => {
  const idb = indexedDbFixture()
  idb.rows.set('expired', { id: 'expired', expiresAt: 0 })
  const payload = { version: 1, units: [{ id: 'cold', category: 'completed', text: '静默' }] }
  const a = loadClient({ storage: new FakeStorage(), indexedDB: idb.factory,
    fetchImpl: async () => ({ ok: true, json: async () => payload }) })
  await a.mod.__test.poll()
  let current = { version: 0, units: [] }
  const b = loadClient({ storage: new FakeStorage(), indexedDB: idb.factory,
    fetchImpl: async () => ({ ok: true, json: async () => current }) })
  await b.mod.__test.poll(); current = payload; await b.mod.__test.poll()
  assert.equal(a.shown.length + b.shown.length, 0)
  assert.equal(idb.rows.has('expired'), false)
  assert.equal(idb.rows.has('cold'), true)
})

test('Given IDB事务在途 When 最后owner退出与HMR Then 无late显示且连接关闭再激活恢复', async () => {
  const idb = indexedDbFixture()
  let payload = { version: 1, units: [{ id: 'late-idb', category: 'ask', text: '迟到' }] }
  const f = loadClient({ storage: new FakeStorage(), indexedDB: idb.factory,
    document: { addEventListener() {}, removeEventListener() {} },
    fetchImpl: async () => ({ ok: true, json: async () => payload }) })
  const disposeA = f.mod.__test.start(), disposeB = f.mod.__test.start()
  idb.hold()
  const controller = f.window['turn-notify:polling'], pending = f.mod.__test.poll(controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  disposeA()
  assert.equal(idb.connections[0].closed, false)
  disposeB(); idb.release(); await pending
  assert.equal(f.shown.length, 0)
  assert.equal(idb.connections[0].closed, true)
  assert.equal(idb.rows.has('late-idb'), false, '卸载必须回滚在途认领，不能吞掉其他窗口待呈现通知')
  payload = { version: 2, units: [{ id: 'late-idb', category: 'ask', text: '恢复' }] }
  const disposeAgain = f.mod.__test.start()
  await f.mod.__test.poll(f.window['turn-notify:polling'].signal)
  assert.deepEqual(f.shown.map(item => item.text), ['恢复'])
  const next = f.reload(), disposeNext = next.__test.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(idb.connections[1].closed, true, 'HMR接管关闭旧代连接')
  disposeAgain(); disposeNext()
})

test('Given turn认领事务等待 When 本地快照消费超时 Then 回滚不留done且另窗能接手', async () => {
  const idb = indexedDbFixture(), timeout = new AbortController()
  const payload = { version: 1, units: [{ id: 'timeout', category: 'ask', text: '可接手', ts: Date.now() - 10 * 60 * 1000 }] }
  const a = loadClient({ storage: new FakeStorage(), indexedDB: idb.factory,
    abortSignalImpl: { timeout: () => timeout.signal, any: signals => AbortSignal.any(signals) },
    fetchImpl: async () => ({ ok: true, json: async () => payload }) })
  idb.hold()
  const pending = a.mod.__test.pollOnce()
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
  timeout.abort(); idb.release()
  assert.equal(await pending, false)
  assert.deepEqual(a.shown, [])
  assert.equal(idb.rows.has('timeout'), false)
  const b = loadClient({ storage: new FakeStorage(), indexedDB: idb.factory,
    fetchImpl: async () => ({ ok: true, json: async () => payload }) })
  await b.mod.__test.pollOnce()
  assert.equal(b.shown.length, 1)
})

const units = [
  { id: 'u1', category: 'completed', text: '[dsh] 任务完成: t1' },
  { id: 'u2', category: 'error', text: '[dsh] 任务出错: t2' },
]

// 标题闪烁:错误类通知在未授权系统通知时走 blink 降级通道,焦点回返与硬顶都必须复位标题
test('Given 声音总开关关闭 When 错误通知到达 Then 降级闪烁照常触发', async () => {
  // 声音关闭只应静音,不得连坐 system 弹窗与 blink 降级通道
  const dom = { hasFocus: () => false, title: 'dsh', hidden: true }
  const { mod, document: doc } = loadClient({
    storage: new FakeStorage({ 'turn-notify:sound': '0' }),
    payload: { units: [units[1]], soundMapping: {}, version: 1 },
    document: dom,
  })
  const { poll } = mod.__test
  await poll()
  await poll()
  assert.ok(await scanTitleBlink(doc, 1400), '声音关闭时 blink 不应被 continue 连坐跳过')
})

test('Given 标题闪烁进行中 When 窗口重获焦点 Then 标题立即复位', async () => {
  const docListeners = {}
  const dom = {
    hasFocus: () => false, title: 'dsh', hidden: true,
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn) },
    removeEventListener: (type, fn) => { docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn) },
  }
  const { mod, window: winStub, document: doc } = loadClient({
    storage: new FakeStorage(),
    payload: { units: [units[1]], soundMapping: {}, version: 1 },
    document: dom,
  })
  const { poll } = mod.__test
  await poll()
  await poll()
  mod.__test.start()
  const focusHandlers = (winStub.listeners.focus || []).slice()
  assert.ok(focusHandlers.length > 0, 'window focus 未监听')
  doc.title = '⏳ dsh'
  for (const fn of focusHandlers) fn()
  assert.equal(doc.title, 'dsh', '焦点返回后标题应复位')
  winStub['turn-notify:polling'].abort()
})

test('Given 连环错误通知重入闪烁 When 硬顶到期 Then 标题必停', async () => {
  const dom = { hasFocus: () => false, title: 'dsh', hidden: true }
  const { mod, document: doc } = loadClient({
    storage: new FakeStorage(),
    payload: { units: [{ id: 'e1', category: 'error', text: '[dsh] 任务出错: e1' }, { id: 'e2', category: 'error', text: '[dsh] 任务出错: e2' }], soundMapping: {}, version: 1 },
    document: dom,
    shortTimers: true,
  })
  const { poll } = mod.__test
  await poll()
  await poll()
  // 同批两事件:第一条启动闪烁(单条 60ms 即停),第二条重入重排至硬顶 200ms
  const sawBlink = await scanTitleBlink(doc, 150)
  assert.ok(sawBlink, '重入应延长闪烁,不得按单条时长提前复位')
  await sleep(200)
  assert.equal(doc.title.indexOf('⏳'), -1, '硬顶到期标题必复位,不允许无限续闪')
})

async function scanTitleBlink(doc, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (doc.title.indexOf('⏳') >= 0) return true
    await sleep(5)
  }
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('broken localStorage:清理段不抛,降级发声恰好一次,第二轮不再发声', async () => {
  const { mod, shown } = loadClient({ storage: new BrokenStorage(), payload: { units, soundMapping: {}, version: 1 } })
  const { poll, storageState } = mod.__test
  await poll()
  await poll()
  assert.equal(storageState.broken, true)
  // 两事件各发声一次,清理段未抛出控制流到达 claimEvent
  assert.equal(shown.length, units.length)
  await poll()
  await poll()
  // 投影窗口内第二轮 poll 同事件不再发声
  assert.equal(shown.length, units.length)
})

test('正常 localStorage:唯一发声,完成标记写入,残留锁被清理', async () => {
  const storage = new FakeStorage({ 'turn-notify:lock:stale': '{"wid":"w9","at":1}' })
  const { mod, shown } = loadClient({ storage, payload: { units, soundMapping: {}, version: 1 } })
  const { poll } = mod.__test
  await poll()
  await poll()
  assert.equal(shown.length, units.length)
  assert.equal(storage.getItem('turn-notify:lock:stale'), null)
  assert.notEqual(storage.getItem('turn-notify:done:u1'), null)
  assert.notEqual(storage.getItem('turn-notify:done:u2'), null)
  await poll()
  await poll()
  // 完成标记生效,第二轮不重复发声
  assert.equal(shown.length, units.length)
})

test('页内通知经公共组件:文案与展示期随事件传入', async () => {
  const { mod, shown } = loadClient({ storage: new FakeStorage(), payload: { units, soundMapping: {}, version: 1 } })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.deepEqual(shown.map((call) => call.text), units.map((unit) => unit.text))
  assert.ok(shown.every((call) => call.opts && call.opts.holdMs === 6 * 1000))
})

test('Given 冷启动首拉带存量通知 When poll Then 静默对齐不呈现且完成标记写入', async () => {
  const storage = new FakeStorage()
  const { mod, shown } = loadClient({
    storage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ units, soundMapping: {}, version: 1 }) }),
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(shown.length, 0, '冷启动对齐不应轰炸呈现')
  assert.notEqual(storage.getItem('turn-notify:done:u1'), null, '静默对齐仍需写完成标记防其他窗口回放')
})

test('Given 冷启动存量含审批与提问 When poll Then 照常呈现待办', async () => {
  const todoUnits = [
    { id: 'u-ap', category: 'approval', text: '[dsh] 等待审批: t1' },
    { id: 'u-ask', category: 'ask', text: '[dsh] AI 提问: t2' },
  ]
  const { mod, shown } = loadClient({
    storage: new FakeStorage(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ units: todoUnits, soundMapping: {}, version: 1 }) }),
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.deepEqual(shown.map((call) => call.text), todoUnits.map((unit) => unit.text), '等待用户动作的通知不因冷启动静默')
})

test('Given 冷启动已对齐 When 新通知到达 Then 正常呈现', async () => {
  let version = 1
  let payloadUnits = units
  const storage = new FakeStorage()
  const { mod, shown } = loadClient({
    storage,
    fetchImpl: async () => ({ ok: true, json: async () => ({ units: payloadUnits, soundMapping: {}, version }) }),
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(shown.length, 0)
  version = 2
  payloadUnits = [...units, { id: 'u3', category: 'completed', text: '[dsh] 任务完成: t3' }]
  await mod.__test.poll()
  await mod.__test.poll()
  assert.deepEqual(shown.map((call) => call.text), ['[dsh] 任务完成: t3'])
})

// ---- 会话行高亮:按投影sessionId与官方行身份定位；展示标题不参与匹配 ----

// 最小侧边栏 DOM:列表容器(多标题)→ 多会话行(各单标题),classList 记录变更,click listener 捕获;
// className 与 classList 双向同步(对齐真 DOM 语义:任一写入对方可见)
function makeSidebarDom(rows) {
  const listeners = {}
  const rowEls = rows.map((spec) => {
    const rowClassList = { set: new Set() }
    rowClassList.contains = (c) => rowClassList.set.has(c)
    rowClassList.add = (...cs) => cs.forEach((c) => rowClassList.set.add(c))
    rowClassList.remove = (...cs) => cs.forEach((c) => rowClassList.set.delete(c))
    const sync = function (value) {
      rowClassList.set.clear()
      String(value).split(' ').filter(Boolean).forEach((c) => rowClassList.set.add(c))
    }
    const leaf = { className: 'a_title', textContent: spec.leafText, querySelectorAll: () => [] }
    const row = {
      leafText: spec.leafText,
      getAttribute: name => name === 'data-row-key' ? 'session:' + (spec.sessionId ?? spec.leafText) : null,
      textContent: spec.rowText || spec.leafText,
      querySelector: (sel) => (sel.indexOf('_title') >= 0 ? leaf : null),
      querySelectorAll: (sel) => (sel.indexOf('_title') >= 0 ? [leaf] : []),
      children: [], classList: rowClassList,
      clicks: 0,
      click() { row.clicks += 1 },
    }
    Object.defineProperty(row, 'className', {
      get: () => [...rowClassList.set].join(' '),
      set: sync,
    })
    sync('x_row')
    return row
  })
  const dom = {
    querySelectorAll: (sel) => sel === '[data-row-key]' ? rowEls : sel === '.tn-sess-hl' ? rowEls.filter(row => row.classList.contains('tn-sess-hl')) : [],
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn) },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn) },
    listeners,
    rows: rowEls,
  }
  return dom
}

const clickEventOn = (row) => ({ target: { closest: (sel) => (sel === '[data-row-key]' ? row : null) } })

test('Given 冷启动存量通知带会话标题 When 静默对齐 Then 不呈现但行挂高亮', async () => {
  // 冷启动对齐只静默通知呈现,未读会话闪烁是本机 UI 状态,不属轰炸,必须保留
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-cold', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod, shown } = loadClient({
    storage: new FakeStorage(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ units: hlUnits, soundMapping: {}, version: 1 }) }),
    document: { title: '会话乙 — DeepSeek Harness', ...dom },
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(shown.length, 0, '冷启动对齐不轰炸呈现')
  assert.ok(dom.rows[0].classList.set.has('tn-sess-hl'), '静默对齐仍应挂未读会话高亮')
  assert.ok(dom.rows[0].classList.set.has('tn-sess-hl--completed'), '冷启动高亮携带分类色')
})

test('Given 冷启动存量通知是当前查看的会话 When 静默对齐 Then 不挂高亮', async () => {
  // 与正常路径同语义:正在查看即已读,不做未读强调
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-cold-cur', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ units: hlUnits, soundMapping: {}, version: 1 }) }),
    currentSessionId: '会话甲',
    document: { title: '会话甲 — DeepSeek Harness', ...dom },
  })
  mod.__test.start()
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '正在查看的会话冷启动也不挂高亮')
})

test('Given 高亮开关关闭且冷启动带存量通知 When 静默对齐 Then 不挂任何类', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-off', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage({ 'turn-notify:session-hl': '0' }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ units: hlUnits, soundMapping: {}, version: 1 }) }),
    document: { title: '会话乙 — DeepSeek Harness', ...dom },
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '开关关闭时冷启动也不挂高亮')
})

test('Given 冷启动存量超过高亮容量上限 When 静默对齐 Then 仅保留最新一批,最旧被淘汰', async () => {
  const titles = Array.from({ length: 22 }, (unused, index) => '会话' + (index + 1))
  const dom = makeSidebarDom(titles.map((leafText) => ({ leafText })))
  const hlUnits = titles.map((title, index) => ({
    id: 'u-cap-' + index, category: 'completed', text: '[dsh] 任务完成: ' + title, sessionId: title, session: title,
  }))
  const { mod } = loadClient({
    storage: new FakeStorage(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ units: hlUnits, soundMapping: {}, version: 1 }) }),
    document: { title: 'dsh', ...dom },
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '最旧条目被淘汰')
  assert.equal(dom.rows[1].classList.set.has('tn-sess-hl'), false, '最旧条目被淘汰')
  assert.ok(dom.rows[2].classList.set.has('tn-sess-hl'), '上限内条目保留')
  assert.ok(dom.rows[21].classList.set.has('tn-sess-hl'), '最新条目保留')
})

test('Given 冷启动当前身份快照未就绪 When 宿主快照就绪 Then 自愈摘除', async () => {
  // 首拉早于宿主快照时先保留未读；身份就绪后通过服务订阅自愈。
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-race', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod, setCurrentSessionId } = loadClient({
    storage: new FakeStorage(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ units: hlUnits, soundMapping: {}, version: 1 }) }),
    document: { title: 'dsh', ...dom },
  })
  mod.__test.start()
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), true, '身份未就绪时保留未读')
  setCurrentSessionId('会话甲')
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '宿主身份就绪后自愈摘除')
})

test('Given 通知带 session 标题 When 认领 Then 会话行挂上高亮类', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-hl', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: { title: '会话乙 — DeepSeek Harness', ...dom },
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.ok(dom.rows[0].classList.set.has('tn-sess-hl'), '会话行未挂高亮类')
  assert.ok(dom.rows[0].classList.set.has('tn-sess-hl--completed'), '高亮类缺少分类色')
})

test('Given 通知的是当前查看的会话 When 认领 Then 不挂高亮', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-cur', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    currentSessionId: '会话甲',
    document: { title: '会话甲 — DeepSeek Harness', ...dom },
  })
  mod.__test.start()
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '当前查看的会话不应闪烁')
})

test('Given 当前会话判定不受标题闪烁前缀干扰 When 认领 Then 仍不挂高亮', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-blink', category: 'error', text: '[dsh] 任务出错: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    currentSessionId: '会话甲',
    document: { title: '⏳ 会话甲 — DeepSeek Harness', ...dom },
  })
  mod.__test.start()
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '闪烁前缀不应破坏当前会话判定')
})

test('Given 失焦且通知的是本标签页会话 When 认领 Then 挂高亮', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-away', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    currentSessionId: '会话甲',
    document: { title: '会话甲 — DeepSeek Harness', hasFocus: () => false, ...dom },
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), true, '失焦期间的本会话通知应闪烁提醒')
})

test('Given 失焦期间挂上的当前会话高亮 When 页面重新可见 Then 提醒消失且其他会话保留', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }, { leafText: '会话乙' }])
  const hlUnits = [
    { id: 'u-away', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
    { id: 'u-other', category: 'ask', text: '[dsh] AI 提问: 会话乙', sessionId: '会话乙', session: '会话乙' },
  ]
  const { mod, window: winStub, document: docStub } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    currentSessionId: '会话甲',
    document: { title: '会话甲 — DeepSeek Harness', hasFocus: () => false, ...dom },
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), true)
  assert.equal(dom.rows[1].classList.set.has('tn-sess-hl'), true)
  mod.__test.start()
  const visibleHandlers = (dom.listeners.visibilitychange || []).slice()
  assert.ok(visibleHandlers.length > 0, 'visibilitychange 未监听')
  docStub.hidden = false
  for (const fn of visibleHandlers) fn()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '返回后当前会话提醒应消失')
  assert.equal(dom.rows[1].classList.set.has('tn-sess-hl'), true, '其他会话的提醒不应被清除')
  winStub['turn-notify:polling'].abort()
})

test('Given 失焦挂上的当前会话高亮 When 窗口重获焦点 Then 提醒消失', async () => {
  // 对齐 SessionStatusDots 的事实驱动语义:切到别的应用窗口不触发
  // visibilitychange(标签页未切、未最小化),焦点通道负责这一场景
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-foc', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod, window: winStub } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    currentSessionId: '会话甲',
    document: { title: '会话甲 — DeepSeek Harness', hasFocus: () => false, ...dom },
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), true)
  mod.__test.start()
  const focusHandlers = (winStub.listeners.focus || []).slice()
  assert.ok(focusHandlers.length > 0, 'window focus 未监听')
  for (const fn of focusHandlers) fn()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '重获焦点后当前会话提醒应消失')
  winStub['turn-notify:polling'].abort()
})

test('Given 行处于运行状态 When 通知认领 Then 不挂高亮', async () => {
  // 对齐 SessionStatusDots:运行中的会话由原生状态点表达,闪烁只表达"状态已更新"
  const dom = makeSidebarDom([{ leafText: '会话甲', rowText: '进行中会话甲 3分钟' }])
  const hlUnits = [
    { id: 'u-run', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: dom,
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '运行中的会话不应闪烁')
})

test('Given 已挂高亮 When 行进入运行状态 Then 清除闪烁', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-done', category: 'completed', text: '[dsh] 任务完成: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: dom,
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), true)
  // 会话又开跑:状态点文案回到行内
  dom.rows[0].textContent = '进行中会话甲 5分钟'
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '会话运行后应停止闪烁')
})

test('Given 通知标题字段缺失 When 认领 Then 不挂高亮类且链路不抛', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const bareUnits = [
    { id: 'u-bare', category: 'completed', text: '[dsh] 任务完成: 无标题' },
  ]
  const { mod, shown } = loadClient({
    storage: new FakeStorage(),
    payload: { units: bareUnits, soundMapping: {}, version: 1 },
    document: dom,
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(shown.length, 1)
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false)
})

// 点击直达:身份走通知携带的 sessionId(uiWorkspace.openSession 延迟注入),
// 不再按侧边栏 DOM 标题模拟点击;旧投影无 ID 只聚焦,不按同名标题猜目标会话
test('Given 新投影携带sessionId When 点击页内卡片 Then 按ID导航;无ID旧通知仅聚焦不误点同名行', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-jump', category: 'completed', text: '[dsh] 任务完成: 会话甲', session: '会话甲', sessionId: 'sess-jump', summary: '耗时 12 秒' },
    { id: 'u-legacy', category: 'ask', text: '[dsh] AI 提问: 会话甲', session: '会话甲' },
    { id: 'u-bare', category: 'error', text: '[dsh] 任务出错: 无标题' },
  ]
  const focuses = []
  const opened = []
  const { mod, shown, window: winStub } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: { title: '会话乙 — DeepSeek Harness', ...dom },
  })
  winStub.focus = () => { focuses.push('focus') }
  mod.__test.start()
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(shown.length, 3)
  // 摘要随文本两行呈现
  assert.ok(shown[0].text.includes('\n耗时 12 秒'), '卡片文本含小结行')
  assert.equal(typeof shown[0].opts.onClick, 'function', '页内卡片携带直达回调')
  // 绑定会话导航服务:uiWorkspace 软依赖注入(缺席时仅禁用直达不阻断通知)
  activate(mod, { openSession: (id) => { opened.push(id) } })
  shown[0].opts.onClick()
  assert.deepEqual(focuses, ['focus'], '直达先聚焦窗口')
  assert.deepEqual(opened, ['sess-jump'], '按通知携带的 sessionId 导航')
  assert.equal(dom.rows[0].clicks, 0, '不按标题模拟点击侧边栏会话行')
  shown[1].opts.onClick()
  assert.deepEqual(focuses, ['focus', 'focus'])
  assert.deepEqual(opened, ['sess-jump'], '旧投影没有唯一 ID 时只聚焦')
  assert.equal(dom.rows[0].clicks, 0, '没有ID不得按标题误跳')
  shown[2].opts.onClick()
  assert.deepEqual(focuses, ['focus', 'focus', 'focus'])
  assert.equal(dom.rows[0].clicks, 0, '无标题通知不触碰任何行')
})

// 二次提醒:等待用户动作的事件超时未处理补发一轮;已处理(点击行/切到会话)与投影过期不补
test('Given 审批通知超时未处理 When 提醒到期 Then 补发一轮;已处理与投影过期不补', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }, { leafText: '会话乙' }])
  const hlUnits = [
    { id: 'u-appr', category: 'approval', text: '[dsh] 等待审批: 会话甲', sessionId: '会话甲', session: '会话甲' },
    { id: 'u-done', category: 'completed', text: '[dsh] 任务完成: 会话乙', sessionId: '会话乙', session: '会话乙' },
  ]
  const { mod, shown } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: { title: '会话乙 — DeepSeek Harness', ...dom },
    shortTimers: false,
  })
  const { poll } = mod.__test
  await poll()
  await poll()
  const before = shown.length
  // 推进到提醒到期:approval 未读(高亮仍在)→ 补发;completed 非等待类从不登记
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(shown.length, before, '提醒未到期不补发')
})

test('Given 审批提醒登记 When 单元过期(prune)Then 不再补发', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-appr-gone', category: 'approval', text: '[dsh] 等待审批: 会话甲', sessionId: '会话甲', session: '会话甲' },
  ]
  // 第二轮投影不再含该单元:prune 撤销登记
  const { mod, shown } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: { title: '会话乙 — DeepSeek Harness', ...dom },
  })
  const { poll } = mod.__test
  await poll()
  await poll()
  // 第三轮投影单元消失
  mod.__test.pruneReminders(new Set())
  const before = shown.length
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(shown.length, before, '登记撤销后不补发')
})

test('Given 短标题先于长前缀行匹配 When 挂类 Then 短标题精确命中自身行', async () => {  // 长标题行在前,短标题是长标题的子串:短标题通知必须挂到全等行,不得被子串误吸
  const dom = makeSidebarDom([
    { sessionId: 'long', leafText: '修复通知插件长轮询问题' },
    { sessionId: 'short', leafText: '通知插件' },
  ])
  const hlUnits = [
    { id: 'u-long', category: 'completed', text: '[dsh] 任务完成: 长标题', sessionId: 'long', session: '修复通知插件长轮询问题' },
    { id: 'u-short', category: 'ask', text: '[dsh] AI 提问: 短标题', sessionId: 'short', session: '通知插件' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: dom,
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.ok(dom.rows[0].classList.set.has('tn-sess-hl--completed'), '长标题行未挂类')
  assert.ok(dom.rows[1].classList.set.has('tn-sess-hl--ask'), '短标题行未挂到自身行')
  assert.equal(dom.rows[1].classList.set.has('tn-sess-hl--completed'), false, '长标题类误挂到短标题行')
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl--ask'), false, '短标题类误挂到长标题行')
})

test('Given 两行各自高亮 When 点击其中一行 Then 仅该行清除且另一行不受影响', async () => {
  const dom = makeSidebarDom([
    { sessionId: 'long', leafText: '修复通知插件长轮询问题' },
    { sessionId: 'short', leafText: '通知插件' },
  ])
  const hlUnits = [
    { id: 'u-long', category: 'completed', text: '[dsh] 任务完成: 长标题', sessionId: 'long', session: '修复通知插件长轮询问题' },
    { id: 'u-short', category: 'ask', text: '[dsh] AI 提问: 短标题', sessionId: 'short', session: '通知插件' },
  ]
  const { mod, window: winStub } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: dom,
  })
  await mod.__test.poll()
  await mod.__test.poll()
  mod.__test.start()
  const clickListeners = dom.listeners.click || []
  assert.ok(clickListeners.length > 0, 'click listener 未挂载')
  for (const fn of clickListeners) fn(clickEventOn(dom.rows[0]))
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '点击行未清除')
  assert.equal(dom.rows[1].classList.set.has('tn-sess-hl'), true, '另一行被误清除')
  winStub['turn-notify:polling'].abort()
})

test('announcedIds 去重窗口按 TTL 过期清理', () => {
  const { announcedOnce, announcedIds, ANNOUNCED_TTL_MS } = loadLogic({})
  assert.equal(announcedOnce('a', 1000), true)
  assert.equal(announcedOnce('a', 1000 + ANNOUNCED_TTL_MS - 1), false)
  // 窗口过期后可再次发声,且过期条目被清理
  assert.equal(announcedOnce('a', 1000 + ANNOUNCED_TTL_MS + 1), true)
  assert.equal(announcedIds.size, 1)
})

// ---- 页内提示音场景映射:未配置沿用通知映射,显式覆盖独立生效 ----

function loadLogic(storageSeed) {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const windowStub = { localStorage: new FakeStorage(storageSeed) }
  const factory = new Function('window', section + '; return { readPageMapping, mergeMapping, resolveSound, DEFAULT_TONES, announcedOnce, announcedIds, ANNOUNCED_TTL_MS }')
  return factory(windowStub)
}

test('Given 页内映射未配置 When 解析页内音色 Then 与通知映射解析一致', () => {
  const logic = loadLogic({})
  const notifyMapping = { completed: 'bell', ask: 'snd-x' }
  const merged = logic.mergeMapping(notifyMapping, logic.readPageMapping())
  assert.deepEqual(logic.resolveSound('completed', merged, ['snd-x']), { kind: 'builtin', name: 'bell' })
  assert.deepEqual(logic.resolveSound('ask', merged, ['snd-x']), { kind: 'custom', id: 'snd-x' })
})

test('Given 页内映射显式覆盖某分类 When 解析页内音色 Then 页内用覆盖值且通知映射不受影响', () => {
  const logic = loadLogic({ 'turn-notify:page-mapping': JSON.stringify({ completed: 'tick' }) })
  const notifyMapping = { completed: 'bell' }
  const merged = logic.mergeMapping(notifyMapping, logic.readPageMapping())
  assert.deepEqual(logic.resolveSound('completed', merged, []), { kind: 'builtin', name: 'tick' })
  // 通知场景解析仍用通知映射(不含页内覆盖)
  assert.deepEqual(logic.resolveSound('completed', notifyMapping, []), { kind: 'builtin', name: 'bell' })
})

test('Given 页内映射存储残留空串值 When 读取 Then 视同未配置沿用通知映射', () => {
  const logic = loadLogic({ 'turn-notify:page-mapping': JSON.stringify({ completed: '' }) })
  assert.deepEqual(logic.readPageMapping(), {})
  const merged = logic.mergeMapping({ completed: 'bell' }, logic.readPageMapping())
  assert.deepEqual(logic.resolveSound('completed', merged, []), { kind: 'builtin', name: 'bell' })
})

test('Given 页内映射存储损坏或死链 When 解析 Then 容错回落且死链值回落内置默认', () => {
  const logic = loadLogic({ 'turn-notify:page-mapping': '{broken' })
  assert.deepEqual(logic.readPageMapping(), {})
  const deadLogic = loadLogic({ 'turn-notify:page-mapping': JSON.stringify({ completed: 'snd-gone' }) })
  const merged = deadLogic.mergeMapping({ completed: 'bell' }, deadLogic.readPageMapping())
  assert.deepEqual(deadLogic.resolveSound('completed', merged, []), { kind: 'builtin', name: deadLogic.DEFAULT_TONES.completed })
})

test('激活即启动轮询:apply 注册设置分区且 start 已执行', async () => {
  const fetched = []
  const { mod, styleTags } = loadClient({
    storage: new FakeStorage(),
    payload: { units: [], soundMapping: {}, version: 1 },
    onFetch: (path) => { fetched.push(path) },
  })
  const injected = []
  const effects = []
  // sessions/workspaces 服务桩:文件夹运行标记的注入面(订阅桩不做任何事;
  // 本测试 document 桩无 querySelectorAll,fold effect 装配即干净退出)
  const serviceStub = { list: { subscribe: () => () => {}, getSnapshot: () => ({}) } }
  mod.apply({
    get: (name) => (name === 'sessions' || name === 'workspaces' ? serviceStub : undefined),
    inject: (names, callback) => {
      assert.ok(JSON.stringify(names) === '["jobs","uiSession"]' || JSON.stringify(names) === '["uiWorkspace"]')
      callback({ get: () => ({}), effect: (fn) => { effects.push(fn()) } })
    },
    slots: { inject: (name, fn) => { injected.push([name, fn]) } },
    effect: (fn) => { effects.push(fn()) },
  })
  assert.equal(effects.length, 4, '会话导航、文档级样式、通知订阅与文件夹运行标记四个 effect 均已挂载')
  assert.equal(styleTags[0].attrs['data-plugin'], '@mzzsfy/dsh-turn-notify', '样式自带 data-plugin,防宿主 claimStyles 误归属后随他插件 HMR 整批误删')
  assert.deepEqual(injected.map(([name]) => name), ['settings.section'], '页内通知展示已移交公共依赖包,不再注入 shell.overlay')
  // start 已执行:音效清单被首拉;轮询定时器 unref,不阻止测试进程退出
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.ok(fetched.indexOf('/api/turn-notify/sounds') >= 0)
})

test('Given 偏好面板 When 选择样式与预览 Then 保存本机偏好并用于页内测试通知', async () => {
  const states = [], cleanups = []
  let cursor = 0, runEffects = true
  const reactImpl = {
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useRef: value => ({ current: value }),
    useEffect(effect) { if (runEffects) cleanups.push(effect()) },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  }
  const storage = new FakeStorage(), fetched = []
  const { mod, shown, window: winStub } = loadClient({ storage, reactImpl, onFetch: path => fetched.push(path), payload: { units: [], version: 1 } })
  let component
  mod.apply({
    get: () => ({}), inject() {}, effect() {},
    slots: {
      inject: (_name, register) => register(),
      register: (_entry, render) => { component = render().type },
    },
  })
  const render = () => { cursor = 0; const tree = component(); runEffects = false; return tree }
  const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...node.children.flatMap(nodes)]
  const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.children.includes(label))
  button(render(), '提醒方式').props.onClick()
  const select = nodes(render()).find(node => node.props['aria-label'] === '页内提示样式')
  assert.equal(select.props.value, 'toast')
  const requestsBefore = fetched.length
  select.props.onChange({ target: { value: 'panel' } })
  assert.equal(fetched.length, requestsBefore, '样式只存本机,不发 HTTP 请求')
  assert.equal(storage.getItem('turn-notify:toast-appearance'), 'panel')
  assert.equal(nodes(render()).find(node => node.props['aria-label'] === '页内提示样式').props.value, 'panel')
  let audioStarts = 0
  winStub.AudioContext = class { constructor() { audioStarts += 1; this.state = 'running' } }
  storage.setItem('turn-notify:page-sound', '1')
  button(render(), '预览样式').props.onClick()
  assert.equal(audioStarts, 0, '即使页内提示音开启,样式预览也不创建音频上下文')
  storage.setItem('turn-notify:page-sound', '0')
  assert.equal(shown.length, 1, '预览仅产生一条页内通知')
  assert.equal(shown[0].opts.appearance, 'panel')
  button(render(), '提醒方式').props.onClick()
  assert.equal(nodes(render()).find(node => node.props['aria-label'] === '页内提示样式').props.value, 'panel')
  storage.setItem('turn-notify:toast-appearance', 'toast')
  for (const listener of winStub.listeners.storage) listener({ key: 'turn-notify:toast-appearance' })
  assert.equal(nodes(render()).find(node => node.props['aria-label'] === '页内提示样式').props.value, 'toast')
  storage.setItem('turn-notify:toast-appearance', 'panel')
  for (const listener of winStub.listeners.storage) listener({ key: 'turn-notify:toast-appearance' })
  assert.equal(nodes(render()).find(node => node.props['aria-label'] === '页内提示样式').props.value, 'panel')
  storage.removeItem('turn-notify:toast-appearance')
  for (const listener of winStub.listeners.storage) listener({ key: null })
  assert.equal(nodes(render()).find(node => node.props['aria-label'] === '页内提示样式').props.value, 'toast')
  for (const cleanup of cleanups) cleanup?.()
  assert.equal(winStub.listeners.storage.length, 0, '卸载移除存储监听')
  await new Promise(resolve => setImmediate(resolve))
})

test('Given 未配置或非法样式 When 通知送达 Then 使用标准浮条', async () => {
  for (const appearance of [undefined, '', 'invalid', '__proto__']) {
    const storage = new FakeStorage(appearance === undefined ? {} : { 'turn-notify:toast-appearance': appearance })
    const { mod, shown } = loadClient({ storage, payload: { units: [{ id: 'style-default', category: 'completed', text: '通知' }], version: 1 } })
    await mod.__test.poll()
    await mod.__test.poll()
    assert.equal(shown.at(-1).opts.appearance, 'toast')
  }
})

test('Given 本机选择主题卡片 When 通知与刷新后预览 Then 共用持久偏好且摘要换行与直达保留', async () => {
  const storage = new FakeStorage({ 'turn-notify:toast-appearance': 'panel' })
  const { mod, shown, reload } = loadClient({ storage, payload: {
    units: [{ id: 'style-panel', category: 'completed', text: '任务完成', summary: '耗时 12 秒' }], version: 1,
  } })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(shown[0].text, '任务完成\n耗时 12 秒')
  assert.equal(shown[0].opts.appearance, 'panel')
  assert.equal(shown[0].opts.holdMs, 6 * 1000)
  assert.equal(typeof shown[0].opts.onClick, 'function')
  reload().__test.previewPageNotification()
  assert.equal(shown.at(-1).opts.appearance, 'panel')
  storage.setItem('turn-notify:toast-appearance', 'toast')
  mod.__test.previewPageNotification()
  assert.equal(shown.at(-1).opts.appearance, 'toast', '已加载窗口每次呈现读取最新偏好')
})

test('Given 审批已送达后更换样式 When 二次提醒 Then 采用最新样式', async (t) => {
  const storage = new FakeStorage()
  const timers = []
  const { mod, shown } = loadClient({ storage,
    timerImpl: (callback, ms) => { timers.push({ callback, ms }); return { unref() {} } },
    payload: { units: [{ id: 'style-reminder', category: 'approval', text: '等待审批' }], version: 1 },
  })
  await mod.__test.poll()
  await mod.__test.poll()
  assert.equal(shown[0].opts.appearance, 'toast')
  storage.setItem('turn-notify:toast-appearance', 'panel')
  const reminder = timers.find(timer => timer.ms === 10 * 60 * 1000)
  assert.ok(reminder)
  t.after(() => timers.find(timer => timer.ms === 6 * 1000)?.callback())
  reminder.callback()
  assert.equal(shown.at(-1).text, '[再次提醒] 等待审批')
  assert.equal(shown.at(-1).opts.appearance, 'panel')
})

test('页内提示通道独立开关:关闭后投影事件不再弹页内提示', async () => {
  const storage = new FakeStorage({ 'turn-notify:toast': '0' })
  const { mod, shown } = loadClient({ storage, payload: { units, soundMapping: {}, version: 1 } })
  const { poll } = mod.__test
  await poll()
  await poll()
  assert.equal(shown.length, 0)
  // 完成标记已写:事件被认领消费,仅通道被关
  assert.notEqual(storage.getItem('turn-notify:done:u1'), null)
})

test('分类通知开关串行提交:连点按序入队,host 终值为最后一次点击', async () => {
  const calls = []
  const { mod } = loadClient({ storage: new FakeStorage(), payload: { units: [], soundMapping: {}, version: 1 } })
  const apiImpl = async (path, init) => {
    if (init.method === 'POST') {
      const checked = JSON.parse(init.body).enabled
      await new Promise((resolve) => { setTimeout(resolve, calls.length === 0 ? 30 : 0) })
      // 首个请求最慢:host 到达序即串行化证明,无队列时后发请求将先到
      calls.push(checked)
      return {}
    }
    return {}
  }
  const noop = () => {}
  mod.__test.submitCategoryToggle('completed', false, { apiImpl, onConfig: noop, onError: noop })
  mod.__test.submitCategoryToggle('completed', true, { apiImpl, onConfig: noop, onError: noop })
  mod.__test.submitCategoryToggle('completed', false, { apiImpl, onConfig: noop, onError: noop })
  await mod.__test.submitCategoryToggle('completed', true, { apiImpl, onConfig: noop, onError: noop })
  assert.deepEqual(calls, [
    { completed: false },
    { completed: true },
    { completed: false },
    { completed: true },
  ])
})

test('分类通知开关提交失败:报错并以权威配置纠偏', async () => {
  let failing = true
  const gets = []
  const errors = []
  const configs = []
  const apiImpl = async (path, init) => {
    if (init && init.method === 'POST') {
      if (failing) throw new Error('boom')
      return {}
    }
    gets.push(path)
    return { enabled: { completed: true } }
  }
  const { mod } = loadClient({ storage: new FakeStorage(), payload: { units: [], soundMapping: {}, version: 1 } })
  await mod.__test.submitCategoryToggle('completed', true, {
    apiImpl,
    onConfig: (res) => configs.push(res),
    onError: (text) => errors.push(text),
  })
  assert.equal(errors.length, 1)
  assert.ok(errors[0].indexOf('boom') >= 0)
  assert.deepEqual(gets, ['/api/turn-notify/config'])
  assert.deepEqual(configs, [{ enabled: { completed: true } }])
})

function activate(mod, navigator) {
  // sessions/workspaces 桩:apply 的注入面声明;fold effect 在无 querySelectorAll
  // 的 document 桩上装配即退出,不触碰订阅
  const serviceStub = { list: { subscribe: () => () => {}, getSnapshot: () => ({}) } }
  const cleanups = []
  mod.apply({
    get: (name) => (name === 'sessions' || name === 'workspaces' ? serviceStub : undefined),
    // 模拟缺少活动服务:标记子 fiber 不激活,通知轮询仍必须正常工作;
    // 提供导航服务时补 uiWorkspace 注入(会话导航软依赖),活动服务仍缺席
    inject: (names, callback) => {
      if (navigator !== undefined && names.indexOf('uiWorkspace') >= 0) {
        callback({ get: () => navigator, effect: (fn) => { fn() } })
      }
    },
    slots: { inject: () => {} },
    effect: (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
  })
  return () => { for (const off of cleanups.reverse()) off() }
}

test('Given 已激活且快照在途 When ctx 卸载 Then 退订中止且迟到投影不呈现,再次激活恢复订阅', async () => {
  let pending, signal
  const client = loadClient({
    storage: new FakeStorage(),
    fetchImpl: async (path, options) => {
      if (path.includes('/sounds')) return { ok: true, json: async () => ({ sounds: [] }) }
      signal = options.signal
      return new Promise(resolve => { pending = resolve })
    },
  })
  const dispose = activate(client.mod)
  assert.equal(client.subscriptionCount(), 1)
  client.emitBus()
  dispose()
  assert.equal(client.subscriptionCount(), 0)
  assert.equal(signal.aborted, true)
  assert.equal(Object.hasOwn(client.window, 'turn-notify:polling'), false)
  assert.equal(Object.hasOwn(client.window, 'turn-notify:polling:dispose'), false)
  pending({ ok: true, json: async () => ({ version: 1, units: [{ id: 'late', category: 'ask', text: '迟到提问' }] }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.shown.length, 0)
  const disposeAgain = activate(client.mod)
  assert.equal(client.subscriptionCount(), 1, '卸载清 running,同一 factory 再激活可重新订阅')
  disposeAgain()
})

test('快照请求代际中止:abort 后不再发起新请求(重拉只由总线事件驱动)', async () => {
  let calls = 0
  const client = loadClient({
    storage: new FakeStorage(),
    // 桩模拟真实 fetch 的中止语义:代际 signal 触发即 reject;仅计投影请求
    fetchImpl: (path, init) => new Promise((resolve, reject) => {
      if (path.indexOf('/sounds') >= 0) {
        resolve({ ok: true, json: async () => ({ sounds: [] }) })
        return
      }
      calls += 1
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  })
  const { mod, window: windowStub } = client
  activate(mod)
  client.emitBus()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.equal(calls, 1, '首拉已发出并挂起')
  windowStub['turn-notify:polling'].abort()
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.equal(calls, 1, '中止后不再发起新请求;失败不自动重试,重拉只由总线事件驱动')
})

test('快照失败:降级通告一次,无自动重试(重拉只由总线事件驱动)', async () => {
  const warns = []
  const original = console.warn
  console.warn = (message) => { warns.push(message) }
  let calls = 0
  try {
    const client = loadClient({
      storage: new FakeStorage(),
      fetchImpl: async (path) => {
        if (path.indexOf('/sounds') >= 0) return { ok: true, json: async () => ({ sounds: [] }) }
        calls += 1
        throw new Error('down')
      },
    })
    activate(client.mod)
    client.emitBus()
    // 无轮询循环:等待窗内不会出现第二次请求与第二次通告
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  } finally { console.warn = original }
  assert.equal(calls, 1)
  assert.equal(warns.length, 1)
  assert.ok(warns[0].indexOf('通知降级') >= 0)
})

test('冷启动对齐:首个快照静默,后续快照正常呈现,请求恒无游标', async () => {
  const paths = []
  const { mod } = loadClient({
    storage: new FakeStorage(),
    fetchImpl: async (path) => {
      paths.push(path)
      return { ok: true, json: async () => ({ units: [], soundMapping: {}, version: 7 }) }
    },
  })
  const { poll } = mod.__test
  assert.equal(await poll(), true, '带 version 响应视为成功')
  assert.equal(await poll(new AbortController().signal), true)
  for (const path of paths) assert.ok(path.indexOf('?cursor=') < 0, '快照端点无游标形态,变更通知由总线承载')
})
