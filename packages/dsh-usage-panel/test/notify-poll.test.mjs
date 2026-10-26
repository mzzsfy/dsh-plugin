import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

const flush = () => new Promise(resolve => setImmediate(resolve))
const storageFixture = () => {
  const rows = new Map()
  return { get length() { return rows.size }, key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) }
}

function clientFixture({ storage = storageFixture(), indexedDB, abortSignalImpl = AbortSignal } = {}) {
  let definition, payload = { version: 0, units: [] }
  const shown = [], subscriptions = new Set(), pending = new Set()
  const window = { localStorage: storage, indexedDB, __ModuleLoader__: { load: value => { definition = value } } }
  const tools = {
    createSnapshotRefresh: refresh => ({ refresh() {
      const work = refresh(); pending.add(work); work.finally(() => pending.delete(work)); return work
    }, dispose() {} }),
    toast: { show: text => shown.push(text) },
    setupCommonTools: () => ({ subscribe(onMessage, { onReset }) {
      subscriptions.add(onReset); return () => subscriptions.delete(onReset)
    } }),
  }
  const fetch = async () => ({ ok: true, json: async () => payload })
  new Function('window', 'fetch', 'AbortSignal', source)(window, fetch, abortSignalImpl)
  function generation() {
    const mod = definition.factory(name => name === 'react' ? {} : tools)
    return { apply() {
      const cleanups = []
      mod.apply({ fiber: { entry: { options: { name: '@mzzsfy/dsh-usage-panel' } } },
        slots: { inject() {}, register() {} }, effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) } })
      return () => { while (cleanups.length) cleanups.pop()() }
    } }
  }
  return { shown, window, generation, set(payloadNext) { payload = payloadNext },
    poll() { for (const refresh of subscriptions) refresh(); return Promise.all([...pending]) } }
}

// 同库事务串行，只有提交后才发布写入；事务取消丢弃整个草稿。
function indexedDbFixture() {
  let rows = new Map(), initialized = false, queue = Promise.resolve(), gate = null
  const connections = []
  const factory = { open() {
    const request = {}
    setImmediate(() => {
      const db = { closed: false, createObjectStore() {}, close() { this.closed = true }, transaction() {
        if (this.closed) throw new Error('closed')
        const tx = {}, operations = []
        let draft, aborted = false
        tx.abort = () => { aborted = true }
        const requestFor = run => {
          const request = {}; operations.push(() => { request.result = run(); request.onsuccess?.() }); return request
        }
        tx.objectStore = () => ({ getAll: () => requestFor(() => [...draft.values()]),
          delete: id => requestFor(() => draft.delete(id)), add: row => requestFor(() => {
            if (draft.has(row.id)) throw new Error('ConstraintError')
            draft.set(row.id, row)
          }) })
        queue = queue.then(async () => {
          if (gate) await gate.promise
          draft = new Map(rows)
          try {
            if (aborted) throw new Error('AbortError')
            while (operations.length) operations.shift()()
            rows = draft; tx.oncomplete?.()
          } catch (error) { tx.error = error; tx.onabort?.() }
        })
        return tx
      } }
      connections.push(db); request.result = db
      if (!initialized) { initialized = true; request.onupgradeneeded?.() }
      request.onsuccess?.()
    })
    return request
  } }
  return { factory, connections, get rows() { return rows },
    hold() { gate = {}; gate.promise = new Promise(resolve => { gate.resolve = resolve }) },
    release() { const current = gate; gate = null; current?.resolve() } }
}

test('Given usage双窗共享storage When 新通知后旧空快照抵达再追平 Then 总呈现一次', async () => {
  const storage = storageFixture(), idb = indexedDbFixture()
  const a = clientFixture({ storage, indexedDB: idb.factory }), b = clientFixture({ storage, indexedDB: idb.factory })
  const offA = a.generation().apply(), offB = b.generation().apply()
  const payload = { version: 1, units: [{ id: 'new', text: '余额提醒', kind: 'balance', ts: Date.now() }] }
  try {
    a.set(payload); await a.poll(); await flush(); await flush()
    await b.poll(); await flush(); await flush()
    b.set(payload); await b.poll(); await flush(); await flush()
    assert.equal(a.shown.length + b.shown.length, 1)
  } finally { offA(); offB() }
})

