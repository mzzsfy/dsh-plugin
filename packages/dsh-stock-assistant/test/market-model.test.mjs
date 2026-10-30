import test from 'node:test'
import assert from 'node:assert/strict'
import { MARKET_META, securityId, parseSecurityId, makeSecurity } from '../src/market-model.mjs'

test('MARKET_META 八市场齐全且五市场探针默认通过', () => {
  assert.deepEqual(Object.keys(MARKET_META), ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON'])
  assert.equal(Object.values(MARKET_META).filter(m => m.verifiedByDefault).length, 5)
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
