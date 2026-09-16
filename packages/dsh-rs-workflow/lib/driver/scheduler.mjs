// 就绪批次计算(调度域=剧本):依赖(plan.deps,gate 预计算)/for_each 展开/并发上限/审批就绪侦测/死锁防护
export const DEFAULT_CONCURRENCY = 4
const SELF_KEY = '-'

export function stepTypeOf(step) {
  return step.type ?? 'ai'
}

// 升级步集(模板级语义:onExhausted 目标);是否在剧本由 planner-gate 裁决
export function escalateOnlyIds(template) {
  const ids = new Set()
  for (const step of template.steps) {
    if (stepTypeOf(step) === 'approve' && typeof step.onExhausted === 'string' && step.onExhausted !== 'blocked') {
      ids.add(step.onExhausted)
    }
  }
  return ids
}

// 剧本视图:plan.steps(ref 子序列)映射为模板步骤对象;依赖表 = gate 重算的 plan.deps
export function scriptViewOf(template, plan) {
  const byId = new Map(template.steps.map((s) => [s.id, s]))
  const steps = (plan?.steps ?? []).map((p) => byId.get(p.ref)).filter(Boolean)
  const depsById = new Map(Object.entries(plan?.deps ?? {}))
  const planRefs = new Set((plan?.steps ?? []).map((p) => p.ref))
  const escalateOnly = new Set([...escalateOnlyIds(template)].filter((id) => planRefs.has(id)))
  return { steps, depsById, escalateOnly, byId }
}

const stepDone = (s) => s.status === 'done'
const stepBlockedInput = (s) => s.status === 'failed' || s.status === 'skipped'

// 数据源列表解析;源未完成返回 null
function sourceList(state, step) {
  const [srcId, srcOut] = step.for_each.split('.')
  const src = state.steps[srcId]
  if (!src || !stepDone(src)) return null
  const list = src.outputs?.[srcOut]
  return Array.isArray(list) ? list : []
}

function expandForEach(state, step) {
  const s = state.steps[step.id]
  if (s.instances.length > 0) return
  const list = sourceList(state, step)
  if (list === null) return
  s.instances = list.map((item, index) => ({
    key: `#${index + 1}`, index, item, status: 'pending', outputs: null, failCount: 0, carry: null,
  }))
}

// 宏观状态归一:实例级失败传播为步骤失败;实例全终态推导步骤态
function normalizeForEach(state, step) {
  const s = state.steps[step.id]
  if (!s || s.instances.length === 0 || s.status === 'done' || s.status === 'failed' || s.status === 'skipped') return
  if (s.instances.some((i) => i.status === 'failed')) {
    s.status = 'failed'
    s.error = s.instances.find((i) => i.status === 'failed')?.error
    return
  }
  if (s.instances.every((i) => i.status === 'done')) s.status = 'done'
}

// 就绪批次。kind:normal(并行 calls)/approve(外部裁决侦测)/flow(嵌套)/terminal/blocked/idle
export function nextBatch(state, script, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const { steps, depsById, escalateOnly } = script

  // 实例失败传播与步骤态归一
  for (const step of steps) if (step.for_each) normalizeForEach(state, step)

  // 依赖失败传播(宏观级)
  for (const step of steps) {
    if (escalateOnly.has(step.id)) continue
    const s = state.steps[step.id]
    if (!s || s.status !== 'pending') continue
    const bad = (depsById.get(step.id) ?? []).some((d) => state.steps[d] && stepBlockedInput(state.steps[d]))
    if (bad) {
      s.status = 'skipped'
      s.skipReason = '依赖失败传播'
      s.instances = []
    }
  }

  // 审批就绪侦测:target done 且依赖 done → 进入外部裁决(waiting_approval),不派发
  for (const step of steps) {
    if (stepTypeOf(step) !== 'approve') continue
    const s = state.steps[step.id]
    if (!s || s.status !== 'pending') continue
    const depsOk = (depsById.get(step.id) ?? []).every((d) => stepDone(state.steps[d] ?? {}))
    const target = state.steps[step.target]
    if (depsOk && target && stepDone(target)) {
      return { kind: 'approve', step }
    }
  }

  const calls = []
  for (const step of steps) {
    if (escalateOnly.has(step.id)) continue
    const type = stepTypeOf(step)
    const s = state.steps[step.id]
    if (!s || s.status !== 'pending') continue
    const depsOk = (depsById.get(step.id) ?? []).every((d) => stepDone(state.steps[d] ?? {}))
    if (!depsOk) continue
    if (type === 'flow') return { kind: 'flow', step }
    if (type !== 'ai') continue
    if (step.for_each) {
      expandForEach(state, step)
      const list = sourceList(state, step)
      if (list !== null && list.length === 0) {
        s.status = 'skipped'
        s.skipReason = 'for_each 数据源为空'
        continue
      }
      let prev = null
      for (const inst of s.instances) {
        const ready = step.mode === 'sequential'
          ? inst.status === 'pending' && (prev === null || prev.status === 'done')
          : inst.status === 'pending'
        if (ready && step.mode === 'sequential' && prev) inst.carry = prev.outputs
        prev = inst
        if (!ready) continue
        calls.push({ stepId: step.id, instance: { key: inst.key, index: inst.index, item: inst.item, carry: inst.carry } })
        if (calls.length >= concurrency) return { kind: 'normal', calls }
      }
    } else {
      calls.push({ stepId: step.id })
      if (calls.length >= concurrency) return { kind: 'normal', calls }
    }
  }
  if (calls.length > 0) return { kind: 'normal', calls }

  // 升级步:唯一触发边 = 审批耗尽(escalateReady 标记)
  for (const id of escalateOnly) {
    const s = state.steps[id]
    if (s && s.status === 'pending' && s.escalateReady) return { kind: 'normal', calls: [{ stepId: id, escalate: true }] }
  }

  const anyRunning = steps.some((step) => {
    const s = state.steps[step.id]
    if (!s) return false
    return s.status === 'running' || (s.instances ?? []).some((i) => i.status === 'running')
  })
  const anyPending = steps.some((step) => {
    const s = state.steps[step.id]
    if (!s || s.status !== 'pending') return false
    if (escalateOnly.has(step.id)) return !!s.escalateReady
    return true
  })

  if (!anyRunning) {
    if (anyPending) return { kind: 'blocked', reason: '无就绪且无在飞但存在未完成步骤(依赖链缺陷)' }
    return { kind: 'terminal' }
  }
  return { kind: 'idle' }
}

export { SELF_KEY }
