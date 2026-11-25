import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { eastmoney } from '../src/providers/eastmoney.mjs'
import { tencent } from '../src/providers/tencent.mjs'
import { initialControl } from '../src/schemas.mjs'
import { memoryStorage, provider } from './helpers.mjs'

const MINUTE = 60 * 1000
const SECURITY = 'XSHG:equity:600519'
const BASE_TIME = Date.parse('2026-11-16T02:00:00Z')

async function setup(t, { now = BASE_TIME, respond, adapter: upstream, providers, credentials, fallback = false } = {}) {
  const calls = [], storage = memoryStorage(), control = initialControl()
  const adapter = upstream ?? {
    descriptor: { adapterId: 'fake', capabilities: ['trend'], markets: ['XSHG'], instruments: ['equity'] },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async trend(request, ctx) {
      const response = await ctx.fetch(`https://fixture.invalid/trend/${request.code}?limit=${request.limit}&source=${request.providerInstanceId}`, { signal: ctx.signal })
      return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), preClose: 10, ...response }
    },
  }
  control.providers = providers ?? [{ ...provider('fixture-one', adapter.descriptor.adapterId), credentialRef: null }]
  if (fallback) control.providers.push({ ...control.providers[0], id: 'fixture-spare', quotaGroup: 'spare' })
  control.routes = [{ id: 'xshg-trend', capability: 'trend', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'fixture-one', fallbackInstanceIds: fallback ? ['fixture-spare'] : [], failoverMode: fallback ? 'network' : 'off', maxDelaySeconds: null, acceptUnknownDelay: true }]
  storage.maps.control.set('root', control)
  const app = await createApplication({ storageDomain: storage, providers: [adapter], credentials, env: {}, now: () => now, fetch: async (url, { signal }) => {
    calls.push({ url, signal, at: now })
    const close = calls.length + 10
    const candle = { time: '10:00', at: Math.floor(now / 1000), open: close, high: close, low: close, close }
    return respond ? respond({ calls, signal, candle }) : { complete: true, candles: [candle] }
  } })
  t.after(() => app.close())
  const request = (input = {}, signal) => app.kline({ securityId: SECURITY, period: 'trend', limit: 250, ...input }, signal)
  return { request, calls, storage, advance: ms => { now += ms }, app }
}

const cancelled = error => error.code === 'CANCELLED'
const beforeMinute = MINUTE - 1

test('同一分时键在一分钟内复用完整响应，强刷也不回源，到期只新发一轮', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t)
  const first = await request()
  assert.equal(first.candles[0].close, 11)
  assert.equal(typeof first.serverEpoch, 'string')
  assert.equal(first.routingRevision, 0)
  assert.equal(first.routeEpoch, 0)
  assert.equal(first.sessionDate, '2026-11-16')
  advance(beforeMinute)
  assert.deepEqual(await request({ force: '1' }), first)
  assert.equal(calls.length, 1)
  advance(1)
  assert.equal((await request()).candles[0].close, 12)
  assert.equal(calls.length, 2)
})

test('慢分时请求完成后仍守足一分钟，避免排队缩短物理回源间隔', { timeout: 2000 }, async t => {
  const { promise: started, resolve: start } = Promise.withResolvers()
  const { promise: ready, resolve } = Promise.withResolvers()
  const { request, calls, advance } = await setup(t, { respond: async ({ candle }) => { start(); await ready; return { complete: true, candles: [candle] } } })
  const first = request()
  await started
  advance(3 * 1000)
  resolve()
  assert.equal((await first).candles[0].close, 11)
  advance(beforeMinute)
  assert.equal((await request()).candles[0].close, 11)
  assert.equal(calls.length, 1)
  advance(1)
  assert.equal((await request()).candles[0].close, 12)
})

test('同键并发合成一轮，取消首个调用者后第二个仍返回结果', { timeout: 2000 }, async t => {
  const { promise: started, resolve: start } = Promise.withResolvers()
  const { promise: ready, resolve } = Promise.withResolvers()
  const { request, calls, advance } = await setup(t, { respond: async ({ candle }) => { start(); await ready; return { complete: true, candles: [candle] } } })
  const firstCaller = new AbortController()
  const first = request({}, firstCaller.signal)
  await started
  advance(1000)
  const second = request({ force: '1' })
  firstCaller.abort()
  resolve()
  await assert.rejects(first, cancelled)
  assert.equal(calls[0].signal.aborted, false)
  assert.equal((await second).candles[0].close, 11)
  assert.equal(calls.length, 1)
})

