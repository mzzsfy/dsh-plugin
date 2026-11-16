// 计费周期:套餐不一定按自然月结算,也不一定 30 天。
// 三种口径覆盖常见形态:自然月、每月固定账单日(如 15 号)、滚动 N 天。
// 窗口按宿主本地日键返回,与日桶键同一坐标系,聚合时直接比字符串即可。

import { dayKey } from './store.js'

export const MS_PER_DAY = 24 * 60 * 60 * 1000

export const CYCLE_CALENDAR = 'calendar'
export const CYCLE_MONTHLY = 'monthly'
export const CYCLE_ROLLING = 'rolling'
export const CYCLE_KINDS = [CYCLE_CALENDAR, CYCLE_MONTHLY, CYCLE_ROLLING]

// 账单日取 1..31,超出当月天数时落到月末(31 号在 2 月就是 28/29 号)
export const CYCLE_MIN_START_DAY = 1
export const CYCLE_MAX_START_DAY = 31
// 滚动窗口上限一年,防止误填让查询跨度失控
export const CYCLE_MIN_DAYS = 1
export const CYCLE_MAX_DAYS = 366

export const CYCLE_DEFAULT = {
  kind: CYCLE_CALENDAR,
  startDay: CYCLE_MIN_START_DAY,
  days: 30,
}

const MONTH_INDEX_SHIFT = 1
const YEAR_STEP = 1
const DECEMBER = 12
const JANUARY = 1
const DAY_SLICE_START = 8
const DAY_SLICE_END = 10
const MONTH_SLICE_START = 5
const MONTH_SLICE_END = 7
const YEAR_SLICE_END = 4

const pad = (value) => String(value).padStart(2, '0')

// 月天数用 UTC 构造避免本地夏令时干扰:月末的「下月 0 日」就是本月最后一天
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function dayKeyOf(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`
}

export function normalizeCycleConfig(raw) {
  const kind = CYCLE_KINDS.includes(raw?.kind) ? raw.kind : CYCLE_DEFAULT.kind
  const startDay = Number.isInteger(raw?.startDay)
    && raw.startDay >= CYCLE_MIN_START_DAY
    && raw.startDay <= CYCLE_MAX_START_DAY
    ? raw.startDay
    : CYCLE_DEFAULT.startDay
  const days = Number.isInteger(raw?.days) && raw.days >= CYCLE_MIN_DAYS && raw.days <= CYCLE_MAX_DAYS
    ? raw.days
    : CYCLE_DEFAULT.days
  return { kind, startDay, days }
}

// 上一个周期的起点:跨年回退,账单日超出上月天数时落到上月月末
function previousAnchor(year, month, anchor) {
  const previousMonth = month === JANUARY ? DECEMBER : month - MONTH_INDEX_SHIFT
  const previousYear = month === JANUARY ? year - YEAR_STEP : year
  return dayKeyOf(previousYear, previousMonth, Math.min(anchor, daysInMonth(previousYear, previousMonth)))
}

// 日键按本地日历日平移:直接对 YYYY-MM-DD 做 UTC 运算,不经过 24 小时毫秒数,
// 否则夏令时切换日会多算或少算一天
function shiftDayKey(dayKeyText, offsetDays) {
  const [year, month, day] = dayKeyText.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - MONTH_INDEX_SHIFT, day) + offsetDays * MS_PER_DAY)
  return dayKeyOf(shifted.getUTCFullYear(), shifted.getUTCMonth() + MONTH_INDEX_SHIFT, shifted.getUTCDate())
}

export function cycleWindowOf(config, nowMs, timeZone) {
  const normalized = normalizeCycleConfig(config)
  const today = dayKey(nowMs, timeZone)
  if (normalized.kind === CYCLE_ROLLING) {
    return {
      from: shiftDayKey(today, -(normalized.days - CYCLE_MIN_DAYS)),
      to: today,
      today,
    }
  }
  const year = Number(today.slice(0, YEAR_SLICE_END))
  const month = Number(today.slice(MONTH_SLICE_START, MONTH_SLICE_END))
  const day = Number(today.slice(DAY_SLICE_START, DAY_SLICE_END))
  // 自然月等价于账单日 1 号
  const anchorDay = normalized.kind === CYCLE_MONTHLY ? normalized.startDay : CYCLE_DEFAULT.startDay
  // 当月夹取只影响本月起点;回退上月时用原始账单日,否则 31 号会被当月天数带偏
  const anchor = Math.min(anchorDay, daysInMonth(year, month))
  const from = day >= anchor
    ? dayKeyOf(year, month, anchor)
    : previousAnchor(year, month, anchorDay)
  return { from, to: today, today }
}

// 周期长度按本地日计:展示「共 N 天」时与窗口同源
export function cycleDaysOf(from, to) {
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0
  return Math.max(0, Math.round((toMs - fromMs) / MS_PER_DAY) + 1)
}
