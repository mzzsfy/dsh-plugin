import test from 'node:test'
import assert from 'node:assert/strict'
import { finnhub } from '../src/providers/finnhub.mjs'
const QUOTE = { c: 186.64, d: 5.04, dp: 2.78, h: 194.9, l: 185.22, o: 191.1, pc: 181.6, t: 1793998800 }
const EMPTY = { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }
const ctxFor = (resolve, log = [], token = 'tok') => ({ now: () => 100, signal: new AbortController().signal, credential: () => token, fetch: async url => { log.push(String(url)); return resolve(String(url)) } })
const ok = body => ({ ok: true, status: 200, json: async () => body })
const security = (exchange, code) => ({ id: `${exchange}:equity:${code}`, exchange, code })
const request = securities => ({ providerInstanceId: 'fh', securities })

test('Finnhub 报价字段映射与成交时间', async () => {
  const log = []
  const result = await finnhub.quotes(request([security('XNAS', 'NVDA')]), ctxFor(() => ok(QUOTE), log))
  assert.match(log[0], /\/quote\?symbol=NVDA&token=tok/, '按 symbol 与 token 拼请求')
  const quote = result.items[0]
  assert.equal(quote.last, '186.64')
  assert.equal(quote.previousClose, '181.60')
  assert.equal(quote.open, '191.10')
  assert.equal(quote.high, '194.90')
  assert.equal(quote.low, '185.22')
  assert.equal(quote.change, '5.04')
  assert.equal(quote.quoteAt, new Date(1793998800 * 1000).toISOString(), '成交时间取来源的 Unix 秒')
  assert.equal(quote.timestampKind, 'trade')
  assert.equal(quote.delayKind, 'unknown', '时效交给 collector 派生, 适配器不替来源保证')
  assert.equal(quote.errors ?? undefined, undefined)
  assert.equal(result.errors.length, 0)
})

test('Finnhub 无效代码返回全 0 视为无此证券', async () => {
  const result = await finnhub.quotes(request([security('XNYS', 'NOSUCH')]), ctxFor(() => ok(EMPTY)))
  assert.equal(result.items.length, 0)
  assert.equal(result.errors[0].code, 'NO_DATA')
  assert.equal(result.errors[0].securityId, 'XNYS:equity:NOSUCH')
})

test('Finnhub 无批量端点: 多只证券逐只请求', async () => {
  const log = []
  const result = await finnhub.quotes(request([security('XNAS', 'NVDA'), security('XNYS', 'BABA')]), ctxFor(() => ok(QUOTE), log))
  assert.equal(log.length, 2, '两只两次请求')
  assert.match(log[0], /symbol=NVDA/)
  assert.match(log[1], /symbol=BABA/)
  assert.equal(result.items.length, 2)
})

test('Finnhub 单只缺失不影响同批其余证券', async () => {
  const result = await finnhub.quotes(request([security('XNAS', 'NVDA'), security('XNYS', 'NOPE')]), ctxFor(url => ok(url.includes('NOPE') ? EMPTY : QUOTE)))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].securityId, 'XNAS:equity:NVDA')
  assert.equal(result.errors.length, 1)
})

test('Finnhub 令牌被拒报 AUTH, 限流报 RATE_LIMIT 并给出重试窗口', async () => {
  await assert.rejects(() => finnhub.quotes(request([security('XNAS', 'NVDA')]), ctxFor(() => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid API key.' }) }))), e => e.code === 'AUTH')
  await assert.rejects(() => finnhub.quotes(request([security('XNAS', 'NVDA')]), ctxFor(() => ({ ok: false, status: 429, json: async () => ({}) }))), e => e.code === 'RATE_LIMIT' && e.retryAfterMs === 60 * 1000)
})

test('Finnhub 探针用 AAPL 且只声明报价能力', async () => {
  const log = []
  const descriptor = finnhub.descriptor
  assert.deepEqual(descriptor.capabilities, ['quotes'], '免费档没有K线')
  assert.deepEqual(descriptor.markets, ['XNAS', 'XNYS'])
  assert.equal(descriptor.maxQuoteBatch, 1, '一只一请求')
  const status = await finnhub.probe({ market: 'XNAS', instrument: 'equity' }, ctxFor(() => ok(QUOTE), log))
  assert.equal(status.status, 'ready')
  assert.equal(status.capability, 'quotes')
  assert.match(log[0], /symbol=AAPL/)
})

test('Finnhub 探针拿不到数据时报 NO_DATA 而不是假就绪', async () => {
  await assert.rejects(() => finnhub.probe({ market: 'XNAS', instrument: 'equity' }, ctxFor(() => ok(EMPTY))), e => e.code === 'NO_DATA')
})
