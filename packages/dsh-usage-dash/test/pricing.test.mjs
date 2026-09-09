import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CURRENCIES,
  CONDITION_KINDS,
  TOKENS_PER_MILLION,
  UNIT_PER_MILLION,
  conditionMatches,
  costOf,
  isTwoSegmentModel,
  matchPrice,
} from '../src/pricing.js'

// 锚定日期一律本地时区构造,期望只依赖本地分量,与运行机时区无关
const SUNDAY = new Date(2026, 8, 6)
const MONDAY = new Date(2026, 8, 7)
const SATURDAY = new Date(2026, 8, 12)

const localTime = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute)

const makeRule = (overrides = {}) => ({
  model: '*/*',
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
  // Given 精确规则与 '*/*' 规则并存 When 匹配 Then 取精确规则 price
  const exact = makeRule({ model: 'a/b', price: { input: 5 } })
  const wildcard = makeRule({ model: '*/*', price: { input: 1 } })
  assert.deepEqual(matchPrice([wildcard, exact], 'a/b', SUNDAY), exact.price)
})

test('精确子集按数组序取首个命中', () => {
  // Given 两条同模型无条件规则 When 匹配 Then 取数组序第一
  const first = makeRule({ model: 'a/b', price: { input: 1 } })
  const second = makeRule({ model: 'a/b', price: { input: 2 } })
  assert.deepEqual(matchPrice([first, second], 'a/b', SUNDAY), first.price)
})

test('精确子集全不命中回落通配子集', () => {
  // Given 精确规则条件不满足、'*/*' 规则无条件 When 匹配 Then 回落 '*/*' 而非 null
  const exact = makeRule({ model: 'a/b', conditions: [{ kind: 'weekdays', days: [1] }] })
  const wildcard = makeRule({ model: '*/*', price: { input: 3 } })
  assert.deepEqual(matchPrice([exact, wildcard], 'a/b', SUNDAY), wildcard.price)
})

test('通配子集按数组序取首个命中', () => {
  // Given 首条 '*/*' 条件满足、次条无条件 When 匹配 Then 取首条
  const first = makeRule({ model: '*/*', conditions: [{ kind: 'weekdays', days: [0] }], price: { input: 1 } })
  const second = makeRule({ model: '*/*', price: { input: 2 } })
  assert.deepEqual(matchPrice([first, second], 'a/b', SUNDAY), first.price)
})

test('无精确子集直接查通配子集', () => {
  // Given 仅 '*/*' 规则 When 匹配未列出模型 Then 命中通配
  const wildcard = makeRule({ model: '*/*', price: { input: 4 } })
  assert.deepEqual(matchPrice([wildcard], 'other/c', SUNDAY), wildcard.price)
})

test('匹配链:全名优先于模型名、供应商、全通配', () => {
  // Given 四档规则并存 When 匹配 Then 依次全名 > 模型名 > 供应商 > 全通配
  const rules = [
    makeRule({ model: 'x/*', price: { input: 3 } }),
    makeRule({ model: '*/*', price: { input: 4 } }),
    makeRule({ model: '*/a', price: { input: 2 } }),
    makeRule({ model: 'x/a', price: { input: 1 } }),
  ]
  assert.deepEqual(matchPrice(rules, 'x/a', SUNDAY), { input: 1 })
})

test('匹配链:模型名通配优先于供应商通配', () => {
  // Given '*/a' 与 'x/*' 并存 When 匹配 x/a Then 模型名精确档胜
  const rules = [
    makeRule({ model: 'x/*', price: { input: 3 } }),
    makeRule({ model: '*/a', price: { input: 2 } }),
  ]
  assert.deepEqual(matchPrice(rules, 'x/a', SUNDAY), { input: 2 })
})

test('匹配链:供应商通配优先于全通配', () => {
  // Given 'x/*' 与 '*/*' 并存 When 匹配 x/a Then 供应商精确档胜
  const rules = [
    makeRule({ model: '*/*', price: { input: 4 } }),
    makeRule({ model: 'x/*', price: { input: 3 } }),
  ]
  assert.deepEqual(matchPrice(rules, 'x/a', SUNDAY), { input: 3 })
})

test('模型名通配跨供应商命中同模型名', () => {
  // Given '*/gpt-4o' When 匹配不同供应商同模型名 Then 命中;模型名不同不命中
  const rule = makeRule({ model: '*/gpt-4o', price: { input: 7 } })
  assert.deepEqual(matchPrice([rule], 'openai/gpt-4o', SUNDAY), { input: 7 })
  assert.deepEqual(matchPrice([rule], 'azure/gpt-4o', SUNDAY), { input: 7 })
  assert.equal(matchPrice([rule], 'openai/gpt-4o-mini', SUNDAY), null)
})

test('供应商通配命中同供应商全部模型', () => {
  // Given 'openai/*' When 匹配同供应商多模型 Then 命中;异供应商不命中
  const rule = makeRule({ model: 'openai/*', price: { input: 6 } })
  assert.deepEqual(matchPrice([rule], 'openai/gpt-4o', SUNDAY), { input: 6 })
  assert.deepEqual(matchPrice([rule], 'openai/o3', SUNDAY), { input: 6 })
  assert.equal(matchPrice([rule], 'azure/gpt-4o', SUNDAY), null)
})

