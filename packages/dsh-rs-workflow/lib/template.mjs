// 模板静态校验器:DSL v5 唯一权威(board 保存校验唯一入口);v5 新增顶层 autoApprove 键

export const SLOT_KEYS = ['planner', 'executor', 'reviewer', 'executor-loop', 'reviewer-approve', 'executor-escalate']
const TOP_FIELDS = new Set(['id', 'label', 'description', 'inputs', 'steps', 'autoApprove'])
const STEP_FIELDS = new Set(['id', 'label', 'slot', 'prompt', 'load', 'outputs', 'listOutputs', 'after', 'maxFail', 'for_each', 'mode', 'type', 'flow', 'input', 'target', 'rounds', 'onExhausted'])
const ID_RE = /^[a-z][a-z0-9-]*$/
const INPUT_NAME_RE = /^[a-z][a-zA-Z0-9]*$/
// 保留步骤 id:{input.x} 占位符以入参命名空间优先解析,同 id 步骤产出会被遮蔽
const RESERVED_STEP_IDS = new Set(['input'])
const PLACEHOLDER_RE = /\{([^{}]+)\}/g
const LOAD_PREFIX_RE = /^(skill|doc):/
const MAX_ROUND = 10
const MAX_NEST_DEPTH = 3

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'comments'],
  additionalProperties: false,
  properties: { verdict: { type: 'string', enum: ['APPROVED', 'REJECTED'] }, comments: { type: 'string' } },
}

const err = (target, message) => ({ target, message })
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const placeholdersOf = (text) => [...String(text).matchAll(PLACEHOLDER_RE)].map((m) => m[1])

// JSON 解析;失败抛错,调用方经 parseErrorLine 提取行号
export function parseTemplate(text) {
  return JSON.parse(text)
}

export function parseErrorLine(message) {
  const text = String(message)
  // V8 JSON.parse 形态 "(line 1 column 3)" 与 "3:5" 位置形态双兼容
  const v8 = text.match(/\bline (\d+)\b/)
  if (v8) return Number(v8[1])
  const m = text.match(/(?:^|\s)(\d+):(\d+)(?:\s|$|\))/)
  return m ? Number(m[1]) : null
}

