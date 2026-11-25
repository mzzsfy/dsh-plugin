import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const alpha = { id: 'XSHG:equity:600519', code: '600519', exchange: 'XSHG' }
const trendTime = Date.parse('2026-11-25T02:00:00Z')
const realCandle = (offset, close = 10) => ({ at: (trendTime + offset) / 1000, open: close, high: close, low: close, close, volume: 100 })
const quoteEntry = (offset, last, extra = {}) => ({
  health: 'ok', quote: {
    securityId: alpha.id, routingRevision: 9, timestampKind: 'trade', sessionState: 'trading',
    quoteAt: new Date(trendTime + offset).toISOString(), receivedAt: trendTime + offset,
    last: String(last), ...extra,
  },
})
const beta = { id: 'XSHE:equity:000001', code: '000001', exchange: 'XSHE' }
const picked = [alpha, beta]
const route = { id: 'a-trend', market: 'XSHG', instrument: 'equity', capability: 'trend' }
const snapshot = { serverEpoch: 'stock-test', routingRevision: 9, routeSelections: { [route.id]: { routeEpoch: 1 } }, control: { revision: 17, routes: [route], watchlist: { order: picked.map(s => s.id), items: Object.fromEntries(picked.map(s => [s.id, s])) }, preferences: { floatRefreshSeconds: 3 } }, quotes: Object.fromEntries(picked.map(s => [s.id, { quote: { sessionState: 'trading' }, health: 'ok' }])) }