test('模型名段允许含斜杠按首个斜杠分段', () => {
  // Given vendor 段通配或精确 When 匹配模型名含斜杠的多级模型 Then 按 vendor/余段比对
  const vendorWide = makeRule({ model: 'openrouter/*', price: { input: 8 } })
  assert.deepEqual(matchPrice([vendorWide], 'openrouter/deepseek/deepseek-chat', SUNDAY), { input: 8 })
  const named = makeRule({ model: '*/deepseek/deepseek-chat', price: { input: 9 } })
  assert.deepEqual(matchPrice([named], 'openrouter/deepseek/deepseek-chat', SUNDAY), { input: 9 })
  assert.equal(matchPrice([named], 'openrouter/deepseek/chat', SUNDAY), null)
})

test('单段规则属旧形态失效不命中', () => {
  // Given 旧写法 '*' 与裸名规则 When 匹配 Then 一律 null
  const legacy = makeRule({ model: '*', price: { input: 1 } })
  const bare = makeRule({ model: 'a', price: { input: 2 } })
  assert.equal(matchPrice([legacy, bare], 'a/b', SUNDAY), null)
  assert.equal(matchPrice([legacy, bare], 'a', SUNDAY), null)
})

test('请求裸名模型归 default 供应商', () => {
  // Given 无斜杠请求 When 匹配 'default/名' 与 '*/名' Then 全名档优先
  const exact = makeRule({ model: 'default/abc', price: { input: 1 } })
  const named = makeRule({ model: '*/abc', price: { input: 2 } })
  assert.deepEqual(matchPrice([named, exact], 'abc', SUNDAY), { input: 1 })
  assert.deepEqual(matchPrice([named], 'abc', SUNDAY), { input: 2 })
})

test('档位回落:高档条件不满足逐层落低档', () => {
  // Given 全名与模型名档条件仅周一 When 周日匹配 Then 落到无条件的供应商档
  const exact = makeRule({ model: 'x/a', conditions: [{ kind: 'weekdays', days: [1] }], price: { input: 1 } })
  const modelName = makeRule({ model: '*/a', conditions: [{ kind: 'weekdays', days: [1] }], price: { input: 2 } })
  const vendor = makeRule({ model: 'x/*', price: { input: 3 } })
  assert.deepEqual(matchPrice([exact, modelName, vendor], 'x/a', SUNDAY), { input: 3 })
})

test('同档规则按数组序取首个条件满足者', () => {
  // Given 同为 '*/a' 两条,首条条件周日 When 周日匹配 Then 取首条
  const first = makeRule({ model: '*/a', price: { input: 1 }, conditions: [{ kind: 'weekdays', days: [0] }] })
  const second = makeRule({ model: '*/a', price: { input: 2 } })
  assert.deepEqual(matchPrice([first, second], 'x/a', SUNDAY), { input: 1 })
})

test('isTwoSegmentModel 判定提交形态两段式', () => {
  // Given 两段式与单段/空白段串 When 判定 Then 首斜杠在首位之后且两段无空白才成立
  assert.equal(isTwoSegmentModel('a/b'), true)
  assert.equal(isTwoSegmentModel('*/*'), true)
  assert.equal(isTwoSegmentModel('a/b/c'), true)
  assert.equal(isTwoSegmentModel('a'), false)
  assert.equal(isTwoSegmentModel('*'), false)
  assert.equal(isTwoSegmentModel('/b'), false)
  assert.equal(isTwoSegmentModel(''), false)
  assert.equal(isTwoSegmentModel('a/'), false)
  assert.equal(isTwoSegmentModel(' /b'), false)
  assert.equal(isTwoSegmentModel('a/ '), false)
  assert.equal(isTwoSegmentModel('a /b'), false)
  assert.equal(isTwoSegmentModel('* /b'), false)
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

test('dailyWindow from<to 双闭含两端', () => {
  // Given 10:00~12:00 When 逐时刻判定 Then 10:00 与 12:00 命中,09:59 与 12:01 不命中
  const condition = { kind: 'dailyWindow', from: '10:00', to: '12:00' }
  assert.equal(conditionMatches(condition, localTime(6, 10)), true)
  assert.equal(conditionMatches(condition, localTime(6, 11, 59)), true)
  assert.equal(conditionMatches(condition, localTime(6, 12)), true)
  assert.equal(conditionMatches(condition, localTime(6, 9, 59)), false)
  assert.equal(conditionMatches(condition, localTime(6, 12, 1)), false)
})

test('dailyWindow 跨午夜窗口按本地分量命中', () => {
  // Given 22:00~02:00 When 本地 23:30 与次日 01:00/02:00 Then 命中;本地正午不命中
  const condition = { kind: 'dailyWindow', from: '22:00', to: '02:00' }
  assert.equal(conditionMatches(condition, localTime(6, 23, 30)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 8, 7, 1)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 8, 7, 2)), true)
  assert.equal(conditionMatches(condition, localTime(6, 12)), false)
})

