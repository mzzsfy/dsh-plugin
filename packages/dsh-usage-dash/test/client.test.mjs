// client 纯函数层测试:滚动窗口映射/信封解析/上限裁剪/文案/格式化/分组/柱状几何
// Given/When/Then 场景内嵌于用例描述
// client.js 为经典 script bundle(禁 import/export),整文件 IIFE 书挡;经 client-eval 剥壳后整源求值,按顶层声明名收集
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  CHART_HEIGHT,
  CHART_PAD,
  DAY_MAX_SLOTS,
  DAY_PRESETS,
  DEFAULT_HOUR_PRESET,
  DEFAULT_MINUTE_PRESET,
  DEFAULT_RANGE,
  DONUT_CENTER_XY,
  DONUT_CIRCUMFERENCE,
  DONUT_OUTER_RADIUS,
  DONUT_RADIUS,
  DONUT_STROKE_WIDTH,
  DONUT_VIEWBOX_SIZE,
  HEAT_BASE,
  HEAT_GAP,
  HEAT_RX,
  HEAT_WEEKS,
  HEAT_WINDOW_DAYS,
  HOUR_PRESETS,
  MINUTE_PRESETS,
  MESSAGES_EN,
  MESSAGES_ZH,
  OTHER_MODEL,
  aggregateCurrencyOf,
  applyCurrencyToRules,
  cacheRateText,
  coerceConditions,
  coercePricingRules,
  costOf,
  costTitleText,
  createTranslator,
  daysInRange,
  defaultCondition,
  defaultPricingRule,
  donutSegments,
  pointStatsMatches,
  formatCompact,
  formatCost,
  formatDuration,
  formatTokens,
  formatTokensCompact,
  groupPointSlots,
  groupStats,
  heatDisplayDays,
  heatGrid,
  heatLayout,
  heatLevel,
  hourTickLabel,
  indexOfDay,
  isEmptyRange,
  groupRulesOf,
  insertRuleAt,
  logTimeOf,
  matchPrice,
  maxSlotsFor,
  minuteTickLabel,
  modelIoPercentText,
  hasTipContent,
  tipModelEntries,
  modelSegmentLabel,
  modelSpeedText,
  modelNameOf,
  moveRuleTo,
  niceTicks,
  otherDetailItems,
  parseEnvelope,
  partitionGroupOf,
  pointerAt,
  providerOf,
  rateAxisTicks,
  removeRulesAt,
  renameRulesAt,
  resolveDayRange,
  resolveHourRange,
  resolveMinuteRange,
  resolveHourCustomRange,
  resolveMinuteCustomRange,
  resolvePointQuery,
  formatDateTimeInput,
  parseLocalDateTime,
  shortDay,
  smoothPath,
  tipPlace,
  translateWith,
  trimSlots,
  trendLayout,
  trendRatePoints,
  trendSpeedPoints,
  trendTtftPoints,
  ttftScaleMax,
  ttftTipText,
  modelTtftText,
  speedTipText,
  speedScaleMax,
  legendToggle,
  leftAxisTicks,
  hourSlotLabel,
  minuteSlotLabel,
  validatePricingRules,
} = core

const EPSILON = 1e-9
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < EPSILON, `expected ${expected}, got ${actual}`)

// 本地时区固定时钟:2026-03-15 14:30:45
const NOW = new Date(2026, 2, 15, 14, 30, 45)

test('day 预设映射为最近 N 天闭区间', () => {
  assert.deepEqual(resolveDayRange('7', NOW), { from: '2026-03-09', to: '2026-03-15' })
  assert.deepEqual(resolveDayRange('30', NOW), { from: '2026-02-14', to: '2026-03-15' })
})

test('day 预设跨年与跨月边界', () => {
  assert.deepEqual(resolveDayRange('7', new Date(2026, 0, 3)), { from: '2025-12-28', to: '2026-01-03' })
  assert.deepEqual(resolveDayRange('30', new Date(2026, 2, 5)), { from: '2026-02-04', to: '2026-03-05' })
})

test('day 90 天预设起点回卷上年', () => {
  assert.deepEqual(resolveDayRange('90', NOW), { from: '2025-12-16', to: '2026-03-15' })
})

test('hour 预设 now-N 舍入到整点桶起点', () => {
  assert.deepEqual(resolveHourRange('24h', NOW), { from: '2026-03-14T14', to: '2026-03-15T14' })
  assert.deepEqual(resolveHourRange('3d', NOW), { from: '2026-03-12T14', to: '2026-03-15T14' })
})

test('hour 预设跨日且窗口起点落整点', () => {
  assert.deepEqual(resolveHourRange('24h', new Date(2026, 2, 15, 0, 30)), { from: '2026-03-14T00', to: '2026-03-15T00' })
})

test('minute 预设起点对齐 10 分钟桶,to 保持原始分钟', () => {
  assert.deepEqual(resolveMinuteRange('3h', NOW), { from: '2026-03-15T11:30', to: '2026-03-15T14:30' })
  assert.deepEqual(resolveMinuteRange('24h', NOW), { from: '2026-03-14T14:30', to: '2026-03-15T14:30' })
  const offGrid = new Date(2026, 2, 15, 14, 37, 20)
  assert.deepEqual(resolveMinuteRange('3h', offGrid), { from: '2026-03-15T11:30', to: '2026-03-15T14:37' })
})

test('minute 预设整桶边界不再回退', () => {
  assert.deepEqual(resolveMinuteRange('3h', new Date(2026, 2, 15, 14, 30, 0)), { from: '2026-03-15T11:30', to: '2026-03-15T14:30' })
})

test('预设定义表覆盖三视图', () => {
  assert.deepEqual(DAY_PRESETS, ['7', '30', '90'])
  assert.deepEqual(HOUR_PRESETS, ['24h', '3d', '7d', '15d'])
  assert.deepEqual(MINUTE_PRESETS, ['3h', '24h', '3d', '7d'])
})

test('默认挡位均在其挡位列表内,分钟窗口可解析', () => {
  assert.ok(DAY_PRESETS.includes(DEFAULT_RANGE))
  assert.ok(HOUR_PRESETS.includes(DEFAULT_HOUR_PRESET))
  assert.ok(MINUTE_PRESETS.includes(DEFAULT_MINUTE_PRESET))
  assert.notEqual(resolveMinuteRange(DEFAULT_MINUTE_PRESET, NOW), null)
})

test('时/分挡位文案键逐挡齐备,含跨表同 id 挡位', () => {
  // Given 时/分挡位表存在同 id('24h') When 逐挡查词典 Then 两语言均有对应键,漏配即回退键名
  for (const id of HOUR_PRESETS) {
    assert.notEqual(MESSAGES_ZH[`hourPreset.${id}`], undefined, `zh hourPreset.${id}`)
    assert.notEqual(MESSAGES_EN[`hourPreset.${id}`], undefined, `en hourPreset.${id}`)
  }
  for (const id of MINUTE_PRESETS) {
    assert.notEqual(MESSAGES_ZH[`minutePreset.${id}`], undefined, `zh minutePreset.${id}`)
    assert.notEqual(MESSAGES_EN[`minutePreset.${id}`], undefined, `en minutePreset.${id}`)
  }
})

test('pointStats 缓存命中须视图与挡位双匹配', () => {
  // Given 同挡位 id 跨视图('24h') When 判定缓存命中 Then 视图不同即不命中,防误用他端点数据
  const cached = { view: 'hour', preset: '24h', value: { daily: [] } }
  assert.equal(pointStatsMatches(cached, 'hour', '24h'), true)
  assert.equal(pointStatsMatches(cached, 'minute', '24h'), false)
  assert.equal(pointStatsMatches(cached, 'hour', '3d'), false)
  assert.equal(pointStatsMatches(null, 'hour', '24h'), false)
})

// —— 时/分自定义时间范围:归一语义与预设挡一致(小时 floor 整点桶,分钟 from 对齐 10 分钟桶、to 保原分钟) ——

const CUSTOM_FROM = '2026-03-14T09:45'
const CUSTOM_TO = '2026-03-15T14:10'

