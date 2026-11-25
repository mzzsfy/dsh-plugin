import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollector } from '../src/collector.mjs'
import { makeSecurity, marketStateOf } from '../src/market-model.mjs'
import { createRouter } from '../src/provider-router.mjs'

const ids = ['600519', '600521', '600522'].map(code => makeSecurity('XSHG', code, code))
const [a, b, c] = ids.map(s => s.id)
const START = Date.parse('2026-11-25T01:53:00Z')

function setup(t, maxQuoteBatch = 20, { realPhase = false } = {}) {
  let now = START
  let phase = { state: 'trading' }
  let quoteAt
  const calls = []
  const config = {
    routingRevision: 1,
    preferences: { refreshSeconds: 15, floatRefreshSeconds: 3 },
    watchlist: { order: [a, b, c], items: Object.fromEntries(ids.map(s => [s.id, s])) },
    providers: [{ id: 'a', enabled: true, adapterId: 'fake', budget: { requestsPerMinute: 50 } }],
    routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }],
  }
  const router = createRouter(() => config)
  const collector = createCollector({
    getControl: () => config, router, now: () => now, calendarState: realPhase ? exchange => marketStateOf(exchange, now) : () => phase,
    registry: { get: () => ({ descriptor: { maxQuoteBatch } }) },
    executor: { run: (source, _capability, { securities }, { signal }) => new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }))
      signal.addEventListener('abort', abort, { once: true })
      calls.push({ ids: securities.map(s => s.id), signal, fail: () => { signal.removeEventListener('abort', abort); reject(Object.assign(new Error('offline'), { code: 'NETWORK' })) }, finish: () => {
        signal.removeEventListener('abort', abort)
        resolve({ items: securities.map(s => ({ securityId: s.id, providerInstanceId: source.id, quoteAt: new Date(quoteAt ?? now).toISOString(), last: '10.10', receivedAt: now, delayKind: 'realtime' })) })
      } })
    }) },
  })
  t.after(() => collector.dispose())
  return { collector, calls, config, router, setNow: offset => { now = START + offset }, setQuoteAt: at => { quoteAt = at }, setPhase: (state, extra = {}) => { phase = { state, ...(state === 'closed' ? { nextAt: now + 60 * 60 * 1000 } : {}), ...extra } } }
}

const turn = () => new Promise(resolve => setImmediate(resolve))
const finish = calls => calls.forEach(call => call.finish())

test('QA18 周期采集在新鲜期内复用报价, 过期才回源', async t => {
  const { collector, calls, setNow } = setup(t)
  const run = async () => { const result = collector.refresh(undefined, { periodic: true }); await turn(); finish(calls); return result }
  await run()
  assert.equal(calls.length, 1)
  setNow(1000)
  await run()
  assert.equal(calls.length, 1, '3 秒档内不回源')
  setNow(4000)
  await run()
  assert.equal(calls.length, 2, '越过新鲜期才回源')
})

test('QA01 已有全量报价在途时，悬浮子集只等原请求', async t => {
  const { collector, calls } = setup(t)
  const list = collector.refresh(undefined, { periodic: true })
  const float = collector.refresh([b, a], { automatic: true })
  await turn(); finish(calls)
  assert.equal((await float)[b].quote.last, '10.10')
  await list
  assert.deepEqual(calls.map(call => call.ids), [[a, b, c]])
})

test('QA02 部分证券在途时只向上游请求缺失证券', async t => {
  const { collector, calls } = setup(t)
  const first = collector.refresh([b, b], { automatic: true })
  const second = collector.refresh([c, b], { automatic: true })
  await turn(); finish(calls)
  await first
  const entries = await second
  assert.ok(entries[b]?.quote && entries[c]?.quote)
  assert.deepEqual(calls.map(call => call.ids), [[b], [c]])
})

test('QA03 自动轮询重用新鲜报价，到期只查过期的证券，手动不受缓存限制', async t => {
  const { collector, calls, setNow } = setup(t)
  const run = async (requestIds, options) => {
    const result = collector.refresh(requestIds, options)
    await turn(); finish(calls)
    return result
  }
  await run([a]); setNow(1000); await run([b]); setNow(2500)
  assert.equal((await run([a, b], { automatic: true }))[a].quote.receivedAt, START)
  assert.deepEqual(calls.map(call => call.ids), [[a], [b]])
  setNow(3000)
  assert.equal((await run([a, b], { automatic: true }))[a].quote.receivedAt, START + 3000)
  assert.deepEqual(calls.map(call => call.ids), [[a], [b], [a]])
  await run([a]); assert.deepEqual(calls.map(call => call.ids), [[a], [b], [a], [a]])
})

