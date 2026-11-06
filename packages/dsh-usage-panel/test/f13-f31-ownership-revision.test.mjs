// F13 / F31 回归守护(可失败行为测试)。host 侧经真实路由驱动,client 侧经整源求值。
// F13(查询结果归属 + 同 id 单飞):同账号并发查询只打一次上游;账号被删除/替换后,
//   在途查询的迟到结果不得写历史、不得评估发通知(不产生总线广播)。
// F31(数据修订号路由 + 总线桥):任一数据持久化成功即自增修订号并经总线广播(客户端据此
//   重取),/revision 路由暴露该值;client 半区把总线变更桥成 window 事件(面板对账入口)。
// 数据目录经 env 注入临时路径,须在 import src/index.js 之前设置(模块顶层求值)。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { busStub, resetBusStub } from './_mocks.common-tools.mjs'

const tempDir = await mkdtemp(join(tmpdir(), 'usage-f13-'))
process.env.DSH_USAGE_PANEL_DATA_DIR = tempDir

const { apply } = await import('../src/index.js')

after(async () => {
  delete process.env.DSH_USAGE_PANEL_DATA_DIR
  await rm(tempDir, { recursive: true, force: true })
})

const NOTIFY_OFF = { notify: { enabled: false } }

function makeCtx({ settingsValue = NOTIFY_OFF } = {}) {
  const routes = new Map()
  resetBusStub()
  const published = busStub.published
  const settingsService = { register() {}, get: () => settingsValue, update: async () => {} }
  const ctx = {
    get: (name) => (name === 'settings' ? settingsService : undefined),
    effect: (fn) => { fn() },
    inject: (_deps, fn) => fn({ settings: settingsService, interval: () => {} }),
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, routes, published }
}

function makeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000' }
  if (body !== undefined) {
    req.headers['content-type'] = 'application/json'
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    process.nextTick(() => {
      req.emit('data', Buffer.from(text))
      req.emit('end')
    })
  }
  return req
}

async function call(routes, path, req) {
  if (req.url === undefined) req.url = path
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = text ? JSON.parse(text) : null }
  await routes.get(path.split('?')[0])(req, res)
  return res
}

// kimi 形态读数(5 小时窗 95% 已用 / 7 天窗 50%)
const KIMI_BODY = {
  limits: [{ detail: { limit: 100, remaining: 5, resetTime: 'T1' } }],
  usage: { limit: 200, remaining: 100, resetTime: 'T2' },
}

/** 可控上游:deferred 模式下 fetch 挂起,由测试手动放行;记录调用次数。 */
function upstream({ deferred = false } = {}) {
  const control = { calls: 0, resolve: null }
  const original = globalThis.fetch
  globalThis.fetch = (url) => {
    control.calls += 1
    const response = { ok: true, status: 200, text: async () => JSON.stringify(KIMI_BODY) }
    if (!deferred) return Promise.resolve(response)
    return new Promise((resolve) => { control.resolve = () => resolve(response) })
  }
  control.restore = () => { globalThis.fetch = original }
  return control
}

const saveAccounts = (routes, accounts) => call(routes, '/api/usage-panel/accounts', makeReq('POST', { accounts }))
const historyOf = async (routes) => (await call(routes, '/api/usage-panel/history', makeReq('GET'))).payload.sequences
const revisionOf = async (routes) => (await call(routes, '/api/usage-panel/revision', makeReq('GET'))).payload.revision

test('F13-a 同 id 单飞:并发两次查询只打一次上游,两次响应同源', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const fetchControl = upstream({ deferred: true })
  try {
    await saveAccounts(routes, [{ id: 'acct-f13', name: '账号F', type: 'kimi', apiKey: 'sk-test' }])
    const first = call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-f13' }))
    const second = call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-f13' }))
    // 让两个 handler 都进到 runQuery(在途 promise 已登记)
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fetchControl.calls, 1, '同账号并发查询必须共享在途 promise,实际打了 ' + fetchControl.calls + ' 次上游')
    fetchControl.resolve()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.payload.ok, true)
    assert.equal(b.payload.ok, true)
    assert.equal(a.payload.account.last.queriedAt, b.payload.account.last.queriedAt, '两次响应来自同一次查询')
  } finally {
    fetchControl.restore()
  }
})

