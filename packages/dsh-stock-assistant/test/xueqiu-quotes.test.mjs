// 雪球适配器: 5 市场报价、匿名 token 缓存、多余字段透传
import test from 'node:test'
import assert from 'node:assert/strict'
import { xueqiu } from '../src/providers/xueqiu.mjs'

const HOME_COOKIE = { 'set-cookie': null }
const security = (exchange, code) => ({ id: `${exchange}:equity:${code}`, exchange, code, officialName: code, instrument: 'equity' })
const body = (rows) => ({ data: { items: rows.map(quote => ({ quote })) } })
const row = (symbol, extra = {}) => ({ symbol, name: symbol, currency: 'CNY', current: 10, last_close: 9, open: 9.5, high: 10.5, low: 9.4, volume: 1234, amount: 5678, turnover_rate: 0.5, market_capital: 9000, timestamp: 1793862000000, ...extra })

function harness(handler) {
  const calls = []
  const ctx = {
    now: () => 1000,
    signal: new AbortController().signal,
    fetch: async (url, init) => { calls.push({ url: String(url), headers: init?.headers || {} }); return handler(String(url), init, calls.length) },
  }
  return { ctx, calls }
}

test('X01 沪深港美一次混装: symbol 拼装与字段映射', async () => {
  const { ctx, calls } = harness(async (url) => {
    if (url.includes('xueqiu.com/') && !url.includes('batch')) return { ok: true, status: 200, headers: { getSetCookie: () => ['xq_a_token=abc; Path=/'] } }
    return { ok: true, status: 200, json: async () => body([row('SH600519'), row('SZ000001'), row('00700', { currency: 'HKD' }), row('AAPL', { currency: 'USD' })]) }
  })
  const result = await xueqiu.quotes({ providerInstanceId: 'xq', securities: [security('XSHG', '600519'), security('XSHE', '000001'), security('XHKG', '00700'), security('XNAS', 'AAPL')] }, ctx)
  assert.equal(calls.length, 2, '先取 token 再批量报价')
  assert.ok(calls[1].url.includes('symbol=SH600519,SZ000001,00700,AAPL'), '港美不加前缀')
  assert.ok(String(calls[1].headers.Cookie).includes('xq_a_token=abc'))
  assert.equal(result.items.length, 4)
  const hk = result.items.find(i => i.securityId === 'XHKG:equity:00700')
  assert.equal(hk.last, '10.00')
  assert.equal(hk.volume, '1234')
  assert.equal(hk.amountUnit, 'HKD')
  assert.equal(hk.turnoverRate, 0.5)
  assert.equal(hk.marketCapital, 9000)
  assert.equal(hk.quoteAt, new Date(1793862000000).toISOString())
})

test('X02 token 进程内缓存, 第二次请求不再访问首页', async () => {
  const { ctx, calls } = harness(async (url) => {
    if (url.includes('xueqiu.com/') && !url.includes('batch')) return { ok: true, status: 200, headers: { getSetCookie: () => ['xq_a_token=abc; Path=/'] } }
    return { ok: true, status: 200, json: async () => body([row('SH600519')]) }
  })
  const request = { providerInstanceId: 'xq', securities: [security('XSHG', '600519')] }
  await xueqiu.quotes(request, ctx)
  const after = calls.length
  await xueqiu.quotes(request, ctx)
  assert.equal(calls.length, after + 1, '只多一次报价请求')
})

test('X03 令牌失效且刷新拿不到新令牌时视为来源异常, 不伪造凭据', async () => {
  // token 是模块级缓存, 这里让报价请求返回 400 触发刷新, 首页这次不给 cookie
  const { ctx } = harness(async (url) => {
    if (url.includes('xueqiu.com/') && !url.includes('batch')) return { ok: true, status: 200, headers: { getSetCookie: () => [] } }
    return { ok: false, status: 400, json: async () => ({}) }
  })
  await assert.rejects(() => xueqiu.quotes({ providerInstanceId: 'xq', securities: [security('XSHG', '600519')] }, ctx), (e) => e.code === 'BAD_PAYLOAD')
})

test('X04 来源返回 null 报价项时跳过并记 NO_DATA', async () => {
  const { ctx } = harness(async (url) => {
    if (url.includes('xueqiu.com/') && !url.includes('batch')) return { ok: true, status: 200, headers: { getSetCookie: () => ['xq_a_token=abc; Path=/'] } }
    return { ok: true, status: 200, json: async () => body([null]) }
  })
  const result = await xueqiu.quotes({ providerInstanceId: 'xq', securities: [security('XHKG', '00700')] }, ctx)
  assert.equal(result.items.length, 0)
  assert.equal(result.errors[0].code, 'NO_DATA')
})

test('X05 探针覆盖五市场且不支持的交易所直接拒绝', async () => {
  const { ctx } = harness(async (url) => {
    if (url.includes('xueqiu.com/') && !url.includes('batch')) return { ok: true, status: 200, headers: { getSetCookie: () => ['xq_a_token=abc; Path=/'] } }
    return { ok: true, status: 200, json: async () => body([row('00700', { currency: 'HKD' })]) }
  })
  const ready = await xueqiu.probe({ capability: 'quotes', market: 'XHKG' }, ctx)
  assert.equal(ready.status, 'ready')
  await assert.rejects(() => xueqiu.probe({ capability: 'quotes', market: 'XJPX' }, ctx), (e) => e.code === 'UNSUPPORTED_CAPABILITY')
})
