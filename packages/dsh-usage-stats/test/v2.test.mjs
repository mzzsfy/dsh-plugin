// v2 纯逻辑层测试:账本 v2 会话索引、币种折算、价格匹配链、汇率、CSV、仪表盘点位、JS 费用条沙箱。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createLedger,
  dayKeyOf,
  recordCall,
  pruneLedger,
  ensureSessionsIndex,
  sessionTotals,
} from '../src/ledger.mjs'
import {
  normalizeCustomPrices,
  matchPrice,
  nativeCostOfCall,
  toUsd,
  catalogOrFallback,
} from '../src/pricing.mjs'
import { DEFAULT_USD_CNY, RATE_TTL_MS, isRateStale, parseTencentRate, parseErApiRate, resolveRate } from '../src/rates.mjs'
import { csvCell, csvRow, toCsv } from '../src/csv.mjs'
import { monthOverview, dayTrend, monthHeatmap, sessionsView, buildDashboard } from '../src/dashboard.mjs'
import { compileFeeBar, renderFeeBar, turnCostOf, FEE_BAR_SAMPLE } from '../src/feebar.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const PER_MILLION = 1000000

function callAt(ts, overrides) {
  return Object.assign({
    at: ts,
    sessionId: 'sess-1',
    model: 'deepseek-chat',
    provider: 'deepseek',
    inputTokens: 1000,
    cacheReadTokens: 500,
    outputTokens: 200,
  }, overrides)
}

// ---- 账本 v2:顶层会话索引 ----

test('账本 v2:recordCall 同步累加顶层会话索引,firstAt/lastAt 取 call.at', () => {
  const t0 = new Date(2026, 1, 26, 10).getTime()
  const ledger = createLedger()
  recordCall(ledger, callAt(t0), 0.01)
  recordCall(ledger, callAt(t0 + DAY_MS, { inputTokens: 2000 }), 0.02)
  const row = ledger.sessions['sess-1']
  assert.equal(row.firstAt, t0)
  assert.equal(row.lastAt, t0 + DAY_MS)
  assert.equal(row.calls, 2)
  assert.equal(row.inputTokens, 3000)
  assert.ok(Math.abs(row.cost - 0.03) < 1e-9)
  // 按日聚合并存
  assert.equal(Object.keys(ledger.days).length, 2)
})

test('账本 v2:旧结构载入视为空索引,增量写入不回填,版本号置位', () => {
  const t0 = new Date(2026, 1, 26, 10).getTime()
  const legacy = { version: 1, days: {} }
  const ledger = ensureSessionsIndex(legacy)
  assert.equal(ledger.version, 2, '旧账本载入后版本号升级为当前版本')
  assert.deepEqual(Object.keys(ledger.sessions), [])
  recordCall(ledger, callAt(t0, { sessionId: 'sess-new' }), 0.02)
  assert.equal(ledger.sessions['sess-new'].calls, 1)
  assert.equal(ledger.sessions['sess-1'], undefined)
})

test('账本 v2:修剪按 lastAt 清理超期会话索引', () => {
  const base = new Date(2026, 1, 26, 10).getTime()
  const ledger = createLedger()
  recordCall(ledger, callAt(base), 0.01)
  recordCall(ledger, callAt(base - 30 * DAY_MS, { sessionId: 'old' }), 0.01)
  pruneLedger(ledger, dayKeyOf(base), 3)
  assert.equal(ledger.sessions['old'], undefined)
  assert.ok(ledger.sessions['sess-1'])
})

test('账本 v2:sessionTotals 跨日合并读数', () => {
  const t0 = new Date(2026, 1, 26, 10).getTime()
  const ledger = createLedger()
  recordCall(ledger, callAt(t0), 0.01)
  recordCall(ledger, callAt(t0 + DAY_MS, { sessionId: 'sess-2' }), 0.02)
  const totals = sessionTotals(ledger, 'sess-1')
  assert.equal(totals.calls, 1)
  assert.equal(sessionTotals(ledger, 'missing'), null)
})

