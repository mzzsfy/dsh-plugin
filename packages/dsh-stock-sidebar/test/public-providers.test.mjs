import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../src/provider-registry.mjs'
import { tencent } from '../src/providers/tencent.mjs'
import { sina } from '../src/providers/sina.mjs'
import { eastmoney } from '../src/providers/eastmoney.mjs'
import { makeSecurity } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')
const req = { providerInstanceId: 'web-one', securities: [security], market: 'XSHG' }
const gbkCtx = body => ({ now: () => 100, signal: new AbortController().signal, fetch: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer }) })
const jsonCtx = body => ({ now: () => 100, signal: new AbortController().signal, fetch: async () => ({ ok: true, json: async () => body }) })
test('腾讯适配器按~列位解析GBK响应并保留快照时间', async () => {
  const f = Array.from({ length: 88 }, (_, i) => '')
  f[1] = '贵州茅台'; f[3] = '1369.51'; f[4] = '1354.00'; f[5] = '1363.00'; f[30] = '20261030110000'; f[33] = '1376.00'; f[34] = '1352.98'; f[36] = '23651'; f[37] = '323408'
  // 真实多字节GB2312字节流:GBK编码的"贵州茅台"作为字段1,其余~分隔字段保持列位。
  const gbkName = Buffer.from([0xB9, 0xF3, 0xD6, 0xDD, 0xC3, 0xA9, 0xCC, 0xA8])
  const frame = Buffer.concat([Buffer.from('v_sh600519="~'), gbkName, Buffer.from('~' + f.slice(2).join('~') + '";')])
  const result = await tencent.quotes(req, { now: () => 100, signal: new AbortController().signal, fetch: async () => ({ ok: true, arrayBuffer: async () => frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) }) })
  assert.equal(result.items[0].securityId, security.id)
  assert.equal(result.items[0].last, '1369.51')
  assert.equal(result.items[0].previousClose, '1354.00')
  assert.equal(result.items[0].quoteAt, '2026-10-30T03:00:00.000Z')
  assert.equal(result.items[0].volume, '2365100')
  assert.equal(result.items[0].delayKind, 'unknown')
})
test('新浪适配器按逗号列位解析且缺行记NO_DATA', async () => {
  const f = Array.from({ length: 34 }, (_, i) => '')
  f[0] = '贵州茅台'; f[1] = '1363.000'; f[2] = '1354.000'; f[3] = '1369.510'; f[4] = '1376.000'; f[5] = '1352.980'; f[8] = '2365407'; f[9] = '3234488592'; f[30] = '2026-10-30'; f[31] = '11:00:01'
  const other = makeSecurity('XSHG', '601318', '中国平安')
  const result = await sina.quotes({ ...req, securities: [security, other] }, gbkCtx(`var hq_str_sh600519="${f.join(',')}";`))
  assert.equal(result.items[0].last, '1369.51')
  assert.equal(result.items[0].changePct, '1.15')
  assert.equal(result.items[0].quoteAt, '2026-10-30T03:00:01.000Z')
  assert.deepEqual(result.errors.map(e => e.securityId), [other.id])
})
test('东财适配器解析JSON diff结构且停牌"-"不伪造价格', async () => {
  const result = await eastmoney.quotes(req, jsonCtx({ data: { diff: [{ f2: 1369.51, f5: 23654, f6: 3234488592, f12: '600519', f13: 1, f14: '贵州茅台', f15: 1376, f16: 1352.98, f17: 1363, f18: 1354, f124: 1793329204 }] } }))
  assert.equal(result.items[0].last, '1369.51')
  assert.equal(result.items[0].previousClose, '1354.00')
  assert.equal(result.items[0].quoteAt, new Date(1793329204 * 1000).toISOString())
  const halted = await eastmoney.quotes(req, jsonCtx({ data: { diff: [{ f2: '-', f5: '-', f6: '-', f12: '600519', f13: 1, f15: '-', f16: '-', f17: '-', f18: 1354, f124: 1793329204 }] } }))
  assert.equal(halted.items[0].last, null)
  assert.equal(halted.items[0].change, null)
})
test('东财目录分页合并、市场过滤与身份冲突拒绝', async () => {
  const requests = []
  const ctx = { now: () => 100, signal: new AbortController().signal, fetch: async url => {
    requests.push(url)
    const page = Number(/pn=(\d+)/.exec(url)[1])
    const rows = page === 1 ? [{ f12: '600519', f13: 1, f14: '贵州茅台' }, { f12: '688981', f13: 1, f14: '中芯国际' }] : [{ f12: '000001', f13: 0, f14: '深市混入' }]
    return { ok: true, json: async () => ({ data: { total: 2, diff: rows } }) }
  } }
  const result = await eastmoney.catalog({ providerInstanceId: 'em', market: 'XSHG' }, ctx)
  assert.equal(requests.length, 1)
  assert.deepEqual(result.items.map(i => i.code), ['600519', '688981'])
  assert.equal(result.complete, true)
  const conflict = { now: () => 0, signal: new AbortController().signal, fetch: async () => ({ ok: true, json: async () => ({ data: { total: 2, diff: [{ f12: '600519', f13: 1, f14: '重复' }, { f12: '600519', f13: 1, f14: '再次' }] } }) }) }
  await assert.rejects(eastmoney.catalog({ providerInstanceId: 'em', market: 'XSHG' }, conflict), e => e.code === 'BAD_PAYLOAD')
})
test('东财搜索联想过滤非A股与跨市场行', async () => {
  const ctx = { now: () => 100, signal: new AbortController().signal, fetch: async () => ({ ok: true, json: async () => ({ QuotationCodeTable: { Data: [
    { Code: '600519', Name: '贵州茅台', PinYin: 'GZMT', MktNum: '1', Classify: 'AStock' },
    { Code: '00700', Name: '腾讯控股', MktNum: '116', Classify: 'HKStock' },
    { Code: '000001', Name: '平安银行', PinYin: 'PAYH', MktNum: '0', Classify: 'AStock' },
  ] } }) }) }
  const result = await eastmoney.search({ providerInstanceId: 'em', market: 'XSHG', q: 'gzmt', limit: 10 }, ctx)
  assert.deepEqual(result.items.map(i => i.code), ['600519'])
  assert.equal(result.items[0].cnspell, 'gzmt')
})
test('新浪目录分页过滤沪深以外板块并按短页终止', async () => {
  const requests = []
  const row = (code, symbol, name) => ({ code, symbol, name })
  const ctx = { now: () => 100, signal: new AbortController().signal, fetch: async url => {
    requests.push(url)
    if (!/node=sh_a/.test(url)) return { ok: true, json: async () => [] }
    const page = Number(/page=(\d+)/.exec(url)[1])
    const rows = page === 1 ? [row('600001', 'sh600001', '沪市甲'), row('000001', 'sz000001', '深市混入')] : []
    return { ok: true, json: async () => rows }
  } }
  const result = await sina.catalog({ providerInstanceId: 'sn', market: 'XSHG' }, ctx)
  assert.equal(requests.length, 2)
  assert.deepEqual(result.items.map(i => i.code), ['600001'])
  assert.equal(result.complete, true)
  const full = { now: () => 0, signal: new AbortController().signal, fetch: async () => ({ ok: true, json: async () => [row('600001', 'sh600001', '甲'), row('600001', 'sh600001', '重复')] }) }
  await assert.rejects(sina.catalog({ providerInstanceId: 'sn', market: 'XSHG' }, full), e => e.code === 'BAD_PAYLOAD')
})
test('免凭据实例跳过Host环境检查但必须声明保守预算', async () => {
  const { parseConfiguration } = await import('../src/schemas.mjs')
  const base = { id: 'em-one', adapterId: 'eastmoney', enabled: true, credentialEnv: null, quotaGroup: 'free', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }
  assert.doesNotThrow(() => parseConfiguration({ providers: [base], routes: [] }))
  assert.throws(() => parseConfiguration({ providers: [{ ...base, budget: { ...base.budget, requestsPerMinute: null } }], routes: [] }))
  const { createExecutor } = await import('../src/executor.mjs')
  const { createBudget } = await import('../src/budget.mjs')
  let reached = false
  const registry = createRegistry([{ descriptor: { ...eastmoney.descriptor, capabilities: ['quotes'] }, probe() {}, async quotes(request, ctx) { await ctx.fetch('http://fixture'); reached = true; return { items: [] } } }])
  const executor = createExecutor({ registry, budget: createBudget(), env: {}, fetch: async () => ({}) })
  await executor.run(base, 'quotes', {})
  assert.equal(reached, true)
  executor.dispose()
})
test('三个公开适配器合同完整且网络错误归NETWORK', async () => {
  const registry = createRegistry([tencent, sina])
  for (const adapter of [tencent, sina]) {
    assert.doesNotThrow(() => registry.validate({ adapterId: adapter.descriptor.adapterId }, { capability: 'quotes', market: 'XSHG', instrument: 'equity' }))
    assert.throws(() => registry.validate({ adapterId: adapter.descriptor.adapterId }, { capability: 'calendar', market: 'XSHG', instrument: 'equity' }), e => e.code === 'UNSUPPORTED_CAPABILITY')
  }
  assert.doesNotThrow(() => registry.validate({ adapterId: 'sina' }, { capability: 'catalog', market: 'XSHE', instrument: 'equity' }))
  const emRegistry = createRegistry([eastmoney])
  assert.doesNotThrow(() => emRegistry.validate({ adapterId: 'eastmoney' }, { capability: 'quotes', market: 'XSHG', instrument: 'equity' }))
  assert.doesNotThrow(() => emRegistry.validate({ adapterId: 'eastmoney' }, { capability: 'catalog', market: 'XSHE', instrument: 'equity' }))
  assert.doesNotThrow(() => emRegistry.validate({ adapterId: 'eastmoney' }, { capability: 'search', market: 'XSHE', instrument: 'equity' }))
  assert.throws(() => emRegistry.validate({ adapterId: 'eastmoney' }, { capability: 'calendar', market: 'XSHG', instrument: 'equity' }), e => e.code === 'UNSUPPORTED_CAPABILITY')
  const brokenCtx = { now: () => 0, signal: new AbortController().signal, fetch: async () => { throw Error('offline') } }
  await assert.rejects(tencent.quotes(req, brokenCtx), e => e.code === 'NETWORK')
  await assert.rejects(sina.quotes(req, brokenCtx), e => e.code === 'NETWORK')
  await assert.rejects(eastmoney.quotes(req, brokenCtx), e => e.code === 'NETWORK')
})
