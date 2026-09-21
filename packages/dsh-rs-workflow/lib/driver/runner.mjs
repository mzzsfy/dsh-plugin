// 批次执行:slots 解析/候选轮换/engine.start 派发/收敛记账/失败账
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schemaOf, buildPrompt } from './prompts.mjs'
import { stepTypeOf } from './scheduler.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FLOW_EXEC_SOURCE = readFileSync(join(PKG_ROOT, 'engine', 'flow-exec.js'), 'utf8')


const DEFAULT_SLOT = {
  normal: 'executor',
  loop: 'executor-loop',
  redo: 'executor-loop',
  escalate: 'executor-escalate',
  approve: 'reviewer-approve',
}

// 失败账缺省上限:step.maxFail 与 budgets.maxStepFail 均缺省时兜底,防无限重试
const DEFAULT_MAX_STEP_FAIL = 2

// 步骤槽位类别:常规/循环/重做/升级/审批(显式 slot 优先,审批不可覆盖)
export function slotCategoryOf(step, { isRedo = false, isEscalate = false } = {}) {
  if (stepTypeOf(step) === 'approve') return 'approve'
  if (isEscalate) return 'escalate'
  if (isRedo) return 'redo'
  if (step.for_each) return 'loop'
  return 'normal'
}

// 槽位解析:候选数组按 run 级游标轮换;失败换下一候选(游标+1)
// 显式 slot 不限类别(settings-schema:缺省绑定仅在未声明 slot 时生效)
export function resolveSlot(step, category, slots, state) {
  const key = step.slot ?? DEFAULT_SLOT[category]
  const binding = slots?.[key]
  if (binding === undefined || binding === '' || binding === null) return { slotKey: key, provider: undefined, model: undefined }
  if (!Array.isArray(binding)) return { slotKey: key, provider: binding, model: undefined }
  state.slotCursor ??= {}
  const cursor = state.slotCursor[key] ?? 0
  const candidate = binding[cursor % binding.length]
  return { slotKey: key, provider: candidate, model: undefined, cursorKey: key }
}

function rotateCursor(state, slotKey) {
  if (!slotKey) return
  state.slotCursor ??= {}
  state.slotCursor[slotKey] = (state.slotCursor[slotKey] ?? 0) + 1
}