// ---- 币种折算与价格匹配链 ----

test('计价:CNY 原生直算,USD 按汇率折算入账本 USD 口径', () => {
  const cny = { input: 2, output: 4, cacheRead: 0.2, currency: 'CNY' }
  const native = nativeCostOfCall({ inputTokens: PER_MILLION, cacheReadTokens: 0, outputTokens: 0 }, cny)
  assert.equal(native.currency, 'CNY')
  assert.ok(Math.abs(native.amount - 2) < 1e-9)
  // 汇率 8 CNY/USD,2 CNY = 0.25 USD
  assert.ok(Math.abs(toUsd(native.amount, 'CNY', 8) - 0.25) < 1e-9)
  const usd = nativeCostOfCall({ inputTokens: PER_MILLION, cacheReadTokens: 0, outputTokens: 0 }, { input: 2, output: 4, cacheRead: null, currency: 'USD' })
  assert.ok(Math.abs(usd.amount - 2) < 1e-9)
  assert.ok(Math.abs(toUsd(2, 'USD', 8) - 2) < 1e-9)
})

test('自定义单价:归一化支持精确与前缀键,大小写不敏感', () => {
  const table = normalizeCustomPrices([
    { model: 'DeepSeek/DeepSeek-Chat', input: 2, output: 4, cacheRead: 0.2, currency: 'CNY' },
    { model: 'deepseek-r', input: 1, output: 2, cacheRead: null, currency: 'CNY' },
  ])
  assert.equal(table.length, 2)
  assert.deepEqual(table[0].keys, ['deepseek/deepseek-chat', 'deepseek-chat'])
  assert.deepEqual(table[1].keys, ['deepseek-r'])
})

test('匹配链:自定义 provider/model 精确 -> 自定义精确 -> 自定义最长前缀 -> 目录价', () => {
  const custom = normalizeCustomPrices([
    { model: 'deepseek/deepseek-chat', input: 2, output: 4, cacheRead: null, currency: 'CNY' },
    { model: 'deepseek-chat', input: 8, output: 8, cacheRead: null, currency: 'CNY' },
    { model: 'gpt', input: 1, output: 1, cacheRead: null, currency: 'USD' },
  ])
  const catalog = normalizeCustomPrices([
    { model: 'openai/gpt-4', input: 10, output: 20, cacheRead: null, currency: 'USD' },
  ])
  assert.equal(matchPrice(custom, catalog, 'deepseek', 'deepseek-chat').tier, 'custom-full')
  assert.equal(matchPrice(custom, catalog, 'other', 'deepseek-chat').tier, 'custom-name')
  const prefix = matchPrice(custom, catalog, 'other', 'gpt-4o-mini')
  assert.equal(prefix.tier, 'custom-prefix')
  assert.equal(prefix.entry.currency, 'USD')
  // 设计文档顺序:自定义前缀先于目录价,即使目录价精确
  assert.equal(matchPrice(custom, catalog, 'openai', 'gpt-4').tier, 'custom-prefix')
  const onlyCatalog = normalizeCustomPrices([
    { model: 'openai/gpt-4', input: 10, output: 20, cacheRead: null, currency: 'USD' },
  ])
  assert.equal(matchPrice([], onlyCatalog, 'openai', 'gpt-4').tier, 'catalog')
  assert.equal(matchPrice(custom, catalog, 'x', 'none'), null)
})

// ---- 汇率 ----