test('dailyWindow from===to 为单点仅命中该时刻', () => {
  // Given 10:00~10:00 双闭单点 When 判定 10:00 与其他时刻 Then 仅 10:00 命中
  const condition = { kind: 'dailyWindow', from: '10:00', to: '10:00' }
  assert.equal(conditionMatches(condition, localTime(6, 10)), true)
  assert.equal(conditionMatches(condition, localTime(6, 10, 1)), false)
  assert.equal(conditionMatches(condition, localTime(6, 23, 59)), false)
})

test('dailyWindow 全天用 00:00~23:59 表达', () => {
  // Given 00:00~23:59 When 判定 00:00 与 23:59 Then 全部命中
  const condition = { kind: 'dailyWindow', from: '00:00', to: '23:59' }
  assert.equal(conditionMatches(condition, localTime(6, 0)), true)
  assert.equal(conditionMatches(condition, localTime(6, 23, 59)), true)
})

test('dailyWindow 分钟级评估', () => {
  // Given 10:05~10:10 When 判定 10:05/10:09/10:10/10:11 Then 前三者命中
  const condition = { kind: 'dailyWindow', from: '10:05', to: '10:10' }
  assert.equal(conditionMatches(condition, localTime(6, 10, 5)), true)
  assert.equal(conditionMatches(condition, localTime(6, 10, 9)), true)
  assert.equal(conditionMatches(condition, localTime(6, 10, 10)), true)
  assert.equal(conditionMatches(condition, localTime(6, 10, 11)), false)
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

test('monthDays 双闭含两端,from===to 为单日', () => {
  // Given 1~15 When 判定 1/14/15/16 号 Then 含 1 与 15 不含 16;Given 5~5 单日 When 判定 5/6 号 Then 仅 5 命中
  const span = { kind: 'monthDays', from: 1, to: 15 }
  assert.equal(conditionMatches(span, new Date(2026, 8, 1)), true)
  assert.equal(conditionMatches(span, new Date(2026, 8, 14)), true)
  assert.equal(conditionMatches(span, new Date(2026, 8, 15)), true)
  assert.equal(conditionMatches(span, new Date(2026, 8, 16)), false)
  const single = { kind: 'monthDays', from: 5, to: 5 }
  assert.equal(conditionMatches(single, new Date(2026, 8, 5)), true)
  assert.equal(conditionMatches(single, new Date(2026, 8, 6)), false)
})

test('monthDays 全月用 1~31 表达,31 号仅大月命中', () => {
  // Given 1~31 When 判定 1/30/31 号 Then 全月命中;2 月无 31 号自然不触发
  const month = { kind: 'monthDays', from: 1, to: 31 }
  assert.equal(conditionMatches(month, new Date(2026, 8, 1)), true)
  assert.equal(conditionMatches(month, new Date(2026, 8, 30)), true)
  assert.equal(conditionMatches(month, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(month, new Date(2026, 1, 28)), true)
})

test('monthDays 单日 31 号用 31~31 表达', () => {
  // Given 31~31 When 判定 1 月 31 号与 2 月末 Then 仅大月 31 号命中,2 月无 31 号自然不触发
  const condition = { kind: 'monthDays', from: 31, to: 31 }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 28)), false)
})

test('monthDays 26~25 跨月环绕为 26 起至次月 25', () => {
  // Given 26~25 账单周期双闭 When 判定 26/31/1/24/25/15 号 Then 26..31 并 1..25 命中
  const condition = { kind: 'monthDays', from: 26, to: 25 }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 26)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 1)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 24)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 25)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 15)), true)
})

test('monthDays 27~10 环绕存在不命中间隙', () => {
  // Given 27~10 双闭 When 判定 27/31/1/10 与 9/15/26 号 Then 27..31 并 1..10 命中,间隙不命中
  const condition = { kind: 'monthDays', from: 27, to: 10 }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 27)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 1)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 10)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 9)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 11)), false)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 15)), false)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 26)), false)
})

test('dateRange 双闭含两端', () => {
  // Given 2026-01-01~2026-01-31 When 判定首日/中间/末日/界外 Then 首日中间末日命中,两侧不命中
  const condition = { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' }
  assert.equal(conditionMatches(condition, new Date(2026, 0, 1)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 15)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 30)), true)
  assert.equal(conditionMatches(condition, new Date(2026, 0, 31)), true)
  assert.equal(conditionMatches(condition, new Date(2025, 11, 31)), false)
  assert.equal(conditionMatches(condition, new Date(2026, 1, 1)), false)
})

test('dateRange from===to 为单日命中', () => {
  // Given 同日区间双闭 When 判定该日与前后日 Then 仅该日命中
  const single = { kind: 'dateRange', from: '2026-01-15', to: '2026-01-15' }
  assert.equal(conditionMatches(single, new Date(2026, 0, 15)), true)
  assert.equal(conditionMatches(single, new Date(2026, 0, 14)), false)
  assert.equal(conditionMatches(single, new Date(2026, 0, 16)), false)
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