// 单批次:组 Batch → engine.start → 收敛逐 call 记账。返回 {settled, cancelled}
export async function runBatch({ state, script, template, batch, ctx }) {
  const { store, runId, engine, parent, signal } = ctx
  const calls = []
  const callMeta = new Map()
  state.batchSeq++
  const batchNo = state.batchSeq
  for (const [i, item] of batch.entries()) {
    const step = (script ?? template).steps.find((s) => s.id === item.stepId) ?? template.steps.find((s) => s.id === item.stepId)
    const inst = item.instance
    const redo = state.redoInfo?.[item.stepId]
    const isRedo = !!redo
    const category = slotCategoryOf(step, { isRedo, isEscalate: !!item.escalate })
    const { slotKey, provider, model, cursorKey } = resolveSlot(step, category, ctx.slots, state)
    const prompt = buildPrompt({
      state, request: ctx.request, inputs: ctx.inputs, step, inst,
      planStep: ctx.planStepOf?.get(item.stepId),
      injectMessages: ctx.injectMessages, queuedMessages: ctx.queuedMessages,
      redo, readDoc: ctx.readDoc,
    })
    const callId = `${item.stepId}#${inst?.key ?? '-'}@${batchNo}:${i}`
    const label = `${step.label ?? step.id}${inst ? ` ${inst.key}` : ''}`
    calls.push({ callId, prompt, label, schema: schemaOf(step), provider, model })
    callMeta.set(callId, { item, step, slotKey, cursorKey, prompt, label })
  }

  for (const call of calls) {
    const { item, prompt } = callMeta.get(call.callId)
    const s = state.steps[item.stepId]
    if (item.instance) {
      const inst = s.instances.find((x) => x.key === item.instance.key)
      if (inst) inst.status = 'running'
    } else {
      s.status = 'running'
    }
    store.step({ runId, stepId: item.stepId, instance: item.instance?.key, event: 'dispatch', body: { prompt, callLabel: call.label } })
  }

  let outcome
  let run
  try {
    run = engine.start({
      script: FLOW_EXEC_SOURCE,
      args: { calls },
      // 宿主 meta 契约:description 必填非空;phases 必须为 {title} 对象数组(dsh-workflow-worker-thread meta 校验)
      meta: {
        name: `rsww-batch-${runId}-${batchNo}`,
        description: calls.map((c) => c.label).join(' / '),
        phases: calls.map((c) => ({ title: c.label })),
      },
      parent,
      signal,
    })
    outcome = await (run.result ?? run)
  } catch (e) {
    if (signal?.aborted) return { cancelled: true }
    outcome = { results: calls.map((c) => ({ callId: c.callId, ok: false, error: String(e?.message ?? e) })) }
  } finally {
    // 宿主契约:caller must dispose every run(否则 worker 线程泄漏);engine.start 同步抛时 run 为空
    await run?.dispose?.().catch?.(() => {})
  }
  if (signal?.aborted) return { cancelled: true }
  // 引擎 run.result 契约:{ value(脚本返回值), stopReason, error?, agentsStarted }
  // stopReason 非 completed(如 error)时 value 不可信,全部调用统一按失败记账
  let results
  if (outcome?.stopReason !== undefined && outcome?.stopReason !== 'completed') {
    const reason = String(outcome?.error ?? outcome?.stopReason)
    results = calls.map((c) => ({ callId: c.callId, ok: false, error: reason }))
  } else {
    results = outcome?.value?.results ?? outcome?.results ?? []
  }
  const settled = []
  for (const result of results) {
    const meta = callMeta.get(result.callId)
    if (!meta) continue
    const s = state.steps[meta.item.stepId]
    if (result.ok) {
      if (meta.item.instance) {
        const inst = s.instances.find((x) => x.key === meta.item.instance.key)
        if (inst) {
          inst.status = 'done'
          inst.outputs = result.outputs
        }
      } else {
        s.status = 'done'
        s.outputs = result.outputs
      }
      store.step({ runId, stepId: meta.item.stepId, instance: meta.item.instance?.key, event: 'submit', body: { outputs: result.outputs } })
    } else {
      const failTarget = meta.item.instance ? s.instances.find((x) => x.key === meta.item.instance.key) : s
      if (failTarget) {
        failTarget.failCount++
        const limit = meta.step.maxFail ?? ctx.budgets.maxStepFail ?? DEFAULT_MAX_STEP_FAIL
        if (failTarget.failCount >= limit) {
          failTarget.status = 'failed'
          failTarget.error = result.error
        } else {
          failTarget.status = 'pending'
          rotateCursor(state, meta.cursorKey)
        }
      }
      store.step({ runId, stepId: meta.item.stepId, instance: meta.item.instance?.key, event: 'fail', body: { error: result.error, candidate: meta.slotKey } })
    }
    settled.push({ item: meta.item, result })
  }
  // 看门狗:引擎契约要求结果逐 callId 返回;缺失即引擎侧异常,按标准失败路径记账(failCount+上限)
  const seenIds = new Set(results.map((r) => r.callId))
  for (const call of calls) {
    if (seenIds.has(call.callId)) continue
    const meta = callMeta.get(call.callId)
    const s = state.steps[meta.item.stepId]
    const failTarget = meta.item.instance ? s.instances.find((x) => x.key === meta.item.instance.key) : s
    const error = '引擎结果缺失该调用'
    if (failTarget) {
      failTarget.failCount++
      const limit = meta.step.maxFail ?? ctx.budgets.maxStepFail ?? DEFAULT_MAX_STEP_FAIL
      if (failTarget.failCount >= limit) {
        failTarget.status = 'failed'
        failTarget.error = error
      } else {
        failTarget.status = 'pending'
        rotateCursor(state, meta.cursorKey)
      }
    }
    store.step({ runId, stepId: meta.item.stepId, instance: meta.item.instance?.key, event: 'fail', body: { error, candidate: meta.slotKey } })
    settled.push({ item: meta.item, result: { callId: call.callId, ok: false, error } })
  }
  return { settled }
}