test('QA04 收盘后自动保留收盘报价，重新开市立即重新拉取', async t => {
  const { collector, calls, setNow, setPhase, setQuoteAt } = setup(t)
  const run = async () => {
    const result = collector.refresh([a], { automatic: true })
    await turn(); finish(calls)
    return (await result)[a].quote.sessionState
  }
  assert.equal(await run(), 'trading')
  setNow(1000); setPhase('closed', { lastCloseDate: '2026-11-25' }); setQuoteAt(Date.parse('2026-11-25T07:00:00Z'))
  assert.equal(await run(), 'closed')
  setNow(65 * 1000)
  assert.equal(await run(), 'closed')
  assert.equal(calls.length, 2)
  setPhase('trading')
  assert.equal(await run(), 'trading')
  assert.equal(calls.length, 3)
})

test('QA05 一位订阅者取消不会中断重叠请求，最后一位取消才终止上游', async t => {
  const { collector, calls } = setup(t)
  const first = new AbortController(), second = new AbortController()
  const list = collector.refresh([a, b], { automatic: true, signal: first.signal })
  const float = collector.refresh([a], { automatic: true, signal: second.signal })
  await turn(); first.abort()
  await assert.rejects(list, e => e.code === 'CANCELLED')
  assert.equal(calls[0].signal.aborted, false)
  second.abort()
  await assert.rejects(float, e => e.code === 'CANCELLED')
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls.length, 1)
})

test('QA06 不以未订阅证券的成功掩盖当前证券失败', async t => {
  const { collector, calls } = setup(t, 1)
  const full = collector.refresh([a, b], { automatic: true })
  const subset = collector.refresh([b, c], { automatic: true })
  const failed = assert.rejects(subset, e => e.code === 'NETWORK')
  calls.find(call => call.ids[0] === a).finish()
  calls.find(call => call.ids[0] === c).fail()
  await turn()
  calls.find(call => call.ids[0] === b).fail()
  await Promise.all([full, failed])
})

test('QA07 缓存命中时仍尊重已取消的调用者', async t => {
  const { collector, calls } = setup(t)
  const first = collector.refresh([a])
  calls[0].finish(); await first
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(collector.refresh([a], { automatic: true, signal: controller.signal }), e => e.code === 'CANCELLED')
  assert.equal(calls.length, 1)
})

test('QA08 跨到新交易阶段时，不用前一阶段迟到的报价覆盖', async t => {
  const { collector, calls, setPhase } = setup(t, 1)
  const old = collector.refresh([a, b], { automatic: true })
  setPhase('closed')
  const closing = collector.refresh([b], { automatic: true })
  calls[1].finish(); await closing
  calls[0].finish(); await turn()
  finish(calls.slice(2)); await old
  assert.equal(collector.entries()[b].quote.sessionState, 'closed')
})

test('QA09 已共享的临时报价不受另一响应清理快照影响', async t => {
  const { collector, calls, config } = setup(t, 1)
  const peek = { id: a, exchange: 'XSHG', code: '600519' }
  delete config.watchlist.items[a]
  config.watchlist.order = [b, c]
  const first = collector.refresh([peek])
  const later = collector.refresh([peek, c])
  calls[0].finish()
  assert.equal((await first)[a].quote.last, '10.10')
  collector.watchEntries()
  calls[1].finish()
  assert.equal((await later)[a].quote.last, '10.10')
})

test('QA10 最后一个消费者退出时同步中断，迟到的报价不写入', async t => {
  const { collector, calls } = setup(t)
  const control = new AbortController()
  const pending = collector.refresh([a], { signal: control.signal })
  control.abort()
  assert.equal(calls[0].signal.aborted, true)
  calls[0].finish()
  await assert.rejects(pending, e => e.code === 'CANCELLED')
  await turn()
  assert.equal(collector.entries()[a], undefined)
})

test('QA14 盘前复用上一收盘日, 收盘后不沿用上一交易日', async t => {
  const { collector, calls, setNow, setPhase, setQuoteAt } = setup(t)
  const run = async () => {
    const result = collector.refresh([a], { automatic: true })
    await turn(); finish(calls)
    return (await result)[a].quote
  }
  setPhase('closed', { lastCloseDate: '2026-11-25' })
  setQuoteAt(Date.parse('2026-11-25T07:00:00Z'))
  assert.equal((await run()).sessionState, 'closed')
  // 次日 08:00 盘前, 最近收盘日仍是 11-25: 复用不重复回源
  setNow(22 * 60 * 60 * 1000 + 7 * 60 * 1000)
  setPhase('preopen', { lastCloseDate: '2026-11-25' })
  assert.equal((await run()).sessionState, 'closed')
  assert.equal(calls.length, 1, '盘前沿用上一收盘价')
  // 次日 15:30 收盘后, 最近收盘日已变成 11-26: 昨天的收盘价必须回源
  setNow(29 * 60 * 60 * 1000 + 37 * 60 * 1000)
  setPhase('closed', { lastCloseDate: '2026-11-26' })
  assert.equal((await run()).sessionState, 'closed')
  assert.equal(calls.length, 2, '跨过完整交易日后重新取数')
})