test('hour 自定义范围两端 floor 到所在小时桶', () => {
  // Given datetime 输入含分钟偏移 When 解析 Then 两端均取所在小时桶起点(闭区间)
  assert.deepEqual(resolveHourCustomRange(CUSTOM_FROM, CUSTOM_TO), { from: '2026-03-14T09', to: '2026-03-15T14' })
  assert.deepEqual(resolveHourCustomRange('2026-03-14T09:00', '2026-03-15T14:59'), { from: '2026-03-14T09', to: '2026-03-15T14' })
})

test('hour 自定义跨度超保留期钳起点,临界窗经 floor 与原窗输出等价', () => {
  // Given 跨度 16 天 When 解析 Then 起点钳到终点前 15 天整点;15 天余零头的窗钳后 floor 输出不变
  assert.deepEqual(
    resolveHourCustomRange('2026-02-27T00:00', '2026-03-15T14:10'),
    { from: '2026-02-28T14', to: '2026-03-15T14' },
  )
  assert.deepEqual(
    resolveHourCustomRange('2026-02-28T14:00', '2026-03-15T14:10'),
    { from: '2026-02-28T14', to: '2026-03-15T14' },
  )
})

test('hour 自定义非法输入返回 null', () => {
  // Given 空值/垃圾串/from 晚于 to When 解析 Then 恒 null,不发请求
  assert.equal(resolveHourCustomRange('', CUSTOM_TO), null)
  assert.equal(resolveHourCustomRange(CUSTOM_FROM, ''), null)
  assert.equal(resolveHourCustomRange('junk', CUSTOM_TO), null)
  assert.equal(resolveHourCustomRange('2026-13-40T09:00', CUSTOM_TO), null)
  assert.equal(resolveHourCustomRange(CUSTOM_TO, CUSTOM_FROM), null)
})

test('parseLocalDateTime 拒绝数字分量回卷的日历非法值', () => {
  // Given 超界分量(13 月/2 月 30 日/25 时)在 Date 构造下静默回卷 When 解析 Then 逐分量回读拦截为 null
  assert.equal(parseLocalDateTime('2026-13-01T00:00'), null)
  assert.equal(parseLocalDateTime('2026-02-30T10:00'), null)
  assert.equal(parseLocalDateTime('2026-03-14T25:00'), null)
  assert.deepEqual(parseLocalDateTime('2026-03-14T09:45'), new Date(2026, 2, 14, 9, 45))
})

test('hour 自定义拒绝回卷后仍保序的非法日历输入', () => {
  // Given 13 月回卷为次年 1 月且整体仍早于 to When 解析 Then 恒 null,不静默改写查询时段
  assert.equal(resolveHourCustomRange('2026-13-01T00:00', '2027-06-01T00:00'), null)
})

test('minute 自定义 from 对齐 10 分钟桶,to 保持原始分钟', () => {
  // Given from 含非对齐分钟 When 解析 Then from floor 到桶边界,to 原值保留(闭区间上界)
  assert.deepEqual(resolveMinuteCustomRange(CUSTOM_FROM, CUSTOM_TO), { from: '2026-03-14T09:40', to: '2026-03-15T14:10' })
  assert.deepEqual(resolveMinuteCustomRange('2026-03-14T09:40', '2026-03-15T14:17'), { from: '2026-03-14T09:40', to: '2026-03-15T14:17' })
})

test('minute 自定义跨度超保留期钳起点', () => {
  // Given 跨度 8 天 When 解析 Then 起点钳到终点前 7 天的 10 分钟桶边界
  assert.deepEqual(
    resolveMinuteCustomRange('2026-03-06T00:00', '2026-03-15T14:10'),
    { from: '2026-03-08T14:10', to: '2026-03-15T14:10' },
  )
})

test('minute 自定义非法输入返回 null', () => {
  assert.equal(resolveMinuteCustomRange('', CUSTOM_TO), null)
  assert.equal(resolveMinuteCustomRange('junk', CUSTOM_TO), null)
  assert.equal(resolveMinuteCustomRange(CUSTOM_TO, CUSTOM_FROM), null)
})

test('resolvePointQuery 预设挡返回挡位键与滚动窗口请求', () => {
  // Given 时/分预设挡 When 解析查询 Then 键为挡位 id,请求与既有 resolve 同构
  const hour = resolvePointQuery('hour', '24h', '', '', NOW)
  assert.equal(hour.key, '24h')
  assert.deepEqual(hour.request, resolveHourRange('24h', NOW))
  const minute = resolvePointQuery('minute', '3h', '', '', NOW)
  assert.equal(minute.key, '3h')
  assert.deepEqual(minute.request, resolveMinuteRange('3h', NOW))
})

test('resolvePointQuery 自定义挡键含归一范围且随范围变化', () => {
  // Given 同视图同挡不同范围 When 解析查询 Then 键互异;同范围键稳定(缓存可命中)
  const first = resolvePointQuery('hour', 'custom', CUSTOM_FROM, CUSTOM_TO, NOW)
  assert.deepEqual(first.request, { from: '2026-03-14T09', to: '2026-03-15T14' })
  assert.equal(first.key, 'custom:2026-03-14T09:2026-03-15T14')
  const again = resolvePointQuery('hour', 'custom', CUSTOM_FROM, CUSTOM_TO, NOW)
  assert.equal(again.key, first.key)
  const shifted = resolvePointQuery('hour', 'custom', '2026-03-14T10:45', CUSTOM_TO, NOW)
  assert.notEqual(shifted.key, first.key)
  const minute = resolvePointQuery('minute', 'custom', CUSTOM_FROM, CUSTOM_TO, NOW)
  assert.deepEqual(minute.request, { from: '2026-03-14T09:40', to: '2026-03-15T14:10' })
  assert.notEqual(minute.key, first.key)
})

test('resolvePointQuery 自定义输入不完整返回 null', () => {
  // Given 任一端为空 When 解析查询 Then null,面板不发请求不误清缓存
  assert.equal(resolvePointQuery('hour', 'custom', '', CUSTOM_TO, NOW), null)
  assert.equal(resolvePointQuery('minute', 'custom', CUSTOM_FROM, '', NOW), null)
})

test('maxSlotsFor custom 挡取保留期桶数上限', () => {
  // Given 自定义挡受保留期钳制 When 取渲染上限 Then 小时为 15 天小时桶数,分钟为 7 天 10 分钟桶数
  assert.equal(maxSlotsFor('hour', 'custom'), 15 * 24 + 1)
  assert.equal(maxSlotsFor('minute', 'custom'), (7 * 24 * 60) / 10 + 1)
})

test('formatDateTimeInput 产出 datetime-local 分钟粒度值', () => {
  assert.equal(formatDateTimeInput(new Date(2026, 2, 15, 9, 5)), '2026-03-15T09:05')
  assert.equal(formatDateTimeInput(NOW), '2026-03-15T14:30')
})

test('每视图渲染上限等于闭区间桶数', () => {
  assert.equal(maxSlotsFor('day', '90'), DAY_MAX_SLOTS)
  assert.equal(maxSlotsFor('hour', '24h'), 25)
  assert.equal(maxSlotsFor('hour', '3d'), 73)
  assert.equal(maxSlotsFor('hour', '7d'), 169)
  assert.equal(maxSlotsFor('hour', '15d'), 361)
  assert.equal(maxSlotsFor('minute', '3h'), 19)
  assert.equal(maxSlotsFor('minute', '24h'), 145)
  assert.equal(maxSlotsFor('minute', '3d'), 433)
  assert.equal(maxSlotsFor('minute', '7d'), 1009)
})

test('trim 超上限裁最旧且恰好达上限不裁', () => {
  const slots = ['1', '2', '3', '4', '5', '6'].map((day) => ({ day }))
  assert.deepEqual(trimSlots(slots, 3).map((slot) => slot.day), ['4', '5', '6'])
  assert.equal(trimSlots(slots, 6), slots)
})

test('日志条目时刻补零为 HH:mm:ss', () => {
  assert.equal(logTimeOf(new Date(2026, 8, 8, 9, 3, 7).getTime()), '09:03:07')
  assert.equal(logTimeOf(new Date(2026, 8, 8, 19, 13, 47).getTime()), '19:13:47')
})

test('信封解析成功透传 value', () => {
  assert.deepEqual(parseEnvelope({ ok: true, value: { a: 1 } }), { ok: true, value: { a: 1 } })
})

