import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CURRENCIES,
  CONDITION_KINDS,
  TOKENS_PER_MILLION,
  UNIT_PER_MILLION,
  conditionMatches,
  costOf,
  matchPrice,
} from '../src/pricing.js'

// 锚定日期一律本地时区构造,期望只依赖本地分量,与运行机时区无关
const SUNDAY = new Date(2026, 8, 6)
const MONDAY = new Date(2026, 8, 7)
const SATURDAY = new Date(2026, 8, 12)

const localTime = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute)

const makeRule = (overrides = {}) => ({
  model: '*',
  unit: UNIT_PER_MILLION,
  currency: '¥',
  price: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
  conditions: [],
  ...overrides,
})

// 浮点比较容差
const EPSILON = 1e-9

test('常量为文档定值', () => {
  assert.equal(UNIT_PER_MILLION, 'perMillion')
  assert.deepEqual(CURRENCIES, ['¥', '$'])
  assert.deepEqual(CONDITION_KINDS, ['dailyWindow', 'weekdays', 'monthDays', 'dateRange'])
  assert.equal(TOKENS_PER_MILLION, 1000 * 1000)
})

test('锚定日期星期与本地分量自检', () => {
  // Given 本地构造的锚定日期 When 读本地分量 Then 与写死期望一致,防锚点拍脑袋
  assert.equal(SUNDAY.getDay(), 0)
  assert.equal(MONDAY.getDay(), 1)
  assert.equal(SATURDAY.getDay(), 6)
  assert.equal(localTime(6, 23, 30).getHours(), 23)
  assert.equal(localTime(6, 23, 30).getMinutes(), 30)
})

test('无条件规则恒命中', () => {
  // Given conditions 空数组规则 When 匹配其模型 Then 返回该规则 price
  const target = makeRule({ model: 'a/b' })
  assert.deepEqual(matchPrice([target], 'a/b', SUNDAY), target.price)
})

test('精确模型优先于通配规则', () => {
  // Given 精确规则与 '*' 规则并存 When 匹配 Then 取精确规则 price
  const exact = makeRule({ model: 'a/b', price: { input: 5 } })
  const wildcard = makeRule({ model: '*', price: { input: 1 } })
  assert.deepEqual(matchPrice([wildcard, exact], 'a/b', SUNDAY), exact.price)
})

test('精确子集按数组序取首个命中', () => {
  // Given 两条同模型无条件规则 When 匹配 Then 取数组序第一
  const first = makeRule({ model: 'a/b', price: { input: 1 } })
  const second = makeRule({ model: 'a/b', price: { input: 2 } })
  assert.deepEqual(matchPrice([first, second], 'a/b', SUNDAY), first.price)
})

test('精确子集全不命中回落通配子集', () => {
  // Given 精确规则条件不满足、'*' 规则无条件 When 匹配 Then 回落 '*' 而非 null
  const exact = makeRule({ model: 'a/b', conditions: [{ kind: 'weekdays', days: [1] }] })
  const wildcard = makeRule({ model: '*', price: { input: 3 } })
  assert.deepEqual(matchPrice([exact, wildcard], 'a/b', SUNDAY), wildcard.price)
})

test('通配子集按数组序取首个命中', () => {
  // Given 首条 '*' 条件满足、次条无条件 When 匹配 Then 取首条
  const first = makeRule({ model: '*', conditions: [{ kind: 'weekdays', days: [0] }], price: { input: 1 } })
  const second = makeRule({ model: '*', price: { input: 2 } })
  assert.deepEqual(matchPrice([first, second], 'a/b', SUNDAY), first.price)
})

test('无精确子集直接查通配子集', () => {
  // Given 仅 '*' 规则 When 匹配未列出模型 Then 命中通配
  const wildcard = makeRule({ model: '*', price: { input: 4 } })
  assert.deepEqual(matchPrice([wildcard], 'other/c', SUNDAY), wildcard.price)
})

test('两子集全不命中返回 null 计 unpriced', () => {
  // Given 仅一条精确规则且条件不满足 When 匹配本模型与陌生模型 Then 均为 null
  const rules = [makeRule({ model: 'a/b', conditions: [{ kind: 'weekdays', days: [1] }] })]
  assert.equal(matchPrice(rules, 'a/b', SUNDAY), null)
  assert.equal(matchPrice(rules, 'x/y', SUNDAY), null)
})