test('汇率:解析腾讯财经与 er-api,超时判定,全失败沿用上次并标注非实时', () => {
  assert.ok(Math.abs(parseTencentRate('v_whUSDCNY="100~USDCNY~7.2531~..."') - 7.2531) < 1e-9)
  assert.equal(parseTencentRate('garbage'), null)
  assert.ok(Math.abs(parseErApiRate({ rates: { CNY: 7.1 } }) - 7.1) < 1e-9)
  assert.equal(parseErApiRate({}), null)
  const now = 1000 * RATE_TTL_MS
  assert.equal(isRateStale(now - RATE_TTL_MS + 1, now), false)
  assert.equal(isRateStale(now - RATE_TTL_MS - 1, now), true)
  const fresh = resolveRate({ rate: 7, fetchedAt: now - RATE_TTL_MS - 1, stale: true }, { ok: true, rate: 7.3 }, now)
  assert.ok(Math.abs(fresh.rate - 7.3) < 1e-9)
  assert.equal(fresh.stale, false)
  const stale = resolveRate({ rate: 7, fetchedAt: now - RATE_TTL_MS - 1, stale: false }, { ok: false }, now)
  assert.ok(Math.abs(stale.rate - 7) < 1e-9)
  assert.equal(stale.stale, true)
  const none = resolveRate(null, { ok: false }, now)
  assert.ok(Math.abs(none.rate - DEFAULT_USD_CNY) < 1e-9)
  assert.equal(none.fetchedAt, 0)
  assert.equal(none.stale, true)
})

// ---- CSV ----

test('CSV:公式注入防护与全字符集转义', () => {
  assert.equal(csvCell('=cmd'), "'=cmd")
  assert.equal(csvCell('+1'), "'+1")
  assert.equal(csvCell('-1'), "'-1")
  assert.equal(csvCell('@x'), "'@x")
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('行\n换'), '"行\n换"')
  assert.equal(csvCell('中文🚀'), '中文🚀')
  assert.equal(csvRow(['a', 'b']), 'a,b')
  const csv = toCsv([['h1', 'h2'], ['=x', 'y']])
  assert.ok(csv.startsWith('﻿'))
  assert.equal(csv.split('\r\n').length, 2)
})

// ---- 仪表盘聚合 ----

function monthLedger() {
  const ledger = createLedger()
  const mk = (y, m, d, cost) => recordCall(ledger, callAt(new Date(y, m, d, 10).getTime(), { sessionId: 's' + d }), cost)
  // 本月 3 天 + 上月 2 天(以 2026-03-15 为今天)
  mk(2026, 2, 15, 3)
  mk(2026, 2, 14, 1)
  mk(2026, 2, 13, 2)
  mk(2026, 1, 20, 5)
  mk(2026, 1, 21, 7)
  return ledger
}

test('概览:本月 Hero、按日均外推预计、今日与本周环比', () => {
  const todayKey = dayKeyOf(new Date(2026, 2, 15, 10).getTime())
  const overview = monthOverview(monthLedger(), todayKey)
  assert.ok(Math.abs(overview.month.cost - 6) < 1e-9)
  // 3 月 31 天,已过 15 天,6/15*31
  assert.ok(Math.abs(overview.projection - (6 / 15) * 31) < 1e-9)
  assert.ok(Math.abs(overview.todayRatio - 3) < 1e-9)
  assert.equal(overview.weekRatio, null)
  assert.equal(overview.month.calls, 3)
})

test('趋势:范围与视角切换,无数据日期为 null 不伪造', () => {
  const todayKey = dayKeyOf(new Date(2026, 2, 15, 10).getTime())
  const points = dayTrend(monthLedger(), todayKey, 5)
  assert.equal(points.length, 5)
  assert.ok(Math.abs(points[4].cost - 3) < 1e-9)
  assert.equal(points[3].date, '2026-03-14')
  assert.ok(Math.abs(points[3].cost - 1) < 1e-9)
  assert.equal(points[1].cost, null)
  assert.equal(points[1].tokens, 0)
})

