// 计费周期窗口:自然月 / 每月账单日 / 滚动天数三种口径的日键边界契约。
// 窗口按宿主本地日键返回,聚合直接比字符串,跨月与月末夹取是主要风险点。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CYCLE_DEFAULT,
  CYCLE_MAX_DAYS,
  cycleDaysOf,
  cycleWindowOf,
  normalizeCycleConfig,
} from '../src/cycle.js'

const TIME_ZONE = 'Asia/Shanghai'
const at = (text) => Date.parse(`${text}T12:00:00+08:00`)

test('Given 自然月 When 取窗口 Then 从本月一号到今日', () => {
  const window = cycleWindowOf({ kind: 'calendar' }, at('2026-11-15'), TIME_ZONE)
  assert.equal(window.from, '2026-11-01')
  assert.equal(window.to, '2026-11-15')
  assert.equal(window.today, '2026-11-15')
})

test('Given 账单日十五号 When 今日已过账单日 Then 窗口从本月十五号起', () => {
  const window = cycleWindowOf({ kind: 'monthly', startDay: 15 }, at('2026-11-20'), TIME_ZONE)
  assert.equal(window.from, '2026-11-15')
})

test('Given 账单日十五号 When 今日未到账单日 Then 窗口从上月十五号起', () => {
  const window = cycleWindowOf({ kind: 'monthly', startDay: 15 }, at('2026-11-10'), TIME_ZONE)
  assert.equal(window.from, '2026-10-15')
})

test('Given 账单日十五号 When 今日正是账单日 Then 窗口从今日起', () => {
  const window = cycleWindowOf({ kind: 'monthly', startDay: 15 }, at('2026-11-15'), TIME_ZONE)
  assert.equal(window.from, '2026-11-15')
})

test('Given 账单日十五号 When 一月未到账单日 Then 窗口跨年回退到上年十二月', () => {
  const window = cycleWindowOf({ kind: 'monthly', startDay: 15 }, at('2026-01-05'), TIME_ZONE)
  assert.equal(window.from, '2025-12-15')
})

test('Given 账单日三十一号 When 当月不足三十一天 Then 落到当月月末', () => {
  // 2026-02 只有 28 天:窗口起点夹到 02-28,而不是造出不存在的 02-31
  const window = cycleWindowOf({ kind: 'monthly', startDay: 31 }, at('2026-03-05'), TIME_ZONE)
  assert.equal(window.from, '2026-02-28')
})

test('Given 账单日三十一号 When 上月不足三十一天 Then 落到上月月末', () => {
  const window = cycleWindowOf({ kind: 'monthly', startDay: 31 }, at('2026-02-10'), TIME_ZONE)
  assert.equal(window.from, '2026-01-31')
})

test('Given 滚动三十天 When 取窗口 Then 起点含今日往前数满三十天', () => {
  const window = cycleWindowOf({ kind: 'rolling', days: 30 }, at('2026-11-15'), TIME_ZONE)
  assert.equal(window.from, '2026-10-17')
  assert.equal(cycleDaysOf(window.from, window.to), 30)
})

test('Given 滚动窗口 When 不超过十二个月 When 周期长度与配置一致', () => {
  for (const days of [1, 7, 30, 90, 365]) {
    const window = cycleWindowOf({ kind: 'rolling', days }, at('2026-11-15'), TIME_ZONE)
    assert.equal(cycleDaysOf(window.from, window.to), days, `${days} 天窗口长度不符`)
  }
})

test('Given 非法配置 When 归一化 Then 回落到自然月默认', () => {
  assert.deepEqual(normalizeCycleConfig(null), CYCLE_DEFAULT)
  assert.deepEqual(normalizeCycleConfig({ kind: 'weekly' }), CYCLE_DEFAULT)
  assert.deepEqual(normalizeCycleConfig({ kind: 'monthly', startDay: 0 }), { ...CYCLE_DEFAULT, kind: 'monthly' })
  assert.deepEqual(normalizeCycleConfig({ kind: 'monthly', startDay: 32 }), { ...CYCLE_DEFAULT, kind: 'monthly' })
  assert.deepEqual(normalizeCycleConfig({ kind: 'rolling', days: 0 }), { ...CYCLE_DEFAULT, kind: 'rolling' })
  assert.deepEqual(normalizeCycleConfig({ kind: 'rolling', days: CYCLE_MAX_DAYS + 1 }), { ...CYCLE_DEFAULT, kind: 'rolling' })
})

test('Given 合法配置 When 归一化 Then 原样保留', () => {
  assert.deepEqual(normalizeCycleConfig({ kind: 'monthly', startDay: 15, days: 90 }), { kind: 'monthly', startDay: 15, days: 90 })
})

test('Given 夏令时春季前进 When 滚动窗口 Then 实际天数仍等于配置', () => {
  // 2026-03-08 美东进入夏令时:按 24 小时毫秒回退会少算一天
  const window = cycleWindowOf({ kind: 'rolling', days: 30 }, at('2026-03-10'), 'America/New_York')
  assert.equal(cycleDaysOf(window.from, window.to), 30)
})

test('Given 夏令时秋季回拨 When 滚动窗口 Then 实际天数仍等于配置', () => {
  // 2026-11-01 美东退出夏令时:按 24 小时毫秒回退会多算一天
  const window = cycleWindowOf({ kind: 'rolling', days: 30 }, at('2026-11-03'), 'America/New_York')
  assert.equal(cycleDaysOf(window.from, window.to), 30)
})

test('Given 夏令时时区 When 账单日窗口 Then 起止仍是本地日历日', () => {
  const window = cycleWindowOf({ kind: 'monthly', startDay: 15 }, at('2026-03-10'), 'America/New_York')
  assert.equal(window.from, '2026-02-15')
  assert.equal(window.to, '2026-03-10')
})
