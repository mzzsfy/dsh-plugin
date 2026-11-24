// 调度构建器纯函数行为锁定:结构化状态与 cron 表达式互转,反解不出即 custom。
// BDD:给定表单状态,生成表达式;给定表达式,反解为表单状态;不可表达形态一律 custom 兜底。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSchedule, createScheduleState, formatTzOffset, parseSchedule, tzSelectOptions, tzSuffixOffset, FREQS } from '../src/schedule-builder.mjs'

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

test('时区后缀:反解与回写 T+N', () => {
  const state = parseSchedule('0 9 * * *T+8')
  assert.equal(state.freq, 'daily')
  assert.equal(state.hour, 9)
  assert.equal(state.timezone, 8)
  assert.equal(buildSchedule(state), '0 9 * * *T+8')
})

test('时区后缀:无后缀反解 timezone 为 null,回写不附加', () => {
  const state = parseSchedule('30 8 * * *')
  assert.equal(state.timezone, null)
  assert.equal(buildSchedule(state), '30 8 * * *')
})

test('时区后缀:interval 与工作日形态同样携带', () => {
  const interval = parseSchedule('*/30 * * * *T+0')
  assert.equal(interval.freq, 'interval')
  assert.equal(interval.timezone, 0)
  assert.equal(buildSchedule(interval), '*/30 * * * *T+0')
  const weekdays = parseSchedule('0 9 * * 1-5T-5')
  assert.equal(weekdays.freq, 'weekdays')
  assert.equal(weekdays.timezone, -5)
  assert.equal(buildSchedule(weekdays), '0 9 * * 1-5T-5')
})

test('时区后缀:非法后缀反解 custom 且原文保留,不抛', () => {
  const state = parseSchedule('0 9 * * *T+15')
  assert.equal(state.freq, 'custom')
  assert.equal(state.expression, '0 9 * * *T+15')
  assert.equal(state.timezone, null)
})

test('时区后缀:custom 合法后缀剥离存储,回写统一附加', () => {
  const state = parseSchedule('0 9 * * * 2026T+8')
  assert.equal(state.freq, 'custom')
  assert.equal(state.expression, '0 9 * * * 2026')
  assert.equal(state.timezone, 8)
  assert.equal(buildSchedule(state), '0 9 * * * 2026T+8')
})

test('时区后缀:createScheduleState 默认无后缀,置空回写不带后缀', () => {
  const state = createScheduleState('')
  assert.equal(state.timezone, null)
  state.freq = 'daily'
  state.hour = 2
  assert.equal(buildSchedule(state), '0 2 * * *')
})

test('E5:非整点偏移按 ±H:MM 展示,不四舍五入成整点', () => {
  assert.equal(formatTzOffset(8), '+8')
  assert.equal(formatTzOffset(0), '+0')
  assert.equal(formatTzOffset(-5), '-5')
  // 印度 +5:30、尼泊尔 +5:45、伊朗 +3:30、马克萨斯 -9:30
  assert.equal(formatTzOffset(5.5), '+5:30')
  assert.equal(formatTzOffset(5.75), '+5:45')
  assert.equal(formatTzOffset(-3.5), '-3:30')
  assert.equal(formatTzOffset(-9.5), '-9:30')
})

test('E5:非整点设备时区不写后缀(不取整成错误小时),整点照旧固化', () => {
  // Given 设备时区 +5:30 新建任务:后缀语法只收整小时
  const india = parseSchedule('30 8 * * *')
  india.timezone = tzSuffixOffset(5.5)
  // Then 回退宿主默认,表达式无后缀;旧实现取整成 T+6,整体错半小时
  assert.equal(india.timezone, null)
  assert.equal(buildSchedule(india), '30 8 * * *')
  // And 整点设备时区仍固化后缀
  const tokyo = parseSchedule('30 8 * * *')
  tokyo.timezone = tzSuffixOffset(9)
  assert.equal(buildSchedule(tokyo), '30 8 * * *T+9')
  // And 非整点值即使被外部写进状态也不产出非法后缀(构建侧自守)
  const dirty = parseSchedule('30 8 * * *')
  dirty.timezone = 5.5
  assert.equal(buildSchedule(dirty), '30 8 * * *')
})

test('E5:时区下拉选项始终覆盖当前值(选中项不渲染空白)', () => {
  // Given 整点当前值
  const whole = tzSelectOptions(8)
  // Then 覆盖 T±N 全区间且含当前值
  assert.equal(whole[0], -12)
  assert.equal(whole[whole.length - 1], 14)
  assert.ok(whole.includes(8))
  // Given 非整点当前值(脏状态/外部写入)
  const fractional = tzSelectOptions(5.5)
  // Then 兜底项按数值序插入,value 与 option 一一对应
  assert.ok(fractional.includes(5.5))
  assert.equal(fractional.indexOf(5.5), fractional.indexOf(5) + 1)
  // Given 无后缀(host)
  assert.equal(tzSelectOptions(null).length, whole.length)
})

test('E5:client 装配接线——默认偏移与下拉选项都经纯函数', () => {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const client = readFileSync(join(pkgRoot, 'src', 'client.js'), 'utf8')
  // 新建任务:设备时区先过后缀守卫(非整点 → null)
  assert.match(client, /initial\.timezone = tzSuffixOffset\(deviceTzOffset\(\)\)/)
  // 下拉:选项由 tzSelectOptions 派生(不再内联区间数组,当前值永远有 option)
  assert.match(client, /tzSelectOptions\(state\.timezone\)\.map/)
  // 设备偏移不再取整
  assert.doesNotMatch(client, /Math\.round\(-new Date\(\)\.getTimezoneOffset\(\)/)
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
    .map((line) => line.replace(/^export /, '').replace(/\bFREQS\b/g, 'SB_FREQS').replace(/\bWEEKDAY_ORDER\b/g, 'SB_WEEKDAY_ORDER').replace(/\bWEEKDAY_LABELS\b/g, 'SB_WEEKDAY_LABELS').replace(/\bMINUTE_MAX\b/g, 'SB_MINUTE_MAX').replace(/\bHOUR_MAX\b/g, 'SB_HOUR_MAX').replace(/\bINTERVAL_MIN_MINUTES\b/g, 'SB_INTERVAL_MIN_MINUTES').replace(/\bMINUTES_PER_HOUR\b/g, 'SB_MINUTES_PER_HOUR').replace(/\bTZ_SUFFIX_MIN\b/g, 'SB_TZ_SUFFIX_MIN').replace(/\bTZ_SUFFIX_MAX\b/g, 'SB_TZ_SUFFIX_MAX').replace(/\bTZ_SUFFIX_PATTERN\b/g, 'SB_TZ_SUFFIX_PATTERN').replace(/\bsplitScheduleTz\b/g, 'sbSplitScheduleTz').replace(/\bformatTzOffset\b/g, 'sbFormatTzOffset').replace(/\bbuildBase\b/g, 'sbBuildBase').replace(/\bclampInt\b/g, 'sbClampInt').trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
  for (const line of coreLines) {
    assert.ok(block.includes(line), 'client 镜像段缺少核心行: ' + line)
  }
})