function mount(mode, { trendFailure = false, quotes = snapshot.quotes, sessionDate = '2026-11-25', waitForReset = false, gate, candlesFor, snapshotGate } = {}) {
  let plugin, reset, loadSnapshot, holdSnapshot, now = trendTime, serverCandles = [realCandle(0)], serverDate = sessionDate, offline, resultEpoch = 1, currentEpoch = 1, failing = trendFailure
  class Clock extends Date { static now() { return now } }
  const effects = [], refs = [], states = [], prefs = new Map(), intervals = new Map(), requests = []
  let refIndex = 0, stateIndex = 0
  const window = new EventTarget()
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  window.__ModuleLoader__ = { load: entry => { plugin = entry.factory(name => name === 'react' ? {
    ...React,
    useEffect: fn => effects.push(fn),
    // ref 要跨重渲染保留, 否则 lastAttempt 之类的轮询门槛在测试里根本不存在
    useRef: current => { const index = refIndex++; return refs[index] ??= { current } },
    useState: given => {
      const index = stateIndex++
      if (!(index in states)) states[index] = typeof given === 'function' ? given() : given
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useSyncExternalStore: (_, read) => read(),
  } : {}) } }
  const localStorage = {
    getItem: key => key === 'ssb-floating' ? JSON.stringify({ open: true, live: true, mode, ...(prefs.get(key) || {}) }) : prefs.get(key) ?? null,
    setItem: (key, value) => prefs.set(key, JSON.parse(value)),
  }
  const fetch = async (url, options) => {
    requests.push({ url, options })
    if (url.includes('period=trend')) {
      const attempt = requests.filter(r => r.url.includes('period=trend')).length
      const epochAtStart = resultEpoch
      if (waitForReset && attempt === 1) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
      if (failing && attempt > 1) return { ok: false, json: async () => ({ ok: false, error: { code: 'RATE_LIMIT', message: '分时额度受限' } }) }
      if (gate) {
        const wait = typeof gate === 'function' ? gate(attempt) : gate
        if (wait) await wait
      }
      const candles = candlesFor ? candlesFor(attempt) : null
      return { ok: true, json: async () => ({ ok: true, data: { ...snapshot, routeEpoch: epochAtStart, sessionDate: candlesFor ? sessionDate : serverDate, candles: candles ?? serverCandles, offline } }) }
    }
    const atRead = currentEpoch
    if (url.endsWith('/snapshot') && snapshotGate) await snapshotGate
    if (url.endsWith('/snapshot') && holdSnapshot) {
      const wait = holdSnapshot
      holdSnapshot = null
      await wait
    }
    // 快照屏障用例要模拟“等待期间又发布了新代次”: 响应按释放时的代次；普通读取仍按发起时
    const readEpoch = snapshotGate ? currentEpoch : atRead
    return { ok: true, json: async () => ({ ok: true, data: { ...snapshot, quotes, routeSelections: { [route.id]: { routeEpoch: readEpoch } } } }) }
  }
  const setInterval = (fn, delay) => { intervals.set(fn, delay); return fn }
  vm.runInNewContext(source, { window, document, localStorage, console, fetch, AbortController, URLSearchParams, Date: Clock, setTimeout, clearTimeout, setInterval, clearInterval: fn => intervals.delete(fn), crypto: globalThis.crypto })
  const runtime = plugin.__testing.createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} } },
    bus: { subscribe: (_, { onReset }) => { reset = onReset; return () => {} }, publish() {} },
    tools: { createSnapshotRefresh: load => { loadSnapshot = load; return { refresh() {}, dispose() {} } } },
    document, fetch,
  })
  runtime.applySnapshot({ ...snapshot, quotes })
  const render = () => { refIndex = 0; stateIndex = 0; plugin.__testing.FloatingTicker({ runtime }) }
  render()
  const stops = effects.splice(0).map(run => run())
  let cleanups = stops
  // 模拟一次重渲染: 先清理上一轮 effect, 再启动这一轮的; 不立即清理, 否则定时器/订阅等于没建立
  function rerun() { cleanups.forEach(fn => fn?.()); cleanups = []; render(); cleanups = effects.splice(0).map(run => run()) }
  function setQuote(entry) {
    runtime.applySnapshot({ ...snapshot, quotes: { [alpha.id]: entry } })
    rerun()
  }
  function setQuotes(nextQuotes, revision = snapshot.routingRevision) {
    runtime.applySnapshot({ ...snapshot, routingRevision: revision, quotes: nextQuotes })
    rerun()
  }
  // 换观测目标: 走真实偏好写入与 ssb-floating 事件, 模拟用户重新勾选
  function setPickedIds(ids) {
    localStorage.setItem('ssb-floating', JSON.stringify({ open: true, live: true, mode, ids }))
    window.dispatchEvent(new Event('ssb:ssb-floating'))
    rerun()
  }
  return { requests, intervals, document, runtime, reset: () => reset(), holdRead() {
    let release
    holdSnapshot = new Promise(resolve => { release = resolve })
    return { pending: loadSnapshot(), release }
  }, setEpoch(response, current) { resultEpoch = response; currentEpoch = current }, setFailing(next) { failing = next }, setQuote, setQuotes, setPickedIds, setReal(candles, day = sessionDate, fallback) { serverCandles = candles; serverDate = day; offline = fallback }, advance(ms) { now += ms }, stop() { cleanups.forEach(fn => fn?.()); runtime.dispose() } }
}

test('图形盯盘按报价间隔自动刷新所有已选标的，并传报价路由版本', async t => {
  const page = mount('kline')
  t.after(() => page.stop())
  const quoteRequests = () => page.requests.filter(({ url }) => url.endsWith('/refresh')).map(({ options }) => JSON.parse(options.body))
  assert.deepEqual(quoteRequests(), [{ automatic: true, expectedRoutingRevision: 9, securities: picked }])
  await new Promise(resolve => setImmediate(resolve))
  const beat = [...page.intervals].find(([, delay]) => delay === 3 * 1000)?.[0]
  assert.equal(typeof beat, 'function')
  page.advance(3 * 1000)
  beat()
  assert.equal(quoteRequests().length, 2)
  await new Promise(resolve => setImmediate(resolve))
  page.document.visibilityState = 'hidden'
  page.advance(3 * 1000)
  beat()
  assert.equal(quoteRequests().length, 2)
})

