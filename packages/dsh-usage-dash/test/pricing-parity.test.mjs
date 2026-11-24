// 双实现同源 parity 测试:client.js 顶层定价镜像函数与宿主 src/pricing.js 同输入同输出
// 向量表驱动:同一批向量喂双侧,deepEqual 双侧结果并对期望值断言
// client.js 为经典 script bundle(禁 import/export),整文件 IIFE 书挡;经 client-eval 剥壳后整源求值,按顶层声明名收集
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

import {
  matchPrice as hostMatchPrice,
  costOf as hostCostOf,
  conditionMatches as hostConditionMatches,
  isTwoSegmentModel as hostIsTwoSegmentModel,
  normalizePricingRules as hostNormalizePricingRules,
  resolvePricingRule as hostResolvePricingRule,
  UNIT_PER_MILLION as hostUnitPerMillion,
  CURRENCIES as hostCurrencies,
  CONDITION_KINDS as hostConditionKinds,
  TOKENS_PER_MILLION as hostTokensPerMillion,
} from '../src/pricing.js'
import { refOf as hostRefOf } from '../src/collector.js'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  matchPrice: clientMatchPrice,
  costOf: clientCostOf,
  conditionMatches: clientConditionMatches,
  isTwoSegmentModel: clientIsTwoSegmentModel,
  normalizePricingRules: clientNormalizePricingRules,
  resolvePricingRule: clientResolvePricingRule,
  UNIT_PER_MILLION: clientUnitPerMillion,
  CURRENCIES: clientCurrencies,
  CONDITION_KINDS: clientConditionKinds,
  TOKENS_PER_MILLION: clientTokensPerMillion,
  MODEL_UNROUTED: clientModelUnrouted,
  turnModelOf: clientTurnModelOf,
} = core

// 本地时区固定时刻(2026-03-15 为周日):同一 Date 实例喂双侧
const SUNDAY_0930 = [2026, 2, 15, 9, 30]
const SUNDAY_1800 = [2026, 2, 15, 18, 0]
const SUNDAY_0900 = [2026, 2, 15, 9, 0]
const SUNDAY_2330 = [2026, 2, 15, 23, 30]
const SUNDAY_0300 = [2026, 2, 15, 3, 0]
const SUNDAY_1200 = [2026, 2, 15, 12, 0]
const MON_JAN01 = [2026, 0, 1, 12, 0]
const MON_JAN15 = [2026, 0, 15, 12, 0]
const MON_JAN16 = [2026, 0, 16, 12, 0]
const MON_JAN26 = [2026, 0, 26, 12, 0]
const MON_JAN31 = [2026, 0, 31, 12, 0]
const MON_JAN03 = [2026, 0, 3, 12, 0]
const FEB_30_ROLLS_TO_MAR02 = [2026, 1, 30, 12, 0]

