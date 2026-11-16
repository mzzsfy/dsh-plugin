import test from 'node:test'
import assert from 'node:assert/strict'
import { MARKET_META, marketDate, marketStateOf } from '../src/market-model.mjs'
import { createCatalog } from '../src/catalog.mjs'
import { openState } from '../src/state.mjs'
import { memoryStorage } from './helpers.mjs'

const at = iso => Date.parse(iso)
// 各市场本地交易日上午的 UTC 时刻
const TRADING_AT = {
  XSHG: '2026-11-06T02:00:00Z',
  XSHE: '2026-11-06T02:00:00Z',
  XHKG: '2026-11-06T02:00:00Z',
  XNAS: '2026-11-06T15:00:00Z',
  XNYS: '2026-11-06T15:00:00Z',
  XJPX: '2026-11-06T01:00:00Z',
  XKRX: '2026-11-06T01:00:00Z',
  XLON: '2026-11-06T09:00:00Z',
}

test('P2-52 八市场按自身时区判定交易中', () => {
  assert.deepEqual(Object.keys(MARKET_META), Object.keys(TRADING_AT), '八市场全覆盖')
  for (const [market, stamp] of Object.entries(TRADING_AT)) assert.equal(marketStateOf(market, at(stamp)).state, 'trading', `${market} 应处于交易中`)
})

test('P2-51 八市场周末休市且 nextAt 指向下周一开盘, 不再是未知', () => {
  const saturday = at('2026-11-07T02:00:00Z')
  for (const market of Object.keys(MARKET_META)) {
    const state = marketStateOf(market, saturday)
    assert.equal(state.state, 'closed', `${market} 周末休市`)
    assert.ok(Number.isFinite(state.nextAt) && state.nextAt > saturday, `${market} 必须给出下一次开盘时刻`)
    assert.equal(marketDate(market, state.nextAt), '2026-11-09', `${market} 的 nextAt 必须落在下周一`)
  }
})

test('P2-52 各市场本地时段: 港股午休/开盘前/收盘后', () => {
  assert.deepEqual(marketStateOf('XHKG', at('2026-11-06T04:00:00Z')), { state: 'break', nextAt: at('2026-11-06T05:00:00Z') })
  assert.deepEqual(marketStateOf('XHKG', at('2026-11-06T00:30:00Z')), { state: 'preopen', nextAt: at('2026-11-06T01:30:00Z') })
  assert.equal(marketStateOf('XHKG', at('2026-11-06T08:30:00Z')).state, 'closed')
  // 沪深集合竞价沿用原有语义
  assert.equal(marketStateOf('XSHG', at('2026-11-06T01:20:00Z')).state, 'auction')
})

test('P2-52 交易日历分支按市场时区与 sessions 计算, 不再套 A 股 09:15', () => {
  const days = new Map([['2026-11-06', false], ['2026-11-09', true]])
  // 纽约 2026-11-06 10:00 EST 被日历判为休市 -> 下个交易日 09:30 EST
  const us = marketStateOf('XNAS', at('2026-11-06T15:00:00Z'), days)
  assert.deepEqual(us, { state: 'closed', nextAt: at('2026-11-09T14:30:00Z') })
  // 伦敦日历休市 -> 下个交易日 08:00 GMT
  const london = marketStateOf('XLON', at('2026-11-06T09:00:00Z'), days)
  assert.deepEqual(london, { state: 'closed', nextAt: at('2026-11-09T08:00:00Z') })
})

test('P2-52 八市场日历分支: 开市可交易, 休市顺延', () => {
  for (const [market, stamp] of Object.entries(TRADING_AT)) {
    const time = at(stamp), date = marketDate(market, time)
    assert.equal(marketStateOf(market, time, new Map([[date, true]])).state, 'trading', `${market} 日历开市`)
    const closed = marketStateOf(market, time, new Map([[date, false]]))
    assert.equal(closed.state, 'closed', `${market} 日历休市`)
    assert.ok(closed.nextAt > time, `${market} 休市后给出下一次开盘`)
  }
})

test('P2-51/P2-62 catalog.marketState 无日历时给 nextAt, 并按短 TTL 缓存日历扫描', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  let now = at('2026-11-07T02:00:00Z')
  const catalog = createCatalog({ state, getControl: () => state.get(), router: { select: () => ({}) }, executor: { run: async () => ({ items: [] }) }, now: () => now })
  const first = catalog.marketState('XSHG')
  assert.equal(first.state, 'closed')
  assert.equal(first.nextAt, at('2026-11-09T01:15:00Z'))
  // 同一 now 内写入新日历: 短缓存仍返回旧结果
  await state.cache.put('calendar:em:XSHG', { kind: 'calendar', source: 'em', fetchedAt: now, payload: { routingRevision: 0, market: 'XSHG', complete: true, items: [{ date: '2026-11-09', isOpen: false }, { date: '2026-11-10', isOpen: true }] } })
  assert.deepEqual(catalog.marketState('XSHG'), first, 'TTL 内不重复扫描')
  // 过 TTL 后看到 11-09 休市, nextAt 顺延到 11-10
  now += 5 * 1000
  const second = catalog.marketState('XSHG')
  assert.equal(second.nextAt, at('2026-11-10T01:15:00Z'))
  catalog.dispose(); await state.close()
})

test('P2-51 采集 reconcile 只在 nextAt 到达时唤醒, 不再按 15 秒轮询休市市场', async () => {
  const { createCollector } = await import('../src/collector.mjs')
  const { makeSecurity } = await import('../src/market-model.mjs')
  const security = makeSecurity('XNAS', 'AAPL', 'Apple')
  let scheduled
  const now = at('2026-11-07T02:00:00Z')
  const config = { routingRevision: 1, preferences: { refreshSeconds: 15 }, providers: [{ id: 'a', enabled: true, adapterId: 'fake', budget: { requestsPerMinute: 60, capabilityLimits: { quotes: 60 } } }], routes: [{ id: 'us', capability: 'quotes', market: 'XNAS', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }], watchlist: { order: [security.id], items: { [security.id]: security } } }
  const collector = createCollector({ getControl: () => config, router: { select: () => ({ instance: { id: 'a', budget: { requestsPerMinute: 60, capabilityLimits: { quotes: 60 } } }, route: { id: 'us' }, routeEpoch: 1 }) }, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => ({ items: [] }) }, now: () => now, active: () => true, calendarState: market => marketStateOf(market, now), timers: { clearTimeout() {}, setTimeout(fn, ms) { scheduled = { fn, ms }; return 1 } } })
  collector.reconcile()
  assert.equal(scheduled.ms, at('2026-11-09T14:30:00Z') - now, '周末唤醒点=下周一美股开盘')
  collector.dispose()
})