test('热力图:当月逐日分档着色,悬停数据齐备', () => {
  const todayKey = dayKeyOf(new Date(2026, 2, 15, 10).getTime())
  const grid = monthHeatmap(monthLedger(), todayKey)
  assert.equal(grid.month, '2026-03')
  assert.equal(grid.days.length, 31)
  const d15 = grid.days.find((d) => d.date === '2026-03-15')
  assert.ok(Math.abs(d15.cost - 3) < 1e-9)
  assert.equal(d15.calls, 1)
  assert.equal(d15.tier > 0, true)
  const d1 = grid.days.find((d) => d.date === '2026-03-01')
  assert.equal(d1.cost, null)
  assert.equal(d1.tier, 0)
})

test('明细:读顶层索引按费用倒序,标题缺失由调用方以 ID 前缀兜底', () => {
  const ledger = monthLedger()
  recordCall(ledger, callAt(new Date(2026, 2, 15, 11).getTime(), { sessionId: 'big' }), 9)
  const rows = sessionsView(ledger, 10)
  assert.equal(rows[0].sessionId, 'big')
  assert.ok(rows[0].cost > rows[1].cost)
  assert.ok(rows[0].lastAt > 0)
})

test('仪表盘聚合:一次产出概览/趋势/热力图/明细,含 CNY 折算', () => {
  const todayKey = dayKeyOf(new Date(2026, 2, 15, 10).getTime())
  const dash = buildDashboard(monthLedger(), todayKey, { rate: 8, stale: false })
  assert.ok(dash.overview.monthCostCny > 0)
  assert.equal(dash.trend7.length, 7)
  assert.equal(dash.trend30.length, 30)
  assert.equal(dash.heatmap.month, '2026-03')
  assert.ok(dash.sessions.length > 0)
  assert.equal(dash.rate.stale, false)
})

// ---- 自定义 JS 费用条 ----

test('计价:目录价未就绪时回落兜底价,计费不静默丢失', () => {
  const table = catalogOrFallback(null)
  const matched = matchPrice([], table, 'deepseek', 'deepseek-chat')
  assert.ok(matched, '未就绪时仍能命中兜底价')
  const native = nativeCostOfCall({ inputTokens: PER_MILLION, cacheReadTokens: 0, outputTokens: PER_MILLION }, matched.entry)
  assert.ok(native.amount > 0, '未就绪时计费仍有值')
  const live = [{ keys: ['x/y', 'y'], input: 1, output: 2, cacheRead: null }]
  assert.equal(catalogOrFallback(live), live, '已就绪目录价原样返回')
})

test('费用条沙箱:合法函数返回字符串,异常与非字符串回退并带错误', () => {
  const ok = renderFeeBar('(data) => "费用 " + data.sessionCost', FEE_BAR_SAMPLE)
  assert.equal(ok.fallback, false)
  assert.ok(ok.text.indexOf('费用') === 0)
  const bad = renderFeeBar('(data) => { throw new Error("boom") }', FEE_BAR_SAMPLE)
  assert.equal(bad.fallback, true)
  assert.ok(bad.error.length > 0)
  const nonstr = renderFeeBar('(data) => 42', FEE_BAR_SAMPLE)
  assert.equal(nonstr.fallback, true)
  assert.equal(compileFeeBar('not a fn'), null)
})

test('费用条本轮费用:首样本置 0,后续差分且负值钳为 0', () => {
  assert.equal(turnCostOf(0.5, null), 0, '首样本无前值,无差分')
  assert.ok(Math.abs(turnCostOf(0.6, 0.5) - 0.1) < 1e-9)
  assert.equal(turnCostOf(0.4, 0.5), 0, '账本清零等负差分钳为 0')
})

test('CSV:制表符与回车前缀同样触发公式注入防护', () => {
  assert.equal(csvCell('\t=1'), "'\t=1")
  assert.equal(csvCell('\r=1'), '"\'\r=1"', '前缀单引号后含回车再走引号包裹')
  assert.equal(csvCell('a\tb'), 'a\tb', '非前缀制表符不改写(引号规则处理)')
})
