// P2-03:dispose 必须中止在途上游查询,并阻止旧实例继续写盘/发 webhook/IM。
// 数据目录经 env 注入临时路径,须在 import src/index.js 之前设置(模块顶层求值)。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = await mkdtemp(join(tmpdir(), 'usage-dispose-'))
process.env.DSH_USAGE_PANEL_DATA_DIR = tempDir

const { apply } = await import('../src/index.js')

after(async () => {
  delete process.env.DSH_USAGE_PANEL_DATA_DIR
  await rm(tempDir, { recursive: true, force: true })
})

const KIMI_BODY = {
  limits: [{ detail: { limit: 100, remaining: 5, resetTime: 'T1' } }],
  usage: { limit: 200, remaining: 50, resetTime: 'T2' },
}

function makeCtx() {
  const routes = new Map()
  const disposers = []
  const sent = []
  const settingsValue = {
    notify: {
      enabled: true,
      quotaThresholdPct: 50,
      webhookUrl: 'https://hooks.example.com/dsh',
      imTargets: [{ botId: 'wx_a', targetId: 'owner' }],
    },
  }
  const settingsService = { register() {}, get: () => settingsValue, update: async () => {} }
  const interval = () => () => {}
  const ctx = {
    get(name) {
      if (name === 'settings') return settingsService
      if (name === 'dshIm') return { send: async (botId, targetId, text) => { sent.push({ botId, targetId, text }) } }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject(_deps, fn) { fn({ settings: settingsService, interval }) },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  return {
    ctx,
    routes,
    sent,
    disposeAll() { while (disposers.length > 0) disposers.pop()() },
  }
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

async function call(handler, path, req) {
  if (req.url === undefined) req.url = path
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = text ? JSON.parse(text) : null }
  await handler(req, res)
  return res
}

const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
const conversation = async (path) => JSON.parse(await readFile(join(tempDir, path), 'utf8'))

test('P2-03 dispose 中止在途查询,迟到结果不写历史、不评估通知、不外发 webhook/IM', async () => {
  const { ctx, routes, sent, disposeAll } = makeCtx()
  apply(ctx)
  const saveAccounts = await call(routes.get('/api/usage-panel/accounts'), '/api/usage-panel/accounts', makeReq('POST', {
    accounts: [{ id: 'acct-d', name: '待卸载', type: 'kimi', apiKey: 'sk-test' }],
  }))
  assert.equal(saveAccounts.status, 200)

  const fetchCalls = []
  const originalFetch = globalThis.fetch
  let release
  globalThis.fetch = (url, options) => new Promise((resolve) => {
    fetchCalls.push({ url: String(url), options })
    release = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify(KIMI_BODY) })
  })
  try {
    const queryHandler = routes.get('/api/usage-panel/query')
    const accountsHandler = routes.get('/api/usage-panel/accounts')
    const pendingQuery = call(queryHandler, '/api/usage-panel/query', makeReq('POST', { id: 'acct-d' }))
    await flush()
    assert.equal(fetchCalls.length, 1, '查询已发起上游请求')
    const requestSignal = fetchCalls[0].options.signal
    assert.equal(requestSignal.aborted, false, 'dispose 前请求未被中止')

    // When 禁用/HMR 卸载实例
    disposeAll()
    // Then 在途请求被中止
    assert.equal(requestSignal.aborted, true, 'dispose 必须中止在途查询')

    // 上游迟到返回:旧实例不得写历史/发通知/外发 webhook IM
    release()
    const queryRes = await pendingQuery
    await flush()
    assert.equal(queryRes.payload.ok, false, 'dispose 后的迟到结果按失败/孤儿返回')
    assert.equal(fetchCalls.length, 1, 'dispose 后不得再发起 webhook 外呼')
    assert.deepEqual(sent, [], 'dispose 后不得再发 IM')
    const history = await conversation('history.json')
    assert.deepEqual(history.sequences, {}, '迟到查询不得写入历史')
    const accounts = await conversation('accounts.json')
    assert.deepEqual(accounts.accounts.map((item) => item.id), ['acct-d'], '账号数据未被旧实例改写')

    // 旧实例的写路由在 dispose 后也不得落盘
    const staleSave = await call(accountsHandler, '/api/usage-panel/accounts', makeReq('POST', {
      accounts: [{ id: 'acct-d', name: '改名', type: 'kimi', apiKey: 'sk-test' }],
    }))
    assert.equal(staleSave.status, 400)
    assert.match(staleSave.payload.error, /已停止写入/)
    const diskAfter = await conversation('accounts.json')
    assert.equal(diskAfter.accounts[0].name, '待卸载', 'dispose 后写路由拒绝落盘')
  } finally {
    globalThis.fetch = originalFetch
  }
})
