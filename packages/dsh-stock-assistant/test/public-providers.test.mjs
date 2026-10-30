import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../src/provider-registry.mjs'
import { tencent } from '../src/providers/tencent.mjs'
import { sina } from '../src/providers/sina.mjs'
import { eastmoney } from '../src/providers/eastmoney.mjs'
import { makeSecurity } from '../src/market-model.mjs'

// ---- Step 1.4: 东财 kline ----

const klineCtx = (bodies, log = []) => {
  let i = 0
  return { now: () => 100, signal: new AbortController().signal, usSymbols: new Map(), fetch: async url => { log.push(String(url)); const body = bodies[Math.min(i++, bodies.length - 1)]; return { ok: true, json: async () => typeof body === 'function' ? body(url) : body } } }
}
const KLINE_REQ = (market, code, period = '1d', limit = 250) => ({ providerInstanceId: 'em', securityId: `${market}:equity:${code}`, market, code, period, adjust: 'qfq', limit })
const CSV_OK = '2026-10-29,11.30,11.54,11.55,11.29,1993504,2283899682.66'

test('东财 secid 前缀多市场映射与美股动态归属', async () => {
  const log = []
  const ctx = klineCtx([{ data: { klines: [CSV_OK], preKPrice: '11.31', dktotal: 100 } }], log)
  await eastmoney.kline(KLINE_REQ('XHKG', '00700'), ctx)
  assert.ok(log[0].includes('secid=116.00700'))
  const ctx2 = klineCtx([{ data: { klines: [CSV_OK], preKPrice: '227.5', dktotal: 5000 } }], log)
  ctx2.usSymbols.set('US:AAPL', { mktNum: '105', jys: 'NASDAQ', at: 1 })
  await eastmoney.kline(KLINE_REQ('XNAS', 'AAPL'), ctx2)
  assert.ok(log.at(-1).includes('secid=105.AAPL'))
})

test('东财 kline CSV 列序 f52=open/f53=close 与 preKPrice 与源截断标志', async () => {
  const ctx = klineCtx([{ data: { klines: [CSV_OK], preKPrice: '11.31', dktotal: 100 } }])
  const result = await eastmoney.kline(KLINE_REQ('XSHG', '600519'), ctx)
  const c = result.candles[0]
  assert.deepEqual({ time: c.time, open: c.open, close: c.close, high: c.high, low: c.low, volume: c.volume }, { time: '2026-10-29', open: 11.30, close: 11.54, high: 11.55, low: 11.29, volume: 1993504 })
  assert.equal(result.preClose, 11.31)
  // dktotal(100) < limit(250): 数据不足请求量, complete=false(源截断)
  assert.equal(result.complete, false)
  const full = klineCtx([{ data: { klines: [CSV_OK], preKPrice: '11.31', dktotal: 250 } }])
  assert.equal((await eastmoney.kline(KLINE_REQ('XSHG', '600519'), full)).complete, true)
})

test('东财 kline klt 周期映射 101/102/103 与 lmt/fqt', async () => {
  const log = []
  const body = { data: { klines: [CSV_OK], preKPrice: '11.31', dktotal: 100 } }
  const ctx = klineCtx([body, body, body], log)
  await eastmoney.kline(KLINE_REQ('XSHE', '000001', '1d'), ctx)
  await eastmoney.kline(KLINE_REQ('XSHE', '000001', '1w'), ctx)
  await eastmoney.kline(KLINE_REQ('XSHE', '000001', '1M'), ctx)
  assert.ok(log[0].includes('klt=101&fqt=1&end=20500101&lmt=250'))
  assert.ok(log[1].includes('klt=102'))
  assert.ok(log[2].includes('klt=103'))
})

test('东财 trend trends2 8列含avg与preClose', async () => {
  const ctx = klineCtx([{ data: { trends: ['2026-10-30 09:30,11.53,11.53,11.53,11.53,11523,13286019.00,11.530', '2026-10-30 09:31,11.54,11.54,11.54,11.54,8000,9200000.00,11.531'], preClose: 11.54 } }])
  const result = await eastmoney.kline(KLINE_REQ('XSHE', '000001', 'trend'), ctx)
  assert.equal(result.candles.length, 2)
  assert.deepEqual({ time: result.candles[0].time, avg: result.candles[0].avg, open: result.candles[0].open }, { time: '09:30', avg: 11.53, open: 11.53 })
  assert.equal(result.preClose, 11.54)
})