test('最后一个调用者取消才中止上游，共享请求能在下一窗口重建', { timeout: 2000 }, async t => {
  const { promise: started, resolve: start } = Promise.withResolvers()
  const { request, calls, advance } = await setup(t, { respond: ({ signal, candle, calls }) => {
    if (calls.length > 1) return { complete: true, candles: [candle] }
    start()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const a = new AbortController(), b = new AbortController()
  const first = request({}, a.signal), second = request({}, b.signal)
  const firstCancelled = assert.rejects(first, cancelled), secondCancelled = assert.rejects(second, cancelled)
  await started
  a.abort()
  await firstCancelled
  assert.equal(calls[0].signal.aborted, false)
  b.abort()
  await secondCancelled
  assert.equal(calls[0].signal.aborted, true)
  advance(beforeMinute)
  await assert.rejects(request({ force: '1' }), { code: 'RATE_LIMIT' })
  assert.equal(calls.length, 1)
  advance(1)
  assert.equal((await request()).candles[0].close, 12)
  assert.equal(calls.length, 2)
})

test('关闭应用释放在飞分时请求及多个等待者', { timeout: 2000 }, async t => {
  const { promise: started, resolve: start } = Promise.withResolvers()
  const { request, calls, app } = await setup(t, { respond: ({ signal }) => {
    start()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const first = assert.rejects(request(), cancelled)
  const second = assert.rejects(request(), cancelled)
  await started
  await app.close()
  await Promise.all([first, second])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal.aborted, true)
})

test('空分时结果同样守一分钟窗口，下一窗口重新取数', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t, { respond: ({ candle, calls }) => ({ complete: true, candles: calls.length === 1 ? [] : [candle] }) })
  assert.deepEqual((await request()).candles, [])
  advance(beforeMinute)
  assert.deepEqual((await request()).candles, [])
  assert.equal(calls.length, 1)
  advance(1)
  assert.equal((await request()).candles[0].close, 12)
})

test('上游限流的 Retry-After 长于分钟窗口时，窗口内不再打上游', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t, { respond: ({ candle, calls }) => calls.length === 1 ? new Response(null, { status: 429, headers: { 'Retry-After': '120' } }) : { complete: true, candles: [candle] } })
  await assert.rejects(request(), { code: 'RATE_LIMIT', retryAfterMs: 2 * MINUTE })
  advance(MINUTE)
  await assert.rejects(request({ force: '1' }), { code: 'RATE_LIMIT', retryAfterMs: MINUTE })
  assert.equal(calls.length, 1)
  advance(MINUTE)
  assert.equal((await request()).candles[0].close, 12)
})

test('真实分时适配器将 HTTP Retry-After 传入窗口', { timeout: 2000 }, async t => {
  for (const adapter of [eastmoney, tencent]) {
    const { request, calls, advance } = await setup(t, { adapter, respond: () => new Response(null, {
      status: 429,
      headers: { 'Retry-After': adapter === eastmoney ? '120' : new Date(BASE_TIME + 2 * MINUTE).toUTCString() },
    }) })
    await assert.rejects(request(), { code: 'RATE_LIMIT', retryAfterMs: 2 * MINUTE })
    advance(MINUTE)
    await assert.rejects(request(), { code: 'RATE_LIMIT', retryAfterMs: MINUTE })
    assert.equal(calls.length, 1)
  }
})

test('HTTP 503 的 Retry-After 同样延长分时冷却', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t, { adapter: eastmoney, respond: () => new Response(null, { status: 503, headers: { 'Retry-After': '120' } }) })
  await assert.rejects(request(), { code: 'RATE_LIMIT', retryAfterMs: 2 * MINUTE })
  advance(MINUTE)
  await assert.rejects(request(), { code: 'RATE_LIMIT', retryAfterMs: MINUTE })
  assert.equal(calls.length, 1)
})

test('分时主源限流时同一轮切到备源', { timeout: 2000 }, async t => {
  const { request, calls } = await setup(t, {
    fallback: true,
    respond: ({ calls, candle }) => calls.at(-1).url.includes('source=fixture-one')
      ? new Response(null, { status: 429, headers: { 'Retry-After': '600' } })
      : { complete: true, candles: [candle] },
  })
  const result = await request()
  assert.equal(result.providerInstanceId, 'fixture-spare')
  assert.equal(calls.length, 2, '主源 429 后备源当轮出数')
})

