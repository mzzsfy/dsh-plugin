// 常驻摘要:今日/本周期费用、当前燃烧率、预算进度与近 24 小时序列。
// 一次读库聚合供设置页摘要卡与输入区读数共用,避免两处各拉一遍。
// 口径:费用按桶起点时刻命中当前定价规则;今日/本周期均含子会话(消耗真实发生)。

import { evaluateBudget, MINUTES_PER_HOUR, RATE_WINDOW_MINUTES } from './budget.js'
import { CYCLE_DEFAULT, cycleWindowOf } from './cycle.js'
import { costOf, matchPrice } from './pricing.js'
import {
  GRANULARITY_DAILY,
  GRANULARITY_HOURLY,
  GRANULARITY_MINUTE,
  hourKey,
  minuteKey,
  recentMinuteBuckets,
} from './store.js'

export const SUMMARY_SPARK_HOURS = 24

const MS_PER_MINUTE = 60 * 1000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const PERCENT_SCALE = 100
// 桶键补全为可解析的本地时刻:日键补零点时分秒,时键补分秒,分键补秒
const DAY_START_SUFFIX = 'T00:00:00'
const HOUR_START_SUFFIX = ':00:00'
const MINUTE_START_SUFFIX = ':00'

const toFiniteNumber = (value) => (Number.isFinite(value) ? value : 0)

const emptyTotals = () => ({ cost: 0, tokens: 0, requests: 0 })

// 宿主时钟与桶时区由依赖注入;缺省取进程时区,与路由默认口径一致
const nowOf = (deps) => (typeof deps?.now === 'function' ? deps.now() : Date.now())
const timeZoneOf = (deps) => deps?.timeZone
const rulesOf = (deps) => {
  const rules = deps?.pricing?.rules?.()
  return Array.isArray(rules) ? rules : []
}

// 全局显示货币与客户端同源:规则表首个非空货币;无规则即无货币
function currencyOf(rules) {
  const found = rules.find((rule) => typeof rule?.currency === 'string' && rule.currency !== '')
  return found ? found.currency : null
}

function bucketStartOf(bucket, suffix) {
  const date = new Date(`${bucket}${suffix}`)
  return Number.isNaN(date.getTime()) ? null : date
}

// 读前落 pending:采集器批量写盘前先 flush,保证摘要读到本进程刚写入的行
async function flushStore(deps) {
  const flush = deps?.store?.flushNow
  if (typeof flush === 'function') await flush.call(deps.store)
}

const totalTokensOf = (row) =>
  toFiniteNumber(row.inputTokens)
  + toFiniteNumber(row.outputTokens)
  + toFiniteNumber(row.cacheReadTokens)
  + toFiniteNumber(row.cacheWriteTokens)

// 一次计价:命中桶起点时刻的规则才计费,未命中保持 0(与面板的未定价口径一致)
function pricedCostOf(row, rules, date) {
  if (date === null) return 0
  const price = matchPrice(rules, row.model, date)
  return price ? costOf(price, row) : 0
}

// 所有读数共用的行级聚合:token 与请求数照计,费用只在命中规则时累加
function summarizeRows(rows, rules, suffix) {
  const totals = emptyTotals()
  for (const row of rows) {
    const date = bucketStartOf(row.bucket, suffix)
    if (date === null) continue
    totals.tokens += totalTokensOf(row)
    totals.requests += toFiniteNumber(row.requests)
    totals.cost += pricedCostOf(row, rules, date)
  }
  return totals
}

// 缓存命中率(百分比 0-100)与面板卡片同源:命中 token ÷(命中 + 未缓存输入 + 缓存写入)
function cacheHitOf(rows) {
  let hit = 0
  let miss = 0
  for (const row of rows) {
    hit += toFiniteNumber(row.cacheReadTokens)
    miss += toFiniteNumber(row.inputTokens) + toFiniteNumber(row.cacheWriteTokens)
  }
  const billed = hit + miss
  return billed > 0 ? (hit / billed) * PERCENT_SCALE : null
}

// 计费周期窗口:摘要的「本周期」与周期预算共用,窗口起点由用户套餐口径决定
function cycleWindow(deps, nowMs) {
  return cycleWindowOf(deps.cycleConfig?.() ?? CYCLE_DEFAULT, nowMs, timeZoneOf(deps))
}

function sparkKeysOf(deps, nowMs) {
  const keys = []
  for (let offset = SUMMARY_SPARK_HOURS - 1; offset >= 0; offset -= 1) {
    keys.push(hourKey(nowMs - offset * MS_PER_HOUR, timeZoneOf(deps)))
  }
  return keys
}

function rateWindowOf(deps, nowMs) {
  return recentMinuteBuckets(nowMs, timeZoneOf(deps), RATE_WINDOW_MINUTES)
}