const CONDITION_VECTORS = [
  { name: 'dailyWindow from<to 命中', condition: { kind: 'dailyWindow', from: '09:00', to: '18:00' }, date: SUNDAY_0930, expected: true },
  { name: 'dailyWindow 双闭含 to 端点', condition: { kind: 'dailyWindow', from: '09:00', to: '18:00' }, date: SUNDAY_1800, expected: true },
  { name: 'dailyWindow 含头', condition: { kind: 'dailyWindow', from: '09:00', to: '18:00' }, date: SUNDAY_0900, expected: true },
  { name: 'dailyWindow 跨午夜夜段命中', condition: { kind: 'dailyWindow', from: '22:00', to: '06:00' }, date: SUNDAY_2330, expected: true },
  { name: 'dailyWindow 跨午夜凌晨命中', condition: { kind: 'dailyWindow', from: '22:00', to: '06:00' }, date: SUNDAY_0300, expected: true },
  { name: 'dailyWindow 跨午夜日间不命中', condition: { kind: 'dailyWindow', from: '22:00', to: '06:00' }, date: SUNDAY_1200, expected: false },
  { name: 'dailyWindow from===to 单点命中', condition: { kind: 'dailyWindow', from: '12:00', to: '12:00' }, date: SUNDAY_1200, expected: true },
  { name: 'dailyWindow 00:00~23:59 全天含尾', condition: { kind: 'dailyWindow', from: '00:00', to: '23:59' }, date: SUNDAY_2330, expected: true },
  { name: 'dailyWindow 非法格式', condition: { kind: 'dailyWindow', from: 'abc', to: '06:00' }, date: SUNDAY_1200, expected: false },
  { name: 'weekdays 命中周日', condition: { kind: 'weekdays', days: [0] }, date: SUNDAY_0930, expected: true },
  { name: 'weekdays 空 days 不成立', condition: { kind: 'weekdays', days: [] }, date: SUNDAY_0930, expected: false },
  { name: 'weekdays 未命中', condition: { kind: 'weekdays', days: [1] }, date: SUNDAY_0930, expected: false },
  { name: 'weekdays days 非数组', condition: { kind: 'weekdays', days: 'x' }, date: SUNDAY_0930, expected: false },
  { name: 'monthDays 双闭含 to 端点', condition: { kind: 'monthDays', from: 1, to: 15 }, date: MON_JAN15, expected: true },
  { name: 'monthDays 含首日', condition: { kind: 'monthDays', from: 1, to: 15 }, date: MON_JAN01, expected: true },
  { name: 'monthDays 界外', condition: { kind: 'monthDays', from: 1, to: 15 }, date: MON_JAN16, expected: false },
  { name: 'monthDays 1~31 全月', condition: { kind: 'monthDays', from: 1, to: 31 }, date: MON_JAN31, expected: true },
  { name: 'monthDays from===to 单日命中', condition: { kind: 'monthDays', from: 15, to: 15 }, date: MON_JAN15, expected: true },
  { name: 'monthDays 环绕起点命中', condition: { kind: 'monthDays', from: 26, to: 5 }, date: MON_JAN26, expected: true },
  { name: 'monthDays 环绕中段不命中', condition: { kind: 'monthDays', from: 26, to: 5 }, date: MON_JAN15, expected: false },
  { name: 'monthDays 环绕终点含端点', condition: { kind: 'monthDays', from: 26, to: 5 }, date: MON_JAN03, expected: true },
  { name: 'monthDays 非整数不成立', condition: { kind: 'monthDays', from: 1.5, to: 5 }, date: MON_JAN15, expected: false },
  { name: 'dateRange 命中', condition: { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' }, date: MON_JAN15, expected: true },
  { name: 'dateRange to 端点命中', condition: { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' }, date: MON_JAN31, expected: true },
  { name: 'dateRange from===to 单日命中', condition: { kind: 'dateRange', from: '2026-01-15', to: '2026-01-15' }, date: MON_JAN15, expected: true },
  { name: 'dateRange 倒序不成立', condition: { kind: 'dateRange', from: '2026-01-31', to: '2026-01-01' }, date: MON_JAN15, expected: false },
  { name: 'dateRange 非零填充不成立', condition: { kind: 'dateRange', from: '2026-1-1', to: '2026-1-31' }, date: MON_JAN15, expected: false },
  { name: 'dateRange 2 月 30 号滚月后不命中', condition: { kind: 'dateRange', from: '2026-02-01', to: '2026-02-28' }, date: FEB_30_ROLLS_TO_MAR02, expected: false },
  { name: '未知 kind 不成立', condition: { kind: 'hourly', days: [0] }, date: SUNDAY_0930, expected: false },
  { name: '对象原型的 kind 不成立', condition: { kind: 'toString' }, date: SUNDAY_0930, expected: false },
  { name: '非法 Date 不成立', condition: { kind: 'weekdays', days: [0] }, date: null, expected: false },
  { name: 'condition 形状残缺不成立', condition: null, date: SUNDAY_0930, expected: false },
]

const priceOf = (input) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 })
const ruleOf = (model, input, conditions = []) => ({ model, currency: '¥', price: priceOf(input), conditions })

const MATCH_SUNDAY_1000 = [2026, 2, 15, 10, 0]

const MATCH_VECTORS = [
  {
    name: '全名精确命中按数组序取首个',
    rules: [ruleOf('x/a', 1), ruleOf('x/b', 2)], model: 'x/b', date: MATCH_SUNDAY_1000, expected: priceOf(2),
  },
  {
    name: '同全名多条取数组序第一条',
    rules: [ruleOf('x/a', 1), ruleOf('x/a', 3)], model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '模型名通配跨供应商命中',
    rules: [ruleOf('*/a', 5)], model: 'zzz/a', date: MATCH_SUNDAY_1000, expected: priceOf(5),
  },
  {
    name: '供应商通配命中同供应商模型',
    rules: [ruleOf('x/*', 5)], model: 'x/zzz', date: MATCH_SUNDAY_1000, expected: priceOf(5),
  },
  {
    name: '无精确回落全通配',
    rules: [ruleOf('*/*', 5)], model: 'zzz/yyy', date: MATCH_SUNDAY_1000, expected: priceOf(5),
  },
  {
    name: '全名精确优先于全通配',
    rules: [ruleOf('*/*', 5), ruleOf('x/a', 1)], model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '匹配链:精确供应商优先于跨供应商的精确型号',
    rules: [ruleOf('*/a', 2), ruleOf('x/*', 3)], model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(3),
  },
  {
    name: '供应商和多级型号分别使用一个星号',
    rules: [ruleOf('open*/deepseek/*-chat', 3), ruleOf('*/deepseek/demo-chat', 2)],
    model: 'openrouter/deepseek/demo-chat', date: MATCH_SUNDAY_1000, expected: priceOf(3),
  },
  {
    name: '前后缀不重叠且可零字符消费',
    rules: [ruleOf('x/ab*bc', 2), ruleOf('x/a*bc', 3)], model: 'x/abc', date: MATCH_SUNDAY_1000, expected: priceOf(3),
  },
  {
    name: '同档条件更多者胜',
    rules: [ruleOf('x/a', 1), ruleOf('x/a', 2, [{ kind: 'weekdays', days: [0] }])],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(2),
  },
  {
    name: '匹配链:供应商通配优先于全通配',
    rules: [ruleOf('*/*', 4), ruleOf('x/*', 3)], model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(3),
  },
  {
    name: '模型名段允许含斜杠',
    rules: [ruleOf('x/*', 1)], model: 'x/deepseek/deepseek-chat', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '请求裸名归 default 供应商',
    rules: [ruleOf('default/a', 1), ruleOf('*/a', 2)], model: 'a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '请求首位斜杠不拆段归 default 供应商',
    rules: [ruleOf('default//x', 1), ruleOf('*/x', 2)], model: '/x', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '单段旧形态规则失效',
    rules: [ruleOf('*', 5), ruleOf('a', 1)], model: 'x/a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: '供应商段不同不命中',
    rules: [ruleOf('x/*', 1)], model: 'y/a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: '模型段不同不命中',
    rules: [ruleOf('*/a', 1)], model: 'x/b', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: '多条件 AND 全过命中',
    rules: [ruleOf('x/a', 1, [{ kind: 'weekdays', days: [0] }, { kind: 'dailyWindow', from: '00:00', to: '23:59' }])],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '一条件不过跳至下一条规则',
    rules: [ruleOf('x/a', 1, [{ kind: 'weekdays', days: [1] }]), ruleOf('x/a', 2, [])],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(2),
  },
  {
    name: '高档条件不过逐层落低档',
    rules: [ruleOf('x/a', 1, [{ kind: 'weekdays', days: [1] }]), ruleOf('*/a', 5)],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(5),
  },
  {
    name: '缺 conditions 视为无条件命中',
    rules: [{ model: 'x/a', currency: '¥', price: priceOf(1) }],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '缺 price 形状残缺跳过',
    rules: [{ model: 'x/a', currency: '¥', conditions: [] }],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: 'unit 非 perMillion 跳过',
    rules: [{ ...ruleOf('x/a', 1), unit: 'perThousand' }],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: 'unit 缺省视为 perMillion 命中',
    rules: [ruleOf('x/a', 1)],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: 'rules 非数组为 null',
    rules: 'nope', model: 'x/a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: 'model 非字符串为 null',
    rules: [ruleOf('x/a', 1)], model: 7, date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: '非法时间戳为 null',
    rules: [ruleOf('x/a', 1)], model: 'x/a', date: null, expected: null,
  },
  {
    name: '条件不满足且无通配为 null',
    rules: [ruleOf('x/a', 1, [{ kind: 'weekdays', days: [1] }])],
    model: 'x/a', date: MATCH_SUNDAY_1000, expected: null,
  },
]

const MILLION = 1000 * 1000
const COST_VECTORS = [
  {
    name: '四桶全带求和',
    price: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    buckets: { inputTokens: MILLION, outputTokens: MILLION, cacheReadTokens: MILLION, cacheWriteTokens: MILLION },
    expected: 10,
  },
  {
    name: '缺桶按 0',
    price: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    buckets: { inputTokens: MILLION },
    expected: 1,
  },
  {
    name: '非有限 token 按 0',
    price: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    buckets: { inputTokens: Number.NaN, outputTokens: MILLION, cacheReadTokens: Number.POSITIVE_INFINITY, cacheWriteTokens: 0 },
    expected: 2,
  },
  {
    name: '非有限单价按 0',
    price: { input: 1, output: Number.POSITIVE_INFINITY, cacheRead: Number.NaN, cacheWrite: 4 },
    buckets: { inputTokens: MILLION, outputTokens: MILLION, cacheReadTokens: MILLION, cacheWriteTokens: 0 },
    expected: 1,
  },
  {
    name: '零价为 0',
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    buckets: { inputTokens: MILLION, outputTokens: MILLION, cacheReadTokens: MILLION, cacheWriteTokens: MILLION },
    expected: 0,
  },
  {
    name: '原始浮点不圆整',
    price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    buckets: { inputTokens: 3 },
    expected: 3 / MILLION,
  },
]

test('镜像常量与宿主逐项一致', () => {
  assert.equal(clientUnitPerMillion, hostUnitPerMillion)
  assert.deepEqual(clientCurrencies, hostCurrencies)
  assert.deepEqual(clientConditionKinds, hostConditionKinds)
  assert.equal(clientTokensPerMillion, hostTokensPerMillion)
})

// 向量总量下限锁定:S14 要求 ≥25 组,防止后续裁剪 quietly 缩水
const VECTOR_TOTAL = CONDITION_VECTORS.length + MATCH_VECTORS.length + COST_VECTORS.length

test('parity 向量总量不低于 25 组', () => {
  assert.ok(VECTOR_TOTAL >= 25, `向量总量 ${VECTOR_TOTAL} 不足 25`)
})

test(`conditionMatches 双侧一致(${CONDITION_VECTORS.length} 向量)`, () => {
  for (const vector of CONDITION_VECTORS) {
    const date = vector.date ? new Date(...vector.date) : new Date(Number.NaN)
    const host = hostConditionMatches(vector.condition, date)
    const client = clientConditionMatches(vector.condition, date)
    assert.deepEqual(client, host, vector.name)
    assert.equal(host, vector.expected, vector.name)
  }
})

test(`matchPrice 双侧一致(${MATCH_VECTORS.length} 向量)`, () => {
  for (const vector of MATCH_VECTORS) {
    const date = vector.date ? new Date(...vector.date) : new Date(Number.NaN)
    const host = hostMatchPrice(vector.rules, vector.model, date)
    const client = clientMatchPrice(vector.rules, vector.model, date)
    assert.deepEqual(client, host, vector.name)
    assert.deepEqual(host, vector.expected, vector.name)
  }
})

test('resolvePricingRule 双侧按条件数排序且只报告最高实质并列', () => {
  const sunday = { kind: 'weekdays', days: [0] }
  const atTen = { kind: 'dailyWindow', from: '10:00', to: '10:00' }
  const short = ruleOf('ven*/m', 1, [sunday])
  const failed = ruleOf('vendor/m', 2, [{ kind: 'weekdays', days: [1] }])
  const first = ruleOf('ven*/m', 3, [sunday, atTen])
  const lowerAxis = ruleOf('*/m', 4, [sunday, atTen])
  const second = ruleOf('ven*/m', 5, [sunday, atTen])
  const rules = [short, failed, first, lowerAxis, second]
  const expected = { winner: first, candidates: [first, second, short, lowerAxis], conflictRules: [first, second] }
  const timestamp = new Date(...MATCH_SUNDAY_1000).getTime()
  for (const resolve of [hostResolvePricingRule, clientResolvePricingRule]) {
    const result = resolve(rules, 'vendor/m', timestamp)
    assert.deepEqual(result, expected)
    assert.equal(result.winner, first)
    assert.equal(result.conflictRules[1], second)
    assert.deepEqual(resolve(rules, 'vendor/m', NaN), { winner: null, candidates: [], conflictRules: [] })
  }
})

test('稀疏条件数组不虚增匹配优先级', () => {
  const valid = ruleOf('x/a', 1, [{ kind: 'weekdays', days: [0] }])
  const malformed = ruleOf('x/a', 2, new Array(2))
  const rules = [valid, malformed]
  const date = new Date(...MATCH_SUNDAY_1000)
  for (const match of [hostMatchPrice, clientMatchPrice]) {
    assert.equal(match(rules, 'x/a', date), valid.price)
  }
  for (const resolve of [hostResolvePricingRule, clientResolvePricingRule]) {
    assert.deepEqual(resolve(rules, 'x/a', date), { winner: valid, candidates: [valid], conflictRules: [] })
  }
})

test('resolvePricingRule 双侧按平台优先比较两段的长度和形态', () => {
  const rules = [
    ruleOf('*/abcd', 1),
    ruleOf('a*d/abcd', 2),
    ruleOf('*cd/abcd', 3),
    ruleOf('ab*/abcd', 4),
    ruleOf('abc*/abcd', 5),
    ruleOf('abcd/a*d', 6),
    ruleOf('abcd/*cd', 7),
    ruleOf('abcd/ab*', 8),
    ruleOf('abcd/a*cd', 9),
    ruleOf('abcd/abcd', 10),
  ]
  for (const resolve of [hostResolvePricingRule, clientResolvePricingRule]) {
    const result = resolve(rules, 'abcd/abcd', new Date(...MATCH_SUNDAY_1000))
    assert.equal(result.winner, rules[9])
    assert.deepEqual(result.candidates, rules.toReversed())
    assert.deepEqual(result.conflictRules, [])
  }
})

const SEGMENT_VECTORS = [
  { name: '两段合法', model: 'a/b', expected: true },
  { name: '通配段合法', model: '*/*', expected: true },
  { name: '多级模型名合法', model: 'a/b/c', expected: true },
  { name: '单段非法', model: 'a', expected: false },
  { name: '通配单段非法', model: '*', expected: false },
  { name: '首位斜杠非法', model: '/b', expected: false },
  { name: '空串非法', model: '', expected: false },
  { name: '模型段空非法', model: 'a/', expected: false },
  { name: '段含前导空白非法', model: ' /b', expected: false },
  { name: '段含尾随空白非法', model: 'a/ ', expected: false },
  { name: '段内含空白非法', model: 'a /b', expected: false },
  { name: '通配段含空白非法', model: '* /b', expected: false },
  { name: '供应商与型号各有一星', model: 've*/models/*-chat', expected: true },
  { name: '供应商多星非法', model: 'v**/b', expected: false },
  { name: '多级型号共用星号上限', model: 'v/b*/c*', expected: false },
  { name: '末尾换行非法', model: 'v/b\n', expected: false },
  { name: '非字符串非法', model: null, expected: false },
]

test(`isTwoSegmentModel 双侧一致(${SEGMENT_VECTORS.length} 向量)`, () => {
  for (const vector of SEGMENT_VECTORS) {
    const host = hostIsTwoSegmentModel(vector.model)
    const client = clientIsTwoSegmentModel(vector.model)
    assert.deepEqual(client, host, vector.name)
    assert.equal(host, vector.expected, vector.name)
  }
})

test(`costOf 双侧一致(${COST_VECTORS.length} 向量)`, () => {
  for (const vector of COST_VECTORS) {
    const host = hostCostOf(vector.price, vector.buckets)
    const client = clientCostOf(vector.price, vector.buckets)
    assert.deepEqual(client, host, vector.name)
    assert.deepEqual(host, vector.expected, vector.name)
  }
})

// 路由引用键双实现同源:采集器 refOf(样本 model 键)与 client 注入点B turnModelOf(回合计价键)
// 双全拼两段、仅 model 用裸名、多 route 取首条;键不成立时两侧各按自身约定降级
// (refOf→undefined,turnModelOf→全通配键),该场景单独断言各自约定值
const REF_VECTORS = [
  { name: '双全拼两段', route: { provider: 'deepseek', model: 'deepseek-chat' }, expected: 'deepseek/deepseek-chat' },
  { name: '模型段含下级斜杠', route: { provider: 'oc', model: 'xx/xx' }, expected: 'oc/xx/xx' },
  { name: '供应商与模型都含下级斜杠', route: { provider: 'oc/xx', model: 'yy/zz' }, expected: 'oc/xx/yy/zz' },
  { name: '仅 model 用裸名', route: { model: 'm' }, expected: 'm' },
  { name: 'provider 空串按裸名', route: { provider: '', model: 'm' }, expected: 'm' },
  { name: 'provider 非空 model 空串不成立', route: { provider: 'p', model: '' }, expected: undefined },
  { name: '空 route 对象不成立', route: {}, expected: undefined },
  { name: '多 route 取首条', route: { provider: 'a', model: 'x' }, tail: { provider: 'b', model: 'y' }, expected: 'a/x' },
]

test(`路由引用键双侧一致(${REF_VECTORS.length} 向量)`, () => {
  for (const vector of REF_VECTORS) {
    const routes = vector.tail ? [vector.route, vector.tail] : [vector.route]
    assert.equal(hostRefOf(vector.route), vector.expected, vector.name)
    assert.equal(clientTurnModelOf({ routes }), vector.expected ?? clientModelUnrouted, vector.name)
  }
  assert.equal(hostRefOf(null), undefined)
  assert.equal(clientTurnModelOf({ routes: [] }), clientModelUnrouted)
  assert.equal(clientTurnModelOf(null), clientModelUnrouted)
})

// 归一仅去除同模型重复无条件规则,跨模型保留原序。
// 同一输入喂双侧,除顺序外再断言保留下来的对象引用与原数组一致(不得克隆或改写)
const NORMALIZE_VECTORS = [
  {
    name: '重复 */* 保留首条原位',
    rules: [
      { model: '*/*', price: { input: 1 }, conditions: [] },
      { model: 'p/m', price: { input: 3 }, conditions: [] },
      { model: '*/*', price: { input: 9 }, conditions: [] },
    ],
    expected: [['*/*', 1], ['p/m', 3]],
  },
  {
    name: '同模型首条无条件为默认价,与条件规则相对顺序不变',
    rules: [
      { model: 'p/m', price: { input: 1 }, conditions: [] },
      { model: 'p/m', price: { input: 2 }, conditions: [{ kind: 'weekdays', days: [1] }] },
      { model: 'p/m', price: { input: 3 }, conditions: [] },
    ],
    expected: [['p/m', 1], ['p/m', 2]],
  },
  {
    name: '全条件组不合成默认价',
    rules: [{ model: 'p/m', price: { input: 1 }, conditions: [{ kind: 'weekdays', days: [1] }] }],
    expected: [['p/m', 1]],
  },
  {
    name: '缺失 conditions 视作无条件',
    rules: [{ model: 'p/m', price: { input: 1 } }, { model: 'p/m', price: { input: 2 }, conditions: [] }],
    expected: [['p/m', 1]],
  },
  {
    name: '非数组安全回落',
    rules: null,
    expected: [],
  },
]

test(`规则归一双侧一致(${NORMALIZE_VECTORS.length} 向量)`, () => {
  for (const vector of NORMALIZE_VECTORS) {
    const host = hostNormalizePricingRules(vector.rules)
    const client = clientNormalizePricingRules(vector.rules)
    assert.deepEqual(client, host, vector.name)
    assert.deepEqual(host.map((rule) => [rule.model, rule.price.input]), vector.expected, vector.name)
    for (const rule of host) assert.ok(vector.rules?.includes(rule), `${vector.name}: 保留原对象引用`)
  }
})

// 存量规则可缺 currency 或写 null:格式化不得把开发者字面量渲染给用户
test('Given 规则货币缺省或为 null, When 格式化费用, Then 只输出数值不带符号', () => {
  for (const currency of [null, undefined, '']) {
    const text = core.formatCost(1.5, currency)
    assert.equal(text, '1.50', `currency=${String(currency)}`)
  }
  assert.equal(core.formatCost(1.5, '¥'), '¥1.50')
})
