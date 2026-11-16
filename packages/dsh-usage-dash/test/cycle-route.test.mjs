// 计费周期端点契约:缺键不当重置、非对象拒收、未激活回 503,写后回读的窗口跟随新配置。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerUsageRoutes } from '../src/routes.js'
import { CYCLE_DEFAULT } from '../src/cycle.js'

const ROUTE_PREFIX = '/api/usage-dash'
const NOW_MS = Date.parse('2026-11-16T12:00:00+08:00')

function makeCtx() {
  const routes = new Map()
  return {
    routes,
    logger: { warn() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    effect(setup) {
      setup()
    },
  }
}

const makeRes = () => {
  const res = {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      res.statusCode = status
      Object.assign(res.headers, headers ?? {})
    },
    setHeader(name, value) { res.headers[name] = value },
    end(chunk) { res.body = chunk ?? '' },
  }
  return res
}

const makeReq = (method, body, path = `${ROUTE_PREFIX}/cycle`) => ({
  method,
  url: path,
  headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' },
  async *[Symbol.asyncIterator]() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  },
})

const baseDeps = (extra = {}) => ({
  store: { async rangeRows() { return [] }, async sessionRangeRows() { return [] } },
  collector: { running: false, rebuilding: false, status: () => ({}) },
  retentionDays: () => 7,
  pricing: { active: true, rules: () => [], revision: () => 0 },
  now: () => NOW_MS,
  timeZone: 'Asia/Shanghai',
  ...extra,
})

const cycleStub = (overrides = {}) => {
  let current = { ...CYCLE_DEFAULT }
  return {
    active: true,
    config: () => current,
    replace: async (next) => {
      current = { ...CYCLE_DEFAULT, ...(next ?? {}) }
      return current
    },
    ...overrides,
  }
}

test('Given 缺 cycle 根键 When POST Then 400 且不落盘', async () => {
  const ctx = makeCtx()
  let replaced = 0
  registerUsageRoutes(ctx, baseDeps({
    cycle: cycleStub({ replace: async (next) => { replaced += 1; return next } }),
  }))
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('POST', { kind: 'monthly' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error.message, /invalid billing cycle/)
  assert.equal(replaced, 0)
})

test('Given cycle 为标量 When POST Then 400', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, baseDeps({ cycle: cycleStub() }))
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('POST', { cycle: 'monthly' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error.message, /invalid billing cycle/)
})

test('Given cycle 为数组 When POST Then 400', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, baseDeps({ cycle: cycleStub() }))
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('POST', { cycle: [] }), res)
  assert.equal(res.statusCode, 400)
})

test('Given 设置服务未激活 When POST Then 503', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, baseDeps({ cycle: { ...cycleStub(), active: false } }))
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('POST', { cycle: { kind: 'calendar' } }), res)
  assert.equal(res.statusCode, 503)
})

test('Given 写账单日十五号 When POST Then 回读窗口从十五号起', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, baseDeps({ cycle: cycleStub() }))
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('POST', { cycle: { kind: 'monthly', startDay: 15 } }), res)
  assert.equal(res.statusCode, 200)
  const value = JSON.parse(res.body).value
  assert.deepEqual(value.config, { kind: 'monthly', startDay: 15, days: 30 })
  assert.equal(value.window.from, '2026-11-15')
})

test('Given 未提供 cycle 门面 When POST Then 503 而非崩', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, baseDeps())
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('POST', { cycle: { kind: 'calendar' } }), res)
  assert.equal(res.statusCode, 503)
})

test('Given 已激活 When GET Then 回包带 active 与当前窗口', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, baseDeps({ cycle: cycleStub() }))
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 200)
  const value = JSON.parse(res.body).value
  assert.equal(value.active, true)
  assert.deepEqual(value.config, CYCLE_DEFAULT)
  assert.equal(value.window.from, '2026-11-01')
})

test('Given 未激活 When GET Then active 为 false 且给出默认窗口', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, baseDeps())
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('GET'), res)
  assert.equal(res.statusCode, 200)
  const value = JSON.parse(res.body).value
  assert.equal(value.active, false)
  assert.equal(value.window.from, '2026-11-01')
})

test('Given 空请求体 When POST Then 400', async () => {
  const ctx = makeCtx()
  registerUsageRoutes(ctx, baseDeps({ cycle: cycleStub() }))
  const res = makeRes()
  await ctx.routes.get(`${ROUTE_PREFIX}/cycle`).handler(makeReq('POST', undefined), res)
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error.message, /invalid billing cycle/)
})
