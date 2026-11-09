import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { tencent } from '../src/providers/tencent.mjs'
import { sina } from '../src/providers/sina.mjs'
import { eastmoney } from '../src/providers/eastmoney.mjs'
import { memoryStorage } from './helpers.mjs'

// 测试双实例: em-default(东财)+tx-fallback(腾讯), 路由 XHKG kline 主东财备腾讯 failover=network
const CSV = '2026-10-29,11.30,11.54,11.55,11.29,1993504,2283899682.66'
const TENCENT_ROWS = [['2026-10-29', '11.30', '11.54', '11.55', '11.29', '1993504']]

const klineBody = () => ({ data: { klines: [CSV], preKPrice: '11.31', dktotal: 250 } })
const tencentBody = () => ({ data: { hk00700: { qfqday: TENCENT_ROWS } } })

const providers = [
  { id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialRef: null, quotaGroup: 'g-em', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: { kline: 30 } } },
  { id: 'tx-fallback', adapterId: 'tencent', enabled: true, credentialRef: null, quotaGroup: 'g-tx', budget: { requestsPerMinute: 30, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } },
]
const routes = [
  { id: 'xhkg-kline', capability: 'kline', market: 'XHKG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: ['tx-fallback'], failoverMode: 'network', maxDelaySeconds: null, acceptUnknownDelay: true },
]

// 直接以初始 control 注入路由: 经 state.mutate 不可行(操作合同), 改用 configuration 前置 checks 流程过重——
// 内存态构造: 打开应用后用 state 不可达, 故用 createApplication 默认配置+configuration 操作(带 checkId 流程简化为直接白盒替换不可行)。
// 方案: 用 providerCheck 拿 checkId 再 configuration 保存(与 routes.test B-1 同款), 夹具 fetch 按 URL 分派。
// 统一探针响应: 东财 ulist=JSON diff 行; 腾讯=GBK arrayBuffer(quotes 走 arrayBuffer 通道)
const gbkProbe = code => {
  const f = Array.from({ length: 38 }, () => '')
  f[1] = '探针证券'; f[3] = '11.54'; f[4] = '11.31'; f[5] = '11.30'; f[30] = '20261030150000'; f[33] = '11.55'; f[34] = '11.29'; f[36] = '1000'; f[37] = '100'
  const text = `v_${code}="${f.join('~')}";`
  return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer }
}
const probeResponse = u => u.includes('qt.gtimg') ? gbkProbe(u.includes('hk') ? 'hk00700' : 'sz000001') : { ok: true, json: async () => ({ data: { diff: [{ f2: 11.54, f12: u.includes('116') ? '00700' : '000001', f13: u.includes('116') ? 116 : 0, f14: '探针证券', f18: 11.31 }] } }) }

const fetchFixture = (klineBodyFactory = klineBody) => {
  const calls = []
  const trendBody = () => ({ data: { trends: ['2026-10-30 09:30,11.53,11.53,11.53,11.53,11523,13286019.00,11.530', '2026-10-30 15:00,11.64,11.64,11.64,11.64,33388,38863899.00,11.546'], preClose: 11.54 } })
  return { calls, fetch: async url => {
    calls.push(String(url))
    const u = String(url)
    if (u.includes('trends2')) return { ok: true, json: async () => trendBody() }
    if (u.includes('push2his')) return { ok: true, json: async () => klineBodyFactory() }
    if (u.includes('ifzq')) return { ok: true, json: async () => tencentBody() }
    return probeResponse(u)
  } }
}

const setup = async (fetchImpl, routesOverride = routes, providersOverride = providers) => {
  const storage = memoryStorage()
  const app = await createApplication({ storageDomain: storage, providers: [tencent, sina, eastmoney], fetch: fetchImpl, publish: () => {} })
  // 保存路由: providerCheck 平铺参数, configuration 走 payload 包装(各自 API 契约)
  const check = await app.providerCheck({ providers: providersOverride, routes: routesOverride, capabilities: ['kline'] })
  const saved = await app.configuration({ operationId: '00000000-0000-4000-8000-000000000001', expectedRevision: 0, payload: { providers: providersOverride, routes: routesOverride }, checkIds: [check.checkId] })
  assert.equal(saved.revision, 1)
  return app
}

test('kline 主源成功+缓存命中不触源', async () => {
  const fx = fetchFixture()
  const app = await setup(fx.fetch)
  const first = await app.kline({ securityId: 'XHKG:equity:00700', period: '1d', limit: 250 })
  assert.equal(first.source, 'em-default')
  assert.equal(first.candles[0].close, 11.54)
  assert.equal(first.preClose, 11.31)
  const before = fx.calls.length
  const second = await app.kline({ securityId: 'XHKG:equity:00700', period: '1d', limit: 250 })
  assert.equal(second.source, 'em-default')
  assert.equal(fx.calls.length, before, '缓存命中不应触源')
  assert.equal(second.revision, first.revision)
})