const trendRequests = page => page.requests.filter(r => r.url.includes('period=trend'))
const flush = () => new Promise(resolve => setImmediate(resolve))

test('详情与浮窗复用同一在途分时和同分钟缓存', async t => {
  const page = mount('kline')
  t.after(() => page.stop())
  const detail = await page.runtime.loadKline(alpha.id, 'trend')
  assert.equal(detail.candles[0].close, 10)
  assert.equal(trendRequests(page).length, 1, '打开详情不另发请求')
  await page.runtime.loadKline(alpha.id, 'trend', true)
  assert.equal(trendRequests(page).length, 1, '同分钟手动刷新也不另发请求')
})

test('校准失败保留同证券分时及失败原因，窗口内避免再打一次', async t => {
  const page = mount('kline', { trendFailure: true })
  t.after(() => page.stop())
  await flush()
  await page.runtime.loadKline(alpha.id, 'trend')
  page.advance(60 * 1000)
  const failed = await page.runtime.loadKline(alpha.id, 'trend', true)
  assert.equal(failed.candles[0].close, 10)
  assert.match(failed.error, /分时额度受限/)
  await page.runtime.loadKline(alpha.id, 'trend', true)
  assert.equal(trendRequests(page).length, 2)
})

test('报价补点同分钟覆盖，随后只丢弃真正被校准覆盖的尾部', async t => {
  const page = mount('kline')
  t.after(() => page.stop())
  await flush()
  page.advance(10_000)
  page.setQuote(quoteEntry(10_000, 11))
  const line = () => page.runtime.getKlineResult(alpha.id, 'trend').candles
  assert.deepEqual(Array.from(line(), c => c.close), [11])
  assert.equal(line()[0].volume, 100)
  page.advance(55_000)
  page.setQuote(quoteEntry(65_000, 12))
  page.advance(5_000)
  page.setQuote(quoteEntry(70_000, 13))
  page.advance(60_000)
  page.setQuote(quoteEntry(130_000, 14))
  assert.deepEqual(Array.from(line(), c => c.close), [11, 13, 14])
  assert.equal(line()[1].open, undefined)
  assert.equal(line()[1].volume, undefined)
  page.setReal([realCandle(0, 10.5), realCandle(60_000, 12.5)])
  await page.runtime.loadKline(alpha.id, 'trend')
  assert.deepEqual(Array.from(line(), c => c.close), [10.5, 12.5, 14])
})

test('校准重复已知真实分时柱时不回退该分钟内更晚的报价', async t => {
  const page = mount('kline')
  t.after(() => page.stop())
  await flush()
  page.advance(10_000)
  page.setQuote(quoteEntry(10_000, 11))
  page.advance(50_000)
  assert.equal((await page.runtime.loadKline(alpha.id, 'trend')).candles.at(-1).close, 11)
})

test('新请求只有空数据或更旧交易日时保留已加载的真实分时', async t => {
  const page = mount('kline')
  t.after(() => page.stop())
  await flush()
  page.setReal([])
  page.advance(60_000)
  assert.equal((await page.runtime.loadKline(alpha.id, 'trend')).candles[0]?.close, 10)
  page.setReal([realCandle(-24 * 60 * 60_000, 5)], '2026-11-24')
  page.advance(60_000)
  assert.equal((await page.runtime.loadKline(alpha.id, 'trend')).candles[0]?.close, 10)
})

test('首次离线结果保留服务端报价尾部，但只展示收盘价', async t => {
  const page = mount('list')
  t.after(() => page.stop())
  page.setReal([realCandle(0), realCandle(60_000, 12)], '2026-11-25', { appended: 1, reason: '限流' })
  const trend = await page.runtime.loadKline(alpha.id, 'trend')
  assert.deepEqual(Array.from(trend.candles, candle => candle.close), [10, 12])
  assert.equal(trend.candles.at(-1).open, undefined)
  assert.equal(trend.candles.at(-1).volume, undefined)
  assert.equal(trend.offline.appended, 1)
})

