import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const commonSource = readFileSync(new URL('../../dsh-common-tools/src/client.js', import.meta.url), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(name, { manual = false } = {}) {
  const definitions = new Map(), sockets = [], timers = new Map(), requests = [], shown = []
  const storage = new Map()
  let timerId = 0, hold = false, now = 0
  class Clock extends Date { static now() { return now } }
  const pending = []
  const window = {
    location: { href: 'http://runtime.test/' },
    __ModuleLoader__: { load: definition => definitions.set(definition.id, definition) },
    localStorage: {
      get length() { return storage.size }, key: index => [...storage.keys()][index] ?? null,
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key),
    },
    addEventListener() {}, removeEventListener() {},
  }
  const document = {
    hidden: false, title: 'runtime', hasFocus: () => true,
    createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} },
  }
  const setTimeout = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId }
  const clearTimeout = id => timers.delete(id)
  class Socket {
    static OPEN = 1
    constructor() { this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this) }
    send(value) { this.sent.push(JSON.parse(value)) }
    close() { this.readyState = 3; this.onclose?.() }
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
    open() { this.readyState = Socket.OPEN; this.onopen() }
    ready() {
      const frame = this.sent.filter(item => item.type === 'subscribe').at(-1)
      this.frame({ type: 'ready', plugins: frame.plugins, revision: frame.revision })
    }
  }
  new Function('window', 'document', 'WebSocket', 'setTimeout', 'clearTimeout', 'Date', commonSource)(window, document, Socket, setTimeout, clearTimeout, Clock)
  const common = definitions.get('@mzzsfy/dsh-common-tools').factory(() => ({}))
  const tools = { ...common, toast: { show: text => shown.push(text) } }
  const source = readFileSync(new URL(`../../${name}/src/client.js`, import.meta.url), 'utf8')
  const fetch = async (path, options) => {
    const request = { path, options }
    requests.push(request)
    if (manual && !path.endsWith('/sounds')) return new Promise(resolve => {
      request.respond = payload => resolve({ ok: true, json: async () => payload })
    })
    if (hold && !path.endsWith('/sounds')) await new Promise(resolve => pending.push(resolve))
    return { ok: true, json: async () => ({ version: requests.length, units: [{ id: `unit-${requests.length}`, category: 'ask', text: '通知' }], sounds: [] }) }
  }
  new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', source)(window, document, fetch, setTimeout, clearTimeout, setTimeout, clearTimeout)
  const react = { useState: value => [value, () => {}], useEffect() {}, useCallback: fn => fn }
  function factory() {
    const mod = definitions.get(`@mzzsfy/${name}`).factory(module => module === 'react' ? react : tools)
    return { apply() {
      const cleanups = []
      const effect = (fn, tag) => {
        if (tag === 'rs-workflow: session-aware flow view') return
        const off = fn()
        if (typeof off === 'function') cleanups.push(off)
      }
      const ctx = {
        fiber: { entry: { options: { name: `@mzzsfy/${name}` } } },
        get: () => ({ list: { subscribe: () => () => {}, getSnapshot: () => ({}) } }),
        slots: { inject() {}, register() {} },
        // PR #3 起运行标记经 ctx.inject(['jobs','uiSession']) 嵌套 effect,
        // 桩同步形态:注入即回调,内层 effect 沿用本桩,disposer 收集一致
        inject(_names, fn) {
          fn({
            get: service => service === 'jobs'
              ? { state: { getSnapshot: () => ({ rows: {} }), subscribe: () => () => {}, watchRows: () => () => {} } }
              : { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
            effect,
          })
        },
        effect,
      }
      mod.apply(ctx)
      return () => { while (cleanups.length) cleanups.pop()() }
    } }
  }
  const socket = () => sockets.at(-1)
  return { factory, requests, shown, timers, sockets, storage,
    get snapshots() { return requests.filter(item => !item.path.endsWith('/sounds')) },
    hold() { hold = true },
    release() { hold = false; for (const resolve of pending.splice(0)) resolve() },
    connect() { socket().open(); socket().ready() },
    connectReady() { socket().ready() },
    change() { now += 1000; socket().ready(); socket().frame({ type: 'message', plugin: `@mzzsfy/${name}`, payload: null }) },
    advance() { now += 1000; for (const [id, timer] of [...timers]) if (timer.delay <= 1000) { timers.delete(id); timer.fn() } },
    get subscribed() { return socket().sent.filter(item => item.type === 'subscribe').at(-1)?.plugins.includes(`@mzzsfy/${name}`) === true },
    get workCount() { return name === 'dsh-rs-workflow' ? [...timers.values()].filter(timer => timer.delay === 1000).length : requests.filter(request => !request.path.endsWith('/sounds')).length },
    drain() { for (const [id, timer] of [...timers]) { if (timer.delay === 1000) { timers.delete(id); timer.fn() } } },
  }
}