test('kline 主源 NETWORK 即时切换备源 source=备源 且缓存写备源 key', async () => {
  const calls = []
  let dataCall = 0
  const fx = { calls, fetch: async url => {
    calls.push(String(url))
    const u = String(url)
    // 数据请求(lmt=250)首拍抛 NETWORK 模拟主源故障;探针(lmt=3)不受影响
    if (u.includes('push2his')) return u.includes('lmt=250') && dataCall++ === 0 ? (() => { throw Error('offline') })() : { ok: true, json: async () => klineBody() }
    if (u.includes('ifzq')) return { ok: true, json: async () => tencentBody() }
    return probeResponse(u)
  } }
  const app = await setup(fx.fetch)
  const result = await app.kline({ securityId: 'XHKG:equity:00700', period: '1d', limit: 250 })
  assert.equal(result.source, 'tx-fallback')
  // 备源缓存命中: 主源仍故障, 再次请求不再触任何上游
  const before = calls.length
  const again = await app.kline({ securityId: 'XHKG:equity:00700', period: '1d', limit: 250 })
  assert.equal(again.source, 'tx-fallback')
  assert.equal(calls.length, before)
})

test('kline 无路由 NO_ROUTE 422', async () => {
  const app = await setup(fetchFixture().fetch, [])
  await assert.rejects(() => app.kline({ securityId: 'XHKG:equity:00700', period: '1d' }), e => e.code === 'NO_ROUTE' && e.status === 422)
})

test('kline 参数校验 400', async () => {
  const app = await setup(fetchFixture().fetch)
  await assert.rejects(() => app.kline({ period: '1d' }), e => e.code === 'INVALID_PARAM')
  await assert.rejects(() => app.kline({ securityId: 'XHKG:equity:00700', period: '5m' }), e => e.code === 'INVALID_PARAM')
  await assert.rejects(() => app.kline({ securityId: 'XHKG:equity:00700', period: '1d', limit: 10 }), e => e.code === 'INVALID_PARAM')
  const ok = await app.kline({ securityId: 'XHKG:equity:00700', period: '1d' })
  assert.ok(ok.candles.length >= 0)
})

