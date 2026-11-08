// 新浪港美报价解析:同一端点下三种定长表(沪深34/港股25/美股36),列义由前缀决定
import test from 'node:test'
import assert from 'node:assert/strict'
import { sina } from '../src/providers/sina.mjs'

const HK_ROW = 'TENCENT,00700,413.800,401.600,431.200,410.200,430.400,28.800,7.171,430.200,430.400,24168809665.446,56903938,15.639,0.000,654.376,375.200,2026/11/05,16:08:20,100|0,N|Y|Y,430.200|408.800|451.600,0|||0.000|0.000|0.000, |0,Y'
const US_ROW = 'APPLE,349.1600,-0.10,2026-11-05 23:27:35,-0.3500,353.8900,355.3800,348.0600,355.3800,242.8900,17954387,53285985,5074056667469,8.30,42.070000,0.00,0.00,0.00,0.00,14532182001,63,0.0000,0.00,0.00, ,Nov 05 10:27AM EST,349.5100,0,1,2026,6311959841.0000,0.0000,0.0000,0.0000,0.0000,349.5100'
const CN_ROW = '000001,11.710,11.740,11.640,11.770,11.560,11.630,11.640,122899701,1429433016.320,155900,11.630,218530,11.620,435500,11.610,418900,11.600,174200,11.590,116620,11.640,401400,11.650,390920,11.660,253700,11.670,410000,11.680,2026-11-05,15:36:00,00,D|27300|317772.000'

const ctxWith = body => ({ fetch: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(body) }), now: () => 1793890000000, signal: new AbortController().signal })
const security = (exchange, code) => ({ exchange, code, id: `${exchange}:equity:${code}` })

test('S01 港美报价按各自列义解析,币种随市场派生', async () => {
  const body = `var hq_str_rt_hk00700="${HK_ROW}";var hq_str_gb_aapl="${US_ROW}";`
  const result = await sina.quotes({ securities: [security('XHKG', '00700'), security('XNAS', 'AAPL')], providerInstanceId: 'sn' }, ctxWith(body))
  const hk = result.items.find(q => q.securityId === 'XHKG:equity:00700')
  const us = result.items.find(q => q.securityId === 'XNAS:equity:AAPL')
  assert.equal(hk.last, '430.40', '港股现价')
  assert.equal(hk.previousClose, '401.60', '港股昨收')
  assert.equal(hk.open, '413.80', '港股今开')
  assert.equal(hk.high, '431.20')
  assert.equal(hk.low, '410.20')
  assert.equal(hk.volume, '56903938')
  assert.equal(hk.amount, '24168809665', '成交额取整到元')
  assert.equal(hk.amountUnit, 'HKD', '港股币种')
  assert.equal(hk.quoteAt, '2026-11-05T08:08:20.000Z', '斜杠日期归一为 UTC')
  assert.equal(us.last, '349.16')
  assert.equal(us.previousClose, '349.51', '美股昨收取尾部字段')
  assert.equal(us.open, '353.89', '美股今开')
  assert.equal(us.high, '355.38')
  assert.equal(us.low, '348.06')
  assert.equal(us.volume, '17954387')
  assert.equal(us.amount, null, '美股来源不给成交额')
  assert.equal(us.amountUnit, 'USD')
  assert.equal(us.quoteAt, '2026-11-05T15:27:35.000Z')
})

test('S02 沪深列义不因多市场改造而漂移', async () => {
  const body = `var hq_str_sz000001="${CN_ROW}";`
  const result = await sina.quotes({ securities: [security('XSHE', '000001')], providerInstanceId: 'sn' }, ctxWith(body))
  const cn = result.items[0]
  assert.equal(cn.last, '11.64', 'A股现价')
  assert.equal(cn.previousClose, '11.74')
  assert.equal(cn.open, '11.71')
  assert.equal(cn.amountUnit, 'CNY')
  assert.equal(cn.quoteAt, '2026-11-05T07:36:00.000Z')
})

test('S03 未返回的证券记为缺失而不是零价,字段不足判坏载荷', async () => {
  const body = `var hq_str_gb_aapl="${US_ROW}";`
  const result = await sina.quotes({ securities: [security('XNAS', 'AAPL'), security('XHKG', '00700')], providerInstanceId: 'sn' }, ctxWith(body))
  assert.equal(result.items.length, 1)
  assert.deepEqual(result.errors.map(e => e.securityId), ['XHKG:equity:00700'])
  assert.equal(result.errors[0].code, 'NO_DATA')
  await assert.rejects(
    () => sina.quotes({ securities: [security('XNAS', 'AAPL')], providerInstanceId: 'sn' }, ctxWith('var hq_str_gb_aapl="APPLE,1.00";')),
    (e) => e.code === 'BAD_PAYLOAD',
  )
})

test('S04 前缀随市场派生:美股小写、港股保留五位代码', async () => {
  let requested = ''
  const ctx = { fetch: async url => { requested = url; return { ok: true, arrayBuffer: async () => new TextEncoder().encode('') } }, now: () => 0, signal: new AbortController().signal }
  await sina.quotes({ securities: [security('XNYS', 'BABA'), security('XHKG', '00700'), security('XSHG', '600519')], providerInstanceId: 'sn' }, ctx)
  assert.match(requested, /gb_baba/)
  assert.match(requested, /rt_hk00700/)
  assert.match(requested, /sh600519/)
})