test('信封解析失败透传 code 与 message', () => {
  assert.deepEqual(
    parseEnvelope({ ok: false, error: { code: 'forbidden', message: '拒绝' } }),
    { ok: false, code: 'forbidden', message: '拒绝' },
  )
})

test('信封解析键缺失回退默认 code 与 message', () => {
  assert.equal(parseEnvelope({ ok: false }).code, 'error')
  assert.equal(parseEnvelope({ ok: false, error: {} }).message, 'usage api error')
  assert.equal(parseEnvelope(null).ok, false)
  assert.equal(parseEnvelope('junk').code, 'error')
})

test('translateWith zh/en 占位替换与缺键回退键名', () => {
  assert.equal(translateWith(MESSAGES_ZH, 'status.running', { done: 2, total: 9 }), '回扫中 2/9')
  assert.equal(translateWith(MESSAGES_ZH, 'trendLimited', { n: 45 }), '仅显示最近 45 天')
  assert.equal(translateWith(MESSAGES_ZH, 'refresh'), '刷新')
  assert.equal(translateWith(MESSAGES_ZH, 'no.such.key'), 'no.such.key')
  assert.equal(translateWith(MESSAGES_EN, 'skippedSessions', { n: 2 }), '2 unreadable sessions skipped')
  assert.equal(translateWith(MESSAGES_EN, 'trendLimited', { n: 45 }), 'Showing only the last 45 days')
  assert.equal(translateWith(MESSAGES_EN, 'rebuild'), 'Rebuild')
  assert.equal(translateWith(MESSAGES_EN, 'no.such.key'), 'no.such.key')
})

test('createTranslator 与纯查表同构', () => {
  const enT = createTranslator(MESSAGES_EN)
  assert.equal(enT('rangeCustom'), 'Custom')
  assert.equal(enT('hourPreset.15d'), '15 days')
  assert.equal(enT('minutePreset.7d'), '7 days')
  assert.equal(enT('missing.key'), 'missing.key')
})

test('zh/en 词典键集完全一致', () => {
  assert.deepEqual(Object.keys(MESSAGES_ZH).sort(), Object.keys(MESSAGES_EN).sort())
})

test('文案表覆盖 client.js 全部 t 键', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client.js'), 'utf8')
  const keys = [...source.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1])
  assert.ok(keys.length >= 10, `应从 client.js 抽到 t 调用,实际 ${keys.length}`)
  for (const key of keys) assert.ok(key in MESSAGES_ZH, `缺少文案键: ${key}`)
})

test('formatDuration/formatTokensCompact 传 en 翻译器输出官方口径', () => {
  const enT = createTranslator(MESSAGES_EN)
  assert.equal(formatDuration(4500, enT), '4.5s')
  assert.equal(formatDuration(162000, enT), '2m42s')
  assert.equal(formatTokensCompact(12200, enT), '12.2K')
  assert.equal(formatTokensCompact(5000, enT), '5K')
})

test('数字格式化千分位与紧凑单位', () => {
  assert.equal(formatTokens(1234567), '1,234,567')
  assert.equal(formatCompact(999), '999')
  assert.equal(formatCompact(1234), '1.2k')
  assert.equal(formatCompact(1234567), '1.2M')
  assert.equal(formatCompact(2.5e9), '2.5B')
})

test('命中率文案零数据为占位符', () => {
  assert.equal(cacheRateText(0, 0), '—')
  assert.equal(cacheRateText(30, 70), '30.0%')
})

test('模型 ref 拆分与缺省 provider', () => {
  assert.equal(modelNameOf('openai/gpt'), 'gpt')
  assert.equal(providerOf('openai/gpt'), 'openai')
  assert.equal(modelNameOf('solo'), 'solo')
  assert.equal(providerOf('solo'), 'default')
})

test('X 轴标签日界槽叠加日期其余纯时分', () => {
  assert.equal(shortDay('2026-03-05'), '3/5')
  assert.equal(hourTickLabel('2026-03-15T09'), '09:00')
  assert.equal(hourTickLabel('2026-03-15T00'), '3/15 00:00')
  assert.equal(minuteTickLabel('2026-03-15T09:05'), '09:05')
  assert.equal(minuteTickLabel('2026-03-15T00:00'), '3/15 00:00')
})

test('空态判定仅四项全零成立', () => {
  assert.equal(isEmptyRange({ tokens: 0, cacheHit: 0, requests: 0, turns: 0 }), true)
  assert.equal(isEmptyRange({ tokens: 1, cacheHit: 0, requests: 0, turns: 0 }), false)
  assert.equal(isEmptyRange({ tokens: 0, cacheHit: 0, requests: 0, turns: 3 }), false)
})

test('groupStats 折叠 top5 之外为其他哨兵并归并逐日', () => {
  const stats = {
    models: [
      { model: 'p/m1', tokens: 500 },
      { model: 'p/m2', tokens: 400 },
      { model: 'p/m3', tokens: 300 },
      { model: 'p/m4', tokens: 200 },
      { model: 'p/m5', tokens: 100 },
      { model: 'p/m6', tokens: 50 },
    ],
    daily: [
      { day: '2026-03-14', total: 1000, byModel: { 'p/m1': 400, 'p/m2': 500, 'p/m6': 100 } },
      { day: '2026-03-15', total: 550, byModel: { 'p/m3': 300, 'p/m6': 250 } },
    ],
  }
  const grouped = groupStats(stats)
  assert.deepEqual(grouped.models.map((m) => m.model), ['p/m1', 'p/m2', 'p/m3', 'p/m4', 'p/m5', OTHER_MODEL])
  assert.equal(grouped.models[5].tokens, 50)
  assert.deepEqual(grouped.daily[0].byModel, { 'p/m1': 400, 'p/m2': 500, [OTHER_MODEL]: 100 })
  assert.deepEqual(grouped.daily[1].byModel, { 'p/m3': 300, [OTHER_MODEL]: 250 })
})

test('groupPointSlots 跨槽求和排名且不超上限不折叠', () => {
  const slots = [
    { day: '2026-03-15T10', total: 15, byModel: { a: 10, b: 5 } },
    { day: '2026-03-15T11', total: 8, byModel: { a: 1, c: 7 } },
  ]
  const grouped = groupPointSlots(slots)
  assert.deepEqual(grouped.models.map((m) => m.model), ['a', 'c', 'b'])
  assert.deepEqual(grouped.models.map((m) => m.tokens), [11, 7, 5])
  assert.deepEqual(grouped.daily[1].byModel, { a: 1, c: 7 })
})

test('groupPointSlots 窗口模型超上限折叠其他', () => {
  const slots = [
    { day: 'h0', total: 6, byModel: { m1: 1, m2: 1, m3: 1, m4: 1, m5: 1, m6: 1 } },
    { day: 'h1', total: 6, byModel: { m1: 3, m6: 3 } },
  ]
  const grouped = groupPointSlots(slots)
  assert.equal(grouped.models.at(-1).model, OTHER_MODEL)
  assert.equal(grouped.models.at(-1).tokens, 1)
  assert.deepEqual(grouped.daily[0].byModel, { m1: 1, m2: 1, m3: 1, m4: 1, m6: 1, [OTHER_MODEL]: 1 })
})

test('niceTicks 产生 1/2/5 序列且零上限为空', () => {
  assert.deepEqual(niceTicks(0, 4), [])
  assert.deepEqual(niceTicks(50, 4), [20, 40])
  assert.deepEqual(niceTicks(1, 4), [0.5, 1])
})

test('trendLayout 单槽列距铺满且柱宽取上限', () => {
  const layout = trendLayout([{ day: '2026-03-15', total: 50, byModel: { a: 30, b: 20 } }], ['a', 'b'], 720, 46)
  assert.equal(layout.step, 720 - 46 - 65)
  assert.equal(layout.barWidth, 30)
  assert.equal(layout.maxTotal, 50)
})

test('trendLayout 零值槽无分段,无可见数据时刻度为空表', () => {
  const layout = trendLayout([{ day: '2026-03-15', total: 0, byModel: {} }], [], 720, 46)
  assert.deepEqual(layout.bars[0].segments, [])
  assert.deepEqual(layout.ticks, [])
})

