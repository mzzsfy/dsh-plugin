// cron 解析封装测试:内联时区后缀 T±N 的触发点计算、校验与人话摘要(BDD feat-timezone S1)。
// 后缀语义:显式后缀按固定偏移;无后缀按宿主系统时区(与 croner 原生行为一致)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cron } from 'croner'

import { nextRunAtOf, nextRunsOf, assertValidSchedule, summarizeCron } from '../src/cron.mjs'
import { buildSchedule } from '../src/schedule-builder.mjs'

// 固定起点:2026-09-17T12:00:00Z(北京 20:00),之后的 9:00 触发点跨日,断言无歧义
const FROM = new Date('2026-09-17T12:00:00Z')

test('cron:后缀 T+8 按东八区计算触发点', () => {
  // Given 表达式 0 9 * * *T+8
  // When 求自固定起点起的下一次触发
  const at = nextRunAtOf('0 9 * * *T+8', FROM)
  // Then 触发点为北京 09-18 09:00,即 01:00Z
  assert.equal(at, Date.UTC(2026, 8, 18, 1, 0, 0))
})

test('cron:后缀 T+0 与 T-5 按固定偏移计算,允许后缀前空格', () => {
  // Then T+0 即 UTC 触发点 09:00Z
  assert.equal(nextRunAtOf('0 9 * * *T+0', FROM), Date.UTC(2026, 8, 18, 9, 0, 0))
  // Then 空格分隔等价紧贴
  assert.equal(nextRunAtOf('0 9 * * * T+0', FROM), Date.UTC(2026, 8, 18, 9, 0, 0))
  // Then T-5 即 UTC-5 的 9:00,起点(12:00Z)之后的下一次为当日 14:00Z
  assert.equal(nextRunAtOf('0 9 * * *T-5', FROM), Date.UTC(2026, 8, 17, 14, 0, 0))
})

test('cron:后缀 T+8 下三次触发连续推进', () => {
  // Given 显式东八区,取 3 个触发点
  const runs = nextRunsOf('0 9 * * *T+8', 3, FROM)
  // Then 为连续三天北京 09:00(01:00Z)
  assert.deepEqual(runs, [
    Date.UTC(2026, 8, 18, 1, 0, 0),
    Date.UTC(2026, 8, 19, 1, 0, 0),
    Date.UTC(2026, 8, 20, 1, 0, 0),
  ])
})

test('cron:无后缀与 croner 原生系统时区行为一致', () => {
  // Given 无后缀表达式
  // When 求下一次触发
  const at = nextRunAtOf('30 8 * * *', FROM)
  // Then 与 croner 原生(不传 timezone)一致,零回归
  const native = new Cron('30 8 * * *').nextRun(FROM).getTime()
  assert.equal(at, native)
})

test('cron:后缀解析边界——负零、前导零、小写、空格归一', () => {
  // Then 负零等价 +0(UTC)
  assert.equal(nextRunAtOf('0 9 * * *T-0', FROM), Date.UTC(2026, 8, 18, 9, 0, 0))
  // Then 前导零等价单位数
  assert.equal(nextRunAtOf('0 9 * * *T+08', FROM), Date.UTC(2026, 8, 18, 1, 0, 0))
  // Then 小写 t 同样识别
  assert.equal(nextRunAtOf('0 9 * * *t+8', FROM), Date.UTC(2026, 8, 18, 1, 0, 0))
  // Then 空格分隔反解后回写归一为紧贴形态
  const state = { freq: 'daily', hour: 9, minute: 0, weekdays: ['1'], intervalMinutes: 30, expression: '0 9 * * *', timezone: 8 }
  assert.equal(buildSchedule(state), '0 9 * * *T+8')
  // Then 负零写侧归一为 +0(不输出 T-0)
  assert.equal(buildSchedule({ ...state, timezone: -0 }), '0 9 * * *T+0')
})

test('cron:nextRunAtOf 对非法后缀直接抛业务错误', () => {
  assert.throws(() => nextRunAtOf('0 9 * * *T+15', FROM), /时区后缀不合法/)
})

test('cron:非法后缀抛业务错误,坏表达式抛表达式错误', () => {
  // Then 后缀超界(-12..14 之外)报后缀不合法
  assert.throws(() => assertValidSchedule('0 9 * * *T+15'), /时区后缀不合法: T\+15/)
  assert.throws(() => assertValidSchedule('0 9 * * *T-13'), /时区后缀不合法/)
  // Then 表达式本身坏报表达式不合法(文案含原文)
  assert.throws(() => assertValidSchedule('not-a-cronT+8'), /cron 表达式不合法: not-a-cronT\+8/)
  // Then 合法表达式不抛
  assert.doesNotThrow(() => assertValidSchedule('0 9 * * *T+8'))
  assert.doesNotThrow(() => assertValidSchedule('0 9 * * *'))
})

test('cron:摘要显式后缀尾注 (UTC+N)', () => {
  assert.equal(summarizeCron('0 9 * * *T+8'), '每天 09:00(UTC+8)')
  assert.equal(summarizeCron('30 8 * * 1-5 T+0'), '工作日 08:30(UTC+0)')
  assert.equal(summarizeCron('0 22 * * 6T-5'), '每周六 22:00(UTC-5)')
})

test('cron:摘要无后缀尾注显示宿主偏移,显式传参可测', () => {
  // Given 宿主偏移显式传 0
  assert.equal(summarizeCron('0 9 * * *', 0), '每天 09:00(宿主 UTC+0)')
  // Given 宿主偏移显式传 5.5(半时区宿主)
  assert.equal(summarizeCron('0 9 * * *', 5.5), '每天 09:00(宿主 UTC+5.5)')
})

test('cron:摘要 custom 与非 5 段兜底同样携带时区尾注', () => {
  // Given 指定日月(非构建器形态)带后缀
  assert.equal(summarizeCron('0 0 1 1 *T+8'), '0 0 1 1 *(UTC+8)')
  // Given 非法表达式(不构成摘要)带宿主偏移传参
  assert.equal(summarizeCron('not-a-cron', 0), 'not-a-cron(宿主 UTC+0)')
})
