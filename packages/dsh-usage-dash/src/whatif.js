// 省钱沙盘:在真实四桶用量上重算"换个模型 / 把缓存命中率提到某个目标 /
// 把用量挪到低价时段"三种场景的费用。纯计算零 IO,不写库、不改配置。
// 场景缺目标模型定价或缺少可用用量时标 unavailable,不返回伪造的零差额。

import { costOf, matchPrice } from './pricing.js'

export const WHATIF_SCENARIOS = ['model-swap', 'cache-leverage', 'offpeak-shift']
export const WHATIF_STATUS = ['ok', 'unavailable', 'empty']

const DEFAULT_TARGET_HIT_RATE = 0.8
const DEFAULT_SHIFT_RATIO = 0.3
const OFFPEAK_SHIFT_HOURS = 12
const MS_PER_HOUR = 60 * 60 * 1000
const MONEY_SCALE = 100
const PERCENT_SCALE = 100
const RATIO_SCALE = 10

// label 只下发文案键,由客户端按当前语言查词典
const SCENARIO_LABELS = {
  'model-swap': 'whatif.scenario.modelSwap',
  'cache-leverage': 'whatif.scenario.cacheLeverage',
  'offpeak-shift': 'whatif.scenario.offpeakShift',
}

const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite']
const BUCKET_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

const roundMoney = (value) => {
  const rounded = Math.round(value * MONEY_SCALE) / MONEY_SCALE
  return Object.is(rounded, -0) ? 0 : rounded
}

const roundRatio = (value) => {
  const rounded = Math.round(value * RATIO_SCALE) / RATIO_SCALE
  return Object.is(rounded, -0) ? 0 : rounded
}

// 非法 token 计数按 0 处理,负值不参与聚合
const tokenCount = (value) => (Number.isFinite(value) && value > 0 ? value : 0)

const bucketsOf = (entry) => ({
  inputTokens: tokenCount(entry?.inputTokens),
  outputTokens: tokenCount(entry?.outputTokens),
  cacheReadTokens: tokenCount(entry?.cacheReadTokens),
  cacheWriteTokens: tokenCount(entry?.cacheWriteTokens),
})

const totalTokensOf = (buckets) => BUCKET_KEYS.reduce((sum, key) => sum + buckets[key], 0)

const activeModelsOf = (models) => {
  if (!Array.isArray(models)) return []
  return models
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.model === 'string')
    .map((entry) => ({ model: entry.model, buckets: bucketsOf(entry) }))
    .filter((entry) => totalTokensOf(entry.buckets) > 0)
}

const normalizeRatio = (value, fallback) =>
  (Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback)

const normalizeOptions = (options) => ({
  targetModel: typeof options?.targetModel === 'string' ? options.targetModel.trim() : '',
  targetHitRate: normalizeRatio(options?.targetHitRate, DEFAULT_TARGET_HIT_RATE),
  shiftRatio: normalizeRatio(options?.shiftRatio, DEFAULT_SHIFT_RATIO),
})

const samePrice = (left, right) =>
  PRICE_KEYS.every((key) => (left?.[key] ?? 0) === (right?.[key] ?? 0))

const emptyScenario = (id) => ({
  id,
  status: 'empty',
  label: SCENARIO_LABELS[id],
  cost: null,
  delta: null,
  ratio: null,
  detail: { code: 'empty' },
})

const unavailableScenario = (id, detail) => ({
  id,
  status: 'unavailable',
  label: SCENARIO_LABELS[id],
  cost: null,
  delta: null,
  ratio: null,
  detail,
})

const pricedScenario = (id, detail, baseline, rawCost) => {
  const cost = roundMoney(rawCost)
  const delta = roundMoney(cost - baseline)
  return {
    id,
    status: 'ok',
    label: SCENARIO_LABELS[id],
    cost,
    delta,
    ratio: baseline > 0 ? roundRatio((delta / baseline) * PERCENT_SCALE) : null,
    detail,
  }
}