// 分钟桶折算小时速率:只统计窗口内的完整桶,再按窗口占一小时的比例放大
function ratePerHourOf(rows, rules, window) {
  const inWindow = rows.filter((row) => window.keys.has(row.bucket))
  const totals = summarizeRows(inWindow, rules, MINUTE_START_SUFFIX)
  const scale = MINUTES_PER_HOUR / RATE_WINDOW_MINUTES
  // 窗口内一条行都没有就没有速率可言:给 null 让客户端省略,别把「无数据」画成 0/h
  const empty = inWindow.length === 0
  return {
    cost: totals.cost * scale,
    tokens: totals.tokens * scale,
    perHourTokens: empty ? null : totals.tokens * scale,
  }
}

// 逐小时序列以宿主墙钟桶键回传,缺行补零(没有花费的小时不代表没有数据)
function sparkOf(rows, rules, keys) {
  const costs = new Map(keys.map((key) => [key, 0]))
  for (const row of rows) {
    if (!costs.has(row.bucket)) continue
    const date = bucketStartOf(row.bucket, HOUR_START_SUFFIX)
    costs.set(row.bucket, costs.get(row.bucket) + pricedCostOf(row, rules, date))
  }
  return keys.map((key) => ({ t: key, cost: costs.get(key) }))
}

// 费用读数与预算共用同一日档聚合:今日 = 日桶键等于宿主本地日的行,
// monthly = 用户套餐周期窗口内的行(自然月只是其中一种口径,配置键沿用 monthly)
function spentOf(dailyRows, rules, window) {
  return {
    daily: summarizeRows(dailyRows.filter((row) => row.bucket === window.today), rules, DAY_START_SUFFIX).cost,
    monthly: summarizeRows(dailyRows, rules, DAY_START_SUFFIX).cost,
  }
}

// deps: { store, pricing, now, timeZone }
export async function buildSummary(deps) {
  const nowMs = nowOf(deps)
  const rules = rulesOf(deps)
  const window = cycleWindow(deps, nowMs)
  const sparkKeys = sparkKeysOf(deps, nowMs)
  const rateWindow = rateWindowOf(deps, nowMs)
  await flushStore(deps)
  // 三次读覆盖三档:日档出今日/本周期,小时档出序列,分钟档出速率
  const dailyRows = await deps.store.rangeRows(GRANULARITY_DAILY, window.from, window.to)
  const hourRows = await deps.store.rangeRows(GRANULARITY_HOURLY, sparkKeys[0], sparkKeys[sparkKeys.length - 1])
  const minuteRows = await deps.store.rangeRows(GRANULARITY_MINUTE, rateWindow.from, rateWindow.to)
  const todayRows = dailyRows.filter((row) => row.bucket === window.today)
  const rate = ratePerHourOf(minuteRows, rules, rateWindow)
  return {
    currency: currencyOf(rules),
    today: summarizeRows(todayRows, rules, DAY_START_SUFFIX),
    // 周期窗口随用户套餐口径变化,起止一并回传供界面标注
    cycle: { from: window.from, to: window.to, ...summarizeRows(dailyRows, rules, DAY_START_SUFFIX) },
    // 窗口内没有分钟行时速率是「不知道」而不是 0:两个字段一起给 null,别画成 0/h
    ratePerHour: rate.perHourTokens === null ? null : rate.cost,
    tokensPerHour: rate.perHourTokens,
    spark: sparkOf(hourRows, rules, sparkKeys),
    cacheHit: cacheHitOf(todayRows),
  }
}

// 预算护栏与预算端点共用的花费读数:今日 / 本月已花费(同货币)
export async function readSpent(deps) {
  const nowMs = nowOf(deps)
  const rules = rulesOf(deps)
  const window = cycleWindow(deps, nowMs)
  await flushStore(deps)
  const dailyRows = await deps.store.rangeRows(GRANULARITY_DAILY, window.from, window.to)
  return spentOf(dailyRows, rules, window)
}

// /budget 的状态块:配置经 deps.budget.config(),花费经同一日档聚合,速率取分钟档
export async function buildBudgetStatus(deps) {
  const budget = deps?.budget
  if (typeof budget?.config !== 'function') return null
  const config = budget.config()
  if (!config) return null
  const nowMs = nowOf(deps)
  const rules = rulesOf(deps)
  const window = cycleWindow(deps, nowMs)
  const rateWindow = rateWindowOf(deps, nowMs)
  await flushStore(deps)
  const dailyRows = await deps.store.rangeRows(GRANULARITY_DAILY, window.from, window.to)
  const minuteRows = await deps.store.rangeRows(GRANULARITY_MINUTE, rateWindow.from, rateWindow.to)
  const ratePerHour = ratePerHourOf(minuteRows, rules, rateWindow)
  // 顶层摊平评估结果:消费方读 budgets/eta/action 即可,不必再拆 evaluation 一层
  return {
    config,
    currency: currencyOf(rules),
    tokensPerHour: ratePerHour.perHourTokens,
    ...evaluateBudget({ config, spent: spentOf(dailyRows, rules, window), ratePerHour: ratePerHour.cost, now: nowMs }),
  }
}