test('超长 Retry-After 按一小时封顶', { timeout: 2000 }, async t => {
  const { request } = await setup(t, { respond: () => new Response(null, { status: 429, headers: { 'Retry-After': '86400' } }) })
  await assert.rejects(request(), { code: 'RATE_LIMIT', retryAfterMs: 60 * 60 * 1000 })
})

test('关闭时凭据尚未解析也能立即释放同键与排队请求', { timeout: 2000 }, async t => {
  const { promise: resolving, resolve: start } = Promise.withResolvers()
  const { promise: pending, resolve } = Promise.withResolvers()
  let reads = 0
  t.after(() => resolve({ value: 'secret' }))
  const { request, calls, app } = await setup(t, {
    providers: [{ ...provider('fixture-one', 'fake'), credentialRef: 'FIXTURE_TOKEN' }],
    credentials: { set() {}, unset() {}, resolve() { if (++reads === 1) return { value: 'secret' }; start(); return pending } },
  })
  const first = assert.rejects(request(), cancelled)
  const second = assert.rejects(request(), cancelled)
  const queued = assert.rejects(request({ limit: 500 }), cancelled)
  await resolving
  await app.close()
  await Promise.race([
    Promise.all([first, second, queued]),
    new Promise((_, reject) => setImmediate(() => reject(new Error('关闭后凭据仍阻塞调用者')))),
  ])
  assert.equal(calls.length, 0)
})

test('最后一个调用者取消时释放等待凭据占住的同额度组执行槽', { timeout: 2000 }, async t => {
  const { promise: resolving, resolve: start } = Promise.withResolvers()
  const { promise: pending, resolve } = Promise.withResolvers()
  let reads = 0
  t.after(() => resolve({ value: 'secret' }))
  const { request, calls, advance } = await setup(t, {
    providers: [{ ...provider('fixture-one', 'fake'), credentialRef: 'FIXTURE_TOKEN' }],
    credentials: { set() {}, unset() {}, resolve() { if (++reads !== 2) return { value: 'secret' }; start(); return pending } },
  })
  const caller = new AbortController()
  const first = assert.rejects(request({}, caller.signal), cancelled)
  await resolving
  caller.abort()
  await first
  advance(1000)
  const follower = request({ limit: 500 })
  const result = await Promise.race([
    follower,
    new Promise((_, reject) => setImmediate(() => reject(new Error('取消后凭据仍阻塞同额度组')))),
  ])
  assert.equal(result.candles[0].close, 11)
  assert.equal(calls.length, 1)
})

test('网络失败在一分钟内只触一次上游', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t, { respond: ({ candle, calls }) => {
    if (calls.length === 1) throw new Error('上游断开')
    return { complete: true, candles: [candle] }
  } })
  await assert.rejects(request(), { code: 'NETWORK' })
  advance(beforeMinute)
  await assert.rejects(request(), { code: 'NETWORK' })
  assert.equal(calls.length, 1)
  advance(1)
  assert.equal((await request()).candles[0].close, 12)
})

test('路由配置换代或 limit 不同不会复用旧分时响应', { timeout: 2000 }, async t => {
  const { request, calls, advance, storage } = await setup(t)
  assert.equal((await request()).candles[0].close, 11)
  advance(1000)
  assert.equal((await request({ limit: 500 })).candles[0].close, 12)
  const control = storage.maps.control.get('root')
  storage.maps.control.set('root', { ...control, routingRevision: control.routingRevision + 1 })
  advance(1000)
  assert.equal((await request()).candles[0].close, 13)
  assert.equal(calls.length, 3)
})

test('路由来源换代立即失效，并返回新代次', { timeout: 2000 }, async t => {
  const { request, calls, advance, app } = await setup(t)
  const first = await request()
  assert.equal(first.routeEpoch, 0)
  advance(1000)
  await app.routeSelection({ routeId: 'xshg-trend', target: 'primary', expectedRoutingRevision: 0, expectedRouteEpoch: 0 })
  advance(1000)
  const second = await request()
  assert.equal(second.routeEpoch, 1)
  assert.equal(second.routingRevision, first.routingRevision)
  assert.equal(second.candles[0].close, 12)
  assert.equal(calls.length, 2)
})

