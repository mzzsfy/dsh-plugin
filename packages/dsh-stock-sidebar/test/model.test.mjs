import test from 'node:test'
import assert from 'node:assert/strict'
import { securityId, normalizeQuote, parseQuoteTime } from '../src/market-model.mjs'

test('M01 标准身份包含交易所与品种，保留前导零', () => {
  assert.equal(securityId('XSHE', '000001'), 'XSHE:equity:000001')
  assert.notEqual(securityId('XSHG', '000001'), securityId('XSHE', '000001'))
  assert.throws(() => securityId('XSHE', 1), /证券/)
})

test('M03 缺昨收和零价不会伪造涨跌', () => {
  assert.equal(normalizeQuote({ last: '10', previousClose: 0 }).changePct, null)
  assert.equal(normalizeQuote({ last: 0, previousClose: 10 }).last, null)
  assert.equal(normalizeQuote({ last: '1.234', previousClose: 1 }).last, null)
})

test('M04 不把不完整的交易时间伪装成当前时间', () => {
  assert.equal(parseQuoteTime('2026-10-29'), null)
  assert.equal(parseQuoteTime('2026-02-30 10:00:00'), null)
  assert.equal(parseQuoteTime('2026-10-29 14:30:05'), '2026-10-29T06:30:05.000Z')
})

test('M02 同源价格以整数分派生涨跌，零与缺值有不同语义', () => {
  const q = normalizeQuote({ securityId: 'XSHG:equity:600519', last: '10.00', previousClose: '8.00' })
  assert.equal(q.change, '2.00')
  assert.equal(q.changePct, '25.00')
  assert.equal(normalizeQuote({ last: '8', previousClose: '8' }).changePct, '0.00')
})