test('trendLayout 堆叠分段自底向上,轴上限为数据峰乘留白系数', () => {
  const layout = trendLayout([{ day: 'd', total: 50, byModel: { a: 30, b: 20 } }], ['a', 'b'], 720, 46)
  const [segA, segB] = layout.bars[0].segments
  assert.deepEqual(segA.model, 'a')
  assert.deepEqual(segB.model, 'b')
  approx(segA.height, (30 / (50 * 1.1)) * 184)
  approx(segB.height, (20 / (50 * 1.1)) * 184)
  approx(segA.height + segB.height, (50 / (50 * 1.1)) * 184)
  approx(segB.y + segB.height, segA.y)
})

test('trendLayout 数据峰不顶满绘图区,留白系数 1.1', () => {
  const layout = trendLayout([{ day: 'd', total: 30, byModel: { a: 30 } }], ['a'], 720, 46)
  const [segA] = layout.bars[0].segments
  approx(segA.height + CHART_PAD.top, CHART_PAD.top + (1 / 1.1) * 184)
})

test('trendLayout 可见模型无数据时左轴刻度为空表', () => {
  const slots = [{ day: 'd', total: 50, byModel: { a: 50 } }]
  assert.deepEqual(trendLayout(slots, [], 720, 46).ticks, [])
  assert.deepEqual(trendLayout(slots, ['b'], 720, 46).ticks, [])
  assert.ok(trendLayout(slots, ['a'], 720, 46).ticks.length > 0)
})

test('leftAxisTicks 速度模式标定速度刻度,否则标定 token 刻度', () => {
  const tokenTicks = leftAxisTicks([100, 200], 200, [], 1)
  assert.deepEqual(tokenTicks.map((tick) => tick.label), ['100', '200'])
  approx(tokenTicks[0].ratio, 0.5)
  const speedTicks = leftAxisTicks([], 1, [0.5, 1], 1)
  assert.deepEqual(speedTicks.map((tick) => tick.label), ['0.5', '1'])
  approx(speedTicks[0].ratio, 0.5)
  approx(speedTicks[1].ratio, 1)
})

test('hour/minute 悬浮窗槽标签:T 换空格,小时带 h 后缀,分钟保 HH:MM', () => {
  assert.equal(hourSlotLabel('2026-03-15T14'), '2026-03-15 14h')
  assert.equal(hourSlotLabel('2026-03-15T00'), '2026-03-15 00h')
  assert.equal(minuteSlotLabel('2026-03-15T14:30'), '2026-03-15 14:30')
  assert.equal(minuteSlotLabel('2026-03-15T00:00'), '2026-03-15 00:00')
})

test('trendLayout 标签密度随列距收敛', () => {
  const slots = Array.from({ length: 100 }, (_, i) => ({ day: `d${i}`, total: 0, byModel: {} }))
  const layout = trendLayout(slots, [], 720, 46)
  assert.equal(layout.labelEvery, 8)
})

test('热力图常量锁定窗口与几何基准', () => {
  assert.equal(HEAT_WEEKS, 26)
  assert.equal(HEAT_WINDOW_DAYS, HEAT_WEEKS * 7)
  assert.equal(HEAT_BASE, 14)
  assert.equal(HEAT_GAP, 3)
  assert.equal(HEAT_RX, 3)
})

test('indexOfDay 周一为零周日为六', () => {
  assert.equal(indexOfDay('2026-03-09'), 0)
  assert.equal(indexOfDay('2026-03-11'), 2)
  assert.equal(indexOfDay('2026-03-15'), 6)
})

test('daysInRange 闭区间含两端且跨月连续', () => {
  assert.deepEqual(daysInRange('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'])
  assert.deepEqual(daysInRange('2026-03-15', '2026-03-15'), ['2026-03-15'])
})

test('daysInRange 非法日期返回空表', () => {
  assert.deepEqual(daysInRange('junk', 'junk'), [])
})

test('heatLayout 过窄保基准尺寸裁到可容列数', () => {
  assert.deepEqual(heatLayout(200, '2026-03-09'), { size: HEAT_BASE, cols: 11 })
})

test('heatLayout 够宽连续生长铺满窗口', () => {
  const layout = heatLayout(800, '2026-03-09')
  assert.equal(layout.cols, HEAT_WEEKS)
  approx(layout.size, 798 / 27 - 3)
})

test('heatLayout 生长下限不小于基准尺寸', () => {
  assert.deepEqual(heatLayout(460, '2026-03-09'), { size: HEAT_BASE, cols: HEAT_WEEKS })
})

test('heatLayout 极窄至少保一列', () => {
  assert.deepEqual(heatLayout(0, '2026-03-09'), { size: HEAT_BASE, cols: 1 })
})

test('heatDisplayDays 裁剪取尾部保最新且整窗不裁', () => {
  const all = daysInRange('2025-09-15', '2026-03-15')
  assert.equal(all.length, HEAT_WINDOW_DAYS)
  assert.deepEqual(heatDisplayDays(all, 11), all.slice(-11 * 7))
  assert.deepEqual(heatDisplayDays(all, HEAT_WEEKS), all)
})

test('heatGrid 周首位移换行且坐标含格距', () => {
  const rows = daysInRange('2026-03-09', '2026-03-15').map((day) => ({ day }))
  const grid = heatGrid(rows, 14)
  assert.equal(grid.weeks, 2)
  assert.deepEqual(grid.cells[0], { day: '2026-03-09', x: HEAT_GAP, y: HEAT_GAP + 17 })
  assert.deepEqual(grid.cells[6], { day: '2026-03-15', x: HEAT_GAP + 17, y: HEAT_GAP })
  assert.equal(grid.width, 2 * 17 + HEAT_GAP)
  assert.equal(grid.height, 7 * 17 + HEAT_GAP)
})

test('heatGrid 周日对齐零位移整周单列', () => {
  const rows = daysInRange('2026-03-15', '2026-03-21').map((day) => ({ day }))
  const grid = heatGrid(rows, 14)
  assert.equal(grid.weeks, 1)
  assert.deepEqual(grid.cells[6], { day: '2026-03-21', x: HEAT_GAP, y: HEAT_GAP + 6 * 17 })
  assert.equal(grid.width, 17 + HEAT_GAP)
})

test('heatLevel 零值为空档其余按峰值四分位', () => {
  assert.equal(heatLevel(0, 100), 0)
  assert.equal(heatLevel(24, 100), 1)
  assert.equal(heatLevel(25, 100), 2)
  assert.equal(heatLevel(50, 100), 3)
  assert.equal(heatLevel(75, 100), 4)
  assert.equal(heatLevel(100, 100), 5)
  assert.equal(heatLevel(1, 1), 5)
})

const TIP_ANCHOR = { x: 100, y: 100 }
const TIP_SIZE = { width: 80, height: 40 }
const TIP_BOUNDS = { left: 0, top: 0, right: 800, bottom: 600 }

test('tipPlace 指针右下空位放右下', () => {
  assert.deepEqual(tipPlace(TIP_ANCHOR, TIP_SIZE, TIP_BOUNDS), { left: 108, top: 108 })
})

test('tipPlace 右侧越界翻左侧', () => {
  assert.deepEqual(tipPlace({ x: 730, y: 100 }, TIP_SIZE, TIP_BOUNDS), { left: 642, top: 108 })
})

test('tipPlace 下方越界翻上方', () => {
  assert.deepEqual(tipPlace({ x: 100, y: 570 }, TIP_SIZE, TIP_BOUNDS), { left: 108, top: 522 })
})

test('tipPlace 右下均越界双翻', () => {
  assert.deepEqual(tipPlace({ x: 730, y: 570 }, TIP_SIZE, TIP_BOUNDS), { left: 642, top: 522 })
})

test('tipPlace 双翻后仍越界钳进边界', () => {
  assert.deepEqual(tipPlace({ x: 798, y: 598 }, TIP_SIZE, TIP_BOUNDS), { left: 710, top: 550 })
})

test('tipPlace 恰贴右缘等号归属放右侧', () => {
  assert.deepEqual(tipPlace({ x: 704, y: 100 }, TIP_SIZE, TIP_BOUNDS), { left: 712, top: 108 })
})

test('tipPlace 左上角指针放右下不翻转', () => {
  assert.deepEqual(tipPlace({ x: 2, y: 2 }, TIP_SIZE, TIP_BOUNDS), { left: 10, top: 10 })
})