test('QA15 午休复用当天上午的收盘价，不重复回源', async t => {
  const { collector, calls, setNow, setPhase } = setup(t)
  const run = async () => {
    const result = collector.refresh([a], { automatic: true })
    await turn(); finish(calls)
    return (await result)[a].quote
  }
  setPhase('break')
  assert.equal((await run()).sessionState, 'break')
  setNow(65 * 1000)
  assert.equal((await run()).sessionState, 'break')
  assert.equal(calls.length, 1)
})

test('QA16 午休开始时不沿用上午盘中的旧价', async t => {
  const { collector, calls, setNow, setPhase } = setup(t)
  const run = async () => {
    const result = collector.refresh([a], { automatic: true })
    await turn(); finish(calls)
    return (await result)[a].quote
  }
  assert.equal((await run()).sessionState, 'trading')
  // 09:53 的盘中价, 12:00 进入午休: 必须取上午收盘, 不能把 10:00 前的价格当午休收盘
  setNow(2 * 60 * 60 * 1000 + 7 * 60 * 1000)
  setPhase('break')
  assert.equal((await run()).sessionState, 'break')
  assert.equal(calls.length, 2)
})

test('QA17 收盘后不把当天盘中价当收盘价', async t => {
  const { collector, calls, setPhase, setQuoteAt } = setup(t)
  const run = async () => {
    const result = collector.refresh([a], { automatic: true })
    await turn(); finish(calls)
    return (await result)[a].quote
  }
  setPhase('closed', { lastCloseDate: '2026-11-25' })
  setQuoteAt(Date.parse('2026-11-25T02:00:00Z'))
  assert.equal((await run()).sessionState, 'closed')
  assert.equal(calls.length, 1, '盘中时刻的报价不是收盘价, 必须回源')
})

test('QA19 真实日历链路: 盘前复用上一收盘日, 开盘后重新取数', async t => {
  const { collector, calls, setNow, setQuoteAt } = setup(t, 20, { realPhase: true })
  const run = async () => {
    const result = collector.refresh([a], { automatic: true })
    await turn(); finish(calls)
    return (await result)[a].quote
  }
  // 11-25 08:00 盘前, 报价停在 11-24 收盘
  setNow(-(60 + 53) * 60 * 1000)
  setQuoteAt(Date.parse('2026-11-24T07:00:00Z'))
  assert.equal((await run()).sessionState, 'preopen')
  assert.equal(calls.length, 1)
  // 09:00 仍在盘前: 继续复用
  setNow(-53 * 60 * 1000)
  await run()
  assert.equal(calls.length, 1)
  // 10:00 开盘: 上一收盘价不能继续用
  setNow(7 * 60 * 1000)
  await run()
  assert.equal(calls.length, 2)
})

test('QA11 换到备源后与已开始的该代补救合并', async t => {
  const { collector, calls, config, router } = setup(t)
  const route = config.routes[0]
  route.failoverMode = 'network'
  route.fallbackInstanceIds = ['backup']
  config.providers.push({ ...config.providers[0], id: 'backup' })
  const offline = { code: 'NETWORK' }
  router.recordRound(route.id, offline); router.recordRound(route.id, offline)
  const first = collector.refresh([a, b])
  calls[0].fail(); await turn()
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'backup')
  const second = collector.refresh([b, c], { automatic: true })
  finish(calls.slice(1)); await Promise.all([first, second])
  assert.deepEqual(calls.map(call => call.ids), [[a, b], [a, b], [c]])
})

test('QA12 浮窗子集的收盘请求不吞掉列表其余标的的收盘对账', async t => {
  const { collector, calls, setPhase } = setup(t)
  const trading = collector.refresh(undefined, { periodic: true })
  calls[0].finish(); await trading
  setPhase('closed')
  const first = collector.refresh([a], { automatic: true })
  calls[1].finish(); await first
  const final = collector.refresh(undefined, { periodic: true })
  calls[2].finish(); await final
  assert.deepEqual(calls.map(call => call.ids), [[a, b, c], [a], [b, c]])
  assert.equal(collector.entries()[c].quote.sessionState, 'closed')
})

test('QA13 同一请求跨收盘时不继续派旧阶段的剩余批次', async t => {
  const { collector, calls, setPhase } = setup(t, 1)
  const old = collector.refresh([a, b], { automatic: true })
  setPhase('closed')
  calls[0].finish(); await old
  assert.equal(calls.length, 1)
  assert.equal(collector.entries()[a], undefined)
})
