// planner-gate — 规划校验闸(v5 新增,纯函数):校验主模型 PLAN_SCHEMA 提交并生成 run 执行剧本
// 契约源 docs/rsww-v5/feat/planner-gate.md;错误/警告形态 [{ target, message }],与 template-save 一致

const err = (target, message) => ({ target, message })
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
const PLACEHOLDER_RE = /\{([^{}]+)\}/g

// 模板直接依赖表:显式 after;缺省 = 文档序前一步;升级步(onExhausted 目标)脱离常规图无缺省边
export function templateDeps(parsed) {
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : []
  const byId = new Map(steps.filter((s) => isObj(s) && typeof s.id === 'string').map((s) => [s.id, s]))
  const escalateOnly = new Set()
  for (const s of steps) {
    if (isObj(s) && s.type === 'approve' && typeof s.onExhausted === 'string' && s.onExhausted !== 'blocked' && byId.has(s.onExhausted)) {
      escalateOnly.add(s.onExhausted)
    }
  }
  const order = steps.map((s, i) => (isObj(s) && typeof s.id === 'string' ? s.id : `#${i}`))
  const deps = new Map()
  steps.forEach((s, i) => {
    if (!isObj(s) || typeof s.id !== 'string') return
    let d
    if (Array.isArray(s.after)) d = s.after
    else if (escalateOnly.has(s.id) || i === 0) d = []
    else {
      // 缺省边依赖文档序最近的前一个常规步骤:升级步仅审批耗尽可达,常规步不得依赖它
      let j = i - 1
      while (j >= 0 && escalateOnly.has(order[j])) j--
      d = j >= 0 ? [order[j]] : []
    }
    deps.set(s.id, d.filter((x) => byId.has(x) && x !== s.id))
  })
  return { deps, byId, order, escalateOnly }
}

// 压缩依赖:被裁剪步骤的依赖按传递闭包穿透( kept→自身;pruned→其压缩依赖集 )
function compressed(depsOf, id, kept) {
  if (kept.has(id)) return [id]
  const out = []
  for (const d of depsOf.get(id) ?? []) out.push(...compressed(depsOf, d, kept))
  return out
}

const dedup = (arr) => [...new Set(arr)]

// 占位符引用的步骤集(prompt/input/flow 中的 {stepId.out})
function referencedSteps(step) {
  const texts = []
  if (typeof step.prompt === 'string') texts.push(step.prompt)
  if (isObj(step.input)) texts.push(...Object.values(step.input).filter((v) => typeof v === 'string'))
  if (typeof step.flow === 'string') texts.push(step.flow)
  const refs = new Set()
  for (const text of texts) {
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      const ph = m[1]
      if (ph === 'request' || ph === 'item' || ph === 'item.index' || ph.startsWith('input.')) continue
      const dot = ph.indexOf('.')
      if (dot > 0) refs.add(ph.slice(0, dot))
    }
  }
  return refs
}

