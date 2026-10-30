import test from 'node:test'
import assert from 'node:assert/strict'
import { tushare } from '../src/providers/tushare.mjs'
import { makeSecurity } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')
const req = { providerInstanceId: 'ts-one', securities: [security], market: 'XSHG' }
const ctx = items => ({ now: () => 100, credential: () => 'test-only', signal: new AbortController().signal, fetch: async (url, options) => {
  assert.equal(url, 'https://api.tushare.pro')
  assert.equal(JSON.parse(options.body).token, 'test-only')
  return { ok: true, json: async () => ({ code: 0, data: items }), headers: new Headers() }
} })
test('P02 重复冲突报价拒绝，权限错误不泄露来源响应内容', async () => {
  await assert.rejects(tushare.quotes(req, ctx({ fields: ['close', 'ts_code', 'pre_close'], items: [[10, '600519.SH', 8], [11, '600519.SH', 8]] })), e => e.code === 'BAD_PAYLOAD')
})
test('目录达到平台上限时按已支持板块过滤细分，不伪造分页参数', async () => {
  const requests = [], fields = ['ts_code','symbol','name','market','exchange','curr_type','list_status']
  const full = Array.from({ length: 6000 }, (_, i) => [`${String(600000 + i)}.SH`, String(600000 + i), `证券${i}`, '主板','SSE','CNY','L'])
  const context = ctx({ fields, items: [] })
  context.fetch = async (url, options) => {
    const params = JSON.parse(options.body).params; requests.push(params)
    assert.equal(params.offset, undefined)
    const items = !params.market ? full : params.market === '主板' ? [full[0]] : params.market === '科创板' ? [['688001.SH','688001','科创证券','科创板','SSE','CNY','L']] : []
    return { ok: true, json: async () => ({ code: 0, data: { fields, items } }) }
  }
  const result = await tushare.catalog({ providerInstanceId: 'ts-one', market: 'XSHG' }, context)
  assert.equal(requests.length, 3); assert.equal(result.complete, true); assert.equal(result.items.length, 2)
})
test('目录标准化过滤非A股且按官方交易所映射', async () => {
  const result = await tushare.catalog({ providerInstanceId: 'ts-one', market: 'XSHE' }, ctx({ fields: ['ts_code', 'symbol', 'name', 'cnspell', 'market', 'exchange', 'curr_type', 'list_status'], items: [['000001.SZ', '000001', '平安银行', 'payh', '主板', 'SZSE', 'CNY', 'L'], ['200001.SZ', '200001', 'B股', '', '主板', 'SZSE', 'HKD', 'L']] }))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].id, 'XSHE:equity:000001')
  assert.equal(result.items[0].cnspell, 'payh')
})
test('P01 rt_k按列名解析并保留来源时间与单位', async () => {
  const result = await tushare.quotes(req, ctx({ fields: ['close', 'ts_code', 'pre_close', 'name', 'trade_time', 'vol', 'amount'], items: [[10, '600519.SH', 8, '贵州茅台', '2026-10-29 14:30:05', 100, 1000]] }))
  assert.equal(result.items[0]?.securityId, security.id)
  assert.equal(result.items[0].changePct, '25.00')
  assert.equal(result.items[0].quoteAt, '2026-10-29T06:30:05.000Z')
  assert.equal(result.items[0].volume, '100')
})
