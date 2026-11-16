// 常驻摘要宿主侧口径:三档一次读、桶起点计价、无规则零费用、预算状态复用花费读数。
// Given/When/Then 场景内嵌于用例描述;假 store 记录 rangeRows 次数,假 pricing 供应规则。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildBudgetStatus, buildSummary, readSpent } from '../src/summary.js'
import { recentMinuteBuckets } from '../src/store.js'

const TIME_ZONE = 'Asia/Shanghai'
const NOW_MS = Date.parse('2026-11-15T14:35:00+08:00')
const TODAY = '2026-11-15'
const MONTH_START = '2026-11-01'
const SPARK_FIRST = '2026-11-14T15'
const SPARK_LAST = '2026-11-15T14'
const RATE_FROM = '2026-11-15T14:00'
const RATE_TO = '2026-11-15T14:20'
const TOKENS_PER_MILLION = 1000 * 1000

const CURRENCY = '¥'
const RULES = [
  {
    model: 'p/m',
    currency: CURRENCY,
    price: { input: 10, output: 20, cacheRead: 1, cacheWrite: 5 },
  },
  // 日期段条件价:证明按日桶起点命中,而非按查询时刻命中
  {
    model: 'q/*',
    currency: CURRENCY,
    price: { input: 100 },
    conditions: [{ kind: 'dateRange', from: '2026-11-01', to: '2026-11-10' }],
  },
  { model: 'q/*', currency: CURRENCY, price: { input: 1 } },
]

