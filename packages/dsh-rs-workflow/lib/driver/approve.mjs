// 审批裁决路由:重做循环/耗尽清算/升级账本(全部作用于 RunState)
import { effectiveDeps, escalateOnlyIds } from './scheduler.mjs'

const resetStepForRedo = (s) => {
  s.status = 'pending'
  s.outputs = null
  s.failCount = 0
  s.instances = []
}

// target 及其未完成下游集合(有效依赖图的可达闭包,不含 escalate-only)
function descendantsOf(template, targetId) {
  const escalateOnly = escalateOnlyIds(template)
  const deps = effectiveDeps(template, escalateOnly)
  const children = new Map()
  for (const [id, ds] of deps) {
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

// 审批结果路由;返回 {verdict, exhausted, routedTo}
export function applyApproveResult(state, template, approveStep, result, budgets) {
  const s = state.steps[approveStep.id]
  const verdict = result.outputs?.verdict
  state.approvals[approveStep.id] ??= { rounds: 0 }
  const ledger = state.approvals[approveStep.id]

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
      for (const id of descendantsOf(template, approveStep.target)) {
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
    for (const id of descendantsOf(template, approveStep.target)) {
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