// 主入口:gate(plan, template, expected)
// plan = orchestrator 组装后的 PLAN_SCHEMA(request/templateId/inputs 顶层注入;brief/steps 来自 plan 工具参数)
// 显式 plan = plan 工具参数含 steps/brief 任一字段;plan 缺省(或空对象)→ 保底全序
export function gate(plan, template, expected) {
  const explicit = plan != null && (plan.steps !== undefined || plan.brief !== undefined)
  const stepsIn = explicit && Array.isArray(plan.steps) ? plan.steps : []
  const templateId = plan != null && typeof plan.templateId === 'string' ? plan.templateId : (typeof expected?.expectedTemplateId === 'string' ? expected.expectedTemplateId : '')
  const inputs = plan != null && isObj(plan.inputs) ? plan.inputs : {}

  // #1 模板存在且 enabled(失败即短路:后续规则全部依赖模板)
  if (templateId === '' || !isObj(template) || !isObj(template.entry) || template.entry.id !== templateId) {
    return { ok: false, errors: [err('templateId', `模板不存在: ${templateId}`)] }
  }
  if (template.entry.enabled === false) {
    return { ok: false, errors: [err('templateId', `模板已禁用: ${templateId}`)] }
  }
  const parsed = isObj(template.parsed) ? template.parsed : { steps: [] }
  const { deps: depsOf, byId, escalateOnly } = templateDeps(parsed)

  const errors = []
  const warnings = []

  // #1b 组合锚定
  if (typeof expected?.expectedTemplateId === 'string' && expected.expectedTemplateId !== '' && templateId !== expected.expectedTemplateId) {
    errors.push(err('templateId', `与本组合锚定模板不符: ${templateId}`))
  }

  const kept = new Set()
  const indexOf = new Map()
  if (explicit) {
    // #2 steps 非空
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      errors.push(err('steps', '至少保留一个步骤'))
    } else {
      plan.steps.forEach((entry, i) => {
        const ref = isObj(entry) ? entry.ref : entry
        if (typeof ref !== 'string' || !byId.has(ref)) {
          errors.push(err(`steps[${i}].ref`, `未知步骤: ${typeof ref === 'string' ? ref : JSON.stringify(ref) ?? ref}`))
          return
        }
        if (kept.has(ref)) {
          errors.push(err(`steps[${i}].ref`, `步骤重复: ${ref}`))
          return
        }
        kept.add(ref)
        indexOf.set(ref, i)
      })
    }
  }

  const tStepOf = (id) => byId.get(id)

  if (kept.size > 0) {
    // #5 子序列拓扑:顺序颠倒 / 审批目标与 for_each 数据源被裁 / 占位符引用被裁步
    for (const id of kept) {
      const s = tStepOf(id)
      for (const d of depsOf.get(id) ?? []) {
        if (kept.has(d)) {
          if ((indexOf.get(d) ?? 0) > (indexOf.get(id) ?? 0)) {
            errors.push(err('steps', `裁剪破坏依赖: ${id} 依赖 ${d},但顺序颠倒`))
          }
        }
      }
      if (s.type === 'approve' && typeof s.target === 'string' && !kept.has(s.target)) {
        errors.push(err('steps', `approve 目标不在剧本: ${s.target}(审批步 ${id} 不可裁剪其裁决对象)`))
      } else if (s.type === 'approve' && typeof s.target === 'string' && (indexOf.get(s.target) ?? Infinity) > (indexOf.get(id) ?? 0)) {
        errors.push(err('steps', `裁剪破坏依赖: ${id} 依赖 ${s.target},但顺序颠倒`))
      }
      if (typeof s.for_each === 'string') {
        const src = s.for_each.split('.')[0]
        if (!kept.has(src)) errors.push(err('steps', `for_each 数据源不在剧本: ${src}`))
      }
      for (const ref of referencedSteps(s)) {
        if (!kept.has(ref)) errors.push(err('steps', `裁剪破坏依赖: ${id} 依赖 ${ref},但 ${ref} 不在剧本中`))
      }
      // w1 审批耗尽出口被裁
      if (s.type === 'approve' && typeof s.onExhausted === 'string' && s.onExhausted !== 'blocked' && !kept.has(s.onExhausted)) {
        warnings.push(err('steps', `审批步 ${id} 的耗尽出口 ${s.onExhausted} 不在剧本,耗尽兜底降级为 blocked`))
      }
    }

    // 僵尸升级步:保留升级步但其审批步被裁——永不就绪且 run 会误判 completed
    for (const id of kept) {
      if (!escalateOnly.has(id)) continue
      const guarded = [...kept].some((k) => { const st = byId.get(k); return st?.type === 'approve' && st.onExhausted === id })
      if (!guarded) errors.push(err('steps', `升级步 ${id} 保留但其审批步不在剧本:升级步须与审批步同裁同留`))
    }
  }

  if (explicit && stepsIn.length > 0) {
    // #6 note/done 非空
    stepsIn.forEach((entry, i) => {
      const ref = isObj(entry) ? entry.ref : entry
      if (typeof ref !== 'string' || !kept.has(ref)) return
      if (!nonEmpty(isObj(entry) ? entry.note : undefined)) errors.push(err(`steps[${i}].note`, `步骤 ${ref} 的执行要点为空`))
      if (!nonEmpty(isObj(entry) ? entry.done : undefined)) errors.push(err(`steps[${i}].done`, `步骤 ${ref} 的验收口径为空`))
    })
  }

  // #7 inputs 键 ⊆ 模板声明,值必须为字符串
  const declared = isObj(parsed.inputs) ? parsed.inputs : {}
  for (const [k, v] of Object.entries(inputs)) {
    if (!Object.hasOwn(declared, k)) errors.push(err(`inputs.${k}`, `未声明的入参: ${k}`))
    else if (typeof v !== 'string') errors.push(err(`inputs.${k}`, `入参必须为字符串: ${k}`))
  }

  // #8 显式 plan 时 brief 非空
  if (explicit && !nonEmpty(plan.brief)) errors.push(err('brief', '验收口径为空'))

  if (errors.length > 0) return { ok: false, errors }

  // 剧本生成
  const scriptSteps = explicit
    ? stepsIn.map((entry) => ({ ref: entry.ref, note: typeof entry.note === 'string' ? entry.note : '', done: typeof entry.done === 'string' ? entry.done : '' }))
    : parsed.steps.filter((s) => isObj(s) && typeof s.id === 'string').map((s) => ({ ref: s.id, note: '', done: '' }))
  // 保底路径全序保留:压缩闭包 = 剧本全集(explicit 时 kept 已是剧本)
  if (!explicit) for (const s of scriptSteps) kept.add(s.ref)
  const deps = {}
  for (const s of scriptSteps) {
    deps[s.ref] = dedup((depsOf.get(s.ref) ?? []).flatMap((d) => compressed(depsOf, d, kept))).filter((d) => d !== s.ref)
  }
  if (!explicit && template.entry.autoApprove === true) {
    warnings.push(err('plan', '保底全序且模板 autoApprove=true:代审将按模板内联口径执行,无任务级验收口径'))
  }
  const brief = explicit ? plan.brief.trim() : (typeof template.entry.description === 'string' ? template.entry.description : '')
  return {
    ok: true,
    planScript: { source: explicit ? 'model' : 'fallback', brief, steps: scriptSteps, deps },
    warnings,
  }
}