const DAILY_ROWS = [
  // 今日:命中 p/m 四桶价,同时计入本月
  { bucket: TODAY, provider: 'p', model: 'p/m', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, requests: 3 },
  // 今日:命中 q/* 无条件价
  { bucket: TODAY, provider: 'q', model: 'q/m', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
  // 今日:无规则覆盖,只计 token 与请求
  { bucket: TODAY, provider: 'x', model: 'x/y', inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 2 },
  // 本月早于今日:日期段条件价 100 命中,若按当前时刻计价会落到默认价 1
  { bucket: '2026-11-02', provider: 'q', model: 'q/m', inputTokens: 1000 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
  // 上月:窗口外,不得计入
  { bucket: '2026-10-31', provider: 'p', model: 'p/m', inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 9 },
]

const HOUR_ROWS = [
  { bucket: SPARK_FIRST, provider: 'p', model: 'p/m', inputTokens: 500 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
  { bucket: SPARK_LAST, provider: 'p', model: 'p/m', inputTokens: 1000 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 2 },
  // 窗口外一小时:不得进入序列
  { bucket: '2026-11-14T14', provider: 'p', model: 'p/m', inputTokens: 9000 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
]

const MINUTE_ROWS = [
  { bucket: '2026-11-15T14:20', provider: 'p', model: 'p/m', inputTokens: 300 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
  { bucket: '2026-11-15T14:10', provider: 'p', model: 'p/m', inputTokens: 200 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
  // 窗口外 10 分钟:不计入速率
  { bucket: '2026-11-15T13:50', provider: 'p', model: 'p/m', inputTokens: 1000 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 },
]

// 期望值直接由给定价格算出,避免与实现共享同一份计算
const TODAY_COST = (1000 * 10 + 500 * 20 + 2000 * 1) / TOKENS_PER_MILLION
  + (1000 * 1) / TOKENS_PER_MILLION
const MONTH_COST = TODAY_COST + (1000 * 1000 * 100) / TOKENS_PER_MILLION
const TODAY_TOKENS = 1000 + 500 + 2000 + 1000 + 500
const MONTH_TOKENS = TODAY_TOKENS + 1000 * 1000
const TODAY_REQUESTS = 3 + 1 + 2
const MONTH_REQUESTS = TODAY_REQUESTS + 1
const TODAY_CACHE_HIT = (2000 / (2000 + 1000 + 1000 + 500)) * 100
const RATE_PER_HOUR = ((300 * 1000 * 10) / TOKENS_PER_MILLION + (200 * 1000 * 10) / TOKENS_PER_MILLION) * 2

function makeStore(rows, { raw = false } = {}) {
  const calls = { rangeRows: [], flushNow: 0, sessionRangeRows: 0 }
  return {
    calls,
    async flushNow() {
      calls.flushNow += 1
    },
    async rangeRows(g, from, to) {
      calls.rangeRows.push({ g, from, to })
      if (raw) return rows[g] ?? []
      return (rows[g] ?? []).filter((row) => row.bucket >= from && row.bucket <= to)
    },
    async sessionRangeRows() {
      calls.sessionRangeRows += 1
      throw new Error('摘要口径不需要会话索引')
    },
  }
}

const makePricing = (rules) => ({ active: true, rules: () => rules })
const makeDeps = (store, { rules = RULES, budget } = {}) => ({
  store,
  pricing: makePricing(rules),
  now: () => NOW_MS,
  timeZone: TIME_ZONE,
  ...(budget === undefined ? {} : { budget }),
})

const allRows = () => ({ D: DAILY_ROWS, H: HOUR_ROWS, M: MINUTE_ROWS })

const assertClose = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} 期望 ${expected},实际 ${actual}`)
}

const budgetConfig = () => ({
  enabled: true,
  warnRatio: 0.8,
  daily: { limit: 10, action: 'warn' },
  monthly: { limit: 0, action: 'warn' },
  degradeModel: '',
  notify: true,
})

test('Given 三档用量与条件价 When buildSummary Then 今日/本周期按桶起点计价且序列与速率齐全', async () => {
  const store = makeStore(allRows())
  const summary = await buildSummary(makeDeps(store))
  assert.equal(summary.currency, CURRENCY)
  assertClose(summary.today.cost, TODAY_COST)
  assert.equal(summary.today.tokens, TODAY_TOKENS)
  assert.equal(summary.today.requests, TODAY_REQUESTS)
  // 早于今日的本月行按当日条件价 100 命中,证明按桶起点而非当前时刻计价
  assertClose(summary.cycle.cost, MONTH_COST)
  assert.equal(summary.cycle.tokens, MONTH_TOKENS)
  assert.equal(summary.cycle.requests, MONTH_REQUESTS)
  assertClose(summary.cacheHit, TODAY_CACHE_HIT)
  assertClose(summary.ratePerHour, RATE_PER_HOUR)
  assert.equal(summary.spark.length, 24)
  assert.deepEqual(summary.spark[0], { t: SPARK_FIRST, cost: 5 })
  assert.deepEqual(summary.spark[23], { t: SPARK_LAST, cost: 10 })
  assertClose(summary.spark.slice(1, 23).reduce((sum, point) => sum + point.cost, 0), 0)
})

test('Given 一次摘要 When 统计 store 读 Then 仅日/时/分各一次且查询前先落 pending', async () => {
  const store = makeStore(allRows())
  await buildSummary(makeDeps(store))
  assert.equal(store.calls.rangeRows.length, 3)
  assert.deepEqual(store.calls.rangeRows.map((call) => call.g), ['D', 'H', 'M'])
  assert.deepEqual(store.calls.rangeRows[0], { g: 'D', from: MONTH_START, to: TODAY })
  assert.deepEqual(store.calls.rangeRows[1], { g: 'H', from: SPARK_FIRST, to: SPARK_LAST })
  assert.deepEqual(store.calls.rangeRows[2], { g: 'M', from: RATE_FROM, to: RATE_TO })
  assert.equal(store.calls.flushNow, 1)
  // 用量桶不含会话维度,子会话消耗与主会话同表累加,摘要不读会话索引
  assert.equal(store.calls.sessionRangeRows, 0)
})

test('Given 未配置定价规则 When buildSummary Then 货币为 null、费用全 0 而用量照计', async () => {
  const store = makeStore(allRows())
  const summary = await buildSummary(makeDeps(store, { rules: [] }))
  assert.equal(summary.currency, null)
  assert.equal(summary.today.cost, 0)
  assert.equal(summary.cycle.cost, 0)
  assert.equal(summary.today.tokens, TODAY_TOKENS)
  assert.equal(summary.cycle.tokens, MONTH_TOKENS)
  assert.equal(summary.ratePerHour, 0)
  assert.equal(summary.spark.length, 24)
  assert.equal(summary.spark.reduce((sum, point) => sum + point.cost, 0), 0)
  assertClose(summary.cacheHit, TODAY_CACHE_HIT)
})

test('Given store 无 flushNow When buildSummary Then 跳过落盘直接读', async () => {
  const store = makeStore(allRows())
  delete store.flushNow
  const summary = await buildSummary(makeDeps(store))
  assertClose(summary.today.cost, TODAY_COST)
  assert.equal(store.calls.rangeRows.length, 3)
})

test('Given 桶键畸形 When buildSummary Then 跳过该行不拖垮聚合', async () => {
  const store = makeStore({
    D: [{ bucket: 'not-a-day', provider: 'p', model: 'p/m', inputTokens: 999, requests: 1 }, ...DAILY_ROWS],
    H: [],
    M: [],
  }, { raw: true })
  const summary = await buildSummary(makeDeps(store))
  assert.equal(summary.today.tokens, TODAY_TOKENS)
  assertClose(summary.today.cost, TODAY_COST)
})

test('Given 与摘要同一批日档行 When readSpent Then 今日/本月花费与摘要一致且只读日档', async () => {
  const store = makeStore(allRows())
  const deps = makeDeps(store)
  const summary = await buildSummary(deps)
  const spent = await readSpent(deps)
  assert.equal(store.calls.rangeRows.length, 4)
  assert.equal(store.calls.rangeRows[3].g, 'D')
  assert.deepEqual(store.calls.rangeRows[3], { g: 'D', from: MONTH_START, to: TODAY })
  assertClose(spent.daily, summary.today.cost)
  assertClose(spent.monthly, summary.cycle.cost)
})

test('Given 已配置日限额 When buildBudgetStatus Then 复用花费与速率给出评估与预计耗尽', async () => {
  const store = makeStore(allRows())
  const deps = makeDeps(store, { budget: { config: budgetConfig } })
  const status = await buildBudgetStatus(deps)
  assert.equal(status.currency, CURRENCY)
  assert.deepEqual(status.config, budgetConfig())
  assert.equal(status.enabled, true)
  assert.equal(status.action, 'none')
  assertClose(status.ratePerHour, RATE_PER_HOUR)
  assert.equal(status.budgets.length, 1)
  const [daily] = status.budgets
  assert.equal(daily.scope, 'daily')
  assertClose(daily.spent, TODAY_COST)
  assertClose(daily.remaining, 10 - TODAY_COST)
  assert.equal(status.eta.scope, 'daily')
  assertClose(status.eta.hoursLeft, (10 - TODAY_COST) / RATE_PER_HOUR)
  assert.equal(status.eta.at, NOW_MS + ((10 - TODAY_COST) / RATE_PER_HOUR) * 60 * 60 * 1000)
  assert.deepEqual(store.calls.rangeRows.map((call) => call.g), ['D', 'M'])
})

test('Given 无预算服务 When buildBudgetStatus Then 返回 null 且不读库', async () => {
  const store = makeStore(allRows())
  assert.equal(await buildBudgetStatus(makeDeps(store)), null)
  assert.equal(store.calls.rangeRows.length, 0)
})

test('Given 预算配置为 null When buildBudgetStatus Then 返回 null 且不读库', async () => {
  const store = makeStore(allRows())
  const deps = makeDeps(store, { budget: { config: () => null } })
  assert.equal(await buildBudgetStatus(deps), null)
  assert.equal(store.calls.rangeRows.length, 0)
})

test('速率同时给花费与 tokens 的小时折算', async () => {
  const store = makeStore(allRows())
  const summary = await buildSummary(makeDeps(store))
  assertClose(summary.ratePerHour, RATE_PER_HOUR, '花费速率')
  // 分钟窗口内 50 万 tokens,占一小时的一半,折算成小时是 100 万
  assert.equal(summary.tokensPerHour, (300 * 1000 + 200 * 1000) * 2)
})

test('Given 账单日十五号 When 取摘要 Then 本周期从十五号起且花费口径同步', async () => {
  const store = makeStore(allRows())
  const deps = { ...makeDeps(store), cycleConfig: () => ({ kind: 'monthly', startDay: 15 }) }
  const summary = await buildSummary(deps)
  assert.equal(summary.cycle.from, '2026-11-15')
  assert.equal(summary.cycle.to, '2026-11-15')
  // 十五号当天只有 q/m 那一行(日档键等于 TODAY 的行都在今日,但周期窗口从 15 号起仍是同一天)
  assertClose(summary.cycle.cost, TODAY_COST)
  const spent = await readSpent(deps)
  assertClose(spent.monthly, summary.cycle.cost)
})

test('Given 滚动三十天 When 取花费 Then 窗口覆盖上月同日', async () => {
  const store = makeStore(allRows())
  const deps = { ...makeDeps(store), cycleConfig: () => ({ kind: 'rolling', days: 30 }) }
  const summary = await buildSummary(deps)
  assert.equal(summary.cycle.from, '2026-10-17')
  // 滚动窗口把 10-31 那笔也纳入(自然月口径不计),11-02 的百万 token 条件价也在窗口内
  assertClose(summary.cycle.cost, MONTH_COST + (5000 * 10) / TOKENS_PER_MILLION)
})

test('Given 分钟桶无数据 When 取摘要 Then 速率给 null 而不是 0', async () => {
  const store = makeStore({ D: DAILY_ROWS, H: HOUR_ROWS, M: [] })
  const summary = await buildSummary(makeDeps(store))
  assert.equal(summary.tokensPerHour, null)
  assert.equal(summary.ratePerHour, null)
})

test('Given 夏令时回拨 When 取速率窗口 Then 键集合按绝对时间且不含当前桶', () => {
  // 美东 2026-11-01 回拨:01:25 EST 往前三个完整桶跨过重复的 01 点小时
  const window = recentMinuteBuckets(Date.parse('2026-11-01T06:25:00Z'), 'America/New_York', 30)
  assert.deepEqual([...window.keys].sort(), ['2026-11-01T01:00', '2026-11-01T01:10', '2026-11-01T01:50'])
  assert.equal(window.from, '2026-11-01T01:00')
  assert.equal(window.to, '2026-11-01T01:50')
})

test('Given 当前桶只走了几分钟 When 取速率 Then 不把半截桶当整窗', async () => {
  const rows = { D: [], H: [], M: [MINUTE_ROWS[0], MINUTE_ROWS[1]] }
  const at = (iso) => ({ ...makeDeps(makeStore(rows)), now: () => Date.parse(iso) })
  // 14:31 与 14:39 都取 14:20 / 14:10 / 14:00 三个完整桶,速率必须相同
  const early = await buildSummary(at('2026-11-15T14:31:00+08:00'))
  const late = await buildSummary(at('2026-11-15T14:39:00+08:00'))
  assertClose(early.ratePerHour, RATE_PER_HOUR)
  assertClose(late.ratePerHour, early.ratePerHour)
})

test('Given 数据全在当前未完成桶 When 取速率 Then 不计入并给 null tokens', async () => {
  const rows = { D: [], H: [], M: [{ bucket: '2026-11-15T14:30', provider: 'p', model: 'p/m', inputTokens: 900 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 }] }
  const summary = await buildSummary(makeDeps(makeStore(rows)))
  assert.equal(summary.ratePerHour, null)
  assert.equal(summary.tokensPerHour, null)
})
