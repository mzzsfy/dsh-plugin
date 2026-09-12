// 调度构建器纯函数行为锁定:结构化状态与 cron 表达式互转,反解不出即 custom。
// BDD:给定表单状态,生成表达式;给定表达式,反解为表单状态;不可表达形态一律 custom 兜底。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSchedule, createScheduleState, parseSchedule, FREQS } from '../src/schedule-builder.mjs'

test('FREQS 覆盖五种频率形态', () => {
  assert.deepEqual(FREQS, ['daily', 'weekly', 'weekdays', 'interval', 'custom'])
})

test('daily:整点状态生成 每天 表达式', () => {
  const state = createScheduleState('')
  state.freq = 'daily'
  state.hour = 2
  state.minute = 0
  assert.equal(buildSchedule(state), '0 2 * * *')
})

test('daily:反解 每天表达式 还原时刻', () => {
  const state = parseSchedule('30 8 * * *')
  assert.equal(state.freq, 'daily')
  assert.equal(state.hour, 8)
  assert.equal(state.minute, 30)
})

test('weekdays:工作日状态生成 1-5 表达式', () => {
  const state = createScheduleState('')
  state.freq = 'weekdays'
  state.hour = 9
  state.minute = 5
  assert.equal(buildSchedule(state), '5 9 * * 1-5')
})

test('weekdays:反解 1-5 工作日形态', () => {
  const state = parseSchedule('0 9 * * 1-5')
  assert.equal(state.freq, 'weekdays')
})

test('weekly:多选星期按周序输出', () => {
  const state = createScheduleState('')
  state.freq = 'weekly'
  state.hour = 22
  state.minute = 0
  state.weekdays = ['5', '1']
  assert.equal(buildSchedule(state), '0 22 * * 1,5')
})

test('weekly:反解多星期表达式按 UI 序(一..六、日)归位', () => {
  const state = parseSchedule('0 22 * * 6,0,3')
  assert.equal(state.freq, 'weekly')
  assert.deepEqual(state.weekdays, ['3', '6', '0'])
})

test('interval:每 N 分钟生成 */N 表达式', () => {
  const state = createScheduleState('')
  state.freq = 'interval'
  state.intervalMinutes = 30
  assert.equal(buildSchedule(state), '*/30 * * * *')
})

test('interval:反解 */N 分钟形态', () => {
  const state = parseSchedule('*/15 * * * *')
  assert.equal(state.freq, 'interval')
  assert.equal(state.intervalMinutes, 15)
})

test('interval:非法步进(0 或超界)反解为 custom', () => {
  assert.equal(parseSchedule('*/0 * * * *').freq, 'custom')
  assert.equal(parseSchedule('*/61 * * * *').freq, 'custom')
})

test('指定日月的表达式不可表达,归 custom', () => {
  const state = parseSchedule('0 0 1 * *')
  assert.equal(state.freq, 'custom')
  assert.equal(state.expression, '0 0 1 * *')
})

test('小时步进(0 */2 * * *)非构建器形态,归 custom', () => {
  assert.equal(parseSchedule('0 */2 * * *').freq, 'custom')
})

test('非 5 段与乱文本归 custom 且原样保留', () => {
  assert.equal(parseSchedule('not a cron').freq, 'custom')
  const six = parseSchedule('0 9 * * * 2026')
  assert.equal(six.freq, 'custom')
  assert.equal(six.expression, '0 9 * * * 2026')
})

test('custom:构建直接透传手工表达式', () => {
  const state = createScheduleState('  10 1 1 1 *  ')
  state.freq = 'custom'
  assert.equal(buildSchedule(state), '10 1 1 1 *')
})

test('字段越界数值反解归 custom,不猜修正', () => {
  assert.equal(parseSchedule('99 25 * * *').freq, 'custom')
  assert.equal(parseSchedule('* 9 * * *').freq, 'custom')
})

test('parity:client.js SBUILD 段与核心实现逐字镜像', () => {
  // Given client 半区无模块系统,构建器逻辑必须内联(经典 script)
  // When 从两侧源码提取函数体文本(SBUILD 标记段 vs schedule-builder.mjs 导出体)
  // Then 除常量前缀(SB_ 命名空间)与导出关键词外逐字一致,防双实现漂移
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const client = readFileSync(join(pkgRoot, 'src', 'client.js'), 'utf8')
  const begin = client.indexOf('/* SBUILD-BEGIN */')
  const end = client.indexOf('/* SBUILD-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少 SBUILD 标记段')
  const block = client.slice(begin, end)
  const core = readFileSync(join(pkgRoot, 'src', 'schedule-builder.mjs'), 'utf8')
  // 逐函数对比:剥离 export 关键词后,核心源码的每个可执行行都应出现在 client 镜像段
  const coreLines = core.split('\n')
    .map((line) => line.replace(/^export /, '').replace(/\bFREQS\b/g, 'SB_FREQS').replace(/\bWEEKDAY_ORDER\b/g, 'SB_WEEKDAY_ORDER').replace(/\bWEEKDAY_LABELS\b/g, 'SB_WEEKDAY_LABELS').replace(/\bMINUTE_MAX\b/g, 'SB_MINUTE_MAX').replace(/\bHOUR_MAX\b/g, 'SB_HOUR_MAX').replace(/\bINTERVAL_MIN_MINUTES\b/g, 'SB_INTERVAL_MIN_MINUTES').replace(/\bclampInt\b/g, 'sbClampInt').trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
  for (const line of coreLines) {
    assert.ok(block.includes(line), 'client 镜像段缺少核心行: ' + line)
  }
})
