// 成本护栏:在 llm/stream waterfall 上按预算判定放行 / 降级 / 熔断。
// 缺 llm 服务时干净禁用(不注册监听),不影响其余模块。
// 拦截发生在 provider 调用之前,熔断不产生 token 成本;降级只能改下一次请求的
// 模型选择,不能改写已冻结的请求 envelope。

import { BUDGET_ACTION_NONE, RATE_WINDOW_MINUTES, evaluateBudget, hourlyRateOf, planRequest } from './budget.js'
import { splitRequestSegments } from './pricing.js'
import { GRANULARITY_MINUTE, recentMinuteBuckets } from './store.js'

export const BUDGET_EXCEEDED_CODE = 'BUDGET_EXCEEDED'
// 花费读数缓存窗口:模型请求频率远高于查库与定价聚合能力
export const SPENT_CACHE_TTL_MS = 30 * 1000

const MS_PER_MINUTE = 60 * 1000
const COST_SCALE = 100
const SCOPE_LABELS = { daily: '日预算', monthly: '周期预算' }
const NO_LLM_MESSAGE = 'llm 服务缺席,成本护栏未启用'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

const roundCost = (value) => Math.round((Number.isFinite(value) ? value : 0) * COST_SCALE) / COST_SCALE

// 配置签名:配置变更即作废读数缓存;notify 不参与判定,不进签名
const configKeyOf = (config) => [
  config.enabled,
  config.warnRatio,
  config.daily.limit,
  config.daily.action,
  config.monthly.limit,
  config.monthly.action,
  config.degradeModel,
].join('|')

function budgetExceededError(scope, evaluation) {
  const budget = evaluation?.budgets?.find((item) => item.scope === scope)
  const label = SCOPE_LABELS[scope] ?? '预算'
  const detail = budget ? `(已花 ${roundCost(budget.spent)} / 限额 ${roundCost(budget.limit)})` : ''
  const error = new Error(`成本护栏:${label}已超限${detail},本次模型请求已拦截`)
  error.code = BUDGET_EXCEEDED_CODE
  error.scope = scope ?? null
  return error
}

// 缺服务时的空实现:调用面与启用态同形,消费方可统一解构,宿主降级路径不抛错
function idleGuard(deps) {
  const configOf = () => {
    try {
      return deps?.config?.() ?? null
    } catch {
      return null
    }
  }
  const status = () => ({
    installed: false,
    action: BUDGET_ACTION_NONE,
    blockedAt: null,
    blockedScope: null,
    acked: false,
    degrade: null,
    degradeModel: configOf()?.degradeModel ?? '',
    evaluation: null,
    config: configOf(),
    cachedAt: null,
  })
  const noop = () => {}
  const dispose = () => {}
  dispose.status = status
  dispose.dispose = dispose
  dispose.ack = noop
  dispose.reset = noop
  dispose.refresh = () => Promise.resolve(null)
  return dispose
}

