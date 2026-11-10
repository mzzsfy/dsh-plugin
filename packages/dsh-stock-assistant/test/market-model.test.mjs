import test from 'node:test'
import assert from 'node:assert/strict'
import { MARKET_META, securityId, parseSecurityId, makeSecurity } from '../src/market-model.mjs'
import { tagName } from '../src/schemas.mjs'

test('MARKET_META 八市场齐全且八市场探针全部实测通过', () => {
  assert.deepEqual(Object.keys(MARKET_META), ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON'])
  assert.equal(Object.values(MARKET_META).filter(m => m.verifiedByDefault).length, 8)
  // 市场标签会直接写进 control 记录: 不满足 tagName 的取值会让添加自选在写入兜底处 500
  for (const [exchange, meta] of Object.entries(MARKET_META)) assert.ok(tagName.safeParse(meta.tag).success, `${exchange} 的市场标签必须合法: ${meta.tag}`)
})

test('多市场证券构造: 港/美/日按 MARKET_META 派生币种时区精度', () => {
  const hk = makeSecurity('XHKG', '00700', '腾讯控股')
  assert.equal(hk.id, 'XHKG:equity:00700')
  assert.deepEqual({ currency: hk.currency, timezone: hk.timezone, priceScale: hk.priceScale }, { currency: 'HKD', timezone: 'Asia/Hong_Kong', priceScale: 2 })
  const us = makeSecurity('XNAS', 'AAPL', 'Apple')
  assert.deepEqual({ currency: us.currency, priceScale: us.priceScale }, { currency: 'USD', priceScale: 2 })
  const jp = makeSecurity('XJPX', '7203', 'トヨタ')
  assert.deepEqual({ currency: jp.currency, priceScale: jp.priceScale }, { currency: 'JPY', priceScale: 0 })
})

test('沪深既有值不变且美股大写代码约束', () => {
  const sh = makeSecurity('XSHG', '600519', '贵州茅台')
  assert.deepEqual({ currency: sh.currency, timezone: sh.timezone, priceScale: sh.priceScale }, { currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2 })
  assert.throws(() => securityId('XHKG', 'ABC'))
  assert.doesNotThrow(() => securityId('XNAS', 'AAPL'))
  assert.throws(() => securityId('XX', '600519'))
})

test('parseSecurityId 正反例', () => {
  const parsed = parseSecurityId('XHKG:equity:00700')
  assert.deepEqual({ exchange: parsed.exchange, code: parsed.code }, { exchange: 'XHKG', code: '00700' })
  assert.equal(parsed.meta.currency, 'HKD')
  assert.throws(() => parseSecurityId('XHKG:equity:ABC'))
  assert.throws(() => parseSecurityId('XSHG:bond:600519'))
  assert.throws(() => parseSecurityId('garbage'))
})

test('G11 归一到分: 来源三位及以上小数按四舍五入保留, 不再整行判无效', async () => {
  const { normalizeQuote } = await import('../src/market-model.mjs')
  const quote = last => normalizeQuote({ securityId: 'XNAS:equity:GT', last, previousClose: '4.55' })
  assert.equal(quote('4.755').last, '4.76', '三位小数向上进位')
  assert.equal(quote('4.745').last, '4.75', '三位小数向上进位')
  assert.equal(quote('189.285').last, '189.29', '大额价格同样进位')
  assert.equal(quote('4.754').last, '4.75', '第三位小于五不进位')
  assert.equal(quote('4.7').last, '4.70', '一位小数补齐两位')
  assert.equal(quote('4.75').last, '4.75', '两位小数原样保留')
  assert.equal(quote('0.001').last, null, '进位后为零仍视为无值')
  assert.equal(quote('4.755').change, '0.21', '涨跌额随归一分值计算')
})