// 缓存杠杆:总输入不变,targetHitRate 决定缓存读取,余量按现有 input:cacheWrite 比例回填
const rebalanceBuckets = (buckets, targetHitRate) => {
  const totalInput = buckets.inputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
  if (totalInput === 0) return buckets
  const cacheReadTokens = totalInput * targetHitRate
  const remainder = totalInput - cacheReadTokens
  const missBase = buckets.inputTokens + buckets.cacheWriteTokens
  // 无未命中输入可分摊时,余量整体归为未命中输入
  if (missBase === 0) {
    return { ...buckets, inputTokens: remainder, cacheReadTokens, cacheWriteTokens: 0 }
  }
  return {
    ...buckets,
    inputTokens: remainder * (buckets.inputTokens / missBase),
    cacheReadTokens,
    cacheWriteTokens: remainder * (buckets.cacheWriteTokens / missBase),
  }
}

// input: { models: [{model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}],
//          rules, currency, now, options: {targetModel, targetHitRate, shiftRatio} }
export function simulateWhatIf(input) {
  const currency = typeof input?.currency === 'string' && input.currency !== '' ? input.currency : null
  const rules = Array.isArray(input?.rules) ? input.rules : []
  const models = activeModelsOf(input?.models)
  const options = normalizeOptions(input?.options)
  const now = input?.now

  if (rules.length === 0 || models.length === 0) {
    return { baseline: 0, currency, scenarios: WHATIF_SCENARIOS.map(emptyScenario) }
  }

  const priced = models.map((entry) => ({ ...entry, price: matchPrice(rules, entry.model, now) }))
  const unpriced = priced.filter((entry) => !entry.price)
  if (unpriced.length > 0) {
    const detail = { code: 'unpricedModels', models: unpriced.map((entry) => entry.model) }
    return {
      baseline: null,
      currency,
      scenarios: WHATIF_SCENARIOS.map((id) => unavailableScenario(id, detail)),
    }
  }

  const baseline = roundMoney(priced.reduce(
    (sum, entry) => sum + costOf(entry.price, entry.buckets),
    0,
  ))

  const modelSwap = () => {
    if (options.targetModel === '') {
      return unavailableScenario('model-swap', { code: 'targetModelRequired' })
    }
    const targetPrice = matchPrice(rules, options.targetModel, now)
    if (!targetPrice) {
      return unavailableScenario('model-swap', {
        code: 'targetModelUnpriced',
        model: options.targetModel,
      })
    }
    const rawCost = priced.reduce((sum, entry) => sum + costOf(targetPrice, entry.buckets), 0)
    return pricedScenario('model-swap', { targetModel: options.targetModel }, baseline, rawCost)
  }

  const cacheLeverage = () => {
    const rawCost = priced.reduce((sum, entry) => (
      sum + costOf(entry.price, rebalanceBuckets(entry.buckets, options.targetHitRate))
    ), 0)
    return pricedScenario(
      'cache-leverage',
      { targetHitRate: options.targetHitRate },
      baseline,
      rawCost,
    )
  }

  const offpeakShift = () => {
    const nowMs = now instanceof Date ? now.getTime() : Number(now)
    const shifted = new Date(nowMs + OFFPEAK_SHIFT_HOURS * MS_PER_HOUR)
    let rawCost = 0
    for (const entry of priced) {
      const altPrice = matchPrice(rules, entry.model, shifted)
      if (!altPrice) {
        return unavailableScenario('offpeak-shift', { code: 'offpeakUnpriced', model: entry.model })
      }
      if (samePrice(entry.price, altPrice)) {
        return unavailableScenario('offpeak-shift', {
          code: 'offpeakNoDifferential',
          model: entry.model,
        })
      }
      rawCost += (1 - options.shiftRatio) * costOf(entry.price, entry.buckets)
      rawCost += options.shiftRatio * costOf(altPrice, entry.buckets)
    }
    return pricedScenario(
      'offpeak-shift',
      { shiftRatio: options.shiftRatio, hours: OFFPEAK_SHIFT_HOURS },
      baseline,
      rawCost,
    )
  }

  return {
    baseline,
    currency,
    scenarios: [modelSwap(), cacheLeverage(), offpeakShift()],
  }
}