for (const name of ['dsh-turn-notify', 'dsh-usage-panel']) {
  test(`Given ${name} 快照在途 When 连续变更 Then 单飞且仅补拉一轮并保留最新通知完成标记`, async () => {
    const f = fixture(name, { manual: true }), dispose = f.factory().apply()
    const unit = { id: 'B', category: 'ask', text: '通知B' }
    try {
      f.connect()
      f.snapshots[0].respond({ version: 0, units: [] }); await flush()
      f.change(); f.change(); f.change()
      assert.equal(f.snapshots.length, 2, '在途变更仅置dirty,不创建并发快照')
      f.snapshots[1].respond({ version: 1, units: [] }); await flush()
      assert.equal(f.snapshots.length, 3, '多次变更合并成一次补拉')
      f.snapshots[2].respond({ version: 2, units: [unit] }); await flush()
      assert.deepEqual(f.shown, ['通知B'])
      const doneKey = name === 'dsh-turn-notify' ? 'turn-notify:done:B' : 'usage-panel:notify-done:B'
      assert.equal(f.storage.get(doneKey), '1', '完成标记保持最新投影结果')
      f.change()
      f.snapshots[3].respond({ version: 2, units: [unit] }); await flush()
      assert.deepEqual(f.shown, ['通知B'], '后续相同投影不重复提醒')
      assert.equal(f.snapshots.length, 4, 'dirty已清零,无额外补拉')
    } finally { dispose(); for (const request of f.snapshots) request.respond({ version: 0, units: [] }); await flush() }
  })

  test(`Given ${name} 在途快照积累dirty When 最后owner退出 Then 不消费迟到响应且不补拉`, async () => {
    const f = fixture(name, { manual: true }), dispose = f.factory().apply()
    f.connect(); f.change(); f.change()
    const requests = [...f.snapshots]
    dispose()
    for (const request of requests) request.respond({ version: 1, units: [{ id: 'late', category: 'ask', text: '迟到' }] })
    await flush()
    assert.equal(f.snapshots.length, 1, '最后owner退出不得补拉dirty')
    assert.equal(requests[0].options.signal.aborted, true)
    assert.equal(f.shown.length, 0)
  })
}

for (const name of ['dsh-turn-notify', 'dsh-usage-panel', 'dsh-rs-workflow']) {
  for (const first of [0, 1]) {
    test(`Given ${name} 同 factory A+B When 先卸载${first === 0 ? 'A' : 'B'} Then 存活实例继续单次工作且最后退出停工并可再激活`, async () => {
      const f = fixture(name), generation = f.factory(), owners = [generation.apply(), generation.apply()]
      try {
        f.connect(); await flush()
        assert.equal(f.workCount, 1, '并存 ctx 共用一次快照或合并广播')
        if (name !== 'dsh-rs-workflow') assert.equal(f.shown.length, 1, '同一通知只呈现一次')
        f.drain()
        owners[first]()
        assert.equal(f.subscribed, true, '仍有活跃 ctx 时必须保留接收空间')
        const before = f.workCount
        f.change(); await flush()
        assert.equal(f.workCount, before + 1, '存活 ctx 必须继续接收且没有重复快照')
        owners[1 - first]()
        assert.equal(f.sockets[0].readyState, 3, '最后 ctx 退出关闭真实 common 连接')
        assert.equal(f.timers.size, 0, '最后 owner 退出取消工作计时器')
        const disposeAgain = generation.apply()
        try {
          f.connect(); await flush()
          assert.equal(f.subscribed, true, '同 factory 再激活恢复订阅')
          assert.equal(f.workCount, name === 'dsh-rs-workflow' ? 1 : before + 2)
        } finally { disposeAgain() }
      } finally { for (const dispose of owners.reverse()) dispose() }
    })
  }

  test(`Given ${name} 已ready的A When B晚加入并同步onReset Then 不重复快照且A退场后B接续`, async () => {
    const f = fixture(name), generation = f.factory(), disposeA = generation.apply()
    f.connect(); await flush(); f.drain()
    const before = f.workCount, disposeB = generation.apply()
    try {
      await flush()
      assert.equal(f.workCount, before, '晚订阅同步onReset不得重复执行共享工作')
      disposeA()
      f.change(); await flush()
      assert.equal(f.workCount, before + 1)
    } finally { disposeA(); disposeB() }
  })

  if (name !== 'dsh-rs-workflow') test(`Given ${name} A快照在途且B活跃 When A卸载 Then 请求继续有效且B不重复首拉`, async () => {
    const f = fixture(name), generation = f.factory(), disposeA = generation.apply()
    f.hold(); f.connect()
    const request = f.requests.find(item => !item.path.endsWith('/sounds')), disposeB = generation.apply()
    try {
      disposeA()
      assert.equal(request.options.signal.aborted, false, '共享在途请求归属整代工作而非A')
      assert.equal(f.workCount, 1, '转交不额外首拉')
      f.release(); await flush()
      assert.equal(f.shown.length, 1, '存活B继续消费在途结果')
    } finally { f.release(); disposeA(); disposeB() }
    assert.equal(request.options.signal.aborted, true, '最后owner退出才中止整代请求')
  })

  test(`Given ${name} 旧 factory A+B When 新 factory C+D 接管后旧 ctx 卸载 Then 不撤销新代工作`, async () => {
    const f = fixture(name), old = f.factory(), disposeA = old.apply(), disposeB = old.apply()
    f.connect(); await flush(); f.drain()
    const current = f.factory(), disposeC = current.apply(), disposeD = current.apply()
    try {
      f.connectReady(); await flush()
      disposeA(); disposeB()
      assert.equal(f.subscribed, true)
      f.drain()
      const before = f.workCount
      f.change(); await flush()
      assert.equal(f.workCount, before + 1, '旧代 cleanup 不碰新代订阅')
      disposeC()
      assert.equal(f.subscribed, true)
    } finally { disposeA(); disposeB(); disposeC(); disposeD() }
    assert.equal(f.timers.size, 0)
    assert.equal(f.sockets[0].readyState, 3)
  })
}