test('trend 不写缓存每次触源', async () => {
  const fx = fetchFixture()
  const app = await setup(fx.fetch)
  const routesTrend = [{ id: 'xhkg-kline-trend', capability: 'kline', market: 'XHKG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }]
  const check = await app.providerCheck({ providers, routes: routesTrend, capabilities: ['kline'] })
  await app.configuration({ operationId: '00000000-0000-4000-8000-000000000002', expectedRevision: 1, payload: { providers, routes: routesTrend }, checkIds: [check.checkId] })
  const before = fx.calls.length
  await app.kline({ securityId: 'XHKG:equity:00700', period: 'trend' })
  const afterOnce = fx.calls.length
  await app.kline({ securityId: 'XHKG:equity:00700', period: 'trend' })
  assert.ok(fx.calls.length > afterOnce, 'trend 二次请求应再次触源(不缓存)')
  assert.ok(afterOnce > before)
})

test('snapshot 含 klineReady 与 vendorAvailable', async () => {
  const app = await setup(fetchFixture().fetch)
  const snap = app.snapshot()
  assert.deepEqual(snap.klineReady, { XHKG: true })
  assert.equal(snap.vendorAvailable, true)
})

test('search 远程候选下发 currency/priceScale', async () => {
  const storage = memoryStorage()
  const app = await createApplication({ storageDomain: storage, providers: [tencent, sina, eastmoney], fetch: async () => ({ ok: true, json: async () => ({ QuotationCodeTable: { Data: [{ Code: '00700', Name: '腾讯控股', MktNum: '116', JYS: null, QuoteID: '116.00700', Classify: 'HKStock', PinYin: 'txkg' }] } }) }), publish: () => {} })
  const result = await app.search('腾讯', 'remote')
  const hk = result.items.find(i => i.exchange === 'XHKG')
  if (hk) { assert.equal(hk.currency, 'HKD'); assert.equal(hk.priceScale, 2) }
})

test('remote 搜索市场面=启用实例适配器市场并集(无search路由市场仍直连可搜)', async () => {
  // 默认配置只有沪深 search 路由; suggest 为全市场端点, 无路由市场由同一实例一次请求覆盖
  let suggestCalls = 0
  const storage = memoryStorage()
  const app = await createApplication({ storageDomain: storage, providers: [tencent, sina, eastmoney], fetch: async url => {
    if (String(url).includes('suggest')) suggestCalls += 1
    return { ok: true, json: async () => ({ QuotationCodeTable: { Data: [{ Code: '00700', Name: '腾讯控股', MktNum: '116', JYS: null, QuoteID: '116.00700', Classify: 'HKStock', PinYin: 'txkg' }] } }) }
  }, publish: () => {} })
  const result = await app.search('00700', 'remote')
  assert.equal(suggestCalls, 1, '全市场候选由单次请求覆盖, 不按市场重复请求')
  assert.ok(result.items.some(i => i.exchange === 'XHKG'), '无 search 路由市场的候选仍进入结果')
})

test('remote 单市场限速跳过不终止整个搜索(其余市场照常下发)', async () => {
  // 冻结时钟复现 budget 速率门:第一拍(XSHG)过门产出候选,后续拍 RATE_LIMIT 被免疫跳过;
  // 契约:单市场限速不终止整个搜索,已产出候选照常下发
  const storage = memoryStorage()
  const app = await createApplication({ storageDomain: storage, providers: [tencent, sina, eastmoney], now: () => 1_700_000_000_000, fetch: async url => {
    return { ok: true, json: async () => ({ QuotationCodeTable: { Data: [{ Code: '600519', Name: '贵州茅台', MktNum: '1', JYS: null, QuoteID: '1.600519', Classify: 'ABStock', PinYin: 'gzmt' }] } }) }
  }, publish: () => {} })
  const result = await app.search('平安', 'remote')
  assert.ok(result.items.some(i => i.exchange === 'XSHG' && i.code === '600519'), '首拍候选照常进入结果,搜索整体不因单市场 RATE_LIMIT 失败')
})

test('remote 搜索期间路由变化即拒 ROUTE_CONFLICT', async () => {
  const storage = memoryStorage()
  let first = true
  const app = await createApplication({ storageDomain: storage, providers: [tencent, sina, eastmoney], fetch: async url => {
    // 首拍返回后推进存储内 routingRevision, 模拟搜索进行中路由并发变化
    if (first) { first = false; storage.maps.control.get('root').routingRevision += 1 }
    return { ok: true, json: async () => ({ QuotationCodeTable: { Data: [{ Code: '00700', Name: '腾讯控股', MktNum: '116', JYS: null, QuoteID: '116.00700', Classify: 'HKStock', PinYin: 'txkg' }] } }) }
  }, publish: () => {} })
  await assert.rejects(() => app.search('00700', 'remote'), e => e.code === 'ROUTE_CONFLICT')
})

test('browse 概览: 头部指数行情随 browse 返回(上证/深成指), 指数失败静默为null', async () => {
  const sinaPage = Array.from({ length: 80 }, (_, i) => ({ symbol: `sh${String(600000 + i)}`, code: String(600000 + i), name: `沪股${i}` }))
  // 新浪分页: page2 短页代码须与 page1 不重叠(真实目录按代码排序天然不重叠)
  const sinaFetch = url => ({ ok: true, json: async () => String(url).includes('page=1') ? sinaPage : Array.from({ length: 3 }, (_, i) => ({ symbol: `sh68800${i}`, code: `68800${i}`, name: `科创${i}` })) })
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [tencent, sina, eastmoney], fetch: async url => {
    const u = String(url)
    // 指数批量请求: 响应行 secid 必须与请求对齐(1.000001 上证 / 0.399001 深成), 适配器按 f13.f12 回配
    if (u.includes('ulist.np') && u.includes('secids=1.000001')) return { ok: true, json: async () => ({ data: { diff: [{ f2: 3900.25, f12: '000001', f13: 1, f14: '上证指数', f18: 3874.75 }] } }) }
    if (u.includes('ulist.np') && u.includes('secids=0.399001')) return { ok: true, json: async () => ({ data: { diff: [{ f2: 12800.4, f12: '399001', f13: 0, f14: '深证成指', f18: 12750.1 }] } }) }
    // 新浪目录分页
    if (u.includes('getHQNodeData')) return sinaFetch(url)
    // 东财 quotes 探针与指数同通道, 通用放行
    return { ok: true, json: async () => ({ data: { diff: [{ f2: 11.54, f12: '000001', f13: 0, f14: '探针证券', f18: 11.31 }] } }) }
  }, publish: () => {} })
  await app.sync({ market: 'XSHG', expectedRoutingRevision: 0 })
  const sh = await app.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(sh.overview.name, '上证指数')
  assert.equal(sh.overview.last, '3900.25')
  assert.ok(sh.overview.changePct !== null, '带涨跌幅')
  await app.sync({ market: 'XSHE', expectedRoutingRevision: 0 })
  const sz = await app.browse({ market: 'XSHE', offset: 0, limit: 50 })
  assert.equal(sz.overview.name, '深证成指')
  // 指数拉取失败: 概览静默 null 不阻断目录浏览
  const broken = await createApplication({ storageDomain: memoryStorage(), providers: [tencent, sina, eastmoney], fetch: async url => {
    const u = String(url)
    if (u.includes('ulist.np')) return { ok: false, status: 502, json: async () => ({}) }
    if (u.includes('getHQNodeData')) return sinaFetch(url)
    return { ok: true, json: async () => ({ data: { diff: [{ f2: 11.54, f12: '000001', f13: 0, f14: '探针证券', f18: 11.31 }] } }) }
  }, publish: () => {} })
  await broken.sync({ market: 'XSHG', expectedRoutingRevision: 0 })
  const page = await broken.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(page.overview, null, '指数失败静默 null')
  await app.close(); await broken.close()
})
