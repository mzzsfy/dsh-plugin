// 自定义单价与币种折算:纯数据变换,无 IO。
// 币种口径:原生币种计价后统一折 USD 入账本;展示层按当前汇率折 CNY。

const TOKENS_PER_UNIT = 1000000
const CURRENCY_CNY = 'CNY'
const CURRENCY_USD = 'USD'

import { FALLBACK_PRICING } from './ledger.mjs'

// 目录价未就绪(启动窗口内为 null/空)时同步回落内置兜底价,计费不静默丢失。
export function catalogOrFallback(table) {
  return Array.isArray(table) && table.length > 0 ? table : FALLBACK_PRICING
}

const TIERS = {
  custom: { full: 'custom-full', name: 'custom-name', prefix: 'custom-prefix' },
  catalog: { full: 'catalog', name: 'catalog', prefix: 'catalog' },
}

// 设置条目 -> 匹配表条目;模型 id 含 / 视为 provider/model 精确键,否则同时给裸名键。
function normalizeCustomPrices(list) {
  const table = []
  if (!Array.isArray(list)) return table
  for (const item of list) {
    if (!item || typeof item.model !== 'string' || item.model.trim().length === 0) continue
    const input = Number(item.input)
    const output = Number(item.output)
    if (!Number.isFinite(input) && !Number.isFinite(output)) continue
    const model = item.model.trim().toLowerCase()
    const cacheRead = Number.isFinite(Number(item.cacheRead)) ? Number(item.cacheRead) : null
    const slashAt = model.indexOf('/')
    table.push({
      keys: slashAt >= 0 ? [model, model.slice(slashAt + 1)] : [model],
      input: Number.isFinite(input) ? input : null,
      output: Number.isFinite(output) ? output : null,
      cacheRead,
      currency: item.currency === CURRENCY_CNY ? CURRENCY_CNY : CURRENCY_USD,
    })
  }
  return table
}

// provider/model 精确 -> 模型名精确 -> 最长前缀,按层返回 {entry, tier}。
function matchTable(table, full, modelLower, tiers) {
  for (const entry of table) {
    if (entry.keys[0] === full) return { entry, tier: tiers.full }
  }
  for (const entry of table) {
    if (entry.keys.indexOf(modelLower) >= 0) return { entry, tier: tiers.name }
  }
  let best = null
  for (const entry of table) {
    for (const key of entry.keys) {
      if (modelLower.indexOf(key) === 0 && (best === null || key.length > best.keyLen)) {
        best = { entry, keyLen: key.length }
      }
    }
  }
  return best ? { entry: best.entry, tier: tiers.prefix } : null
}

// 匹配链:自定义 provider/model 精确 -> 自定义模型名精确 -> 自定义最长前缀 -> 目录价(同序)。
function matchPrice(customTable, catalogTable, provider, model) {
  if (!model) return null
  const modelLower = String(model).toLowerCase()
  const full = (provider || '') + '/' + modelLower
  return matchTable(customTable, full, modelLower, TIERS.custom) ||
    matchTable(catalogTable, full, modelLower, TIERS.catalog)
}

// 原生币种金额;价格缺失或全空 token 返回 null(不估金额)。
function nativeCostOfCall(call, price) {
  if (!price) return null
  const hasAny = Number.isFinite(call.inputTokens) || Number.isFinite(call.outputTokens) || Number.isFinite(call.cacheReadTokens)
  if (!hasAny) return null
  let amount = 0
  if (Number.isFinite(call.inputTokens) && Number.isFinite(price.input)) {
    amount += (call.inputTokens / TOKENS_PER_UNIT) * price.input
  }
  if (Number.isFinite(call.outputTokens) && Number.isFinite(price.output)) {
    amount += (call.outputTokens / TOKENS_PER_UNIT) * price.output
  }
  if (Number.isFinite(call.cacheReadTokens) && Number.isFinite(price.cacheRead)) {
    amount += (call.cacheReadTokens / TOKENS_PER_UNIT) * price.cacheRead
  }
  return { amount, currency: price.currency || CURRENCY_USD }
}

// 折 USD 入账本:CNY 金额除以汇率(每 USD 兑 CNY)。
function toUsd(amount, currency, rateUsdToCny) {
  if (currency === CURRENCY_CNY) return amount / rateUsdToCny
  return amount
}

export { normalizeCustomPrices, matchPrice, nativeCostOfCall, toUsd, TIERS }
