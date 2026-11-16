import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WHATIF_SCENARIOS,
  WHATIF_STATUS,
  simulateWhatIf,
} from '../src/whatif.js'

const TOKENS = 1000 * 1000
const TUESDAY_MORNING = new Date(2026, 8, 8, 10, 0)

const makeRule = (model, price, overrides = {}) => ({
  model,
  unit: 'perMillion',
  currency: '¥',
  price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...price },
  conditions: [],
  ...overrides,
})

const makeModel = (model, buckets = {}) => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...buckets,
})

const scenarioOf = (outcome, id) => outcome.scenarios.find((scenario) => scenario.id === id)

test('常量为文档定值', () => {
  // Given 场景与状态契约 When 读常量 Then 顺序与取值稳定
  assert.deepEqual(WHATIF_SCENARIOS, ['model-swap', 'cache-leverage', 'offpeak-shift'])
  assert.deepEqual(WHATIF_STATUS, ['ok', 'unavailable', 'empty'])
})

test('Given 无任何用量 When 模拟 Then 基线为零且三场景均为空态', () => {
  // Given 有定价规则但没有模型用量
  const rules = [makeRule('a/one', { input: 1 })]
  // When 模拟
  const outcome = simulateWhatIf({ models: [], rules, currency: '¥', now: TUESDAY_MORNING })
  // Then 基线为 0,三场景 empty 且不返回伪造成本
  assert.equal(outcome.baseline, 0)
  assert.equal(outcome.currency, '¥')
  assert.deepEqual(outcome.scenarios.map((scenario) => scenario.id), WHATIF_SCENARIOS)
  for (const scenario of outcome.scenarios) {
    assert.equal(scenario.status, 'empty')
    assert.equal(scenario.cost, null)
    assert.equal(scenario.delta, null)
    assert.equal(scenario.ratio, null)
    assert.equal(scenario.detail.code, 'empty')
  }
})

test('Given 零 token 行 When 模拟 Then 视为无用量空态', () => {
  // Given 模型行全部四桶为零
  const models = [makeModel('a/one')]
  // When 模拟
  const outcome = simulateWhatIf({ models, rules: [makeRule('a/one', { input: 1 })], now: TUESDAY_MORNING })
  // Then 基线 0 且三场景 empty
  assert.equal(outcome.baseline, 0)
  assert.ok(outcome.scenarios.every((scenario) => scenario.status === 'empty'))
})

test('Given 定价规则为空 When 模拟 Then 基线为零且三场景均为空态', () => {
  // Given 有用量但未配置任何规则
  const models = [makeModel('a/one', { inputTokens: TOKENS })]
  // When 模拟
  const outcome = simulateWhatIf({ models, rules: [], currency: '¥', now: TUESDAY_MORNING })
  // Then 空规则不按零价冒充,直接空态
  assert.equal(outcome.baseline, 0)
  assert.ok(outcome.scenarios.every((scenario) => scenario.status === 'empty'))
})

test('Given 目标模型有价 When 模型替换场景 Then 目标单价套全部四桶结构', () => {
  // Given A 花 1M 输入、B 花 1M 输出,目标模型输入/输出单价均 0.5
  const rules = [
    makeRule('a/one', { input: 1, output: 2 }),
    makeRule('b/two', { input: 3, output: 4 }),
    makeRule('t/target', { input: 0.5, output: 0.5 }),
  ]
  const models = [
    makeModel('a/one', { inputTokens: TOKENS }),
    makeModel('b/two', { outputTokens: TOKENS }),
  ]
  // When 模拟目标模型 t/target
  const outcome = simulateWhatIf({
    models, rules, currency: '¥', now: TUESDAY_MORNING,
    options: { targetModel: 't/target' },
  })
  // Then 基线 1+4=5,场景 0.5+0.5=1,省 4 元即 80%
  const swap = scenarioOf(outcome, 'model-swap')
  assert.equal(outcome.baseline, 5)
  assert.equal(swap.status, 'ok')
  assert.equal(swap.cost, 1)
  assert.equal(swap.delta, -4)
  assert.equal(swap.ratio, -80)
  assert.equal(swap.detail.targetModel, 't/target')
})

test('Given 通配全局规则命中目标模型 When 模型替换 Then 按配置价计算而非缺价', () => {
  // Given 仅一条 '*/*' 全局规则
  const rules = [makeRule('*/*', { input: 1, output: 1 })]
  const models = [makeModel('a/one', { inputTokens: TOKENS })]
  // When 目标模型不在具体规则里
  const outcome = simulateWhatIf({
    models, rules, now: TUESDAY_MORNING, options: { targetModel: 't/target' },
  })
  // Then matchPrice 命中的全局配置价参与计算
  assert.equal(scenarioOf(outcome, 'model-swap').status, 'ok')
  assert.equal(scenarioOf(outcome, 'model-swap').cost, 1)
})