export function installGuard(ctx, deps) {
  const llm = ctx.get?.('llm')
  if (!llm) {
    ctx.logger?.warn?.(`usage-dash: guard ${NO_LLM_MESSAGE}`)
    return idleGuard(deps)
  }

  // 内存态:读数缓存、在飞读数、熔断锁、人工确认标记与最近一次降级;进程内有效,不持久化
  const cache = { read: null, flight: null, trip: null, acked: false, degrade: null, cycleSignature: undefined }
  const switchableCache = new Map()
  const warned = new Set()
  let disposed = false

  const clock = () => (typeof deps.now === 'function' ? deps.now() : Date.now())

  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger?.warn?.(`usage-dash: guard ${message}`)
  }

  const configOf = () => {
    try {
      return deps.config()
    } catch (error) {
      warnOnce('config', `预算配置不可读,本次放行:${messageOf(error)}`)
      return null
    }
  }

  const freshRead = (config) => {
    const read = cache.read
    if (!read || read.configKey !== configKeyOf(config)) return null
    return clock() - read.at < SPENT_CACHE_TTL_MS ? read : null
  }

  // 燃烧率取最近 30 分钟分钟桶:窗口内价格按当前规则命中
  const rateAt = async (at) => {
    const rules = deps.pricing?.rules?.() ?? []
    if (!Array.isArray(rules) || rules.length === 0) return 0
    const window = recentMinuteBuckets(at, deps.timeZone, RATE_WINDOW_MINUTES)
    const rows = await deps.store.rangeRows(GRANULARITY_MINUTE, window.from, window.to)
    return hourlyRateOf({ rows, rules, at, buckets: window.keys })
  }

  // 熔断只在"由未超限进入超限"那一刻置位:人工确认后不再重复武装,
  // 直到读数回落到限额内(换天 / 提额 / 窗口滚动)才重新武装
  const latch = (evaluation, config, at) => {
    if (!config.enabled) return
    const plan = planRequest({ evaluation, config })
    if (plan.kind !== 'block') {
      // 读回复落即释放:status/端点不必等下一次模型请求才看到解除
      cache.trip = null
      cache.acked = false
      return
    }
    if (cache.trip || cache.acked) return
    cache.trip = { scope: plan.scope, at }
    ctx.logger?.warn?.(`usage-dash: guard ${SCOPE_LABELS[plan.scope] ?? '预算'}已超限,后续模型请求将被拦截`)
  }

  // 周期签名:计费周期改了,「已花」就是另一个窗口的数,读数与熔断结论都得作废
  const cycleSignature = () => {
    try {
      const config = deps.cycleConfig?.() ?? null
      return config === null ? 'default' : `${config.kind}|${config.startDay}|${config.days}`
    } catch (error) {
      // 配置不可读不是拦截理由:沿用上一签名,请求照常放行
      warnOnce('cycle', `计费周期不可读,沿用上次口径:${messageOf(error)}`)
      return cache.cycleSignature ?? 'unknown'
    }
  }

  const dropOnCycleChange = () => {
    const signature = cycleSignature()
    if (cache.cycleSignature === signature) return
    cache.read = null
    cache.trip = null
    cache.acked = false
    cache.cycleSignature = signature
  }

  const readSpentNow = () => {
    if (disposed) return Promise.resolve(null)
    if (cache.flight) return cache.flight
    const config = configOf()
    if (!config?.enabled) return Promise.resolve(null)
    dropOnCycleChange()
    const at = clock()
    cache.flight = (async () => {
      try {
        const spent = await deps.spent()
        const ratePerHour = await rateAt(at)
        const evaluation = evaluateBudget({ config, spent, ratePerHour, now: at })
        cache.read = { at, configKey: configKeyOf(config), evaluation }
        latch(evaluation, config, at)
        return cache.read
      } catch (error) {
        warnOnce('spent', `花费读数不可用,沿用上次读数:${messageOf(error)}`)
        return cache.read
      } finally {
        cache.flight = null
      }
    })()
    return cache.flight
  }

  // 同步判定:读数过期时先放行本次并异步刷新,熔断锁一旦置位即持续拒绝
  const decide = (config) => {
    if (!config.enabled) {
      cache.trip = null
      cache.acked = false
      return { kind: 'allow' }
    }
    dropOnCycleChange()
    const read = freshRead(config)
    // 熔断锁不是终态:读数过期就重读,回落到限额内(换天/提额/改周期)自动解除
    if (cache.trip) {
      if (!read) {
        void readSpentNow()
        return { kind: 'block', scope: cache.trip.scope }
      }
      const blocked = planRequest({ evaluation: read.evaluation, config })
      if (blocked.kind === 'block') {
        // 熔断范围随新读数走:熔断中提额可能让拦截方从日档切到周期档
        if (blocked.scope && cache.trip) cache.trip = { ...cache.trip, scope: blocked.scope }
        return { kind: 'block', scope: blocked.scope ?? cache.trip.scope }
      }
      cache.trip = null
      return blocked
    }
    if (!read) {
      void readSpentNow()
      return { kind: 'allow' }
    }
    const plan = planRequest({ evaluation: read.evaluation, config })
    if (plan.kind === 'block' && cache.acked) return { kind: 'allow' }
    return plan
  }

  // 降级目标路线先经 llm 解析一次:配置里写错的模型一旦切过去,后续每一步请求都会失败
  const switchable = async (provider, modelId) => {
    const key = `${provider}/${modelId}`
    if (switchableCache.has(key)) return switchableCache.get(key)
    let ok = typeof llm.resolveCallConfig === 'function'
    if (ok) {
      try {
        await llm.resolveCallConfig({ provider, model: modelId })
      } catch (error) {
        warnOnce(`target:${key}`, `降级目标模型不可用,仅记录不切换:${messageOf(error)}`)
        ok = false
      }
    }
    switchableCache.set(key, ok)
    return ok
  }

  // 切换落点是宿主 agent 的 modelSelection(下一次模型步生效),随宿主形态特性检测
  const switchModel = async (model, sessionId) => {
    const [provider, modelId] = splitRequestSegments(model)
    if (!(await switchable(provider, modelId))) return { reason: 'unresolved' }
    const agent = typeof sessionId === 'string' ? ctx.get?.('agents')?.get?.(sessionId) : undefined
    const selection = agent?.model
    if (typeof selection?.select !== 'function') return { reason: 'no-agent' }
    const current = typeof selection.current === 'function' ? selection.current() : undefined
    if (current?.provider === provider && current?.model === modelId) return { applied: true, reason: 'already' }
    try {
      selection.select({
        provider,
        model: modelId,
        ...(current?.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
      })
    } catch (error) {
      warnOnce('select', `降级切换失败,仅记录:${messageOf(error)}`)
      return { reason: 'failed' }
    }
    return { applied: true, reason: 'switched' }
  }

  const noteDegrade = (model, sessionId) => {
    cache.degrade = { model, at: clock(), applied: false, reason: 'pending' }
    void switchModel(model, sessionId)
      .catch((error) => ({ reason: `error:${messageOf(error)}` }))
      .then((outcome) => {
        if (cache.degrade?.model !== model) return
        cache.degrade = { ...cache.degrade, ...outcome }
      })
  }

  const onStream = (options, next) => {
    const config = configOf()
    const plan = config ? decide(config) : { kind: 'allow' }
    if (plan.kind === 'block') throw budgetExceededError(plan.scope, cache.read?.evaluation)
    if (plan.kind === 'degrade') noteDegrade(plan.model, options?.sessionId)
    return next()
  }

  let off = null
  try {
    off = ctx.on('llm/stream', onStream, { global: true })
  } catch (error) {
    ctx.logger?.warn?.(`usage-dash: guard 监听注册失败,成本护栏未启用:${messageOf(error)}`)
    return idleGuard(deps)
  }
  // 首帧读数:设置已激活时让 status() 一开始就带评估结果
  void readSpentNow()

  const effectiveAction = () => {
    if (cache.trip) return 'block'
    const action = cache.read?.evaluation?.action ?? BUDGET_ACTION_NONE
    return cache.acked && action === 'block' ? BUDGET_ACTION_NONE : action
  }

  const status = () => {
    const config = configOf()
    dropOnCycleChange()
    const enabled = !disposed && config?.enabled === true
    return {
      installed: !disposed,
      action: enabled ? effectiveAction() : BUDGET_ACTION_NONE,
      blockedAt: enabled ? (cache.trip?.at ?? null) : null,
      blockedScope: enabled ? (cache.trip?.scope ?? null) : null,
      acked: cache.acked,
      degrade: cache.degrade ? { ...cache.degrade } : null,
      degradeModel: config?.degradeModel ?? '',
      evaluation: enabled ? (cache.read?.evaluation ?? null) : null,
      config,
      cachedAt: enabled ? (cache.read?.at ?? null) : null,
    }
  }

  // 人工确认本次超支:解除熔断锁且本轮不再重新武装,请求放行;
  // 待读数回到限额内后熔断重新生效
  const ack = () => {
    cache.trip = null
    cache.acked = true
  }

  const reset = () => {
    cache.trip = null
    cache.acked = false
    cache.read = null
    cache.degrade = null
    switchableCache.clear()
  }

  const dispose = () => {
    off?.()
    off = null
    disposed = true
    reset()
  }
  // 返回可调用对象:同时满足 ctx.effect 的 disposer 契约与 { status, dispose } 消费面
  dispose.status = status
  dispose.dispose = dispose
  dispose.ack = ack
  dispose.reset = reset
  dispose.refresh = readSpentNow
  return dispose
}
