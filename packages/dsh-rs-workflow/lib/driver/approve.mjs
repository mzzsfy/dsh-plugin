// 审批裁决路由:重做循环/耗尽清算/升级账本 + 外部裁决(waiting_approval 置位/裁决回写/来源入账)
const resetStepForRedo = (s) => {
  s.status = 'pending'
  s.outputs = null
  s.failCount = 0
  s.instances = []
}

// target 及其未完成下游集合(剧本依赖图的可达闭包,不含 escalate-only)
function descendantsOf(script, targetId) {
  const { depsById, escalateOnly } = script
  const children = new Map()
  for (const [id, ds] of depsById) {
    for (const d of ds) {
      if (!children.has(d)) children.set(d, [])
      children.get(d).push(id)
    }
  }
  const out = new Set()
  const walk = (id) => {
    for (const child of children.get(id) ?? []) {
      if (out.has(child) || escalateOnly.has(child)) continue
      out.add(child)
      walk(child)
    }
  }
  walk(targetId)
  return out
}

// 审批结果路由;返回 {verdict, exhausted, routedTo}。result = { outputs: { verdict, comments } }(外部裁决包成同形)
export function applyApproveResult(state, script, approveStep, result, budgets) {
  const s = state.steps[approveStep.id]
  const verdict = result.outputs?.verdict
  state.approvals[approveStep.id] ??= { rounds: 0 }
  const ledger = state.approvals[approveStep.id]
  ledger.lastComments = result.outputs?.comments ?? ''

  if (verdict === 'APPROVED') {
    s.status = 'done'
    s.outputs = result.outputs
    return { verdict: 'APPROVED', exhausted: false }
  }

  // REJECTED
  ledger.rounds++
  const limit = approveStep.rounds ?? budgets.approveRounds
  const target = state.steps[approveStep.target]
  if (ledger.rounds < limit) {
    const prevOutputs = target?.outputs
    s.status = 'pending'
    s.outputs = null
    if (target) {
      target.redoBy = approveStep.id
      resetStepForRedo(target)
      // 全部后代重置(target 产出改变,done 后代亦陈旧)
      for (const id of descendantsOf(script, approveStep.target)) {
        resetStepForRedo(state.steps[id])
      }
    }
    return { verdict: 'REJECTED', exhausted: false, redoTarget: approveStep.target, comments: result.outputs?.comments, prevOutputs: prevOutputs ? JSON.stringify(prevOutputs, null, 2) : null }
  }

  // 耗尽
  s.status = 'done'
  s.outputs = result.outputs
  s.verdictExhausted = true
  if (approveStep.onExhausted === 'blocked') {
    state.terminalBlocked = `审批轮次耗尽:${approveStep.label ?? approveStep.id}(target=${approveStep.target},rounds=${ledger.rounds})`
    return { verdict: 'REJECTED', exhausted: true, routedTo: 'blocked' }
  }
  const escalateId = approveStep.onExhausted
  const escalateStep = state.steps[escalateId]
  state.escalations++
  if (target) {
    target.status = 'skipped'
    target.skipReason = '审批耗尽走升级出口'
    target.outputs = null
    for (const id of descendantsOf(script, approveStep.target)) {
      const ds = state.steps[id]
      if (!ds || ds.status === 'done') continue
      ds.status = 'skipped'
      ds.skipReason = '审批耗尽走升级出口'
      ds.outputs = null
      ds.instances = []
    }
  }
  if (escalateStep) escalateStep.escalateReady = true
  const hitLimit = state.escalations >= (budgets.escalateLimit ?? 2)
  if (hitLimit) {
    state.escalateLimitReached = true
    state.terminalBlocked = `升级账达上限(${state.escalations}),整流程 blocked`
  }
  return { verdict: 'REJECTED', exhausted: true, routedTo: escalateId, escalateLimitReached: hitLimit }
}

// 外部裁决回写(waiting_approval 期间);paused 期间的裁决由 driver 入队,resume 段首生效
// 返回 { applied: true, route } | { applied: false }
export function applyExternalVerdict(state, script, approveStep, { verdict, comments }, budgets = {}) {
  if (state.status !== 'waiting_approval') return { applied: false }
  const route = applyApproveResult(state, script, approveStep, { outputs: { verdict, comments } }, budgets)
  // blocked 终态由下一段 terminal 侦测收口;此处仅翻回 running(下一段推进/收口)
  state.status = 'running'
  return { applied: true, route }
}

// 段 settle 负载(waiting):待裁决摘要 + 口径上下文(feat/approve-bridge.md 字段集)
export function waitingPayload({ runId, state, script, planStepOf, approveStep }) {
  const target = state.steps[approveStep.target]
  const planStep = planStepOf.get(approveStep.id)
  const brief = planStep?.done || planStep?.note || approveStep.prompt
  const ledger = state.approvals[approveStep.id]
  return {
    kind: 'waiting',
    runId,
    status: state.status,
    waiting: {
      stepId: approveStep.id,
      target: { id: approveStep.target, label: approveStep.target, outputs: target?.outputs ?? null },
      brief,
      comments: ledger?.lastComments ?? '',
      rounds: ledger?.rounds ?? 0,
    },
  }
}