test('tipPlace 提示框宽于边界钳贴左缘', () => {
  assert.equal(tipPlace({ x: 400, y: 100 }, { width: 900, height: 40 }, TIP_BOUNDS).left, 8)
})

test('pointerAt 指针事件取指针坐标', () => {
  assert.deepEqual(pointerAt({ clientX: 12, clientY: 34 }), { x: 12, y: 34 })
})

test('pointerAt 焦点事件回退目标矩形中心', () => {
  const event = {
    currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, right: 30, bottom: 60 }) },
  }
  assert.deepEqual(pointerAt(event), { x: 20, y: 40 })
})

test('tipPlace 零尺寸或非法锚点返回隐藏', () => {
  assert.equal(tipPlace(TIP_ANCHOR, { width: 0, height: 0 }, TIP_BOUNDS), null)
  assert.equal(tipPlace(null, TIP_SIZE, TIP_BOUNDS), null)
  assert.equal(tipPlace({ x: Number.NaN, y: 100 }, TIP_SIZE, TIP_BOUNDS), null)
})

// —— S8 命中率曲线 ——

test('命中率副轴固定零到百五等分刻度', () => {
  assert.deepEqual(rateAxisTicks(), [0, 25, 50, 75, 100])
})

test('trendRatePoints 点映射列中心与百分比高度且零数据日跳过', () => {
  const slots = [
    { day: 'd0', cacheHit: 75, cacheMiss: 25 },
    { day: 'd1', cacheHit: 0, cacheMiss: 0 },
    { day: 'd2', cacheHit: 50, cacheMiss: 50 },
  ]
  const bars = [{ x: 10 }, { x: 20 }, { x: 30 }]
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom
  const points = trendRatePoints(slots, bars, plotHeight)
  assert.equal(points.length, 2)
  assert.equal(points[0].day, 'd0')
  assert.equal(points[0].x, 10)
  approx(points[0].y, CHART_PAD.top + plotHeight - 0.75 * plotHeight)
  assert.equal(points[1].day, 'd2')
  assert.equal(points[1].x, 30)
  approx(points[1].y, CHART_PAD.top + plotHeight - 0.5 * plotHeight)
})

test('trendSpeedPoints 点映射列中心与刻度上限比例高度且无速度槽跳过', () => {
  const slots = [
    { day: 'd0', speed: 50 },
    { day: 'd1', total: 10 },
    { day: 'd2', speed: 25 },
  ]
  const bars = [{ x: 10 }, { x: 20 }, { x: 30 }]
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom
  const points = trendSpeedPoints(slots, bars, plotHeight, 100)
  assert.equal(points.length, 2)
  assert.equal(points[0].day, 'd0')
  assert.equal(points[0].x, 10)
  approx(points[0].y, CHART_PAD.top + plotHeight - 0.5 * plotHeight)
  assert.equal(points[1].day, 'd2')
  assert.equal(points[1].x, 30)
  approx(points[1].y, CHART_PAD.top + plotHeight - 0.25 * plotHeight)
})

test('speedTipText 无速度为占位符有速度为官方吞吐口径', () => {
  assert.equal(speedTipText(undefined), '—')
  assert.equal(speedTipText(5.5556), '5.6 tok/s')
  assert.equal(speedTipText(12.34), '12 tok/s')
})

test('legendToggle 普通点击单选,再点恢复全部,ctrl 多选且禁全藏', () => {
  // null 表示全部可见
  assert.deepEqual(legendToggle(null, 'a', false), new Set(['a']))
  // 单选态再点同项恢复全部(null)
  assert.equal(legendToggle(new Set(['a']), 'a', false), null)
  // 单选态点他项 → 切换单选目标
  assert.deepEqual(legendToggle(new Set(['a']), 'b', false), new Set(['b']))
  // ctrl 切换单项:加入与移除
  assert.deepEqual(legendToggle(new Set(['a']), 'b', true), new Set(['a', 'b']))
  assert.deepEqual(legendToggle(new Set(['a', 'b']), 'b', true), new Set(['a']))
  // ctrl 隐藏最后一项:无操作,保持原态
  const solo = new Set(['a'])
  assert.equal(legendToggle(solo, 'a', true), solo)
})

test('trendLayout 刻度跟随可见模型:单模型刻度按该槽内合计归一', () => {
  const slots = [
    { day: 'd0', total: 50, byModel: { a: 30, b: 20 } },
    { day: 'd1', total: 90, byModel: { a: 40, b: 50 } },
  ]
  assert.equal(trendLayout(slots, ['a', 'b'], 720, 46).maxTotal, 90)
  assert.equal(trendLayout(slots, ['a'], 720, 46).maxTotal, 40)
  assert.equal(trendLayout(slots, [], 720, 46).maxTotal, 1)
})

test('speedScaleMax 全零或空槽钳底防除零,混合取最大速度', () => {
  assert.equal(speedScaleMax([]), 1)
  assert.equal(speedScaleMax([{ day: 'd0' }, { day: 'd1', speed: 0 }]), 1)
  assert.equal(speedScaleMax([{ day: 'd0', speed: 30 }, { day: 'd1', speed: 12.5 }]), 30)
})

test('trendTtftPoints 点映射列中心与刻度上限比例高度且无 ttft 槽跳过', () => {
  const slots = [
    { day: 'd0', ttft: 2000 },
    { day: 'd1', total: 10 },
    { day: 'd2', ttft: 1000 },
  ]
  const bars = [{ x: 10 }, { x: 20 }, { x: 30 }]
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom
  const points = trendTtftPoints(slots, bars, plotHeight, 2200)
  assert.equal(points.length, 2)
  assert.equal(points[0].day, 'd0')
  assert.equal(points[0].x, 10)
  approx(points[0].y, CHART_PAD.top + plotHeight - (2000 / 2200) * plotHeight)
  assert.equal(points[1].day, 'd2')
  assert.equal(points[1].x, 30)
  approx(points[1].y, CHART_PAD.top + plotHeight - (1000 / 2200) * plotHeight)
})

test('ttftScaleMax 全零或空槽钳底防除零,混合取最大延迟', () => {
  assert.equal(ttftScaleMax([]), 1)
  assert.equal(ttftScaleMax([{ day: 'd0' }, { day: 'd1', ttft: 0 }]), 1)
  assert.equal(ttftScaleMax([{ day: 'd0', ttft: 3000 }, { day: 'd1', ttft: 1250 }]), 3000)
})

test('ttftTipText 无 ttft 为占位符有 ttft 为官方时长口径', () => {
  const zhT = createTranslator(MESSAGES_ZH)
  const enT = createTranslator(MESSAGES_EN)
  assert.equal(ttftTipText(undefined, zhT), '—')
  assert.equal(ttftTipText(200, zhT), '0.2秒')
  assert.equal(ttftTipText(200, enT), '0.2s')
  assert.equal(ttftTipText(9500, zhT), '9.5秒')
})

test('ttftLegend 中英文案注册', () => {
  assert.equal(MESSAGES_ZH.ttftLegend, '首 token 延迟')
  assert.equal(MESSAGES_EN.ttftLegend, 'First-token latency')
})

test('smoothPath 空点集为空串单点为移动命令', () => {
  assert.equal(smoothPath([]), '')
  assert.equal(smoothPath([{ x: 1, y: 2 }]), 'M 1 2')
})

test('smoothPath 两点控制点取邻点差六分之一端点折返', () => {
  const d = smoothPath([{ x: 0, y: 0 }, { x: 60, y: 30 }])
  assert.equal(d, 'M 0 0 C 10 5, 50 25, 60 30')
})

test('smoothPath 三点后段取真实邻点', () => {
  const d = smoothPath([{ x: 0, y: 0 }, { x: 60, y: 30 }, { x: 120, y: 0 }])
  assert.equal(d, 'M 0 0 C 10 5, 40 30, 60 30 C 80 30, 110 5, 120 0')
})

test('smoothPath 相邻点间距超 maxGap 折线断开成新段', () => {
  const points = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 300, y: 0 }, { x: 360, y: 0 }]
  const d = smoothPath(points, 90)
  assert.equal(d, 'M 0 0 C 10 0, 10 0, 60 0 M 300 0 C 350 0, 350 0, 360 0')
  // 无 maxGap 时不分段,行为与旧签名一致
  assert.equal(smoothPath(points).includes('M 300'), false)
})