test('F13-b 归属:账号删除后在途查询的迟到结果不写历史、不评估发通知', async () => {
  const { ctx, routes } = makeCtx({ settingsValue: { notify: { enabled: true, quotaThresholdPct: 50, toast: true } } })
  apply(ctx)
  const fetchControl = upstream({ deferred: true })
  try {
    await saveAccounts(routes, [
      { id: 'acct-orphan', name: '待删', type: 'kimi', apiKey: 'sk-test' },
      { id: 'acct-keep', name: '保留', type: 'kimi', apiKey: 'sk-test' },
    ])
    const pending = call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-orphan' }))
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fetchControl.calls, 1, '查询已在途')

    // 用户删除该账号(账号表整体替换,旧对象离场;历史键一并清理)
    await saveAccounts(routes, [{ id: 'acct-keep', name: '保留', type: 'kimi', apiKey: 'sk-test' }])
    const historyBefore = Object.keys(await historyOf(routes)).filter((key) => key.startsWith('acct-orphan:'))
    const notifyBefore = (await call(routes, '/api/usage-panel/notifications', makeReq('GET'))).payload.units.length

    // 迟到响应此刻才落地(读数 95% 已用,若被接纳必然越阈产生事件)
    fetchControl.resolve()
    const orphanRes = await pending
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))

    assert.equal(orphanRes.payload.ok, false, '孤儿结果不得报告成功(面板不应呈现旧读数)')
    const historyAfter = Object.keys(await historyOf(routes)).filter((key) => key.startsWith('acct-orphan:'))
    assert.deepEqual(historyAfter, historyBefore, '已删账号不得被迟到结果重建历史序列')
    const notifyAfter = (await call(routes, '/api/usage-panel/notifications', makeReq('GET'))).payload.units.length
    assert.equal(notifyAfter, notifyBefore, '孤儿结果不得进入通知投影(不得为已删账号发事件)')
  } finally {
    fetchControl.restore()
  }
})

test('F31-a 修订号路由:数据持久化成功即自增并经总线广播一次', async () => {
  const { ctx, routes, published } = makeCtx()
  apply(ctx)
  const fetchControl = upstream()
  try {
    const before = await revisionOf(routes)
    const publishesBefore = published.length
    await saveAccounts(routes, [{ id: 'acct-rev', name: '账号R', type: 'kimi', apiKey: 'sk-test' }])
    const afterSave = await revisionOf(routes)
    assert.ok(afterSave > before, `账号写入后修订号必须自增(前 ${before} 后 ${afterSave})`)
    assert.ok(published.length > publishesBefore, '修订号自增必须伴随总线广播(客户端的重取触发源)')

    // 查询成功落历史:修订号继续增长,广播继续增加
    const beforeQuery = await revisionOf(routes)
    const publishesBeforeQuery = published.length
    const queryRes = await call(routes, '/api/usage-panel/query', makeReq('POST', { id: 'acct-rev' }))
    assert.equal(queryRes.payload.ok, true)
    const afterQuery = await revisionOf(routes)
    assert.ok(afterQuery > beforeQuery, `历史落盘后修订号必须自增(前 ${beforeQuery} 后 ${afterQuery})`)
    assert.ok(published.length > publishesBeforeQuery, '历史落盘必须伴随总线广播')
  } finally {
    fetchControl.restore()
  }
})

// ---- client 半区:总线桥(面板无总线句柄,桥转 window 事件供组件对账) ----
const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

function loadClientBridge() {
  const dispatched = []
  const listeners = new Map()
  const windowStub = {
    __ModuleLoader__: { load: (definition) => { windowStub.definition = definition } },
    addEventListener: (name, handler) => { listeners.set(name, handler) },
    removeEventListener: () => {},
    dispatchEvent: (event) => { dispatched.push(event.type); return true },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  }
  const documentStub = {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
  }
  new Function('window', 'document', 'navigator', 'fetch', `${CLIENT_SRC}\n;return null`)(windowStub, documentStub, {}, async () => ({ ok: true, json: async () => ({}) }))
  assert.ok(windowStub.definition, 'client.js 未自注册')

  const subscribers = new Set()
  const bus = {
    subscribe: (fn, options) => {
      subscribers.add(fn)
      if (options?.onReset) subscribers.add(options.onReset)
      return () => subscribers.delete(fn)
    },
    publish: () => {},
  }
  const ReactStub = {
    createElement: () => null,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    if (name === '@mzzsfy/dsh-common-tools/client') return { setupCommonTools: () => bus }
    throw new Error('模块表缺依赖:' + name)
  }
  const disposers = []
  const plugin = windowStub.definition.factory(requireStub)
  plugin.apply({
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return () => {} },
    slots: { inject: (name, factory) => factory(), register: () => () => {} },
  })
  return {
    dispatched,
    fire(data) {
      for (const subscriber of [...subscribers]) subscriber(data ?? null)
    },
    disposeAll() {
      for (const dispose of disposers) dispose?.()
      subscribers.clear()
    },
  }
}

test('F31-b 总线桥:一次总线广播桥成一次 window 数据变更事件,卸载后不再桥接', () => {
  const bridge = loadClientBridge()
  assert.equal(bridge.dispatched.length, 0, '未广播前不得派发')
  bridge.fire()
  assert.deepEqual(bridge.dispatched, ['up-data-changed'], '一次广播应对应一次面板对账事件')
  bridge.fire()
  assert.deepEqual(bridge.dispatched, ['up-data-changed', 'up-data-changed'])
  bridge.disposeAll()
  bridge.fire()
  assert.equal(bridge.dispatched.length, 2, '卸载后总线桥必须解除')
})
