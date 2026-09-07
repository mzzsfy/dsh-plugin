// client 纯函数层测试:滚动窗口映射/信封解析/上限裁剪/文案/格式化/分组/柱状几何
// Given/When/Then 场景内嵌于用例描述
// client.js 为非模块 script(bundle 求值形态,禁 import/export),整源求值后按顶层声明名收集
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLIENT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')
const DECLARATION_NAMES = [
  ...new Set(
    [...CLIENT_SOURCE.matchAll(/^(?:const|function|let) ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1])
  ),
]
const core = new Function(`${CLIENT_SOURCE}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  DAY_MAX_SLOTS,
  DAY_PRESETS,
  HOUR_PRESETS,
  MINUTE_PRESETS,
  MESSAGES,
  OTHER_MODEL,
  cacheRateText,
  formatCompact,
  formatTokens,
  groupPointSlots,
  groupStats,
  hourTickLabel,
  isEmptyRange,
  maxSlotsFor,
  minuteTickLabel,
  modelNameOf,
  niceTicks,
  parseEnvelope,
  providerOf,
  resolveDayRange,
  resolveHourRange,
  resolveMinuteRange,
  shortDay,
  t,
  trimSlots,
  trendLayout,
} = core

const EPSILON = 1e-9
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < EPSILON, `expected ${expected}, got ${actual}`)

// 本地时区固定时钟:2026-03-15 14:30:45
const NOW = new Date(2026, 2, 15, 14, 30, 45)

test('day 预设映射为最近 N 天闭区间', () => {
  assert.deepEqual(resolveDayRange('7', NOW), { from: '2026-03-09', to: '2026-03-15' })
  assert.deepEqual(resolveDayRange('14', NOW), { from: '2026-03-02', to: '2026-03-15' })
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
  assert.deepEqual(resolveHourRange('72h', NOW), { from: '2026-03-12T14', to: '2026-03-15T14' })
})

test('hour 预设跨日且窗口起点落整点', () => {
  assert.deepEqual(resolveHourRange('24h', new Date(2026, 2, 15, 0, 30)), { from: '2026-03-14T00', to: '2026-03-15T00' })
})

test('minute 预设 now-N 舍入到整分桶起点', () => {
  assert.deepEqual(resolveMinuteRange('60m', NOW), { from: '2026-03-15T13:30', to: '2026-03-15T14:30' })
  assert.deepEqual(resolveMinuteRange('360m', NOW), { from: '2026-03-15T08:30', to: '2026-03-15T14:30' })
})

test('minute 预设整分边界不再回退', () => {
  assert.deepEqual(resolveMinuteRange('60m', new Date(2026, 2, 15, 14, 30, 0)), { from: '2026-03-15T13:30', to: '2026-03-15T14:30' })
})

test('预设定义表覆盖三视图', () => {
  assert.deepEqual(DAY_PRESETS, ['7', '14', '30', '90'])
  assert.deepEqual(HOUR_PRESETS, ['24h', '48h', '72h'])
  assert.deepEqual(MINUTE_PRESETS, ['60m', '180m', '360m'])
})

test('每视图渲染上限等于闭区间桶数', () => {
  assert.equal(maxSlotsFor('day', '90'), DAY_MAX_SLOTS)
  assert.equal(maxSlotsFor('hour', '24h'), 25)
  assert.equal(maxSlotsFor('hour', '48h'), 49)
  assert.equal(maxSlotsFor('hour', '72h'), 73)
  assert.equal(maxSlotsFor('minute', '60m'), 61)
  assert.equal(maxSlotsFor('minute', '180m'), 181)
  assert.equal(maxSlotsFor('minute', '360m'), 361)
})

test('trim 超上限裁最旧且恰好达上限不裁', () => {
  const slots = ['1', '2', '3', '4', '5', '6'].map((day) => ({ day }))
  assert.deepEqual(trimSlots(slots, 3).map((slot) => slot.day), ['4', '5', '6'])
  assert.equal(trimSlots(slots, 6), slots)
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

test('t 占位替换与缺键防御', () => {
  assert.equal(t('status.running', { done: 2, total: 9 }), '回扫中 2/9')
  assert.equal(t('trendLimited', { n: 45 }), '仅显示最近 45 天')
  assert.equal(t('refresh'), '刷新')
  assert.equal(t('no.such.key'), 'no.such.key')
})

test('文案表覆盖 client.js 全部 t 键', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client.js'), 'utf8')
  const keys = [...source.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1])
  assert.ok(keys.length >= 10, `应从 client.js 抽到 t 调用,实际 ${keys.length}`)
  for (const key of keys) assert.ok(key in MESSAGES, `缺少文案键: ${key}`)
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

test('trendLayout 零值槽无分段但保留刻度', () => {
  const layout = trendLayout([{ day: '2026-03-15', total: 0, byModel: {} }], [], 720, 46)
  assert.deepEqual(layout.bars[0].segments, [])
  assert.deepEqual(layout.ticks, [0.5, 1])
})

test('trendLayout 堆叠分段自底向上且高度求和等于绘图高', () => {
  const layout = trendLayout([{ day: 'd', total: 50, byModel: { a: 30, b: 20 } }], ['a', 'b'], 720, 46)
  const [segA, segB] = layout.bars[0].segments
  assert.deepEqual(segA.model, 'a')
  assert.deepEqual(segB.model, 'b')
  approx(segA.height, (30 / 50) * 184)
  approx(segB.height, (20 / 50) * 184)
  approx(segA.height + segB.height, 184)
  approx(segB.y + segB.height, segA.y)
})

test('trendLayout 标签密度随列距收敛', () => {
  const slots = Array.from({ length: 100 }, (_, i) => ({ day: `d${i}`, total: 0, byModel: {} }))
  const layout = trendLayout(slots, [], 720, 46)
  assert.equal(layout.labelEvery, 8)
})