// —— S8 模型 donut 与列表 ——

test('donut 常量锁定视口与环几何', () => {
  assert.equal(DONUT_VIEWBOX_SIZE, 200)
  assert.equal(DONUT_CENTER_XY, 100)
  assert.equal(DONUT_OUTER_RADIUS, 95)
  assert.equal(DONUT_STROKE_WIDTH, 30)
  assert.equal(DONUT_RADIUS, DONUT_OUTER_RADIUS - DONUT_STROKE_WIDTH / 2)
  approx(DONUT_CIRCUMFERENCE, 2 * Math.PI * DONUT_RADIUS)
})

test('donutSegments 分段 dash 按 token 占比 offset 渲染序累加', () => {
  const segments = donutSegments([{ model: 'a', tokens: 75 }, { model: 'b', tokens: 25 }], 100)
  approx(segments[0].dash, DONUT_CIRCUMFERENCE * 0.75)
  assert.equal(segments[0].offset, 0)
  approx(segments[0].percent, 75)
  approx(segments[1].dash, DONUT_CIRCUMFERENCE * 0.25)
  approx(segments[1].offset, DONUT_CIRCUMFERENCE * 0.75)
  approx(segments[0].dash + segments[1].dash, DONUT_CIRCUMFERENCE)
})

test('donutSegments 全零 total 回落下限防除零', () => {
  const segments = donutSegments([{ model: 'a', tokens: 0 }], 0)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].dash, 0)
  assert.equal(segments[0].offset, 0)
  assert.equal(segments[0].percent, 0)
})

test('groupStats 哨兵折叠四桶求和,top 模型四桶透传', () => {
  // Given 超 top 上限模型条目带四桶 When 分组 Then 哨兵四桶为 rest 求和,top 条目原字段保留
  const stats = {
    models: [
      { model: 'p/m1', tokens: 500, inputTokens: 300, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: 'p/m2', tokens: 400, inputTokens: 100, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: 'p/m3', tokens: 300, inputTokens: 0, outputTokens: 100, cacheReadTokens: 150, cacheWriteTokens: 50 },
      { model: 'p/m4', tokens: 200, inputTokens: 80, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: 'p/m5', tokens: 100, inputTokens: 60, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: 'p/m6', tokens: 50, inputTokens: 10, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 5 },
    ],
    daily: [],
  }
  const grouped = groupStats(stats)
  assert.equal(grouped.models[0].inputTokens, 300)
  assert.equal(grouped.models[0].outputTokens, 200)
  assert.deepEqual(grouped.models[5], {
    model: OTHER_MODEL,
    tokens: 50,
    inputTokens: 10,
    outputTokens: 30,
    cacheReadTokens: 5,
    cacheWriteTokens: 5,
    items: [stats.models[5]],
  })
})

test('groupStats 哨兵费用同源:无 cost 输入不挂 cost,有 cost 求和', () => {
  // Given rest 条目无 cost When 折叠 Then 哨兵无 cost 字段;Given rest 带 cost When 折叠 Then 哨兵求和
  const bare = groupStats({ models: [
    { model: 'p/m1', tokens: 500 },
    { model: 'p/m2', tokens: 400 },
    { model: 'p/m3', tokens: 300 },
    { model: 'p/m4', tokens: 200 },
    { model: 'p/m5', tokens: 100 },
    { model: 'p/m6', tokens: 50 },
  ], daily: [] })
  assert.equal('cost' in bare.models[5], false)
  const priced = groupStats({ models: [
    { model: 'p/m1', tokens: 500, cost: 1 },
    { model: 'p/m2', tokens: 400, cost: 2 },
    { model: 'p/m3', tokens: 300, cost: undefined },
    { model: 'p/m4', tokens: 200, cost: 4 },
    { model: 'p/m5', tokens: 100, cost: 8 },
    { model: 'p/m6', tokens: 50, cost: 16 },
    { model: 'p/m7', tokens: 25, cost: 32 },
  ], daily: [] })
  assert.equal(priced.models[5].cost, 16 + 32)
})

test('groupStats 哨兵保留其他模型明细供展开与提示', () => {
  const stats = {
    models: [
      { model: 'p/m1', tokens: 500 },
      { model: 'p/m2', tokens: 400 },
      { model: 'p/m3', tokens: 300 },
      { model: 'p/m4', tokens: 200 },
      { model: 'p/m5', tokens: 100 },
      { model: 'p/m6', tokens: 50 },
    ],
    daily: [],
  }
  const grouped = groupStats(stats)
  assert.deepEqual(grouped.models[5].items, [{ model: 'p/m6', tokens: 50 }])
  // Given 旧形条目无四桶 When 折叠 Then 哨兵不合成零值四桶,与 top 条目降级形态一致
  assert.equal('inputTokens' in grouped.models[5], false)
})

test('groupStats 逐日保留其他明细映射供 tooltip', () => {
  const stats = {
    models: Array.from({ length: 6 }, (_, index) => ({ model: `m${index + 1}`, tokens: 70 - (index + 1) * 10 })),
    daily: [{ day: 'd', total: 110, byModel: { m1: 50, m2: 40, m6: 20 } }],
  }
  const grouped = groupStats(stats)
  assert.deepEqual(grouped.daily[0].byModel, { m1: 50, m2: 40, [OTHER_MODEL]: 20 })
  assert.deepEqual(grouped.daily[0].otherByModel, { m6: 20 })
})

test('otherDetailItems 取哨兵明细无哨兵为空表', () => {
  const withOther = [
    { model: 'a', tokens: 9 },
    { model: OTHER_MODEL, tokens: 3, items: [{ model: 'x', tokens: 2 }, { model: 'y', tokens: 1 }] },
  ]
  assert.deepEqual(otherDetailItems(withOther), [{ model: 'x', tokens: 2 }, { model: 'y', tokens: 1 }])
  assert.deepEqual(otherDetailItems([{ model: 'a', tokens: 9 }]), [])
})

test('donut 分段可访问标签格式化名称数值与占比', () => {
  assert.equal(modelSegmentLabel('p/m', 1234, 12.34), 'p/m: 1,234 (12.3%)')
})

test('模型速度文本:官方吞吐口径格式化,无速度为空串', () => {
  assert.equal(modelSpeedText(5.5556), '5.6 tok/s')
  assert.equal(modelSpeedText(12.34), '12 tok/s')
  assert.equal(modelSpeedText(0), '0 tok/s')
  assert.equal(modelSpeedText(undefined), '')
})

test('模型输入输出占比构成:缓存/输入/输出 三段各占该模型 token 总量', () => {
  // Given 四桶齐备的模型条目 When 格式化 Then 三段占比相对 tokens 总量,缓存=读+写,合计 100%,顺序缓存/输入/输出
  const zhT = createTranslator(MESSAGES_ZH)
  const enT = createTranslator(MESSAGES_EN)
  const item = { tokens: 1000, inputTokens: 31, cacheReadTokens: 954, cacheWriteTokens: 10, outputTokens: 5 }
  assert.equal(modelIoPercentText(item, zhT), '缓存 96.4% · 输入 3.1% · 输出 0.5%')
  assert.equal(modelIoPercentText(item, enT), 'Cache 96.4% · Input 3.1% · Output 0.5%')
})

test('趋势 tooltip 模型行:仅含可见且当前时段有用量的模型', () => {
  // Given 槽内 byModel 含零值与非零值,OTHER 明细含零值与无序多元素 When 取行数据 Then 主行与子行均过滤零用量,子行按 tokens 降序,OTHER 不可见时子行为空
  const hoverSlot = {
    total: 300,
    byModel: { 'p/a': 200, 'p/b': 0, [OTHER_MODEL]: 100 },
    otherByModel: { 'p/y': 0, 'p/x': 20, 'p/z': 50 },
  }
  const visible = new Set(['p/a', 'p/b', OTHER_MODEL])
  const rows = tipModelEntries(hoverSlot, visible)
  assert.deepEqual(rows.main, [{ model: 'p/a', tokens: 200 }, { model: OTHER_MODEL, tokens: 100 }])
  assert.deepEqual(rows.other, [['p/z', 50], ['p/x', 20]])
  const hiddenOther = tipModelEntries(hoverSlot, new Set(['p/a']))
  assert.deepEqual(hiddenOther.main, [{ model: 'p/a', tokens: 200 }])
  assert.deepEqual(hiddenOther.other, [])
})

