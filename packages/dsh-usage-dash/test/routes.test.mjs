// 路由测试:webServer 用内存假件捕获 exact 注册,直接调 handler(req,res)。
// Given/When/Then 场景嵌于各用例,覆盖守卫、信封、校验与数据管线。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { MAX_RANGE_SPAN_DAYS, registerUsageRoutes } from '../src/routes.js'
import { DEFAULT_MINUTE_RETENTION_DAYS, minuteKey } from '../src/store.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const ROUTE_PREFIX = '/api/usage-dash'
const PATH_RANGE = `${ROUTE_PREFIX}/range`
const PATH_HOURS = `${ROUTE_PREFIX}/hours`
const PATH_MINUTES = `${ROUTE_PREFIX}/minutes`
const PATH_STATUS = `${ROUTE_PREFIX}/status`
const PATH_RESET = `${ROUTE_PREFIX}/reset`
const PATH_UNKNOWN = `${ROUTE_PREFIX}/unknown`
const LOCAL_HOST = '127.0.0.1:3080'
// 固定"当前时刻",分钟保留窗口断言以此换算,消除真实时钟不确定性
const FIXED_NOW = Date.UTC(2026, 1, 10, 12, 0, 0)
const JSON_HEADERS = { 'content-type': 'application/json' }

const makeRow = (overrides = {}) => ({
  bucket: '2026-02-01',
  provider: 'default',
  model: 'deepseek-chat',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
  turns: 0,
  lastSeen: 0,
  ...overrides,
})

function makeCtx() {
  return {
    webServer: undefined,
    logger: {
      warnings: [],
      warn(message) {
        this.warnings.push(message)
      },
    },
    effect(setup) {
      const disposer = setup()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
}

function makeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

function makeStore({ rows = [], fail } = {}) {
  const calls = { rangeRows: 0 }
  return {
    calls,
    async rangeRows(g, from, to) {
      calls.rangeRows += 1
      if (fail) throw fail
      return rows.filter((row) => row.bucket >= from && row.bucket <= to)
    },
  }
}

function makeCollector({ stateOverrides = {}, rebuilding = false } = {}) {
  const state = {
    running: false,
    total: 0,
    done: 0,
    scannedSessions: 0,
    lastSessionId: undefined,
    error: undefined,
    recordFailures: 0,
    ...stateOverrides,
  }
  const calls = { resetAndRescan: 0 }
  return {
    calls,
    get running() {
      return state.running
    },
    get rebuilding() {
      return rebuilding
    },
    status() {
      return { ...state }
    },
    async resetAndRescan() {
      calls.resetAndRescan += 1
    },
  }
}

function mount({ store, collector, retentionDays, now } = {}) {
  const ctx = makeCtx()
  ctx.webServer = makeWebServer()
  const dispose = registerUsageRoutes(ctx, {
    store: store ?? makeStore(),
    collector: collector ?? makeCollector(),
    retentionDays: retentionDays ?? (() => DEFAULT_MINUTE_RETENTION_DAYS),
    now: now ?? (() => FIXED_NOW),
  })
  return { routes: ctx.webServer.routes, dispose, ctx }
}

function makeReq({ url, method = 'POST', headers = {}, body } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.url = url
  req.headers = headers
  if (body !== undefined) req.push(body)
  req.push(null)
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload
    },
  }
}

async function invoke(routes, path, reqOptions = {}) {
  const route = routes.get(path)
  assert.ok(route, `route ${path} 未注册`)
  const res = makeRes()
  await route.handler(makeReq({ url: path, ...reqOptions }), res)
  return res
}

const invokeJson = (routes, path, { headers, payload, ...rest } = {}) =>
  invoke(routes, path, {
    headers: { ...JSON_HEADERS, ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    ...rest,
  })

// 值经 JSON 线协议传输,undefined 键不出现,按线形态对比
const wireOf = (value) => JSON.parse(JSON.stringify(value))

test('跨源 POST 拒绝 403 forbidden', async () => {
  const { routes } = mount()
  const res = await invoke(routes, PATH_STATUS, {
    headers: { origin: 'http://evil.example', host: LOCAL_HOST },
  })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(parsed, { ok: false, error: { code: 'forbidden', message: parsed.error.message } })
})

test('无 Origin 的 POST 放行', async () => {
  const { routes } = mount()
  const res = await invokeJson(routes, PATH_STATUS, { headers: { host: LOCAL_HOST } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(parsed.ok, true)
})

test('content-type 非 JSON 拒绝 400', async () => {
  const { routes } = mount()
  const res = await invoke(routes, PATH_STATUS, { headers: { 'content-type': 'text/plain' } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 400)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'usage_api_error')
})

test('非 POST 方法拒绝 405', async () => {
  const { routes } = mount()
  const res = await invoke(routes, PATH_STATUS, { method: 'GET' })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 405)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'usage_api_error')
})

test('未知路径 404 not_found', async () => {
  const { routes } = mount()
  const res = await invoke(routes, PATH_STATUS, { url: PATH_UNKNOWN })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 404)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'not_found')
  assert.ok(parsed.error.message.includes(PATH_UNKNOWN))
})

