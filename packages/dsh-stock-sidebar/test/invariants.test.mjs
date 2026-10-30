import test from 'node:test'
import assert from 'node:assert/strict'
import { securitySchema, controlSchema, initialControl, parseConfiguration } from '../src/schemas.mjs'
import { makeSecurity, normalizeQuote } from '../src/market-model.mjs'
import { tushare } from '../src/providers/tushare.mjs'
test('标准身份与代码/交易所必须一致，权威自选顺序不得重复或缺项', () => {
  const s = makeSecurity('XSHG', '600519', '贵州茅台')
  assert.equal(securitySchema.safeParse({ ...s, exchange: 'XSHE' }).success, false)
  const c = initialControl(); c.watchlist = { order: [s.id, s.id], items: { [s.id]: { ...s, alias: '', pinned: false } } }
  assert.equal(controlSchema.safeParse(c).success, false)
})
test('涨跌半分远离零舍入，负跌幅与零值不丢失', () => {
  assert.equal(normalizeQuote({ last: '2.01', previousClose: '2' }).changePct, '0.50')
  assert.equal(normalizeQuote({ last: '1.99', previousClose: '2' }).changePct, '-0.50')
  assert.equal(normalizeQuote({ last: '3.01', previousClose: '3' }).changePct, '0.33')
})
test('Tushare权限响应及429 Retry-After映射且不泄露消息里的凭据', async () => {
  const request = { providerInstanceId: 'ts', securities: [makeSecurity('XSHG', '600519', '茅台')] }
  const context = response => ({ credential: () => 'do-not-expose', signal: new AbortController().signal, now: () => 0, fetch: async () => response })
  await assert.rejects(tushare.quotes(request, context({ ok: true, json: async () => ({ code: 2002, msg: 'do-not-expose' }) })), e => e.code === 'PERMISSION' && !e.message.includes('do-not-expose'))
  await assert.rejects(tushare.quotes(request, context({ ok: true, json: async () => ({ code: 40101, msg: 'token无效' }) })), e => e.code === 'AUTH')
  await assert.rejects(tushare.quotes(request, context({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '20' }) })), e => e.code === 'RATE_LIMIT' && e.retryAfterMs === 20000)
})