test('趋势 tooltip 内容门:仅 total>0 的槽渲染', () => {
  // Given 全零槽/常规槽 When 判定 Then 全零槽无内容,常规槽有内容,null 槽无内容
  assert.equal(hasTipContent(null), false)
  assert.equal(hasTipContent({ total: 0 }), false)
  assert.equal(hasTipContent({ total: 5 }), true)
})

test('模型输入输出占比构成:缺四桶或零总量为空串', () => {
  const zhT = createTranslator(MESSAGES_ZH)
  assert.equal(modelIoPercentText({ tokens: 100 }, zhT), '')
  assert.equal(modelIoPercentText(undefined, zhT), '')
  assert.equal(modelIoPercentText({ tokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, zhT), '')
})

test('模型首字文本:语言中立短时长,无 ttft 为空串', () => {
  assert.equal(modelTtftText(200), 'TTFT 0.2s')
  assert.equal(modelTtftText(162000), 'TTFT 2m42s')
  assert.equal(modelTtftText(0), 'TTFT 0s')
  assert.equal(modelTtftText(undefined), '')
})

// —— S14 费用格式化与展示辅助(镜像函数核心语义见 pricing-parity.test.mjs) ——

test('formatCost 千分位与两位小数', () => {
  assert.equal(formatCost(1234567.891, '¥'), '¥1,234,567.89')
  assert.equal(formatCost(1234.5, '¥'), '¥1,234.50')
  assert.equal(formatCost(1.5, ''), '1.50')
  assert.equal(formatCost(0, '$'), '$0.00')
})

test('formatCost 微观值四位小数', () => {
  assert.equal(formatCost(0.001, ''), '0.0010')
  assert.equal(formatCost(0.009999, '$'), '$0.0100')
})

test('镜像函数基本行为:非法输入 null 与命中计价', () => {
  assert.equal(matchPrice(null, 'x/m', NOW), null)
  assert.equal(matchPrice([], 'x/m', NOW), null)
  assert.deepEqual(
    matchPrice([{ model: 'x/m', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] }], 'x/m', NOW),
    { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
  assert.equal(costOf({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }, { inputTokens: 1000 * 1000 }), 2)
})

test('aggregateCurrencyOf 取首个非空货币,无则空串', () => {
  assert.equal(aggregateCurrencyOf([{ currency: '' }, { currency: '$' }]), '$')
  assert.equal(aggregateCurrencyOf([{ currency: '¥' }]), '¥')
  assert.equal(aggregateCurrencyOf([{ currency: '' }]), '')
  assert.equal(aggregateCurrencyOf(null), '')
})

test('applyCurrencyToRules 整表统一货币,不改其余字段且不动原数组', () => {
  const rules = [
    { model: 'a', currency: '', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] },
    { model: '*', currency: '¥', price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ type: 'weekdays', days: [1] }] },
  ]
  const stamped = applyCurrencyToRules(rules, '$')
  assert.equal(stamped.length, rules.length)
  assert.equal(stamped[0].currency, '$')
  assert.equal(stamped[1].currency, '$')
  assert.deepEqual(stamped[1].conditions, [{ type: 'weekdays', days: [1] }])
  assert.deepEqual(stamped[1].price, rules[1].price)
  assert.equal(rules[0].currency, '')
  assert.equal(rules[1].currency, '¥')
})

test('applyCurrencyToRules 空表恒等', () => {
  assert.deepEqual(applyCurrencyToRules([], '$'), [])
})

test('defaultPricingRule 承接给定货币,缺省回落首档', () => {
  assert.equal(defaultPricingRule('$').currency, '$')
  assert.equal(defaultPricingRule().currency, '¥')
  assert.equal(defaultPricingRule('$').model, '')
  assert.deepEqual(defaultPricingRule('$').price, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(defaultPricingRule('$').conditions, [])
})

test('validatePricingRules 就地校验 model 必填两段式与价格非空非负', () => {
  const valid = [{ model: 'p/m', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] }]
  assert.equal(validatePricingRules(valid).size, 0)
  const broken = [
    { model: '  ', currency: '¥', price: { input: '', output: -1, cacheRead: 0, cacheWrite: 0 }, conditions: [] },
    { model: 'solo', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] },
    { model: '*', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] },
    { model: '/x', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] },
  ]
  const errors = validatePricingRules(broken)
  assert.equal(errors.get('0.model'), 'required')
  assert.equal(errors.get('0.price.input'), 'required')
  assert.equal(errors.get('0.price.output'), 'priceInvalid')
  assert.equal(errors.has('0.price.cacheRead'), false)
  assert.equal(errors.get('1.model'), 'modelFormat')
  assert.equal(errors.get('2.model'), 'modelFormat')
  assert.equal(errors.get('3.model'), 'modelFormat')
})

test('costTitleText 未计价计数后缀', () => {
  const zhT = createTranslator(MESSAGES_ZH)
  assert.equal(costTitleText(zhT, 0), '按当前费率对历史用量估算,精度为小时级')
  assert.equal(costTitleText(zhT, 3), '按当前费率对历史用量估算,精度为小时级,3 个小时桶未计价')
})

test('defaultCondition 各类型默认值即填即用', () => {
  // Given 四种条件类型 When 取默认 Then 时段全天(00:00~23:59)/周几空/号段全月(1~31)/日期段当天单日
  assert.deepEqual(defaultCondition('dailyWindow'), { kind: 'dailyWindow', from: '00:00', to: '23:59' })
  assert.deepEqual(defaultCondition('weekdays'), { kind: 'weekdays', days: [] })
  assert.deepEqual(defaultCondition('monthDays'), { kind: 'monthDays', from: 1, to: 31 })
  assert.deepEqual(defaultCondition('dateRange', new Date(2026, 2, 15)), { kind: 'dateRange', from: '2026-03-15', to: '2026-03-15' })
})

test('validatePricingRules 拒绝非法时刻与时刻字段缺失', () => {
  // Given dailyWindow 时刻超界或缺失 When 校验 Then 标 condTime/required;双闭域 00:00~23:59,24:00 超界
  const rules = [
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '99:99', to: '08:00' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '', to: '08:00' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '24:00', to: '24:00' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '08:00', to: '24:30' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '00:00', to: '23:59' }] },
  ]
  const errors = validatePricingRules(rules)
  assert.equal(errors.get('0.conditions.0.from'), 'condTime')
  assert.equal(errors.get('1.conditions.0.from'), 'required')
  assert.equal(errors.get('2.conditions.0.from'), 'condTime')
  assert.equal(errors.get('3.conditions.0.to'), 'condTime')
  assert.equal(errors.has('4.conditions.0'), false)
})

test('validatePricingRules 接受 from===to 单点与单日', () => {
  // Given 双闭下时段/号段/日期段 from===to When 校验 Then 全部合法
  const rules = [
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '10:00', to: '10:00' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'monthDays', from: 5, to: 5 }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dateRange', from: '2026-03-05', to: '2026-03-05' }] },
  ]
  const errors = validatePricingRules(rules)
  assert.equal(errors.size, 0)
})

test('validatePricingRules 校验周几与月号段边界', () => {
  // Given weekdays 含 7、monthDays 含 0/32/33 When 校验 Then 标 condWeekday/condMonthDay;31 为合法上界
  const rules = [
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'weekdays', days: [0, 7] }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'monthDays', from: 0, to: 31 }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'monthDays', from: 32, to: 32 }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'monthDays', from: 1, to: 33 }] },
  ]
  const errors = validatePricingRules(rules)
  assert.equal(errors.get('0.conditions.0.days'), 'condWeekday')
  assert.equal(errors.get('1.conditions.0.from'), 'condMonthDay')
  assert.equal(errors.get('2.conditions.0.from'), 'condMonthDay')
  assert.equal(errors.get('3.conditions.0.to'), 'condMonthDay')
})

