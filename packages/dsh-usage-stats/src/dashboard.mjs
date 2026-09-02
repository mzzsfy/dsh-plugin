// 仪表盘聚合:概览 / 趋势 / 热力图 / 明细的纯计算;输入为账本与当日键,输出点位数据。

import { DEFAULT_USD_CNY } from './rates.mjs'

const TREND_DAYS_SHORT = 7
const TREND_DAYS_LONG = 30
const WEEK_DAYS = 7

// 热力图费用分档上限(USD,CNY 展示前先按 USD 账本口径分档),空档为 0。
const HEAT_TIER_USD = [0.1, 1, 10]

function emptyTotals() {
  return { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0, cost: 0 }
}

function addTotals(target, source) {
  target.inputTokens += source.inputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.outputTokens += source.outputTokens
  target.calls += source.calls
  target.cost += source.cost
}

function parseKey(key) {
  const parts = key.split('-').map(Number)
  return { year: parts[0], month: parts[1] - 1, day: parts[2] }
}

function keyOf(date) {
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function shiftKey(key, offsetDays) {
  const { year, month, day } = parseKey(key)
  return keyOf(new Date(year, month, day + offsetDays))
}

function tierOf(cost) {
  let tier = 0
  for (const bound of HEAT_TIER_USD) {
    if (cost > bound) tier += 1
  }
  return tier
}

// 概览:本月 Hero、按日均外推预计、今日与本周环比、token/调用 KPI。costCny 按当前汇率折算;rate 缺省用兜底汇率。
export function monthOverview(ledger, todayKey, rate) {
  const rateValue = rate && Number.isFinite(rate.rate) ? rate.rate : DEFAULT_USD_CNY
  const { year, month, day } = parseKey(todayKey)
  const monthPrefix = todayKey.slice(0, 7)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const monthTotals = emptyTotals()
  const prevMonthTotals = emptyTotals()
  const prevPrefix = keyOf(new Date(year, month - 1, 1)).slice(0, 7)
  for (const key of Object.keys(ledger.days)) {
    if (key.indexOf(monthPrefix) === 0) addTotals(monthTotals, ledger.days[key])
    if (key.indexOf(prevPrefix) === 0) addTotals(prevMonthTotals, ledger.days[key])
  }
  const today = ledger.days[todayKey] || emptyTotals()
  const yesterday = ledger.days[shiftKey(todayKey, -1)] || emptyTotals()
  const dayRatio = (current, base) => (base.cost > 0 ? current.cost / base.cost : null)
  let week = emptyTotals()
  let prevWeek = emptyTotals()
  for (let i = 0; i < WEEK_DAYS; i += 1) {
    const key = shiftKey(todayKey, -i)
    if (ledger.days[key]) addTotals(week, ledger.days[key])
    const prevKey = shiftKey(todayKey, -i - WEEK_DAYS)
    if (ledger.days[prevKey]) addTotals(prevWeek, ledger.days[prevKey])
  }
  return {
    month: monthTotals,
    monthCostCny: monthTotals.cost * rateValue,
    projection: daysInMonth > 0 ? (monthTotals.cost / day) * daysInMonth : 0,
    todayRatio: dayRatio(today, yesterday),
    weekRatio: dayRatio(week, prevWeek),
    prevMonthCostCny: prevMonthTotals.cost * rateValue,
  }
}

// 趋势点位:固定日历窗口,无数据日期 cost 为 null 不伪造,tokens/calls 为 0。
export function dayTrend(ledger, todayKey, count) {
  const points = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const key = shiftKey(todayKey, -i)
    const day = ledger.days[key]
    points.push({
      date: key,
      cost: day ? day.cost : null,
      tokens: day ? day.inputTokens + day.cacheReadTokens + day.outputTokens : 0,
      calls: day ? day.calls : 0,
    })
  }
  return points
}

// 月历热力图:当月逐日费用与分档,悬停展示费用与调用数。
export function monthHeatmap(ledger, todayKey) {
  const { year, month } = parseKey(todayKey)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const days = []
  for (let d = 1; d <= daysInMonth; d += 1) {
    const key = keyOf(new Date(year, month, d))
    const day = ledger.days[key]
    days.push({
      date: key,
      cost: day ? day.cost : null,
      calls: day ? day.calls : 0,
      tier: day ? tierOf(day.cost) : 0,
    })
  }
  return { month: todayKey.slice(0, 7), days }
}

// 明细:顶层会话索引已跨日合并,按费用倒序;标题由调用方经 sessionQuery 动态补齐。
export function sessionsView(ledger, limit) {
  const rows = Object.keys(ledger.sessions || {}).map((sessionId) => {
    const row = ledger.sessions[sessionId]
    return {
      sessionId,
      firstAt: row.firstAt,
      lastAt: row.lastAt,
      calls: row.calls,
      inputTokens: row.inputTokens,
      cacheReadTokens: row.cacheReadTokens,
      outputTokens: row.outputTokens,
      cost: row.cost,
    }
  })
  rows.sort((a, b) => b.cost - a.cost)
  return limit > 0 ? rows.slice(0, limit) : rows
}

// 一次取全:CNY 折算、双档趋势、当月热力图与明细。
export function buildDashboard(ledger, todayKey, rate) {
  return {
    todayKey,
    rate,
    overview: monthOverview(ledger, todayKey, rate),
    trend7: dayTrend(ledger, todayKey, TREND_DAYS_SHORT),
    trend30: dayTrend(ledger, todayKey, TREND_DAYS_LONG),
    heatmap: monthHeatmap(ledger, todayKey),
    sessions: sessionsView(ledger, 0),
  }
}