test('Given 目标模型无定价 When 模型替换 Then 该场景不可用且不返回零差额', () => {
  // Given A 有价但目标模型没有任何规则命中
  const rules = [makeRule('a/one', { input: 1 })]
  const models = [makeModel('a/one', { inputTokens: TOKENS })]
  // When 目标模型 t/missing
  const outcome = simulateWhatIf({
    models, rules, now: TUESDAY_MORNING, options: { targetModel: 't/missing' },
  })
  // Then 场景 unavailable,原因指明目标模型缺价
  const swap = scenarioOf(outcome, 'model-swap')
  assert.equal(outcome.baseline, 1)
  assert.equal(swap.status, 'unavailable')
  assert.equal(swap.cost, null)
  assert.equal(swap.delta, null)
  assert.equal(swap.ratio, null)
  assert.equal(swap.detail.code, 'targetModelUnpriced')
  assert.equal(swap.detail.model, 't/missing')
})

test('Given 未填目标模型 When 模型替换 Then 提示先填模型', () => {
  // Given 有价有量但目标为空
  const outcome = simulateWhatIf({
    models: [makeModel('a/one', { inputTokens: TOKENS })],
    rules: [makeRule('a/one', { input: 1 })],
    now: TUESDAY_MORNING,
    options: { targetModel: '   ' },
  })
  // Then 场景不可用,原因为缺少目标模型
  assert.equal(scenarioOf(outcome, 'model-swap').status, 'unavailable')
  assert.equal(scenarioOf(outcome, 'model-swap').detail.code, 'targetModelRequired')
})

test('Given 部分模型缺价 When 模拟 Then 基线不可计算且三场景均不可用', () => {
  // Given 一个模型有价、另一个模型无任何规则
  const models = [
    makeModel('a/priced', { inputTokens: TOKENS }),
    makeModel('a/unpriced', { inputTokens: TOKENS }),
  ]
  const rules = [makeRule('a/priced', { input: 1 })]
  // When 模拟
  const outcome = simulateWhatIf({ models, rules, now: TUESDAY_MORNING, options: { targetModel: 'a/priced' } })
  // Then 基线为 null,所有场景 unavailable 并列出缺价模型
  assert.equal(outcome.baseline, null)
  for (const scenario of outcome.scenarios) {
    assert.equal(scenario.status, 'unavailable')
    assert.equal(scenario.cost, null)
    assert.equal(scenario.delta, null)
    assert.equal(scenario.detail.code, 'unpricedModels')
    assert.deepEqual(scenario.detail.models, ['a/unpriced'])
  }
})

test('Given 目标命中率 75% When 缓存杠杆 Then 总输入不变且余量按输入与写入比例分摊', () => {
  // Given 输入 1M、缓存读 2M、缓存写 1M;输入价 4、读价 1、写价 2
  const rules = [makeRule('a/cache', { input: 4, cacheRead: 1, cacheWrite: 2 })]
  const models = [makeModel('a/cache', {
    inputTokens: TOKENS,
    cacheReadTokens: 2 * TOKENS,
    cacheWriteTokens: TOKENS,
  })]
  // When 目标命中率 0.75
  const outcome = simulateWhatIf({
    models, rules, now: TUESDAY_MORNING, options: { targetHitRate: 0.75 },
  })
  // Then 读 3M,余 1M 按输入:写入 1:1 各 0.5M;费用 2+3+1=6,基线 8
  const leverage = scenarioOf(outcome, 'cache-leverage')
  assert.equal(outcome.baseline, 8)
  assert.equal(leverage.status, 'ok')
  assert.equal(leverage.cost, 6)
  assert.equal(leverage.delta, -2)
  assert.equal(leverage.ratio, -25)
  assert.equal(leverage.detail.targetHitRate, 0.75)
})

test('Given 输入与缓存写均为零 When 缓存杠杆提升命中率 Then 余量全部落回未命中输入', () => {
  // Given 输入仅缓存读 2M,目标命中率降到 50%
  const rules = [makeRule('a/cache', { input: 3, cacheRead: 1 })]
  const models = [makeModel('a/cache', { cacheReadTokens: 2 * TOKENS })]
  // When 模拟
  const outcome = simulateWhatIf({
    models, rules, now: TUESDAY_MORNING, options: { targetHitRate: 0.5 },
  })
  // Then 读 1M、未命中输入 1M,费用 3+1=4;基线 2,差额 +2
  const leverage = scenarioOf(outcome, 'cache-leverage')
  assert.equal(outcome.baseline, 2)
  assert.equal(leverage.status, 'ok')
  assert.equal(leverage.cost, 4)
  assert.equal(leverage.delta, 2)
  assert.equal(leverage.ratio, 100)
})