test('在飞来源旧于手动换代时，旧响应被丢弃', { timeout: 2000 }, async t => {
  const { promise: started, resolve: start } = Promise.withResolvers()
  const { promise: ready, resolve } = Promise.withResolvers()
  const { request, calls, advance, app } = await setup(t, { respond: async ({ candle }) => { start(); await ready; return { complete: true, candles: [candle] } } })
  const old = assert.rejects(request(), { code: 'ROUTE_CONFLICT' })
  await started
  advance(1000)
  await app.routeSelection({ routeId: 'xshg-trend', target: 'primary', expectedRoutingRevision: 0, expectedRouteEpoch: 0 })
  resolve()
  await old
  advance(1000)
  assert.equal((await request()).routeEpoch, 1)
  assert.equal(calls.length, 2)
})

test('同轮自动降级的备源结果挂到新代次，后续请求复用', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t, { fallback: true, respond: ({ calls, candle }) => {
    if (calls.at(-1).url.endsWith('source=fixture-one')) throw new Error('主源断开')
    return { complete: true, candles: [candle] }
  } })
  for (let i = 0; i < 2; i++) {
    assert.equal((await request()).routeEpoch, 0)
    advance(MINUTE)
  }
  const switched = await request()
  assert.equal(switched.routeEpoch, 1)
  assert.equal(switched.source, 'fixture-spare')
  advance(1000)
  assert.deepEqual(await request({ force: '1' }), switched)
  assert.equal(calls.length, 6, '三轮分别尝试主源及备源，没有第四轮')
})

test('同轮自动降级后备源也失败时保留上游错误和新代次冷却', { timeout: 2000 }, async t => {
  const { request, calls, advance, app } = await setup(t, { fallback: true, respond: () => { throw new Error('来源断开') } })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(request(), { code: 'NETWORK' })
    advance(MINUTE)
  }
  await assert.rejects(request(), { code: 'NETWORK' })
  assert.equal(app.snapshot().routeSelections['xshg-trend'].routeEpoch, 1)
  advance(1000)
  await assert.rejects(request({ force: '1' }), { code: 'NETWORK' })
  assert.equal(calls.length, 6)
})

test('市场日期切换立即清除上一交易日的分时热缓存', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t, { now: Date.parse('2026-11-16T15:59:58Z') })
  assert.equal((await request()).candles[0].close, 11)
  advance(2 * 1000)
  assert.equal((await request()).candles[0].close, 12)
  assert.equal(calls.length, 2)
})

test('不完整分时不作为热缓存或离线数据重放，且一分钟内不增加回源', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t, { respond: ({ candle }) => ({ complete: false, candles: [candle] }) })
  assert.equal((await request()).complete, false)
  advance(1000)
  await assert.rejects(request(), { code: 'RATE_LIMIT' })
  assert.equal(calls.length, 1)
})

test('盘前拿到上一交易日完整分时时，窗口内复用而不是报限流', { timeout: 2000 }, async t => {
  const { request, calls, advance } = await setup(t, { respond: ({ candle }) => ({ complete: true, candles: [{ ...candle, at: candle.at - 24 * 60 * 60 }] }) })
  const first = await request()
  assert.equal(first.sessionDate, '2026-11-15')
  advance(1000)
  assert.deepEqual(await request(), first)
  assert.equal(calls.length, 1)
})

test('换源后当日真实分时仍能用于离线兜底', { timeout: 3000 }, async t => {
  const { request, calls, advance } = await setup(t, { fallback: true, respond: ({ calls }) => {
    if (calls.length === 1) return { complete: true, candles: [{ time: '10:00', at: Math.floor(BASE_TIME / 1000), close: 10.5 }] }
    throw new Error('来源断开')
  } })
  const live = await request()
  assert.equal(live.routeEpoch, 0)
  const rounds = []
  for (let i = 0; i < 3; i++) {
    advance(MINUTE)
    rounds.push(await request())
  }
  assert.deepEqual(rounds.map(result => result.routeEpoch), [0, 0, 1], '第三轮失败后已经切到备源')
  for (const result of rounds) {
    assert.equal(result.offline.kind, 'cache')
    assert.equal(result.candles.at(-1).close, 10.5, '缓存来自换源前的当日真实分时')
  }
})