test('回扫进行中 reset 冲突 409 且不触发重建', async () => {
  const collector = makeCollector({ stateOverrides: { running: true, total: 9 } })
  const { routes } = mount({ collector })
  const res = await invokeJson(routes, PATH_RESET)
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 409)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'usage_api_error')
  assert.equal(parsed.error.message, 'usage stats: backfill already running')
  assert.equal(collector.calls.resetAndRescan, 0)
})

test('reset 引发的重建中放行并回状态快照', async () => {
  const collector = makeCollector({ stateOverrides: { running: true, total: 9, done: 2 }, rebuilding: true })
  const { routes } = mount({ collector })
  const res = await invokeJson(routes, PATH_RESET)
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value, wireOf(collector.status()))
  assert.equal(collector.calls.resetAndRescan, 1)
})

test('hours 桶串分量回滚拒绝 400', async () => {
  const { routes } = mount()
  const res = await invokeJson(routes, PATH_HOURS, { payload: { from: '2026-02-01T24', to: '2026-02-02T00' } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 400)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'usage_api_error')
  assert.ok(parsed.error.message.startsWith('usage stats: '))
})

test('hours to 先于 from 拒绝 400', async () => {
  const { routes } = mount()
  const res = await invokeJson(routes, PATH_HOURS, { payload: { from: '2026-02-02T00', to: '2026-02-01T00' } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 400)
  assert.equal(parsed.ok, false)
})

test('range 跨度超上限拒绝 400', async () => {
  const { routes } = mount()
  const from = '2025-01-01'
  const to = new Date(Date.UTC(2025, 0, 1) + (MAX_RANGE_SPAN_DAYS + 1) * DAY_MS).toISOString().slice(0, 10)
  const res = await invokeJson(routes, PATH_RANGE, { payload: { from, to } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 400)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'usage_api_error')
})

test('range 合法请求回 UsageStatsRange 信封', async () => {
  const store = makeStore({
    rows: [
      makeRow({ bucket: '2026-02-01', inputTokens: 1, outputTokens: 2, requests: 1 }),
      makeRow({ bucket: '2026-02-02', outputTokens: 5 }),
    ],
  })
  const { routes } = mount({ store })
  const res = await invokeJson(routes, PATH_RANGE, { payload: { from: '2026-02-01', to: '2026-02-02' } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(parsed.ok, true)
  assert.deepEqual(
    { from: parsed.value.from, to: parsed.value.to, tokens: parsed.value.tokens, daily: parsed.value.daily.map((slot) => slot.day) },
    { from: '2026-02-01', to: '2026-02-02', tokens: 8, daily: ['2026-02-01', '2026-02-02'] },
  )
  assert.equal(store.calls.rangeRows, 1)
})

test('status 回采集快照', async () => {
  const collector = makeCollector({
    stateOverrides: { running: true, total: 5, done: 2, scannedSessions: 7, lastSessionId: 's1', error: 'boom', recordFailures: 1 },
  })
  const { routes } = mount({ collector })
  const res = await invokeJson(routes, PATH_STATUS)
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value, collector.status())
})

test('minutes 超出保留窗口标注 coveredFrom/coveredTo', async () => {
  const { routes } = mount({ retentionDays: () => DEFAULT_MINUTE_RETENTION_DAYS })
  const from = minuteKey(FIXED_NOW - (DEFAULT_MINUTE_RETENTION_DAYS + 1) * DAY_MS)
  const to = minuteKey(FIXED_NOW)
  const res = await invokeJson(routes, PATH_MINUTES, { payload: { from, to } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.coveredFrom, minuteKey(FIXED_NOW - DEFAULT_MINUTE_RETENTION_DAYS * DAY_MS))
  assert.equal(parsed.value.coveredTo, to)
})

test('minutes 禁用保留时标注空 covered', async () => {
  const { routes } = mount({ retentionDays: () => 0 })
  const from = minuteKey(FIXED_NOW - 2 * MINUTE_MS)
  const res = await invokeJson(routes, PATH_MINUTES, { payload: { from, to: minuteKey(FIXED_NOW) } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.coveredFrom, '')
  assert.equal(parsed.value.coveredTo, '')
})

test('请求体缺失 from/to 拒绝 400', async () => {
  const { routes } = mount()
  const res = await invoke(routes, PATH_RANGE, { headers: { ...JSON_HEADERS } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 400)
  assert.equal(parsed.ok, false)
})

test('内部错误 500 不回显内部文本', async () => {
  const store = makeStore({ fail: new Error('secret db path leaked') })
  const { routes, ctx } = mount({ store })
  const res = await invokeJson(routes, PATH_RANGE, { payload: { from: '2026-02-01', to: '2026-02-02' } })
  const parsed = JSON.parse(res.body)
  assert.equal(res.statusCode, 500)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'usage_api_error')
  assert.equal(parsed.error.message, 'internal error')
  assert.ok(!res.body.includes('secret'))
  assert.equal(ctx.logger.warnings.length, 1)
})