// 单模板校验:结构/字段/引用/环/审批与升级规则;返回 errors[](空=通过)
export function validateTemplate(t) {
  const errors = []
  if (!isObj(t)) return [err('json', '模板必须是对象')]
  for (const k of Object.keys(t)) if (!TOP_FIELDS.has(k)) errors.push(err(`top:${k}`, `未知顶层字段 ${k}`))
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) errors.push(err('top:id', 'id 必填且须匹配 ^[a-z][a-z0-9-]*$'))
  if (typeof t.label !== 'string' || t.label.trim() === '') errors.push(err('top:label', 'label 必填且为非空字符串'))
  if (typeof t.description !== 'string' || t.description.trim() === '') errors.push(err('top:description', 'description 必填且为非空字符串(分诊目录/保底 brief 依据)'))
  if (t.autoApprove !== undefined && typeof t.autoApprove !== 'boolean') errors.push(err('top:autoApprove', 'autoApprove 须为布尔(缺省 false;true = 审批由主循环代审)'))

  const declaredInputs = new Set()
  if (t.inputs !== undefined) {
    if (!isObj(t.inputs)) errors.push(err('top:inputs', 'inputs 须为对象(name: 说明)'))
    else {
      for (const [k, v] of Object.entries(t.inputs)) {
        if (!INPUT_NAME_RE.test(k)) errors.push(err('top:inputs', `入参名 ${k} 须匹配 ${INPUT_NAME_RE.source}`))
        if (typeof v !== 'string') errors.push(err('top:inputs', `入参 ${k} 的说明须为字符串`))
        declaredInputs.add(k)
      }
    }
  }

  if (!Array.isArray(t.steps) || t.steps.length === 0) {
    errors.push(err('top:steps', 'steps 必填且为非空数组'))
    return errors
  }

  const byId = new Map()
  for (const s of t.steps) {
    if (isObj(s) && typeof s.id === 'string') {
      if (byId.has(s.id)) errors.push(err('top:steps', `步骤 id 重复:${s.id}`))
      byId.set(s.id, s)
    }
  }

  // escalate-only 集:被任一 approve 步 onExhausted 指向的步骤;记其审批对象(target)用于产出引用禁令
  const escalateTargetOf = new Map()
  for (const s of t.steps) {
    if (isObj(s) && s.type === 'approve' && typeof s.target === 'string' && typeof s.onExhausted === 'string' && s.onExhausted !== 'blocked' && byId.has(s.onExhausted)) {
      escalateTargetOf.set(s.onExhausted, s.target)
    }
  }

  const order = []
  for (const s of t.steps) {
    const sid = isObj(s) && typeof s.id === 'string' ? s.id : `#${order.length}`
    order.push(sid)
    if (!isObj(s)) {
      errors.push(err('top:steps', `步骤 ${sid} 必须是对象`))
      continue
    }
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) {
      errors.push(err('top:steps', `步骤 id 必填且须匹配 ${ID_RE.source}`))
      continue
    }
    const target = `step:${s.id}`
    if (RESERVED_STEP_IDS.has(s.id)) errors.push(err(target, `步骤 id ${s.id} 为保留字,与子流程入参命名空间冲突`))
    for (const k of Object.keys(s)) if (!STEP_FIELDS.has(k)) errors.push(err(target, `未知步骤字段 ${k}`))
    const type = s.type === undefined ? 'ai' : s.type
    if (!['ai', 'flow', 'approve'].includes(type)) errors.push(err(target, `type 仅支持 ai/flow/approve,得到 ${type}`))

    if (s.slot !== undefined) {
      if (!SLOT_KEYS.includes(s.slot)) errors.push(err(target, `slot 仅六键:${SLOT_KEYS.join('/')}`))
      if (type === 'approve' && s.slot !== 'reviewer-approve') errors.push(err(target, 'approve 步骤 slot 固定 reviewer-approve,不可声明其他值'))
    }
    if (s.label !== undefined && typeof s.label !== 'string') errors.push(err(target, 'label 须为字符串'))
    if (s.maxFail !== undefined && (!Number.isInteger(s.maxFail) || s.maxFail < 1 || s.maxFail > MAX_ROUND)) errors.push(err(target, `maxFail 须为 [1,${MAX_ROUND}] 整数`))

    if (s.outputs !== undefined) {
      if (!isObj(s.outputs)) errors.push(err(target, 'outputs 须为对象(字段名: 说明)'))
      else for (const [k, v] of Object.entries(s.outputs)) {
        if (k.trim() === '') errors.push(err(target, 'outputs 字段名不可为空'))
        if (typeof v !== 'string') errors.push(err(target, `outputs.${k} 的说明须为字符串`))
      }
    }
    const outputNames = new Set(isObj(s.outputs) ? Object.keys(s.outputs) : [])
    if (s.listOutputs !== undefined) {
      if (!Array.isArray(s.listOutputs)) errors.push(err(target, 'listOutputs 须为字符串数组'))
      else for (const n of s.listOutputs) {
        if (!outputNames.has(n)) errors.push(err(target, `listOutputs 项 ${n} 未在本步 outputs 中声明`))
      }
    }
    if (s.load !== undefined) {
      if (!Array.isArray(s.load) || s.load.some((v) => typeof v !== 'string' || !LOAD_PREFIX_RE.test(v))) {
        errors.push(err(target, 'load 须为字符串数组且每项带 skill:/doc: 前缀'))
      }
    }
    if (s.after !== undefined) {
      if (!Array.isArray(s.after) || s.after.some((v) => typeof v !== 'string')) errors.push(err(target, 'after 须为步骤 id 数组'))
      else for (const dep of s.after) {
        if (dep === s.id) errors.push(err(target, 'after 不可引用自身'))
        else if (!byId.has(dep)) errors.push(err(target, `after 引用不存在的步骤 ${dep}`))
      }
    }
    if (s.for_each !== undefined) {
      if (typeof s.for_each !== 'string' || !/^[a-z][a-z0-9-]*\.[a-zA-Z0-9]+$/.test(s.for_each)) {
        errors.push(err(target, 'for_each 须为 "<步骤id>.<产出名>" 形态'))
      } else {
        const [srcId, srcOut] = s.for_each.split('.')
        const src = byId.get(srcId)
        if (!src) errors.push(err(target, `for_each 数据源步骤 ${srcId} 不存在`))
        else if (!(Array.isArray(src.listOutputs) && src.listOutputs.includes(srcOut))) {
          errors.push(err(target, `for_each 数据源 ${s.for_each} 未在该步骤 listOutputs 中声明`))
        }
      }
    }
    if (s.mode !== undefined) {
      if (!['sequential', 'parallel'].includes(s.mode)) errors.push(err(target, 'mode 仅支持 sequential/parallel'))
      if (s.for_each === undefined) errors.push(err(target, 'mode 仅在声明 for_each 时有效'))
    }
    if (s.for_each !== undefined && s.mode === undefined) {
      // sequential 为缺省(spec §8),不必显式声明
      s.mode = 'sequential'
    }

    if (type === 'ai') {
      if (typeof s.prompt !== 'string' || s.prompt.trim() === '') errors.push(err(target, '普通步骤 prompt 必填'))
      if (s.flow !== undefined || s.input !== undefined || s.target !== undefined || s.rounds !== undefined || s.onExhausted !== undefined) {
        errors.push(err(target, '普通步骤不可声明 flow/input/target/rounds/onExhausted'))
      }
      if (!isObj(s.outputs) || outputNames.size === 0) errors.push(err(target, '普通步骤必须以 outputs 声明产出契约'))
    }
    if (type === 'approve') {
      if (typeof s.prompt !== 'string' || s.prompt.trim() === '') errors.push(err(target, 'approve 步骤 prompt(审批口径)必填'))
      if (s.outputs !== undefined || s.listOutputs !== undefined) errors.push(err(target, 'approve 步骤裁决契约由引擎生成,不可声明 outputs/listOutputs'))
      if (s.for_each !== undefined || s.mode !== undefined) errors.push(err(target, 'approve 步骤不支持 for_each/mode'))
      if (typeof s.target !== 'string' || !byId.has(s.target)) errors.push(err(target, 'approve 步骤 target 必填且须指向存在步骤'))
      else if (s.target === s.id) errors.push(err(target, 'approve 步骤 target 不可为自身'))
      if (s.rounds !== undefined && (!Number.isInteger(s.rounds) || s.rounds < 1 || s.rounds > MAX_ROUND)) errors.push(err(target, `rounds 须为 [1,${MAX_ROUND}] 整数`))
      if (s.onExhausted !== undefined && s.onExhausted !== 'blocked' && !byId.has(s.onExhausted)) {
        errors.push(err(target, `onExhausted 须为 "blocked" 或存在步骤 id,得到 ${s.onExhausted}`))
      }
    }
    if (type === 'flow') {
      if (s.prompt !== undefined) errors.push(err(target, 'flow 步骤不派发子代理,不可声明 prompt'))
      if (s.outputs !== undefined || s.listOutputs !== undefined) errors.push(err(target, 'flow 步骤产出由子流程扁平挂载,不可声明 outputs/listOutputs'))
      if (s.load !== undefined || s.for_each !== undefined || s.mode !== undefined) errors.push(err(target, 'flow 步骤不支持 load/for_each/mode'))
      if (typeof s.flow !== 'string' || s.flow.trim() === '') errors.push(err(target, 'flow 步骤 flow 必填(模板 id 或 "{步骤id.产出名}" 动态路由)'))
      else if (s.flow.trim() === t.id) errors.push(err(target, '子流程路由不可指向自身'))
      if (s.input !== undefined) {
        if (!isObj(s.input)) errors.push(err(target, 'input 须为对象'))
        else for (const [k, v] of Object.entries(s.input)) {
          if (typeof v !== 'string' || !/^\{[^{}]+\}$/.test(v)) errors.push(err(target, `input.${k} 须为单占位符引用 "{来源}"`))
        }
      }
    }
  }

  // 占位符来源校验(prompt/flow/input 中 {引用} 的存在性与合法性)
  const refOk = (s, ph, target) => {
    if (ph === 'request') return true
    if (ph === 'item' || ph === 'item.index') {
      if (s.for_each === undefined) errors.push(err(target, `占位符 {${ph}} 仅在 for_each 步骤内可用`))
      return
    }
    if (ph.startsWith('input.')) {
      if (!declaredInputs.has(ph.slice(6))) errors.push(err(target, `占位符 {${ph}} 引用未声明的入参`))
      return
    }
    const dot = ph.indexOf('.')
    if (dot <= 0) {
      errors.push(err(target, `占位符 {${ph}} 无合法来源(request/input.<name>/<步骤>.<产出>/item)`))
      return
    }
    const refId = ph.slice(0, dot)
    const refOut = ph.slice(dot + 1)
    const ref = byId.get(refId)
    if (!ref) {
      errors.push(err(target, `占位符 {${ph}} 引用不存在的步骤`))
      return
    }
    if (ref.type === 'approve') {
      errors.push(err(target, `占位符 {${ph}} 不可引用审批步骤产出(裁决不进产出账)`))
      return
    }
    const refOuts = isObj(ref.outputs) ? Object.keys(ref.outputs) : []
    if (!refOuts.includes(refOut)) {
      errors.push(err(target, `占位符 {${ph}} 的产出未在步骤 ${refId} outputs 中声明`))
      return
    }
    if (refId === s.id && !(s.for_each !== undefined && s.mode === 'sequential')) {
      errors.push(err(target, '自引用产出仅 sequential 循环实例可用(首实例解析空串)'))
    }
    const forbid = escalateTargetOf.get(s.id)
    if (forbid !== undefined && refId === forbid) {
      errors.push(err(target, `升级步占位符 {${ph}} 禁止引用审批对象产出(耗尽时已清空),只可引用其上游产出`))
    }
  }
  for (const s of t.steps) {
    if (!isObj(s) || typeof s.id !== 'string') continue
    const target = `step:${s.id}`
    if (typeof s.prompt === 'string') for (const ph of placeholdersOf(s.prompt)) refOk(s, ph, target)
    if (type_flow(s)) {
      const m = /^\{([^{}]+)\}$/.exec(String(s.flow).trim())
      if (m) {
        const ph = m[1]
        if (!ph.includes('.') || ph.startsWith('input.') || ph === 'request' || ph === 'item') {
          errors.push(err(target, `flow 动态路由 {${ph}} 须引用 "<步骤id>.<产出名>"`))
        } else refOk(s, ph, target)
      }
      if (isObj(s.input)) for (const v of Object.values(s.input)) {
        for (const ph of placeholdersOf(v)) refOk(s, ph, target)
      }
    }
  }

  // escalate-only 规则:不参与依赖图(不可声明 after),且不可被其他步骤 after 引用
  for (const s of t.steps) {
    if (!isObj(s) || typeof s.id !== 'string') continue
    if (escalateTargetOf.has(s.id) && s.after !== undefined) {
      errors.push(err(`step:${s.id}`, '升级步由引擎脱离常规调度图,不可声明 after'))
    }
  }
  for (const s of t.steps) {
    if (!isObj(s) || !Array.isArray(s.after)) continue
    for (const dep of s.after) {
      if (escalateTargetOf.has(dep)) errors.push(err(`step:${s.id}`, `after 不可引用升级步 ${dep}(其唯一触发边为审批耗尽)`))
    }
  }

  // 环检测:边 = 显式 after,缺省 = 文档序前一步(escalate-only 无缺省边)
  const depsOf = new Map()
  t.steps.forEach((s, i) => {
    if (!isObj(s) || typeof s.id !== 'string') return
    let deps
    if (Array.isArray(s.after)) deps = s.after
    else if (escalateTargetOf.has(s.id) || i === 0) deps = []
    else deps = [order[i - 1]]
    depsOf.set(s.id, deps.filter((d) => byId.has(d) && d !== s.id))
  })
  const state = new Map()
  const visit = (id, stack) => {
    const st = state.get(id)
    if (st === 'done') return
    if (st === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(' -> ')
      errors.push(err('top:steps', `依赖环:${cycle}`))
      return
    }
    state.set(id, 'visiting')
    for (const d of depsOf.get(id) ?? []) visit(d, [...stack, id])
    state.set(id, 'done')
  }
  for (const id of depsOf.keys()) visit(id, [])

  return errors
}