test('多条件 AND 一过一不过整规则不命中', () => {
  // Given 周日 + 10:00~12:00 两条件 When 周日 09:00 与 11:00 Then 前者 null 后者命中
  const target = makeRule({
    model: 'a/b',
    conditions: [
      { kind: 'weekdays', days: [0] },
      { kind: 'dailyWindow', from: '10:00', to: '12:00' },
    ],
  })
  assert.equal(matchPrice([target], 'a/b', localTime(6, 9)), null)
  assert.deepEqual(matchPrice([target], 'a/b', localTime(6, 11)), target.price)
})

test('规则形状残缺跳过不崩溃', () => {
  // Given 缺 model/缺 price/非法 unit/缺 conditions 的规则在前 When 匹配 Then 跳过并命中合法规则
  const good = makeRule({ model: 'a/b' })
  const rules = [
    { unit: UNIT_PER_MILLION, price: { input: 9 }, conditions: [] },
    { model: 'a/b', conditions: [] },
    makeRule({ model: 'a/b', unit: 'perKilo' }),
    makeRule({ model: 'a/b', conditions: undefined }),
    good,
  ]
  assert.deepEqual(matchPrice(rules, 'a/b', SUNDAY), good.price)
})

test('rules 非数组或 timestamp 非法返回 null', () => {
  // Given 非法入参 When matchPrice Then 返回 null 不抛错
  assert.equal(matchPrice([], 'a/b', SUNDAY), null)
  assert.equal(matchPrice(undefined, 'a/b', SUNDAY), null)
  assert.equal(matchPrice([makeRule()], 'a/b', Number.NaN), null)
})

test('dailyWindow from<to 含头不含尾', () => {
  // Given 10:00~12:00 When 逐时刻判定 Then 10:00 与 11:59 命中,09:59 与 12:00 不命中
  const condition = { kind: 'dailyWindow', from: '10:00', to: '12:00' }
  assert.equal(conditionMatches(condition, localTime(6, 10)), true)
  assert.equal(conditionMatches(condition, localTime(6, 11, 59)), true)
  assert.equal(conditionMatches(condition, localTime(6, 9, 59)), false)
  assert.equal(conditionMatches(condition, localTime(6, 12)), false)
})

test('dailyWindow 跨午夜窗口按本地分量命中', () => {
  // Given 22:00~02:00 When 本地 23:30 与次日 01:00 Then 命中;本地正午不命中
  const condition = { kind: 'dailyWindow', from: '22:00', to: '02:00' }
  assert.equal(conditionMatches(condition, localTime(6, 23, 30)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 8, 7, 1)), true)
  assert.equal(conditionMatches(condition, localTime(6, 12)), false)
})

test('dailyWindow from===to 全天生效', () => {
  // Given 10:00~10:00 When 判定 00:00/10:00/23:59 Then 全部命中
  const condition = { kind: 'dailyWindow', from: '10:00', to: '10:00' }
  assert.equal(conditionMatches(condition, localTime(6, 0)), true)
  assert.equal(conditionMatches(condition, localTime(6, 10)), true)
  assert.equal(conditionMatches(condition, localTime(6, 23, 59)), true)
})

test('dailyWindow 分钟级评估', () => {
  // Given 10:05~10:10 When 判定 10:05/10:09/10:10 Then 前两者命中
  const condition = { kind: 'dailyWindow', from: '10:05', to: '10:10' }
  assert.equal(conditionMatches(condition, localTime(6, 10, 5)), true)
  assert.equal(conditionMatches(condition, localTime(6, 10, 9)), true)
  assert.equal(conditionMatches(condition, localTime(6, 10, 10)), false)
})

test('weekdays 集合按 getDay 命中', () => {
  // Given days [0,6] When 判定锚定周日/周六/周一 Then 前两者命中
  const weekend = { kind: 'weekdays', days: [0, 6] }
  assert.equal(conditionMatches(weekend, SUNDAY), true)
  assert.equal(conditionMatches(weekend, SATURDAY), true)
  assert.equal(conditionMatches(weekend, MONDAY), false)
})

test('weekdays 空数组条件不成立', () => {
  assert.equal(conditionMatches({ kind: 'weekdays', days: [] }, SUNDAY), false)
})

test('monthDays 正向段双闭含单日', () => {
  // Given 1~15 When 判定 1/15/16 号 Then 双闭;Given 5~5 When 判定 5/6 号 Then 单日
  const span = { kind: 'monthDays', from: 1, to: 15 }
  assert.equal(conditionMatches(span, new Date(2026, 8, 1)), true)
  assert.equal(conditionMatches(span, new Date(2026, 8, 15)), true)
  assert.equal(conditionMatches(span, new Date(2026, 8, 16)), false)
  const single = { kind: 'monthDays', from: 5, to: 5 }
  assert.equal(conditionMatches(single, new Date(2026, 8, 5)), true)
  assert.equal(conditionMatches(single, new Date(2026, 8, 6)), false)
})