test('Given usage双窗storage观察均为空 When 同时消费首快照 Then 事务单赢家且过期记录清理', async () => {
  const idb = indexedDbFixture()
  idb.rows.set('expired', { id: 'expired', expiresAt: 0 })
  const a = clientFixture({ indexedDB: idb.factory }), b = clientFixture({ indexedDB: idb.factory })
  const offA = a.generation().apply(), offB = b.generation().apply()
  const payload = { version: 1, units: [{ id: 'race', text: '并发余额提醒', kind: 'balance', ts: Date.now() }] }
  try {
    a.set(payload); b.set(payload)
    await Promise.all([a.poll(), b.poll()])
    assert.equal(a.shown.length + b.shown.length, 1, '首快照保留既有呈现语义但跨窗只呈现一次')
    assert.deepEqual([...idb.rows.keys()], ['race'])
  } finally { offA(); offB() }
})

test('Given usage事务在途 When 最后owner退出和HMR Then 回滚无late显示且同id可重激活', async () => {
  const idb = indexedDbFixture(), f = clientFixture({ indexedDB: idb.factory }), generation = f.generation()
  const offA = generation.apply(), offB = generation.apply()
  const payload = { version: 1, units: [{ id: 'late', text: '待接手', ts: Date.now() }] }
  f.set(payload); idb.hold()
  const pending = f.poll()
  await flush(); await flush()
  offA(); assert.equal(idb.connections[0].closed, false)
  offB(); idb.release(); await pending
  assert.equal(idb.rows.has('late'), false)
  assert.deepEqual(f.shown, [])
  assert.equal(idb.connections[0].closed, true)
  const offAgain = generation.apply()
  await f.poll()
  assert.deepEqual(f.shown, ['待接手'])
  const current = f.generation(), offCurrent = current.apply()
  await flush()
  assert.equal(idb.connections[1].closed, true, '新代接管关闭旧代连接')
  offAgain(); offCurrent()
})

test('Given 宿主时钟落后 When 消费有效快照 Then 正常呈现；IDB不可用时本窗同事件仍只呈现一次', async () => {
  const idb = indexedDbFixture(), f = clientFixture({ indexedDB: idb.factory })
  const off = f.generation().apply()
  try {
    f.set({ version: 1, units: [{ id: 'clock-skew', text: '有效通知', ts: Date.now() - 10 * 60 * 1000 }] })
    await f.poll()
    assert.deepEqual(f.shown, ['有效通知'])
  } finally { off() }
  const degraded = clientFixture({ storage: { get length() { throw new Error('blocked') }, getItem() { throw new Error('blocked') } } })
  const offDegraded = degraded.generation().apply()
  try {
    degraded.set({ version: 1, units: [{ id: 'fallback', text: '降级', ts: Date.now() }] })
    await degraded.poll(); await degraded.poll()
    assert.deepEqual(degraded.shown, ['降级'])
  } finally { offDegraded() }
})

test('Given usage认领事务等待 When 本地快照消费超时 Then 回滚不留done且另窗能接手', async () => {
  const idb = indexedDbFixture(), timeout = new AbortController()
  const payload = { version: 1, units: [{ id: 'timeout', text: '可接手', ts: Date.now() - 10 * 60 * 1000 }] }
  const a = clientFixture({ indexedDB: idb.factory,
    abortSignalImpl: { timeout: () => timeout.signal, any: signals => AbortSignal.any(signals) } })
  const offA = a.generation().apply()
  a.set(payload); idb.hold()
  const pending = a.poll()
  await flush(); await flush()
  timeout.abort(); idb.release(); await pending
  assert.deepEqual(a.shown, [])
  assert.equal(idb.rows.has('timeout'), false)
  const b = clientFixture({ indexedDB: idb.factory }), offB = b.generation().apply()
  try { b.set(payload); await b.poll(); assert.deepEqual(b.shown, ['可接手']) }
  finally { offA(); offB() }
})

test('消费形态为推送总线订阅:setInterval 短轮询与长轮询游标不得回归', () => {
  assert.ok(!source.includes('setInterval'), '残留 interval 短轮询形态')
  assert.ok(!source.includes('while (!notifyController'), '残留长轮询主循环形态')
  assert.match(source, /tools\.setupCommonTools\(ctx\)/, '缺少插件上下文绑定')
  assert.match(source, /bus\.subscribe\(refresh, \{ onReset: refresh \}\)/, '缺少消息与重连快照入口')
  assert.match(source, /AbortSignal\.timeout\(NOTIFY_REQUEST_TIMEOUT_MS\)/, '快照请求缺少超时上限')
  assert.ok(!source.includes('?cursor='), '残留长轮询续传游标形态')
  assert.ok(!source.includes('NOTIFY_RETRY'), '残留退避重试形态')
})
