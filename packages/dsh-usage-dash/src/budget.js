// 预算评估:配置归一、状态判定与分钟级 ETA。纯函数零 IO,供 Guard 拦截器与
// /budget、/summary 端点共用同一口径,避免同一份配置在两处判定出不同结果。

import { costOf, matchPrice } from './pricing.js'

export const BUDGET_ACTIONS = ['warn', 'degrade', 'block']
export const BUDGET_SCOPES = ['daily', 'monthly']
export const BUDGET_STATE_OK = 'ok'
export const BUDGET_STATE_WARN = 'warn'
export const BUDGET_STATE_EXCEEDED = 'exceeded'
export const BUDGET_ACTION_NONE = 'none'
export const DEFAULT_WARN_RATIO = 0.8
export const MINUTES_PER_HOUR = 60
export const MS_PER_HOUR = MINUTES_PER_HOUR * 60 * 1000
// 燃烧率取样窗口:取值过短受单次大请求影响,过长对"正在超支"反应迟钝
export const RATE_WINDOW_MINUTES = 30

// 动作严重度:多档同时命中取最重者,block > degrade > warn > none
const ACTION_SEVERITY = {
  [BUDGET_ACTION_NONE]: 0,
  warn: 1,
  degrade: 2,
  block: 3,
}

const isPositive = (value) => Number.isFinite(value) && value > 0

const normalizeLimit = (value) => (isPositive(value) ? value : 0)

const normalizeAction = (value) => (BUDGET_ACTIONS.includes(value) ? value : BUDGET_ACTIONS[0])

const normalizeRatio = (value) => (isPositive(value) && value < 1 ? value : DEFAULT_WARN_RATIO)

function normalizeScope(raw) {
  return { limit: normalizeLimit(raw?.limit), action: normalizeAction(raw?.action) }
}

export function normalizeBudgetConfig(raw) {
  return {
    warnRatio: normalizeRatio(raw?.warnRatio),
    daily: normalizeScope(raw?.daily),
    monthly: normalizeScope(raw?.monthly),
    degradeModel: typeof raw?.degradeModel === 'string' ? raw.degradeModel.trim() : '',
    notify: raw?.notify !== false,
  }
}

function stateOf(ratio, warnRatio) {
  if (ratio >= 1) return BUDGET_STATE_EXCEEDED
  if (ratio >= warnRatio) return BUDGET_STATE_WARN
  return BUDGET_STATE_OK
}

function actionOf(scopeConfig, state, config) {
  if (state === BUDGET_STATE_WARN) return 'warn'
  if (state !== BUDGET_STATE_EXCEEDED) return BUDGET_ACTION_NONE
  // 降级缺少目标模型时退化为提示:不能声称已降级却无处可降
  if (scopeConfig.action === 'degrade' && config.degradeModel.length === 0) return 'warn'
  return scopeConfig.action
}

// 评估一次:spent 为窗口内已花费(同货币),ratePerHour 为当前燃烧率。
// 未配置 limit 的档位不出现,ETA 只对首个未超限档给出
export function evaluateBudget({ config, spent, ratePerHour = 0, now = 0 }) {
  const budgets = BUDGET_SCOPES
    .filter((scope) => config[scope].limit > 0)
    .map((scope) => {
      const limit = config[scope].limit
      const used = Math.max(0, spent?.[scope] ?? 0)
      const ratio = used / limit
      const state = stateOf(ratio, config.warnRatio)
      return {
        scope,
        limit,
        spent: used,
        remaining: Math.max(0, limit - used),
        ratio,
        state,
        action: actionOf(config[scope], state, config),
      }
    })
  const action = budgets.reduce(
    (worst, item) => (ACTION_SEVERITY[item.action] > ACTION_SEVERITY[worst] ? item.action : worst),
    BUDGET_ACTION_NONE,
  )
  const target = budgets.find((item) => item.state !== BUDGET_STATE_EXCEEDED && item.remaining > 0 && ratePerHour > 0)
  const eta = target
    ? { scope: target.scope, hoursLeft: target.remaining / ratePerHour, at: now + (target.remaining / ratePerHour) * MS_PER_HOUR }
    : null
  return { enabled: config.enabled, action, budgets, eta, ratePerHour }
}

// 拦截器判定:只保留是否阻断与降级目标,避免消费方重复解读 action 语义
export function planRequest({ evaluation, config }) {
  if (!config.enabled) return { kind: 'allow' }
  if (evaluation.action === 'block') return { kind: 'block', scope: blockingScopeOf(evaluation) }
  if (evaluation.action === 'degrade' && config.degradeModel.length > 0) {
    return { kind: 'degrade', model: config.degradeModel }
  }
  return { kind: 'allow' }
}

const blockingScopeOf = (evaluation) =>
  evaluation.budgets.find((item) => item.action === 'block')?.scope ?? null

// 燃烧率:窗口内分钟桶费用折算每小时。价格按计价时刻命中当前规则,
// 未命中价格的桶不计入(与聚合侧 unpriced 口径一致,不虚增速率)
export function hourlyRateOf({ rows, rules, at, windowMinutes = RATE_WINDOW_MINUTES, buckets = null }) {
  if (!Array.isArray(rows) || !(windowMinutes > 0)) return 0
  let cost = 0
  for (const row of rows) {
    if (buckets && !buckets.has(row?.bucket)) continue
    const price = matchPrice(rules, row?.model, at)
    if (price) cost += costOf(price, row)
  }
  return cost / (windowMinutes / MINUTES_PER_HOUR)
}
