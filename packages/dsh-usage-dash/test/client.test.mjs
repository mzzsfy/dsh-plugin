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
  logTimeOf,
  matchPrice,
  maxSlotsFor,
  minuteTickLabel,
  modelSegmentLabel,
  modelSpeedText,
  modelNameOf,
  niceTicks,
  otherDetailItems,
  parseEnvelope,
  providerOf,
  rateAxisTicks,
  resolveDayRange,
  resolveHourRange,
  resolveMinuteRange,
  shortDay,
  smoothPath,
  tipPlace,
  translateWith,
  trimSlots,
  trendLayout,
  trendRatePoints,
  trendSpeedPoints,
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

test('hour/minute 悬浮窗槽标签:T 换空格,小时带时,分钟保 HH:MM', () => {
  assert.equal(hourSlotLabel('2026-03-15T14'), '2026-03-15 14时')
  assert.equal(hourSlotLabel('2026-03-15T00'), '2026-03-15 00时')
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

const TIP_ANCHOR = { left: 100, top: 100, right: 140, bottom: 114 }
const TIP_SIZE = { width: 80, height: 40 }
const TIP_BOUNDS = { left: 0, top: 0, right: 800, bottom: 600 }

test('tipPlace 默认锚点下方水平居中', () => {
  assert.deepEqual(tipPlace(TIP_ANCHOR, TIP_SIZE, TIP_BOUNDS), { left: 80, top: 122 })
})

test('tipPlace 下方放不下翻转上方', () => {
  const anchor = { ...TIP_ANCHOR, top: 540, bottom: 580 }
  assert.equal(tipPlace(anchor, TIP_SIZE, TIP_BOUNDS).top, 492)
})

test('tipPlace 两侧均放不下钳到边界顶', () => {
  const bounds = { left: 0, top: 0, right: 800, bottom: 50 }
  const anchor = { left: 100, top: 20, right: 140, bottom: 50 }
  assert.equal(tipPlace(anchor, TIP_SIZE, bounds).top, 8)
})

test('tipPlace 水平越界钳到边界左缘', () => {
  const anchor = { left: 2, top: 100, right: 10, bottom: 114 }
  assert.equal(tipPlace(anchor, TIP_SIZE, TIP_BOUNDS).left, 8)
})

test('tipPlace 零尺寸或全零锚定矩形返回隐藏', () => {
  assert.equal(tipPlace(TIP_ANCHOR, { width: 0, height: 0 }, TIP_BOUNDS), null)
  assert.equal(tipPlace({ left: 0, top: 0, right: 0, bottom: 0 }, TIP_SIZE, TIP_BOUNDS), null)
  assert.equal(tipPlace(null, TIP_SIZE, TIP_BOUNDS), null)
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
  // Given 四种条件类型 When 取默认 Then 时段全天/周几空/号段全月/日期段当天
  assert.deepEqual(defaultCondition('dailyWindow'), { kind: 'dailyWindow', from: '00:00', to: '00:00' })
  assert.deepEqual(defaultCondition('weekdays'), { kind: 'weekdays', days: [] })
  assert.deepEqual(defaultCondition('monthDays'), { kind: 'monthDays', from: 1, to: 31 })
  assert.deepEqual(defaultCondition('dateRange', new Date(2026, 2, 15)), { kind: 'dateRange', from: '2026-03-15', to: '2026-03-15' })
})

test('validatePricingRules 拒绝非法时刻与时刻字段缺失', () => {
  // Given dailyWindow 时刻超界或缺失 When 校验 Then 标 condTime/required
  const rules = [
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '99:99', to: '08:00' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '', to: '08:00' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dailyWindow', from: '23:59', to: '24:00' }] },
  ]
  const errors = validatePricingRules(rules)
  assert.equal(errors.get('0.conditions.0.from'), 'condTime')
  assert.equal(errors.get('1.conditions.0.from'), 'required')
  assert.equal(errors.get('2.conditions.0.to'), 'condTime')
})

test('validatePricingRules 校验周几与月号段边界', () => {
  // Given weekdays 含 7、monthDays 含 0 或 32 When 校验 Then 标 condWeekday/condMonthDay
  const rules = [
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'weekdays', days: [0, 7] }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'monthDays', from: 0, to: 31 }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'monthDays', from: 1, to: 32 }] },
  ]
  const errors = validatePricingRules(rules)
  assert.equal(errors.get('0.conditions.0.days'), 'condWeekday')
  assert.equal(errors.get('1.conditions.0.from'), 'condMonthDay')
  assert.equal(errors.get('2.conditions.0.to'), 'condMonthDay')
})

test('validatePricingRules 校验日期段格式与倒序', () => {
  // Given dateRange 非规范日期或倒序 When 校验 Then 标 condDate/condRange
  const rules = [
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dateRange', from: '2026-3-5', to: '2026-03-08' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dateRange', from: '2026-03-08', to: '2026-03-05' }] },
    { model: 'a/b', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [{ kind: 'dateRange', from: '2026-03-05', to: '2026-03-08' }] },
  ]
  const errors = validatePricingRules(rules)
  assert.equal(errors.get('0.conditions.0.from'), 'condDate')
  assert.equal(errors.get('1.conditions.0'), 'condRange')
  assert.equal(errors.has('2.conditions.0'), false)
  assert.equal(errors.has('2.conditions.0.from'), false)
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