test('validatePricingRules 校验日期段格式与倒序', () => {
  // Given dateRange 非规范日期或倒序(双闭下同日合法)When 校验 Then 标 condDate/condRange
  const rules = [
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dateRange', from: '2026-3-5', to: '2026-03-08' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dateRange', from: '2026-03-08', to: '2026-03-05' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dateRange', from: '2026-03-05', to: '2026-03-05' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dateRange', from: '2026-03-05', to: '2026-03-08' }] },
  ]
  const errors = validatePricingRules(rules)
  assert.equal(errors.get('0.conditions.0.from'), 'condDate')
  assert.equal(errors.get('1.conditions.0'), 'condRange')
  assert.equal(errors.has('2.conditions.0'), false)
  assert.equal(errors.has('3.conditions.0'), false)
  assert.equal(errors.has('3.conditions.0.from'), false)
})

test('coerceConditions 规整数字字段且不改其余字段', () => {
  // Given 输入框字符串形态 When 规整 Then weekdays days 与 monthDays 号段转数字,时段日期原样
  const conditions = [
    { kind: 'weekdays', days: ['1', '5'] },
    { kind: 'monthDays', from: '26', to: '5' },
    { kind: 'dailyWindow', from: '09:00', to: '18:00' },
    { kind: 'dateRange', from: '2026-03-01', to: '2026-03-15' },
  ]
  const coerced = coerceConditions(conditions)
  assert.deepEqual(coerced[0], { kind: 'weekdays', days: [1, 5] })
  assert.deepEqual(coerced[1], { kind: 'monthDays', from: 26, to: 5 })
  assert.deepEqual(coerced[2], conditions[2])
  assert.deepEqual(coerced[3], conditions[3])
})

test('coercePricingRules 连带规整条件', () => {
  // Given 含条件规则 When POST 前规整 Then 价格与条件数字字段同时规整
  const rules = [{
    model: 'a/b', currency: '¥',
    price: { input: '1', output: '0', cacheRead: '0', cacheWrite: '0' },
    conditions: [{ kind: 'weekdays', days: ['1'] }, { kind: 'monthDays', from: '1', to: '31' }],
  }]
  const coerced = coercePricingRules(rules)
  assert.deepEqual(coerced[0].conditions, [{ kind: 'weekdays', days: [1] }, { kind: 'monthDays', from: 1, to: 31 }])
  assert.deepEqual(coerced[0].price, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })
})

// —— 定价编辑器分组视图:模型组 = 默认价(组末无条件规则投影,禁条件) + 附加计费规则(带条件) ——

test('groupRulesOf 按模型聚合,组序为首次出现序,槽位保序带平面索引', () => {
  // Given 平面规则 [a1, b1, a2] When 分组 Then a 组槽位 [0,2]、b 组槽位 [1],组顺序按首次出现
  const rules = [{ model: 'a/1' }, { model: 'b/1' }, { model: 'a/1' }]
  const groups = groupRulesOf(rules)
  assert.deepEqual(groups.map((group) => group.model), ['a/1', 'b/1'])
  assert.deepEqual(groups[0].slots.map((slot) => slot.index), [0, 2])
  assert.deepEqual(groups[1].slots.map((slot) => slot.index), [1])
  groups[0].slots.forEach((slot, i) => assert.equal(slot.rule, rules[[0, 2][i]]))
})

test('groupRulesOf 空表返回空组列表', () => {
  assert.deepEqual(groupRulesOf([]), [])
})

test('partitionGroupOf 组末无条件规则为默认价,其余为附加规则且保序', () => {
  // Given 组槽位 [条件0, 条件1, 无条件2] When 划分 Then 默认价=索引2,附加=[0,1]
  const cond = { kind: 'dailyWindow', from: '00:00', to: '08:00' }
  const group = { model: 'a/1', slots: [
    { rule: { model: 'a/1', conditions: [cond] }, index: 0 },
    { rule: { model: 'a/1', conditions: [{ kind: 'weekdays', days: [1] }] }, index: 1 },
    { rule: { model: 'a/1', conditions: [] }, index: 2 },
  ] }
  const { defaultSlot, extras } = partitionGroupOf(group)
  assert.equal(defaultSlot.index, 2)
  assert.deepEqual(extras.map((slot) => slot.index), [0, 1])
})

test('partitionGroupOf 全条件规则组无默认价', () => {
  // Given 组内全部带条件 When 划分 Then defaultSlot 为 null,附加=全部槽位
  const group = { model: 'a/1', slots: [
    { rule: { model: 'a/1', conditions: [{ kind: 'weekdays', days: [1] }] }, index: 0 },
    { rule: { model: 'a/1', conditions: [{ kind: 'weekdays', days: [2] }] }, index: 1 },
  ] }
  const { defaultSlot, extras } = partitionGroupOf(group)
  assert.equal(defaultSlot, null)
  assert.deepEqual(extras.map((slot) => slot.index), [0, 1])
})

test('partitionGroupOf 多条无条件规则时末条为默认价,前条按附加规则显示', () => {
  // Given 组槽位 [无条件0, 无条件1] When 划分 Then 默认价=索引1,附加=[0](存量数据自然收敛)
  const group = { model: 'a/1', slots: [
    { rule: { model: 'a/1', conditions: [] }, index: 0 },
    { rule: { model: 'a/1', conditions: [] }, index: 1 },
  ] }
  const { defaultSlot, extras } = partitionGroupOf(group)
  assert.equal(defaultSlot.index, 1)
  assert.deepEqual(extras.map((slot) => slot.index), [0])
})

test('moveRuleTo 跨位移动返回新数组且不动原数组', () => {
  // Given [A,B,C] When 索引 2 移到索引 0 Then [C,A,B],原数组不变
  const rules = [{ model: 'a/1' }, { model: 'b/1' }, { model: 'a/2' }]
  const moved = moveRuleTo(rules, 2, 0)
  assert.deepEqual(moved.map((rule) => rule.model), ['a/2', 'a/1', 'b/1'])
  assert.deepEqual(rules.map((rule) => rule.model), ['a/1', 'b/1', 'a/2'])
  assert.notEqual(moved, rules)
})

test('moveRuleTo 组内上移等价于移到组内前一槽位平面位', () => {
  // Given [a1,b1,a2] When a2 移到 a1 平面位 0 Then [a2,a1,b1],a 组内序为 a2,a1
  const rules = [{ model: 'a/1' }, { model: 'b/1' }, { model: 'a/1' }]
  assert.deepEqual(moveRuleTo(rules, 2, 0).map((rule) => rule.model), ['a/1', 'a/1', 'b/1'])
})

test('moveRuleTo 同位或越界返回原数组引用', () => {
  // Given 同源同目标/越界 When 移动 Then 恒返回原引用,UI 无操作
  const rules = [{ model: 'a/1' }, { model: 'a/2' }]
  assert.equal(moveRuleTo(rules, 0, 0), rules)
  assert.equal(moveRuleTo(rules, -1, 1), rules)
  assert.equal(moveRuleTo(rules, 0, rules.length), rules)
  assert.equal(moveRuleTo(rules, rules.length, 0), rules)
})

test('renameRulesAt 批量改组内模型键,其余规则不动', () => {
  // Given 索引 [0,2] 改名 x/y When 应用 Then 仅这两条 model 变 x/y
  const rules = [{ model: 'a/1' }, { model: 'b/1' }, { model: 'a/1' }]
  const renamed = renameRulesAt(rules, [0, 2], 'x/y')
  assert.deepEqual(renamed.map((rule) => rule.model), ['x/y', 'b/1', 'x/y'])
  assert.notEqual(renamed[0], rules[0])
  assert.equal(renamed[1], rules[1])
  assert.notEqual(renamed[2], rules[2])
})
test('insertRuleAt 插入到目标位之后', () => {
  // Given 组内末槽位平面索引 2 When 插入新槽位 Then 落在索引 3,后续元素后移
  const rules = [{ model: 'a/1' }, { model: 'b/1' }, { model: 'a/1' }]
  const next = insertRuleAt(rules, 2, { model: 'a/1' })
  assert.equal(next.length, 4)
  assert.equal(next[3].model, 'a/1')
  assert.equal(next[1].model, 'b/1')
})

test('removeRulesAt 批量移除组内槽位', () => {
  // Given 索引 [0,2] When 删除 Then 仅剩 b 组
  const rules = [{ model: 'a/1' }, { model: 'b/1' }, { model: 'a/1' }]
  const rest = removeRulesAt(rules, [0, 2])
  assert.deepEqual(rest.map((rule) => rule.model), ['b/1'])
})
