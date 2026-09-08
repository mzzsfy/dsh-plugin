// 双实现同源 parity 测试:client.js 顶层定价镜像函数与宿主 src/pricing.js 同输入同输出
// 向量表驱动:同一批向量喂双侧,deepEqual 双侧结果并对期望值断言
// client.js 为非模块 script(bundle 求值形态,禁 import/export),整源求值后按顶层声明名收集
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  matchPrice as hostMatchPrice,
  costOf as hostCostOf,
  conditionMatches as hostConditionMatches,
  UNIT_PER_MILLION as hostUnitPerMillion,
  CURRENCIES as hostCurrencies,
  CONDITION_KINDS as hostConditionKinds,
  TOKENS_PER_MILLION as hostTokensPerMillion,
} from '../src/pricing.js'

const CLIENT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')
const DECLARATION_NAMES = [
  ...new Set(
    [...CLIENT_SOURCE.matchAll(/^(?:const|function|let) ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1])
  ),
]
const core = new Function(`${CLIENT_SOURCE}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  matchPrice: clientMatchPrice,
  costOf: clientCostOf,
  conditionMatches: clientConditionMatches,
  UNIT_PER_MILLION: clientUnitPerMillion,
  CURRENCIES: clientCurrencies,
  CONDITION_KINDS: clientConditionKinds,
  TOKENS_PER_MILLION: clientTokensPerMillion,
} = core

// 本地时区固定时刻(2026-03-15 为周日):同一 Date 实例喂双侧
const SUNDAY_0930 = [2026, 2, 15, 9, 30]
const SUNDAY_1800 = [2026, 2, 15, 18, 0]
const SUNDAY_0900 = [2026, 2, 15, 9, 0]
const SUNDAY_2330 = [2026, 2, 15, 23, 30]
const SUNDAY_0300 = [2026, 2, 15, 3, 0]
const SUNDAY_1200 = [2026, 2, 15, 12, 0]
const MON_JAN15 = [2026, 0, 15, 12, 0]
const MON_JAN16 = [2026, 0, 16, 12, 0]
const MON_JAN26 = [2026, 0, 26, 12, 0]
const MON_JAN03 = [2026, 0, 3, 12, 0]
const FEB_30_ROLLS_TO_MAR02 = [2026, 1, 30, 12, 0]

const CONDITION_VECTORS = [
  { name: 'dailyWindow from<to 命中', condition: { kind: 'dailyWindow', from: '09:00', to: '18:00' }, date: SUNDAY_0930, expected: true },
  { name: 'dailyWindow 含头不含尾', condition: { kind: 'dailyWindow', from: '09:00', to: '18:00' }, date: SUNDAY_1800, expected: false },
  { name: 'dailyWindow 含头', condition: { kind: 'dailyWindow', from: '09:00', to: '18:00' }, date: SUNDAY_0900, expected: true },
  { name: 'dailyWindow 跨午夜夜段命中', condition: { kind: 'dailyWindow', from: '22:00', to: '06:00' }, date: SUNDAY_2330, expected: true },
  { name: 'dailyWindow 跨午夜凌晨命中', condition: { kind: 'dailyWindow', from: '22:00', to: '06:00' }, date: SUNDAY_0300, expected: true },
  { name: 'dailyWindow 跨午夜日间不命中', condition: { kind: 'dailyWindow', from: '22:00', to: '06:00' }, date: SUNDAY_1200, expected: false },
  { name: 'dailyWindow from===to 全天', condition: { kind: 'dailyWindow', from: '00:00', to: '00:00' }, date: SUNDAY_1200, expected: true },
  { name: 'dailyWindow 非法格式', condition: { kind: 'dailyWindow', from: 'abc', to: '06:00' }, date: SUNDAY_1200, expected: false },
  { name: 'weekdays 命中周日', condition: { kind: 'weekdays', days: [0] }, date: SUNDAY_0930, expected: true },
  { name: 'weekdays 空 days 不成立', condition: { kind: 'weekdays', days: [] }, date: SUNDAY_0930, expected: false },
  { name: 'weekdays 未命中', condition: { kind: 'weekdays', days: [1] }, date: SUNDAY_0930, expected: false },
  { name: 'weekdays days 非数组', condition: { kind: 'weekdays', days: 'x' }, date: SUNDAY_0930, expected: false },
  { name: 'monthDays 双闭含端', condition: { kind: 'monthDays', from: 1, to: 15 }, date: MON_JAN15, expected: true },
  { name: 'monthDays 界外', condition: { kind: 'monthDays', from: 1, to: 15 }, date: MON_JAN16, expected: false },
  { name: 'monthDays 环绕起点命中', condition: { kind: 'monthDays', from: 26, to: 5 }, date: MON_JAN26, expected: true },
  { name: 'monthDays 环绕中段不命中', condition: { kind: 'monthDays', from: 26, to: 5 }, date: MON_JAN15, expected: false },
  { name: 'monthDays 环绕终点命中', condition: { kind: 'monthDays', from: 26, to: 5 }, date: MON_JAN03, expected: true },
  { name: 'monthDays 非整数不成立', condition: { kind: 'monthDays', from: 1.5, to: 5 }, date: MON_JAN15, expected: false },
  { name: 'dateRange 命中', condition: { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' }, date: MON_JAN15, expected: true },
  { name: 'dateRange 倒序不成立', condition: { kind: 'dateRange', from: '2026-01-31', to: '2026-01-01' }, date: MON_JAN15, expected: false },
  { name: 'dateRange 非零填充不成立', condition: { kind: 'dateRange', from: '2026-1-1', to: '2026-1-31' }, date: MON_JAN15, expected: false },
  { name: 'dateRange 2 月 30 号滚月后不命中', condition: { kind: 'dateRange', from: '2026-02-01', to: '2026-02-28' }, date: FEB_30_ROLLS_TO_MAR02, expected: false },
  { name: '未知 kind 不成立', condition: { kind: 'hourly', days: [0] }, date: SUNDAY_0930, expected: false },
  { name: '非法 Date 不成立', condition: { kind: 'weekdays', days: [0] }, date: null, expected: false },
  { name: 'condition 形状残缺不成立', condition: null, date: SUNDAY_0930, expected: false },
]

const priceOf = (input) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 })
const ruleOf = (model, input, conditions = []) => ({ model, currency: '¥', price: priceOf(input), conditions })

const MATCH_SUNDAY_1000 = [2026, 2, 15, 10, 0]

const MATCH_VECTORS = [
  {
    name: '精确命中按数组序取首个',
    rules: [ruleOf('a', 1), ruleOf('b', 2)], model: 'b', date: MATCH_SUNDAY_1000, expected: priceOf(2),
  },
  {
    name: '同 model 多条取数组序第一条',
    rules: [ruleOf('a', 1), ruleOf('a', 3)], model: 'a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '无精确回落通配',
    rules: [ruleOf('*', 5)], model: 'zzz', date: MATCH_SUNDAY_1000, expected: priceOf(5),
  },
  {
    name: '精确优先于通配',
    rules: [ruleOf('*', 5), ruleOf('a', 1)], model: 'a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '多条件 AND 全过命中',
    rules: [ruleOf('a', 1, [{ kind: 'weekdays', days: [0] }, { kind: 'dailyWindow', from: '00:00', to: '23:59' }])],
    model: 'a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: '一条件不过跳至下一条规则',
    rules: [ruleOf('a', 1, [{ kind: 'weekdays', days: [1] }]), ruleOf('a', 2, [])],
    model: 'a', date: MATCH_SUNDAY_1000, expected: priceOf(2),
  },
  {
    name: '缺 conditions 形状残缺跳过',
    rules: [{ model: 'a', currency: '¥', price: priceOf(1) }],
    model: 'a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: '缺 price 形状残缺跳过',
    rules: [{ model: 'a', currency: '¥', conditions: [] }],
    model: 'a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: 'unit 非 perMillion 跳过',
    rules: [{ ...ruleOf('a', 1), unit: 'perThousand' }],
    model: 'a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: 'unit 缺省视为 perMillion 命中',
    rules: [ruleOf('a', 1)],
    model: 'a', date: MATCH_SUNDAY_1000, expected: priceOf(1),
  },
  {
    name: 'rules 非数组为 null',
    rules: 'nope', model: 'a', date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: 'model 非字符串为 null',
    rules: [ruleOf('a', 1)], model: 7, date: MATCH_SUNDAY_1000, expected: null,
  },
  {
    name: '非法时间戳为 null',
    rules: [ruleOf('a', 1)], model: 'a', date: null, expected: null,
  },
  {
    name: '条件不满足且无通配为 null',
    rules: [ruleOf('a', 1, [{ kind: 'weekdays', days: [1] }])],
    model: 'a', date: MATCH_SUNDAY_1000, expected: null,
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

test(`costOf 双侧一致(${COST_VECTORS.length} 向量)`, () => {
  for (const vector of COST_VECTORS) {
    const host = hostCostOf(vector.price, vector.buckets)
    const client = clientCostOf(vector.price, vector.buckets)
    assert.deepEqual(client, host, vector.name)
    assert.deepEqual(host, vector.expected, vector.name)
  }
})