test('同轮分时降级代次经最新快照确认后展示结果', async t => {
  const page = mount('list')
  t.after(() => page.stop())
  page.setEpoch(2, 2)
  const result = await page.runtime.loadKline(alpha.id, 'trend')
  assert.equal(result.candles[0].close, 10)
  assert.equal(page.runtime.getSnapshot().data.routeSelections[route.id].routeEpoch, 2)
  assert.equal(trendRequests(page).length, 1)
})

test('确认较新路由时，切源前在飞的旧快照结束后再确认一次', async t => {
  const page = mount('kline')
  t.after(() => page.stop())
  await flush()
  page.advance(60_000)
  const oldRead = page.holdRead()
  page.setEpoch(2, 2)
  const refreshed = page.runtime.loadKline(alpha.id, 'trend')
  await flush()
  assert.equal(page.requests.filter(r => r.url.endsWith('/snapshot')).length, 1)
  oldRead.release()
  await oldRead.pending
  assert.equal((await refreshed).routeEpoch, 2)
  assert.equal(page.requests.filter(r => r.url.endsWith('/snapshot')).length, 2)
})

test('同分钟更早的本地报价不能覆盖离线补点，重复校准保留点数', async t => {
  const page = mount('kline')
  t.after(() => page.stop())
  await flush()
  page.advance(72_000)
  page.setReal([realCandle(0), realCandle(72_000, 12)], '2026-11-25', { appended: 1, reason: '已离线' })
  await page.runtime.loadKline(alpha.id, 'trend')
  page.setQuote(quoteEntry(68_000, 11))
  let trend = page.runtime.getKlineResult(alpha.id, 'trend')
  assert.equal(trend.candles.at(-1).close, 12)
  page.advance(60_000)
  trend = await page.runtime.loadKline(alpha.id, 'trend')
  assert.equal(trend.offline.appended, 1)
})

test('总线重置取消首次分时以后可以重新初始化', async t => {
  const page = mount('list', { waitForReset: true })
  t.after(() => page.stop())
  const first = page.runtime.loadTrend(alpha.id)
  page.reset()
  await first
  page.advance(60_000)
  const loaded = await page.runtime.loadTrend(alpha.id)
  assert.equal(loaded.candles[0].close, 10)
  assert.equal(trendRequests(page).length, 2)
})

test('切换分时来源立即取新源数据，不一分钟内复用旧图', async t => {
  const page = mount('kline')
  t.after(() => page.stop())
  await flush()
  assert.equal(page.runtime.getTrend(alpha.id).candles[0].close, 10)
  page.setEpoch(2, 2)
  page.runtime.applySnapshot({ ...snapshot, routeSelections: { [route.id]: { routeEpoch: 2 } } })
  const switched = await page.runtime.loadKline(alpha.id, 'trend', true)
  assert.equal(switched.routeEpoch, 2)
  assert.equal(trendRequests(page).length, 2)
})

test('分时在飞时换源，旧请求作废并立即取新源', async t => {
  const { promise, resolve } = Promise.withResolvers()
  const page = mount('kline', { gate: attempt => attempt === 1 ? promise : null })
  t.after(() => { resolve(); page.stop() })
  const first = page.runtime.loadTrend(alpha.id)
  await flush()
  page.setEpoch(2, 2)
  page.runtime.applySnapshot({ ...snapshot, routeSelections: { [route.id]: { routeEpoch: 2 } } })
  const second = page.runtime.loadTrend(alpha.id)
  await flush()
  assert.equal(trendRequests(page).length, 2, '换源不等待旧请求')
  resolve()
  const trend = await second
  assert.equal(trend.routeEpoch, 2)
  assert.equal(page.runtime.getTrend(alpha.id).routeEpoch, 2)
  await first
})

