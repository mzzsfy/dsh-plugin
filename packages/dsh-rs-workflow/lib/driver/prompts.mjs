// 指令组装:节顺序固定 [任务][产出要求][参考资料][用户补充][运行中用户消息][重做说明]
import { buildSchema } from '../template-v4.mjs'
import { stepTypeOf } from './scheduler.mjs'

const PLACEHOLDER_RE = /\{([^{}]+)\}/g
const DOC_TRUNCATE = 16 * 1024
export const VERDICT_SCHEMA = buildSchema({ type: 'approve' })

// 占位符解析;未满足来源解析空串(静态校验期已拦截非法引用)
export function resolvePlaceholders(text, ctx) {
  return String(text).replace(PLACEHOLDER_RE, (_, ph) => {
    if (ph === 'request') return ctx.request ?? ''
    if (ph === 'item') return ctx.item !== undefined ? String(ctx.item) : ''
    if (ph === 'item.index') return ctx.index !== undefined ? String(ctx.index) : ''
    if (ph.startsWith('input.')) {
      const v = ctx.inputs?.[ph.slice(6)]
      return v === undefined || v === null ? '' : String(v)
    }
    const dot = ph.indexOf('.')
    if (dot > 0) {
      const refId = ph.slice(0, dot)
      const refOut = ph.slice(dot + 1)
      if (ctx.selfId === refId) {
        if (ctx.carry !== undefined && ctx.carry !== null) return String(ctx.carry[refOut] ?? '')
        return ''
      }
      const ref = ctx.state?.steps?.[refId]
      if (ref?.outputs && refOut in ref.outputs) {
        const v = ref.outputs[refOut]
        return Array.isArray(v) ? v.join('\n') : String(v ?? '')
      }
      return ''
    }
    return ''
  })
}

export function outputsSection(step) {
  if (stepTypeOf(step) === 'approve') {
    return [
      '[产出要求]',
      'verdict:审批裁决,只能是 APPROVED(达标放行)或 REJECTED(驳回)',
      'comments:裁决说明;驳回时必须写明逐条修正要求',
      '完成后以 structured_output 工具提交,字段缺失或为空视同本步失败。',
    ]
  }
  const lines = ['[产出要求]']
  const listSet = new Set(step.listOutputs ?? [])
  for (const [name, desc] of Object.entries(step.outputs ?? {})) {
    lines.push(`${name}:${desc}${listSet.has(name) ? '(字符串列表,每行一项)' : ''}`)
  }
  lines.push('完成后以 structured_output 工具提交,字段缺失或为空视同本步失败。')
  return lines
}

export function loadSection(step, ctx) {
  if (!Array.isArray(step.load) || step.load.length === 0) return []
  const lines = ['[参考资料]']
  for (const entry of step.load) {
    if (entry.startsWith('skill:')) {
      lines.push(`本步需使用技能 ${entry.slice(6)}(经技能工具加载后按其指引执行)。`)
    } else if (entry.startsWith('doc:')) {
      const text = ctx.readDoc?.(entry.slice(4))
      if (text) lines.push(text.length > DOC_TRUNCATE ? `${text.slice(0, DOC_TRUNCATE)}\n...(已截断)` : text)
    }
  }
  return lines.length > 1 ? lines : []
}

// 批次指令;ctx: {state, request, inputs, step, inst, injectMessages, queuedMessages, redo, readDoc}
export function buildPrompt(ctx) {
  const { step, inst } = ctx
  const phCtx = {
    request: ctx.request, inputs: ctx.inputs, state: ctx.state,
    item: inst?.item, index: inst?.index, carry: inst?.carry, selfId: step.id,
  }
  const lines = [`[任务]`, resolvePlaceholders(step.prompt, phCtx)]
  lines.push(...outputsSection(step))
  lines.push(...loadSection(step, ctx))
  if (ctx.queuedMessages?.length) {
    lines.push('[用户补充]', ...ctx.queuedMessages.map((m) => `- ${m}`))
  }
  if (ctx.injectMessages?.length) {
    lines.push('[运行中用户消息]', ...ctx.injectMessages.map((m) => `- ${m}`))
  }
  if (ctx.redo) {
    lines.push('[重做说明]', `上一轮产出被驳回,审批意见:${ctx.redo.comments || '(无补充说明)'}`, `上一轮产出:`, ctx.redo.prevOutputs ?? '(无)')
  }
  return lines.join('\n')
}

export function schemaOf(step) {
  return stepTypeOf(step) === 'approve' ? VERDICT_SCHEMA : buildSchema(step)
}