test('东财 kline 列数不足与乱序重复 BAD_PAYLOAD', async () => {
  const short = klineCtx([{ data: { klines: ['2026-10-29,11.30,11.54'], preKPrice: '11.31', dktotal: 10 } }])
  await assert.rejects(() => eastmoney.kline(KLINE_REQ('XSHG', '600519'), short), e => e.code === 'BAD_PAYLOAD')
  const dup = klineCtx([{ data: { klines: [CSV_OK, CSV_OK], preKPrice: '11.31', dktotal: 10 } }])
  await assert.rejects(() => eastmoney.kline(KLINE_REQ('XSHG', '600519'), dup), e => e.code === 'BAD_PAYLOAD')
  const unordered = klineCtx([{ data: { klines: ['2026-10-30,11.30,11.54,11.55,11.29,1,2', '2026-10-29,11.30,11.54,11.55,11.29,1,2'], preKPrice: '11.31', dktotal: 10 } }])
  await assert.rejects(() => eastmoney.kline(KLINE_REQ('XSHG', '600519'), unordered), e => e.code === 'BAD_PAYLOAD')
})

test('东财 kline 美股默认105 data:null→suggest 解析重试一次', async () => {
  const log = []
  const suggestBody = { QuotationCodeTable: { Data: [{ Code: 'BABA', Name: '阿里巴巴', MktNum: '106', JYS: 'NYSE', QuoteID: '106.BABA', Classify: 'UsStock' }] } }
  const babaOk = { data: { klines: ['2026-10-29,90.10,91.20,91.50,89.90,12345678,1123000000.00'], preKPrice: '89.80', dktotal: 3000 } }
  const bodies = [url => url.includes('push2his') ? { data: null } : suggestBody, url => url.includes('push2his') ? babaOk : suggestBody]
  const ctx = klineCtx(bodies, log)
  const result = await eastmoney.kline(KLINE_REQ('XNAS', 'BABA'), ctx)
  assert.ok(log[0].includes('secid=105.BABA'))
  assert.ok(log[1].includes('searchapi'))
  assert.ok(log[2].includes('secid=106.BABA'))
  assert.equal(result.candles[0].close, 91.20)
  assert.equal(ctx.usSymbols.get('US:BABA').mktNum, '106')
})

test('东财 kline 美股二次失败 NO_DATA 而非死循环', async () => {
  const suggestBody = { QuotationCodeTable: { Data: [{ Code: 'XX', MktNum: '105', QuoteID: '105.XX', Classify: 'UsStock' }] } }
  const ctx = klineCtx([url => url.includes('push2his') ? { data: null } : suggestBody])
  await assert.rejects(() => eastmoney.kline(KLINE_REQ('XNAS', 'XX'), ctx), e => e.code === 'NO_DATA')
})

test('东财 kline 非美股 data:null 直接 NO_DATA', async () => {
  const ctx = klineCtx([{ data: null }])
  await assert.rejects(() => eastmoney.kline(KLINE_REQ('XSHG', '600519'), ctx), e => e.code === 'NO_DATA')
})

// ---- Step 1.5: 腾讯 kline 备源 ----

const tencentKlineCtx = (body, log = []) => ({ now: () => 100, signal: new AbortController().signal, usSymbols: new Map(), fetch: async url => { log.push(String(url)); return { ok: true, json: async () => body } } })