test('换源期间旧请求等到快照确认后也不得覆盖新请求结果', async t => {
  const gate = Promise.withResolvers()
  const page = mount('kline', { snapshotGate: gate.promise, candlesFor: attempt => [realCandle(0, attempt === 2 ? 5 : 20)] })
  t.after(() => { gate.resolve(); page.stop() })
  await flush()
  page.advance(60_000)
  // A 的响应带新代次 2，但页面快照还停在 1: 它会卡在快照二次确认
  page.setEpoch(2, 1)
  const first = page.runtime.loadTrend(alpha.id)
  await flush()
  // A 等待快照期间页面换源并启动 B，B 返回新价格
  page.setEpoch(2, 2)
  page.runtime.applySnapshot({ ...snapshot, routeSelections: { [route.id]: { routeEpoch: 2 } } })
  const second = page.runtime.loadTrend(alpha.id)
  await flush()
  assert.equal(trendRequests(page).length, 3)
  gate.resolve()
  assert.equal((await second).candles[0].close, 20)
  await first
  await flush()
  assert.equal(page.runtime.getTrend(alpha.id).candles[0].close, 20, '旧请求不得把旧收盘价写回')
})

test('陈旧、休市、没有市场当日真实分时的报价都不能续点', async t => {
  const page = mount('kline')
  const old = mount('kline', { sessionDate: '2026-11-24' })
  t.after(() => { old.stop(); page.stop() })
  await flush()
  page.advance(180_000)
  page.setQuote(quoteEntry(120_000, 11, { receivedAt: trendTime + 180_000 }))
  page.setQuote(quoteEntry(180_000, 12, { sessionState: 'closed' }))
  old.advance(180_000)
  old.setQuote(quoteEntry(180_000, 13))
  for (const scenario of [page, old]) assert.deepEqual(Array.from(scenario.runtime.getKlineResult(alpha.id, 'trend').candles, c => c.close), [10])
})

test('详情重开超过一分钟要重新校准，不拿上一轮旧图顶替', async t => {
  const page = mount('list')
  t.after(() => page.stop())
  await page.runtime.loadTrend(alpha.id)
  page.advance(61_000)
  const reopened = await page.runtime.loadTrend(alpha.id)
  assert.equal(trendRequests(page).length, 2)
  assert.equal(reopened.candles[0].close, 10)
})

test('分时错误态的重试立即再取一次，不被上一轮窗口挡住', async t => {
  const page = mount('list', { trendFailure: true })
  t.after(() => page.stop())
  const first = await page.runtime.loadTrend(alpha.id)
  assert.equal(first.candles[0].close, 10)
  page.advance(61_000)
  const failed = await page.runtime.loadTrend(alpha.id)
  assert.match(failed.error, /分时额度受限/)
  page.setFailing(false)
  const retried = await page.runtime.retryTrend(alpha.id)
  assert.equal(trendRequests(page).length, 3, '重试不受客户端窗口拦截')
  assert.equal(retried.error, '')
  assert.equal(retried.candles[0].close, 10)
})

test('校准窗口从上一轮结束起算，慢响应不会把下次回源挤到两分钟', async t => {
  const { promise, resolve } = Promise.withResolvers()
  const page = mount('list', { gate: promise })
  t.after(() => { resolve(); page.stop() })
  const first = page.runtime.loadTrend(alpha.id)
  page.advance(30_000)
  resolve()
  await first
  assert.ok(page.runtime.trendDelay(alpha.id) >= 59_000, '结束后仍守满一分钟')
})

test('休市时换观测目标立即取数，不沿用上一轮的等待档', async t => {
  const closed = Object.fromEntries(picked.map(s => [s.id, { quote: { sessionState: 'closed' }, health: 'ok' }]))
  const page = mount('list', { quotes: closed })
  t.after(() => page.stop())
  await flush()
  const refreshes = () => page.requests.filter(({ url }) => url.endsWith('/refresh'))
  assert.equal(refreshes().length, 1)
  page.setPickedIds([beta.id])
  await flush()
  assert.equal(refreshes().length, 2, '换目标立即取一次报价')
  assert.deepEqual(JSON.parse(refreshes()[1].options.body).securities, [beta])
})