test('monthDays 单日 31 号在 2 月自然不触发', () => {
  // Given 31~31 When 判定 1 月 31 号与 2 月末 Then 前者命中;2 月无 31 号,该月任意日不命中
  const condition = { kind: 'monthDays', from: 31, to: 31 }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 28)), false)
})

test('monthDays 26~25 跨月环绕覆盖全月', () => {
  // Given 26~25 账单周期 When 判定 26/31/1/25/15 号 Then 26..31 并 1..25 覆盖全月,含 15
  const condition = { kind: 'monthDays', from: 26, to: 25 }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 26)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 1)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 25)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 15)), true)
})

test('monthDays 27~10 环绕存在不命中间隙', () => {
  // Given 27~10 When 判定 27/31/1/10 与 15/26 号 Then 前四命中,间隙内不命中
  const condition = { kind: 'monthDays', from: 27, to: 10 }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 27)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 1)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 10)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 15)), false)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 26)), false)
})

test('dateRange 双闭区间', () => {
  // Given 2026-01-01~2026-01-31 When 判定首末日与界外 Then 端点命中,两侧不命中
  const condition = { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 1)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 15)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(condition, new Date(2025, 11, 31)), false)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 1)), false)
})

test('dateRange 倒序属配置错误不成立', () => {
  const condition = { kind: 'dateRange', from: '2026-02-01', to: '2026-01-01' }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 15)), false)
})

test('未知 kind 与非法日期不成立', () => {
  // Given 未知 kind/null 条件/非法 Date When conditionMatches Then 均不成立不抛错
  assert.equal(conditionMatches({ kind: 'lunarPhase' }, SUNDAY), false)
  assert.equal(conditionMatches(null, SUNDAY), false)
  assert.equal(conditionMatches({ kind: 'weekdays', days: [0] }, new Date(Number.NaN)), false)
})

test('同值 Date 与毫秒数结果一致', () => {
  // Given 命中与不命中规则各一 When 分别传 Date 与 getTime() Then 两次结果一致
  const hit = makeRule({ model: 'a/b', conditions: [{ kind: 'weekdays', days: [0] }] })
  const miss = makeRule({ model: 'a/b', conditions: [{ kind: 'weekdays', days: [1] }] })
  const stamp = localTime(6, 10, 30)
  assert.deepEqual(matchPrice([hit], 'a/b', stamp), matchPrice([hit], 'a/b', stamp.getTime()))
  assert.deepEqual(matchPrice([miss], 'a/b', stamp), matchPrice([miss], 'a/b', stamp.getTime()))
})

test('四桶计价混合 token 算术', () => {
  // Given 四桶单价与部分桶 token When costOf Then Σ(桶token×单价)/百万
  const price = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 1 }
  const buckets = {
    inputTokens: TOKENS_PER_MILLION,
    outputTokens: TOKENS_PER_MILLION / 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  assert.ok(Math.abs(costOf(price, buckets) - 5) < EPSILON)
})

test('四桶全非零按权重求和', () => {
  // Given 四桶单价 1/2/3/4 且各桶百万 token When costOf Then 权重和 10
  const price = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
  const buckets = {
    inputTokens: TOKENS_PER_MILLION,
    outputTokens: TOKENS_PER_MILLION,
    cacheReadTokens: TOKENS_PER_MILLION,
    cacheWriteTokens: TOKENS_PER_MILLION,
  }
  assert.ok(Math.abs(costOf(price, buckets) - (1 + 2 + 3 + 4)) < EPSILON)
})

test('全零 token 费用为 0', () => {
  const buckets = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  assert.equal(costOf({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 1 }, buckets), 0)
})

test('缺桶或价格字段按 0 计', () => {
  // Given buckets 缺部分桶、price 只配部分单价 When costOf Then 只计两侧齐备的桶
  assert.ok(Math.abs(costOf({ input: 2 }, { inputTokens: TOKENS_PER_MILLION, outputTokens: TOKENS_PER_MILLION / 2 }) - 2) < EPSILON)
  assert.equal(costOf({ input: 2 }, {}), 0)
  assert.equal(costOf({}, { inputTokens: TOKENS_PER_MILLION }), 0)
})

test('费用保留原始浮点不圆整', () => {
  // Given 0.1+0.2 类单价 When costOf Then 得原始浮点和,不 toFixed 圆整
  const price = { input: 0.1, output: 0.2 }
  const buckets = { inputTokens: TOKENS_PER_MILLION, outputTokens: TOKENS_PER_MILLION }
  assert.ok(Math.abs(costOf(price, buckets) - 0.3) < EPSILON)
})