test('Given 同模型存在峰谷两档价 When 峰谷移位 Then 按挪移比例加权当前价与差异时段价', () => {
  // Given 10:00 命中白天价 2,12 小时后 22:00 命中夜间价 1
  const rules = [
    makeRule('a/peak', { input: 2 }, { conditions: [{ kind: 'dailyWindow', from: '00:00', to: '12:00' }] }),
    makeRule('a/peak', { input: 1 }, { conditions: [{ kind: 'dailyWindow', from: '12:01', to: '23:59' }] }),
  ]
  const models = [makeModel('a/peak', { inputTokens: TOKENS })]
  // When 50% 用量移位
  const outcome = simulateWhatIf({
    models, rules, now: TUESDAY_MORNING, options: { shiftRatio: 0.5 },
  })
  // Then 基线 2,场景 2*0.5+1*0.5=1.5,省 0.5 元即 25%
  const shift = scenarioOf(outcome, 'offpeak-shift')
  assert.equal(outcome.baseline, 2)
  assert.equal(shift.status, 'ok')
  assert.equal(shift.cost, 1.5)
  assert.equal(shift.delta, -0.5)
  assert.equal(shift.ratio, -25)
  assert.equal(shift.detail.shiftRatio, 0.5)
})

test('Given 差异时刻无规则命中 When 峰谷移位 Then 场景不可用', () => {
  // Given 仅 00:00-12:00 一档价,12 小时后无价
  const rules = [makeRule('a/peak', { input: 2 }, { conditions: [{ kind: 'dailyWindow', from: '00:00', to: '12:00' }] })]
  const models = [makeModel('a/peak', { inputTokens: TOKENS })]
  // When 模拟
  const outcome = simulateWhatIf({ models, rules, now: TUESDAY_MORNING, options: { shiftRatio: 0.5 } })
  // Then 差异价缺失即不可用
  const shift = scenarioOf(outcome, 'offpeak-shift')
  assert.equal(shift.status, 'unavailable')
  assert.equal(shift.detail.code, 'offpeakUnpriced')
  assert.equal(shift.detail.model, 'a/peak')
})

test('Given 差异时刻与当前同时段同价 When 峰谷移位 Then 场景不可用而非零差额', () => {
  // Given 无条件规则使任何时刻同价
  const rules = [makeRule('a/flat', { input: 2 })]
  const models = [makeModel('a/flat', { inputTokens: TOKENS })]
  // When 模拟
  const outcome = simulateWhatIf({ models, rules, now: TUESDAY_MORNING, options: { shiftRatio: 0.5 } })
  // Then 无差异价即不可用
  assert.equal(scenarioOf(outcome, 'offpeak-shift').status, 'unavailable')
  assert.equal(scenarioOf(outcome, 'offpeak-shift').detail.code, 'offpeakNoDifferential')
})

test('Given 金额产生三位小数 When 模拟 Then 基线与场景金额一律两位小数', () => {
  // Given 1.5M 输入、输入价 1.005,基线 1.5075
  const rules = [makeRule('a/round', { input: 1.005, cacheRead: 0.5 })]
  const models = [makeModel('a/round', { inputTokens: 1.5 * TOKENS })]
  // When 命中率提到 100%
  const outcome = simulateWhatIf({
    models, rules, now: TUESDAY_MORNING, options: { targetHitRate: 1 },
  })
  // Then 基线 1.51,场景 0.75,差额 -0.76,比例 -50.3%
  const leverage = scenarioOf(outcome, 'cache-leverage')
  assert.equal(outcome.baseline, 1.51)
  assert.equal(leverage.cost, 0.75)
  assert.equal(leverage.delta, -0.76)
  assert.equal(leverage.ratio, -50.3)
  for (const value of [outcome.baseline, leverage.cost, leverage.delta]) {
    assert.ok(Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, `${value} 非两位小数`)
  }
})

test('Given 未传目标命中率与移位比例 When 模拟 Then 使用默认 80% 与 30%', () => {
  // Given 有价有量且存在差异时段价
  const rules = [
    makeRule('a/default', { input: 1, cacheRead: 0.5 }, { conditions: [{ kind: 'dailyWindow', from: '00:00', to: '12:00' }] }),
    makeRule('a/default', { input: 0.5, cacheRead: 0.5 }, { conditions: [{ kind: 'dailyWindow', from: '12:01', to: '23:59' }] }),
  ]
  const models = [makeModel('a/default', { inputTokens: TOKENS })]
  // When 不传 options
  const outcome = simulateWhatIf({ models, rules, now: TUESDAY_MORNING })
  // Then 场景细节回显默认参数
  assert.equal(scenarioOf(outcome, 'cache-leverage').detail.targetHitRate, 0.8)
  assert.equal(scenarioOf(outcome, 'offpeak-shift').detail.shiftRatio, 0.3)
})

test('Given 非法入参 When 模拟 Then 不抛错并回空态', () => {
  // Given 缺省与形状错误的输入
  for (const input of [undefined, {}, { models: 'bad', rules: 'bad' }]) {
    // When 模拟
    const outcome = simulateWhatIf(input)
    // Then 基线 0、空态、货币 null
    assert.equal(outcome.baseline, 0)
    assert.equal(outcome.currency, null)
    assert.ok(outcome.scenarios.every((scenario) => scenario.status === 'empty'))
  }
})
