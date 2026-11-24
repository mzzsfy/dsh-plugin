// 多 cron 计划测试:一条任务挂多条表达式(按行书写),触发点取各表达式最早一次。
// 覆盖计划文本归一、合并触发点、摘要、逐条校验与 client 装配接线守卫。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  MAX_SCHEDULES,
  assertValidSchedule,
  nextRunAtOfSchedules,
  nextRunsOfSchedules,
  normalizeSchedule,
  splitSchedules,
  summarizeSchedules,
} from '../src/cron.mjs'

// 固定起点:2026-09-17T12:00:00Z(北京 20:00),之后的触发点跨日,断言无歧义
const FROM = new Date('2026-09-17T12:00:00Z')
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('多计划:按行拆分,去空白/空行/重复行并保持书写顺序', () => {
  // Given 含空行、首尾空白与重复行的计划文本
  const schedule = '  0 9 * * *  \n\n0 9 * * *\n30 8 * * *\n'
  // Then 只留两条,顺序按书写
  assert.deepEqual(splitSchedules(schedule), ['0 9 * * *', '30 8 * * *'])
  // Then 落库形态同样归一(按行重排,无首尾空白)
  assert.equal(normalizeSchedule(schedule), '0 9 * * *\n30 8 * * *')
  // Then 非文本输入归一为空计划(交由校验报错)
  assert.deepEqual(splitSchedules(undefined), [])
  assert.equal(normalizeSchedule(42), '')
})

test('多计划:合并触发点取各表达式最早一次(含不同时区)', () => {
  // Given 东八区每天 9 点与 UTC 每天 8:30 两条表达式
  const schedule = '0 9 * * *T+8\n30 8 * * *T+0'
  // When 求自固定起点起的下一次触发
  const at = nextRunAtOfSchedules(schedule, FROM)
  // Then 取更早的一次:北京 9 点为 01:00Z,UTC 8:30 为 08:30Z
  assert.equal(at, Date.UTC(2026, 8, 18, 1, 0, 0))
  // Then 单条表达式时与标量结果一致
  assert.equal(nextRunAtOfSchedules('0 9 * * *T+8', FROM), Date.UTC(2026, 8, 18, 1, 0, 0))
  // Then 空计划无触发点
  assert.equal(nextRunAtOfSchedules('', FROM), null)
})

test('多计划:下 N 次触发合并去重并按时间排序', () => {
  // Given 两条表达式:一条每 30 分钟,一条每天 9 点(同一时刻会重合)
  const schedule = '*/30 * * * *T+0\n0 9 * * *T+0'
  // When 取 3 次触发
  const runs = nextRunsOfSchedules(schedule, 3, FROM)
  // Then 前三次为 12:30Z、13:00Z、13:30Z(起点之后,连续推进,没有重复项)
  assert.deepEqual(runs, [
    Date.UTC(2026, 8, 17, 12, 30, 0),
    Date.UTC(2026, 8, 17, 13, 0, 0),
    Date.UTC(2026, 8, 17, 13, 30, 0),
  ])
  // Then 同一时刻被两条不同时区的表达式命中时只保留一次(UTC 9 点 == UTC-8 的 1 点)
  const overlapping = nextRunsOfSchedules('0 9 * * *T+0\n0 1 * * *T-8', 4, FROM)
  assert.equal(new Set(overlapping).size, overlapping.length)
})

test('多计划:摘要逐条以 · 连接,单条时与标量摘要同文', () => {
  // Then 多条不同时区各自带尾注
  assert.equal(
    summarizeSchedules('0 9 * * *T+8\n30 8 * * 1-5T+0', 8),
    '每天 09:00(UTC+8) · 工作日 08:30(UTC+0)',
  )
  // Then 单条退化为标量摘要
  assert.equal(summarizeSchedules('0 9 * * *T+8', 8), '每天 09:00(UTC+8)')
  // Then 空计划摘要为空文本(列表侧仍显示任务本身)
  assert.equal(summarizeSchedules(''), '')
})

test('多计划:校验逐条报因——空计划 / 超上限 / 任一条非法', () => {
  // Then 空计划拒绝
  assert.throws(() => assertValidSchedule(' \n '), /调度计划不能为空/)
  // Then 超出条数上限拒绝(上限由常量派生,不写死字面量)
  const tooMany = Array.from({ length: MAX_SCHEDULES + 1 }, (_, index) => index + ' 9 * * *')
  assert.throws(() => assertValidSchedule(tooMany.join('\n')), new RegExp('最多 ' + MAX_SCHEDULES + ' 条'))
  // Then 第二条非法时错误文案带该行原文(不是整段计划)
  assert.throws(
    () => assertValidSchedule('0 9 * * *\nnot-a-cron'),
    /cron 表达式不合法: not-a-cron/,
  )
  // Then 合法多条不抛
  assert.doesNotThrow(() => assertValidSchedule('0 9 * * *\n30 8 * * 1-5T+8'))
})

test('多计划:client 装配接线——计划行列表 / 添加时间 / 逐行摘要', () => {
  const client = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  // Then 计划文本拆分与构建器状态数组派生走同一组纯函数
  assert.match(client, /function splitScheduleLines\(schedule\)/)
  assert.match(client, /function deriveScheduleText\(states\)/)
  // Then 表单渲染计划行列表与添加入口(多行计划的可视入口)
  assert.match(client, /className: 'cb-sched-list'/)
  assert.match(client, /className: 'cb-icon cb-button--danger'[\s\S]{0,200}removeSchedule\(index\)/)
  assert.match(client, /'\+ 添加时间'/)
  // Then 预览按表达式匹配行:服务端对重复表达式去重,不能按行号取值
  assert.match(client, /function schedulePreviewItem\(preview, expression\)/)
  assert.match(client, /schedulePreviewItem\(preview, activeState \? buildSchedule\(activeState\) : ''\)/)
  // Then 日志展示共用计划级时区(混合时区回退宿主默认)
  assert.match(client, /schedulesTzOffset\(selectedJob \? selectedJob\.schedule : null\)/)
})