test('腾讯 kline 三市场 symbol 映射与 param 形态与 preClose 索引', async () => {
  const log = []
  const body = { data: { sz000001: { qfqday: [['2026-10-29', '11.30', '11.54', '11.55', '11.29', '1993504']], qt: { sz000001: ['51', '平安银行', '000001', '11.64', '11.54', '11.30'] } } } }
  const ctx = tencentKlineCtx(body, log)
  const result = await tencent.kline(KLINE_REQ('XSHE', '000001'), ctx)
  assert.ok(log[0].includes('param=sz000001,day,,,250,qfq'))
  assert.deepEqual(result.candles[0], { time: '2026-10-29', open: 11.30, close: 11.54, high: 11.55, low: 11.29, volume: 1993504 })
  assert.equal(result.preClose, 11.54, 'qt[4]=昨收(实测定案)')
  const hk = tencentKlineCtx({ data: { hk00700: { qfqday: [['2026-10-29', '380', '385', '386', '379', '10000000']] } } }, log)
  await tencent.kline(KLINE_REQ('XHKG', '00700'), hk)
  assert.ok(log.at(-1).includes('param=hk00700,day'))
  const week = tencentKlineCtx({ data: { sz000001: { qfqweek: [['2026-10-25', '11', '11.5', '11.6', '10.9', '900000']] } } }, log)
  await tencent.kline(KLINE_REQ('XSHE', '000001', '1w'), week)
  assert.ok(log.at(-1).includes('param=sz000001,week'))
})

test('腾讯 kline 键名漂移兜底(只给 qfqweek 键)', async () => {
  const ctx = tencentKlineCtx({ data: { sh600519: { qfqweek: [['2026-10-25', '1370', '1392', '1396', '1362', '23651']] } } })
  const result = await tencent.kline(KLINE_REQ('XSHG', '600519', '1w'), ctx)
  assert.equal(result.candles[0].close, 1392)
})

test('腾讯 kline trend 拒绝与乱序拒绝', async () => {
  await assert.rejects(() => tencent.kline(KLINE_REQ('XSHG', '600519', 'trend'), tencentKlineCtx({})), e => e.code === 'UNSUPPORTED_CAPABILITY')
  const ctx = tencentKlineCtx({ data: { sz000001: { day: [['2026-10-29', '11.30', '11.54', '11.55', '11.29', '1993504'], ['2026-10-28', '11', '11', '11', '11', '1']] } } })
  await assert.rejects(() => tencent.kline(KLINE_REQ('XSHE', '000001'), ctx), e => e.code === 'BAD_PAYLOAD')
})

test('腾讯 kline 美股无映射拒绝 含提示文案', async () => {
  await assert.rejects(() => tencent.kline(KLINE_REQ('XNAS', 'AAPL'), tencentKlineCtx({})), e => { assert.equal(e.code, 'UNSUPPORTED_CAPABILITY'); assert.match(e.message, /代码映射/); return true })
})

test('腾讯 kline 美股 JYS 映射 suffix 正确拼入', async () => {
  const log = []
  const ctx = tencentKlineCtx({ data: { 'usAAPL.OQ': { qfqday: [['2026-10-29', '255', '258', '259', '254', '50000000']] } } }, log)
  ctx.usSymbols.set('US:AAPL', { mktNum: '105', jys: 'NASDAQ', at: 1 })
  const result = await tencent.kline(KLINE_REQ('XNAS', 'AAPL'), ctx)
  assert.ok(log[0].includes('param=usAAPL.OQ,day'))
  assert.equal(result.candles[0].close, 258)
  const nyse = tencentKlineCtx({ data: { 'usBABA.N': { qfqday: [['2026-10-29', '90', '91', '92', '89', '12000000']] } } }, log)
  nyse.usSymbols.set('US:BABA', { mktNum: '106', jys: 'NYSE', at: 1 })
  await tencent.kline(KLINE_REQ('XNAS', 'BABA'), nyse)
  assert.ok(log.at(-1).includes('param=usBABA.N,day'))
  // AMEX: 腾讯 .A 形态返回空数据(实测), 走裸代码兜底
  const amex = tencentKlineCtx({ data: { usSPY: { qfqday: [['2026-10-29', '765', '769', '770', '764', '70000000']] } } }, log)
  amex.usSymbols.set('US:SPY', { mktNum: '107', jys: 'AMEX', at: 1 })
  await tencent.kline(KLINE_REQ('XNAS', 'SPY'), amex)
  assert.ok(log.at(-1).includes('param=usSPY,day'))
})

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
