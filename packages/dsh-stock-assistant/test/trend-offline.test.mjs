import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { initialControl } from '../src/schemas.mjs'
import { memoryStorage, provider } from './helpers.mjs'

// 分时离线兜底:
//   Given 当日曾成功取到过真实分时
//   When 上游断开
//   Then 用当日缓存出图, 并把之后新到的报价点续在线尾
//   Given 当日从没成功取到过真实分时
//   When 上游断开
//   Then 即使攒了报价点也如实报错——几个点连成的线说明不了走势
const trendRoute = (market = 'XSHG') => ({ id: `${market.toLowerCase()}-trend`, capability: 'trend', market, instrument: 'equity', primaryInstanceId: 'em-one', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
const quotesRoute = (market = 'XSHG') => ({ id: `${market.toLowerCase()}-quotes`, capability: 'quotes', market, instrument: 'equity', primaryInstanceId: 'em-one', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
// 上海上午 10:10 与 10:11, 当天
const TODAY_AT = 1794792600
const MAOTAI = { id: 'XSHG:equity:600519', exchange: 'XSHG', code: '600519', officialName: '贵州茅台', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'L' }

function fakeAdapter(clock, state) {
  const candle = (at, close) => ({ time: '10:10', at, open: close, close, high: close, low: close, volume: 1 })
  return {
    descriptor: { adapterId: 'fake', capabilities: ['quotes', 'trend'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async quotes(request) {
      return {
        providerInstanceId: 'em-one',
        items: request.securities.map(s => ({ securityId: s.id, providerInstanceId: 'em-one', code: s.code, market: s.exchange, instrument: 'equity', last: state.price, previousClose: 10, open: 10, high: 10, low: 10, volume: 100, quoteAt: state.noTradeTime ? null : new Date(clock.now).toISOString(), receivedAt: clock.now, timestampKind: 'trade', delayKind: 'realtime', delaySeconds: 0 })),
      }
    },
    async trend() {
      if (state.trendFails) { const error = new Error('无法连接行情来源'); error.code = 'NETWORK'; throw error }
      // 上游"成功但没数据"是真实存在的: 不能当成可用的当日缓存
      if (state.empty) return { providerInstanceId: 'em-one', fetchedAt: clock.now, complete: true, preClose: 10, candles: [] }
      return { providerInstanceId: 'em-one', fetchedAt: clock.now, complete: true, preClose: 10, candles: [candle(state.trendAt, 10.1), candle(state.trendAt + 60, 10.2)] }
    },
  }
}

async function setup({ watch = [] } = {}) {
  const clock = { now: Date.parse('2026-11-16T02:00:00Z') }
  const state = { price: 10, trendFails: false, empty: false, trendAt: TODAY_AT }
  const storage = memoryStorage()
  const control = initialControl()
  control.providers = [{ ...provider('em-one', 'fake'), credentialRef: null }]
  control.routes = [quotesRoute(), trendRoute()]
  control.watchlist = { order: watch.map(item => item.id), items: Object.fromEntries(watch.map(item => [item.id, item])) }
  storage.maps.control.set('root', control)
  const app = await createApplication({ storageDomain: storage, providers: [fakeAdapter(clock, state)], env: {}, now: () => clock.now })
  return { app, clock, state }
}
// 每次调用都跨过一个节拍周期: 闸门等待用的是真实定时器, 假时钟不跟随, 落进拍的后半段会一直等
const PAST_TICK = 10 * 1000
const NEXT_TREND_WINDOW = 60 * 1000
const trendOf = app => app.kline({ securityId: 'XSHG:equity:600519', period: 'trend', limit: 250 })
const breakDown = (state, clock) => { state.trendFails = true; clock.now += NEXT_TREND_WINDOW }

test('有真实分时打底时, 断开后把之后的报价点续在线尾', async () => {
  const { app, clock, state } = await setup({ watch: [MAOTAI] })
  try {
    const live = await trendOf(app)
    assert.equal(live.offline, undefined, '在线时没有离线标记')
    clock.now += 12 * 60 * 1000
    state.price = 10.5
    await app.refresh()
    clock.now += 60 * 1000
    state.price = 10.8
    await app.refresh()
    breakDown(state, clock)
    const offline = await trendOf(app)
    assert.equal(offline.offline.kind, 'cache')
    assert.equal(offline.serverEpoch, live.serverEpoch)
    assert.equal(offline.routingRevision, 0)
    assert.equal(offline.routeEpoch, 0)
    assert.equal(offline.sessionDate, '2026-11-16')
    assert.equal(offline.offline.appended, 2, '缓存之后的两拍都补上')
    assert.equal(offline.candles.length, 4, '真实两根 + 补两根')
    assert.deepEqual(offline.candles.slice(-2).map(candle => candle.close), [10.5, 10.8])
    assert.deepEqual(offline.candles.slice(-2).map(candle => candle.time), ['10:12', '10:13'], '横轴按来源时区(北京)写, 与在线分时同一基准')
    for (const candle of offline.candles.slice(-2)) assert.deepEqual([candle.open, candle.high, candle.low], [candle.close, candle.close, candle.close], '拍点只有收盘价, 开高低补成同值才过客户端的 OHLC 校验')
    assert.equal(offline.complete, false, '补过点就不是完整分时')
    assert.equal(offline.preClose, 10, '基线用缓存里的昨收')
  } finally { await app.close() }
})

test('失败窗口内继续追加新报价点，不回源也不覆盖真实线', async () => {
  const { app, clock, state } = await setup({ watch: [MAOTAI] })
  try {
    const live = await trendOf(app)
    clock.now += 12 * 60 * 1000
    state.price = 10.5
    await app.refresh()
    state.trendFails = true
    clock.now += PAST_TICK
    const offline = await trendOf(app)
    assert.equal(offline.offline.appended, 1)
    // 下一分钟有更新报价，但还没到失败窗口的截止时刻。
    clock.now += 50 * 1000
    state.price = 10.8
    await app.refresh()
    clock.now += 1000
    state.trendFails = false
    const replay = await trendOf(app)
    assert.equal(replay.offline.appended, 2)
    assert.deepEqual(replay.candles.slice(0, 2), live.candles)
    assert.deepEqual(replay.candles.slice(-2).map(candle => candle.close), [10.5, 10.8])
    assert.equal(replay.sessionDate, live.sessionDate)
  } finally { await app.close() }
})

test('没有成交时间的报价不伪造分时补点', async () => {
  const { app, clock, state } = await setup({ watch: [MAOTAI] })
  try {
    const live = await trendOf(app)
    clock.now += 12 * 60 * 1000
    state.noTradeTime = true
    await app.refresh()
    breakDown(state, clock)
    const offline = await trendOf(app)
    assert.equal(offline.offline.appended, 0)
    assert.deepEqual(offline.candles, live.candles)
  } finally { await app.close() }
})

test('拍点都在缓存之前就不补, 缓存原样返回', async () => {
  const { app, clock, state } = await setup({ watch: [MAOTAI] })
  try {
    // 让真实分时停在 10:20, 两拍报价都早于它
    state.trendAt = TODAY_AT + 50 * 60
    const live = await trendOf(app)
    clock.now += 2 * 60 * 1000
    state.price = 10.5
    await app.refresh()
    clock.now += 60 * 1000
    await app.refresh()
    breakDown(state, clock)
    const offline = await trendOf(app)
    assert.equal(offline.offline.kind, 'cache')
    assert.equal(offline.offline.appended, 0)
    assert.deepEqual(offline.candles, live.candles, '不该把早于最后一根的点插回历史')
    assert.equal(offline.complete, true, '没有补点时它仍是完整分时')
  } finally { await app.close() }
})

test('从没成功取到真实分时, 攒再多报价点也报错', async () => {
  const { app, clock, state } = await setup({ watch: [MAOTAI] })
  try {
    clock.now += 2 * 60 * 1000
    await app.refresh()
    clock.now += 60 * 1000
    state.price = 10.3
    await app.refresh()
    breakDown(state, clock)
    await assert.rejects(trendOf(app), error => error.code === 'NETWORK', '没有真实 K 线打底, 不画只有几个点的线')
  } finally { await app.close() }
})

test('上游成功但没数据不算缓存, 也不出图', async () => {
  const { app, clock, state } = await setup()
  try {
    state.empty = true
    clock.now += PAST_TICK
    assert.deepEqual((await trendOf(app)).candles, [], '上游就是给了空的')
    breakDown(state, clock)
    await assert.rejects(trendOf(app), error => error.code === 'NETWORK')
  } finally { await app.close() }
})

test('缓存按数据所属交易日判定, 昨天的线不进今天的兜底', async () => {
  const { app, clock, state } = await setup()
  try {
    // 上游返回的是上一交易日的分时(盘前常见), 存不进"今天"
    state.trendAt = TODAY_AT - 24 * 60 * 60
    await trendOf(app)
    breakDown(state, clock)
    await assert.rejects(trendOf(app), error => error.code === 'NETWORK')
  } finally { await app.close() }
})

test('续过点的线不写回缓存, 下次拿到的还是真实那一份', async () => {
  const { app, clock, state } = await setup({ watch: [MAOTAI] })
  try {
    const live = await trendOf(app)
    clock.now += 12 * 60 * 1000
    state.price = 10.5
    await app.refresh()
    breakDown(state, clock)
    const appended = await trendOf(app)
    assert.equal(appended.offline.appended, 1)
    // 上游恢复但这次没有数据: 不覆盖缓存。再断开时前两根必须还是真实那两根
    state.trendFails = false
    state.empty = true
    clock.now += NEXT_TREND_WINDOW
    await trendOf(app)
    breakDown(state, clock)
    const again = await trendOf(app)
    assert.deepEqual(again.candles.slice(0, 2), live.candles, '缓存里始终是真实的两根, 不是续过点的三根')
    assert.equal(again.offline.appended, 1, '新的那拍还会再续一次')
  } finally { await app.close() }
})

test('恢复到新的真实分时后, 缓存换成新的那一份', async () => {
  const { app, clock, state } = await setup()
  try {
    await trendOf(app)
    breakDown(state, clock)
    assert.equal((await trendOf(app)).offline.kind, 'cache')
    state.trendFails = false
    state.trendAt = TODAY_AT + 60
    clock.now += NEXT_TREND_WINDOW
    const recovered = await trendOf(app)
    assert.equal(recovered.offline, undefined)
    breakDown(state, clock)
    const cached = await trendOf(app)
    assert.deepEqual(cached.candles, recovered.candles, '缓存换成新的真数据')
  } finally { await app.close() }
})