const type_flow = (s) => (s.type === undefined ? false : s.type === 'flow')

// 集合校验:各模板单独校验 + 字面子流程引用存在性 + 嵌套深度 ≤3;损坏成员跳过不阻塞其余
export function validateTemplateSet(list) {
  const errors = []
  const ok = []
  for (const t of Array.isArray(list) ? list : []) {
    const es = validateTemplate(t)
    errors.push(...es)
    if (es.length === 0) ok.push(t)
  }
  const ids = new Set(ok.map((t) => t.id))
  const tmplEdges = new Map()
  for (const t of ok) {
    const outs = new Set()
    for (const s of t.steps) {
      if (s.type !== 'flow' || typeof s.flow !== 'string') continue
      const literal = s.flow.trim()
      if (/^\{[^{}]+\}$/.test(literal)) continue
      if (!ids.has(literal)) errors.push(err(`step:${s.id}`, `子流程 ${literal} 不存在于模板集合`))
      else if (literal !== t.id) outs.add(literal)
    }
    if (outs.size > 0) tmplEdges.set(t.id, outs)
  }
  const depthOf = (id, seen) => {
    // 环即拒绝:深度无穷,不限于此路径是否重复经过
    if (seen.has(id)) return Infinity
    seen.add(id)
    let d = 1
    for (const n of tmplEdges.get(id) ?? []) d = Math.max(d, 1 + depthOf(n, seen))
    return d
  }
  for (const id of tmplEdges.keys()) {
    if (depthOf(id, new Set()) > MAX_NEST_DEPTH) errors.push(err(`top:id`, `${id} 子流程嵌套深度超过 ${MAX_NEST_DEPTH}`))
  }
  return errors
}

// 产出契约 → structured_output schema(宿主 schema 子集内);approve 步为固定裁决契约
export function buildSchema(step) {
  if (step.type === 'approve') return VERDICT_SCHEMA
  const properties = {}
  const required = []
  const listSet = new Set(Array.isArray(step.listOutputs) ? step.listOutputs : [])
  for (const name of Object.keys(isObj(step.outputs) ? step.outputs : {})) {
    required.push(name)
    properties[name] = listSet.has(name) ? { type: 'array', items: { type: 'string' } } : { type: 'string' }
  }
  return { type: 'object', required, additionalProperties: false, properties }
}
