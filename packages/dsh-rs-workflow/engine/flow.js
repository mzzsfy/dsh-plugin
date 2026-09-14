// ── rs-workflow 通用流程解释器 v1(强流程) ─────────────────────────────────
// 由宿主 takeover 行经 workflowEngine.start 调用,脚本由插件自带,模型不经手:
//   args = {
//     flow:      <当前流程定义(已过 lib/flows.mjs 校验)>,
//     flows:     { <流程id>: <定义> },           // 动态路由目标全集(collab 内置条目不可作子流程)
//     resources: { "<scheme>:<引用>": "<全文>" }, // 宿主已解析的 load 资源
//     request:   <用户需求原文>,
//     slots:     <16 工作位绑定(细分位→基础位→会话默认降级)>,
//     budgets:   { reviewRejectBeforeEscalate, emptyOutputRetryLimit },
//     depth:     <嵌套深度,1 起>,
//     flowStack: <流程 id 栈,环检测>,
//     input:     <父流程经步骤 input 显式传入的参数>,
//   }
// 只用 agent / parallel / phase / log 钩子;无 fs / network / timer / Node API。
//
// 强流程语义(弱模型补偿,提示词口径对齐原版 rs-tui):
//   - 每步一条自包含指令(指令模板 + 资源全文 + 上游产出注入),子代理回复末尾必须
//     携带 <output name="..."> 产出块;缺块 → 附格式示例教学重问(不烧失败账),
//     重问预算耗尽 → 步骤失败;调用失败 → 烧失败账,原地重试换模型(候选游标轮换),
//     失败账达 maxFail(缺省 reviewRejectBeforeEscalate)→ 流程 blocked
//   - 调度 = 拓扑就绪:after 全 done 即就绪,就绪步骤并行发车(并发受 agent 上限约束)
//   - for_each:sequential 实例链式(上一实例产出对下一实例可见,循环携带),
//     parallel 实例独立并行;实例指令注入 {item} {item.index}
//   - type=flow:递归解释执行子流程(深度上限 3 / id 栈环检测),子流程产出扁平为
//     "<子步骤id>.<产出名>" 挂到本步骤产出,下游以 {stepId.子步骤id.产出名} 直引
//
// 返回: { ok, flowId, steps: [{id, status, outputs}], blocked?, error? }

const A = args || {}

// ── 解释器主体(递归入口,子流程经本函数重入;全部状态为调用局部) ─────────────
async function runFlow(flow, runArgs) {
  const REGISTRY = (runArgs.flows && typeof runArgs.flows === 'object') ? runArgs.flows : {}
  const RESOURCES = (runArgs.resources && typeof runArgs.resources === 'object') ? runArgs.resources : {}
  const SLOTS = (runArgs.slots && typeof runArgs.slots === 'object' && !Array.isArray(runArgs.slots)) ? runArgs.slots : {}
  const BUDGETS_SRC = (runArgs.budgets && typeof runArgs.budgets === 'object') ? runArgs.budgets : {}
  const REQUEST = String(runArgs.request || '')
  const DEPTH = Math.max(1, Math.floor(Number(runArgs.depth) || 1))
  const FLOW_STACK = Array.isArray(runArgs.flowStack) ? runArgs.flowStack : []
  const INPUT = (runArgs.input && typeof runArgs.input === 'object') ? runArgs.input : {}

  if (!flow || !Array.isArray(flow.steps) || flow.steps.length === 0) {
    return { ok: false, error: '流程定义缺失或无步骤' }
  }
  if (FLOW_STACK.includes(flow.id)) {
    return { ok: false, error: '流程环调用: ' + FLOW_STACK.concat(flow.id).join(' → ') }
  }
  if (DEPTH > MAX_FLOW_DEPTH) {
    return { ok: false, error: '嵌套深度超过上限 ' + MAX_FLOW_DEPTH + ': ' + FLOW_STACK.concat(flow.id).join(' → ') }
  }

  // ── 预算(与 lib schema 口径一致,引擎侧自保 clamp) ───────────────────────
  function clampBudget(name, dflt) {
    const raw = BUDGETS_SRC[name]
    if (raw === undefined || raw === null) return dflt
    const n = Math.floor(Number(raw))
    if (!isFinite(n)) return dflt
    return Math.min(10, Math.max(1, n))
  }
  const STEP_FAIL_RETRY = clampBudget('reviewRejectBeforeEscalate', 2)
  const REASK_LIMIT = clampBudget('emptyOutputRetryLimit', 3)

  // ── 产出契约解析(容错块解析,口径同 collab 引擎) ──────────────────────────
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
  function parseOutputs(text, names) {
    const values = {}
    const missing = []
    for (const name of names) {
      const re = new RegExp('<output\\s+name\\s*=\\s*["\']' + escapeRe(name) + '["\'][^>]*>([\\s\\S]*?)</output\\s*>', 'gi')
      let last = null
      for (const m of String(text).matchAll(re)) last = m[1]
      // 块存在即产出(显式空串合法,如分诊未命中路由);块不存在才是缺失
      if (last === null) missing.push(name)
      else values[name] = last.trim()
    }
    return { values: values, missing: missing }
  }
  // 列表产出解析:<item> 块优先,其次行首 "N." / "N、" / "-" / "*" 条目
  function parseListItems(body) {
    const items = []
    for (const m of String(body).matchAll(/<item\s*>([\s\S]*?)<\/item\s*>/gi)) {
      if (m[1].trim() !== '') items.push(m[1].trim())
    }
    if (items.length > 0) return items
    for (const line of String(body).split(/\r?\n/)) {
      const m = line.match(/^\s*(?:\d+\s*[.、)]\s*|[-*]\s+)(.+)$/)
      if (m && m[1].trim() !== '') items.push(m[1].trim())
    }
    return items
  }

  // ── 占位符解析:{request} {input.x} {item} {item.index} {stepId.outputName} ─
  // 未满足引用 = 上游失败/定义错误 → 中止(强流程不猜);
  // 唯一豁免:sequential for_each 实例引用自身产出,首实例解析为空串(循环携带起点)
  function resolveText(text, ctx) {
    return String(text).replace(/\{([a-zA-Z0-9_.-]+)\}/g, function (whole, path) {
      if (path === 'request') return REQUEST
      if (path === 'item') return ctx.item === null ? '' : String(ctx.item)
      if (path === 'item.index') return ctx.itemIndex === null ? '' : String(ctx.itemIndex)
      if (path.indexOf('input.') === 0) {
        const key = path.slice('input.'.length)
        if (!(key in ctx.input)) throw new Error('[' + flow.id + '] 占位符 {' + path + '} 无传入值(父流程步骤 input 未提供)')
        return String(ctx.input[key])
      }
      const dot = path.indexOf('.')
      if (dot > 0) {
        const stepId = path.slice(0, dot)
        const outName = path.slice(dot + 1)
        const produced = ctx.produced[stepId]
        if (produced && outName in produced) return String(produced[outName])
        if (ctx.selfId === stepId) return ''
        throw new Error('[' + flow.id + '] 占位符 {' + path + '} 引用不可用(上游 ' + stepId + ' 未产出 ' + outName + ')')
      }
      throw new Error('[' + flow.id + '] 占位符 {' + path + '} 无法解析(合法形态: {request} {item} {item.index} {input.x} {stepId.outputName})')
    })
  }

  // ── 模型工作位解析(细分位→基础位→会话默认;候选游标轮换,重试换模型) ────────
  const SLOT_CURSORS = new Map()
  function resolveModel(slot) {
    let cursor = slot || 'executor'
    const seen = new Set()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const raw = SLOTS[cursor]
      if (raw !== undefined && raw !== null && raw !== '') {
        let candidates = []
        if (typeof raw === 'string') candidates = [raw]
        else if (Array.isArray(raw)) candidates = raw.filter(function (x) { return typeof x === 'string' && x !== '' })
        else if (typeof raw === 'object' && Array.isArray(raw.rotation)) candidates = raw.rotation.filter(function (x) { return typeof x === 'string' && x !== '' })
        if (candidates.length > 0) {
          const idx = SLOT_CURSORS.get(cursor) || 0
          SLOT_CURSORS.set(cursor, idx + 1)
          return candidates[idx % candidates.length]
        }
      }
      cursor = cursor.indexOf('-') > 0 ? cursor.slice(0, cursor.indexOf('-')) : null
    }
    return null // 会话默认模型
  }

  // ── 步骤级状态与拓扑(缺省链式:无 after 的步骤依赖文档序前一步,与 lib 校验同构) ──
  function normalizeChaining(steps) {
    return steps.map(function (step, i) {
      const after = step.after === undefined ? (i > 0 ? [steps[i - 1].id] : []) : step.after
      return { step: step, after: after }
    })
  }
  function topoOrder(entries) {
    const indegree = new Map(entries.map(function (e) { return [e.step.id, 0] }))
    for (const e of entries) {
      for (const ref of e.after) {
        if (indegree.has(ref)) indegree.set(e.step.id, indegree.get(e.step.id) + 1)
      }
    }
    const order = []
    const queue = entries.filter(function (e) { return indegree.get(e.step.id) === 0 }).map(function (e) { return e.step.id })
    const emitted = new Set()
    while (queue.length) {
      const id = queue.shift()
      if (emitted.has(id)) continue
      emitted.add(id)
      order.push(id)
      for (const e of entries) {
        if (e.after.includes(id)) {
          indegree.set(e.step.id, indegree.get(e.step.id) - 1)
          if (indegree.get(e.step.id) === 0) queue.push(e.step.id)
        }
      }
    }
    return order
  }
  const CHAINED = normalizeChaining(flow.steps)
  const ORDER = topoOrder(CHAINED)
  if (ORDER.length !== flow.steps.length) return { ok: false, error: '[' + flow.id + '] 步骤依赖环(宿主校验应已拦截,引擎自保)' }
  const AFTER_OF = new Map(CHAINED.map(function (e) { return [e.step.id, e.after] }))
  const BY_ID = new Map(flow.steps.map(function (s) { return [s.id, s] }))
  const RANK = new Map(ORDER.map(function (id, i) { return [id, i] }))

  const ledger = new Map()
  for (const s of flow.steps) ledger.set(s.id, { status: 'pending', outputs: {}, failCount: 0 })
  const outputsDoc = {}
  for (const s of flow.steps) {
    if (s.outputs && typeof s.outputs === 'object') {
      for (const name of Object.keys(s.outputs)) outputsDoc[name] = s.outputs[name]
    }
  }

  function clip(text, limit) {
    const s = String(text)
    const ELLIPSIS = '...[已压缩]'
    return s.length <= limit ? s : s.slice(0, limit - ELLIPSIS.length) + ELLIPSIS
  }
  const RESOURCE_CHARS = 16 * 1000
  function resourceSection(refs) {
    const used = (refs || []).filter(function (r) { return typeof RESOURCES[r] === 'string' })
    if (used.length === 0) return ''
    return used.map(function (r) {
      return '[参考资料: ' + r + ']\n' + clip(RESOURCES[r], RESOURCE_CHARS)
    }).join('\n\n')
  }

  // 步骤指令组装(指令模板 + 资源全文 + 直接前驱产出注入 + 产出要求)
  function buildInstruction(step, ctx) {
    const parts = [resolveText(step.prompt, ctx)]
    const refs = resourceSection(step.load)
    if (refs) parts.push(refs)
    const upstream = []
    for (const ref of AFTER_OF.get(step.id)) {
      const produced = ctx.produced[ref]
      if (!produced) continue
      const lines = Object.keys(produced).map(function (k) { return '- ' + k + ': ' + clip(produced[k], 2000) })
      if (lines.length) upstream.push('[' + ref + ' 产出]\n' + lines.join('\n'))
    }
    if (upstream.length) parts.push(upstream.join('\n\n'))
    const contract = Object.keys(step.outputs || {})
    if (contract.length > 0) {
      parts.push('[产出要求] 完成后,在回复末尾原样输出以下产出块(块外可保留论述,块名不可改动):\n' +
        contract.map(function (name) {
          return '<output name="' + name + '">' + (outputsDoc[name] || '') + '</output>'
        }).join('\n'))
    }
    return parts.join('\n\n')
  }

  function reaskNote(contract, missing, attempt) {
    return '\n【产出格式重申】上一轮回复缺少有效产出块(' + missing.join(', ') + ')。请在回复末尾原样输出以下产出块:\n' +
      contract.map(function (name) {
        return '<output name="' + name + '">' + (outputsDoc[name] || '') + '</output>'
      }).join('\n') + '\n(教学重问 ' + attempt + '/' + REASK_LIMIT + ',预算耗尽本步骤记失败)'
  }

  async function callAgent(instruction, slot, label) {
    const model = resolveModel(slot)
    const opts = { label: label }
    if (model) {
      const at = model.indexOf('/')
      if (at > 0) { opts.provider = model.slice(0, at); opts.model = model.slice(at + 1) }
      else opts.model = model
    }
    try {
      const out = await agent(instruction, opts)
      return { text: typeof out === 'string' ? out : String(out), failed: false }
    } catch (err) {
      log('[' + flow.id + '] 子代理调用失败(' + label + '): ' + (err && err.message ? err.message : String(err)))
      return { text: '', failed: true }
    }
  }

  // 单实例执行:一轮循环内同时计失败账(调用失败)与重问账(产出缺失),双预算封顶
  async function runInstance(step, ctxInst, labelSuffix) {
    const contract = Object.keys(step.outputs || {})
    const maxFail = step.maxFail || STEP_FAIL_RETRY
    let failCount = 0
    let reasks = 0
    let attempt = 0
    ctxInst._lastMissing = null
    while (attempt <= maxFail + REASK_LIMIT) {
      attempt++
      const retryMark = attempt > 1 ? '(第' + attempt + '次)' : ''
      const label = step.id + labelSuffix + (step.label ? ' ' + step.label : '') + retryMark
      let instruction = buildInstruction(step, ctxInst)
      if (ctxInst._lastMissing) {
        instruction += reaskNote(contract, ctxInst._lastMissing, reasks)
      }
      const res = await callAgent(instruction, step.slot || 'executor', label)
      if (res.failed) {
        failCount++
        if (failCount > maxFail) return null
        continue
      }
      if (contract.length === 0) return {}
      const parsed = parseOutputs(res.text, contract)
      if (parsed.missing.length === 0) return parsed.values
      reasks++
      if (reasks > REASK_LIMIT) return null
      ctxInst._lastMissing = parsed.missing
    }
    return null
  }

  // 步骤执行(ai / flow)
  async function runStep(step, ctx) {
    const rec = ledger.get(step.id)
    rec.status = 'running'
    if (step.type === 'flow') return runSubflow(step, ctx)
    return runAiStep(step, ctx)
  }

  async function runAiStep(step, ctx) {
    const rec = ledger.get(step.id)
    // for_each 实例展开
    let instances = [{ item: null, index: null }]
    if (step.for_each) {
      const dot = step.for_each.indexOf('.')
      const items = forEachItems(step.for_each.slice(0, dot), step.for_each.slice(dot + 1))
      if (items === null || items.length === 0) {
        log('[' + flow.id + '] 步骤 ' + step.id + ' 的循环数据源 ' + step.for_each + ' 无列表项,流程中止')
        rec.status = 'blocked'
        return 'blocked'
      }
      instances = items.map(function (item, i) { return { item: item, index: i + 1 } })
      log('[' + flow.id + '] 步骤 ' + step.id + ' 展开 ' + instances.length + ' 个循环实例(' + (step.mode === 'parallel' ? '并行' : '串行') + ')')
    }
    const parallel = step.for_each && step.mode === 'parallel'
    phase(flow.label + ' · ' + (step.label || step.id))
    if (parallel) {
      const settled = await parallel(instances.map(function (inst) {
        return function () {
          const ctxInst = makeCtx(ctx, step, inst)
          return runInstance(step, ctxInst, ' #' + inst.index).then(function (outs) { return { inst: inst, outs: outs } })
        }
      }))
      const merged = {}
      let ok = true
      for (const r of settled) {
        if (!r || !r.outs) { ok = false; continue }
        mergeInstanceOutputs(step, merged, r.outs)
      }
      if (!ok) { rec.status = 'failed'; rec.failReason = '并行实例存在失败'; return 'failed' }
      rec.outputs = merged
      ctx.produced[step.id] = merged
      rec.status = 'done'
      return 'done'
    }
    // sequential(含非循环步骤的单实例)
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]
      const ctxInst = makeCtx(ctx, step, inst)
      const outs = await runInstance(step, ctxInst, inst.index === null ? '' : ' #' + inst.index)
      if (outs === null) {
        rec.status = 'failed'
        rec.failReason = '重试与重问预算耗尽' + (inst.index === null ? '' : '(实例#' + inst.index + ')')
        log('[' + flow.id + '] 步骤 ' + step.id + (inst.index === null ? '' : ' 实例#' + inst.index) + ' 重试与重问预算耗尽,流程中止')
        return 'failed'
      }
      // sequential: 实例产出即步骤产出(下一实例 {stepId.out} 循环携带本实例产出)
      rec.outputs = outs
      ctx.produced[step.id] = outs
    }
    rec.status = 'done'
    return 'done'
  }

  function makeCtx(ctx, step, inst) {
    return {
      produced: ctx.produced,
      input: ctx.input,
      item: inst ? inst.item : null,
      itemIndex: inst ? inst.index : null,
      selfId: step.for_each ? step.id : null,
    }
  }
  function mergeInstanceOutputs(step, merged, outs) {
    for (const [k, v] of Object.entries(outs)) {
      const isList = Array.isArray(step.listOutputs) && step.listOutputs.includes(k)
      if (isList) merged[k] = k in merged ? merged[k] + '\n' + v : v
      else if (!(k in merged)) merged[k] = v
    }
  }

  function forEachItems(stepId, outName) {
    const src = ledger.get(stepId)
    if (!src || src.status !== 'done') return null
    const body = src.outputs ? src.outputs[outName] : null
    if (typeof body !== 'string') return null
    return parseListItems(body)
  }

  // 嵌套子流程:动态路由 + input 显式传参 + 递归
  async function runSubflow(step, ctx) {
    const rec = ledger.get(step.id)
    let flowId = step.flow
    const dynamic = step.flow.startsWith('{') && step.flow.endsWith('}') && (String(step.flow).match(/\{/g) || []).length === 1
    if (dynamic) {
      flowId = String(resolveText(step.flow, ctx)).trim()
      if (!flowId) {
        log('[' + flow.id + '] 子流程路由 ' + step.flow + ' 解析为空,步骤 ' + step.id + ' 按完成处理(分诊未选中目标)')
        rec.outputs = {}
        ctx.produced[step.id] = {}
        rec.status = 'done'
        return 'done'
      }
    }
    const target = REGISTRY[flowId]
    if (!target) {
      log('[' + flow.id + '] 子流程 "' + flowId + '" 不在流程集内,步骤 ' + step.id + ' 失败')
      rec.status = 'failed'
      rec.failReason = '子流程 "' + flowId + '" 不在流程集内'
      return 'failed'
    }
    if (target.kind === 'collab') {
      log('[' + flow.id + '] 内置协作模板不可作嵌套子流程,步骤 ' + step.id + ' 失败')
      rec.status = 'failed'
      rec.failReason = '内置协作模板不可作嵌套子流程'
      return 'failed'
    }
    const input = {}
    for (const [k, v] of Object.entries(step.input || {})) input[k] = resolveText(String(v), ctx)
    const sub = await runFlow(target, {
      request: REQUEST,
      slots: SLOTS,
      budgets: BUDGETS_SRC,
      resources: RESOURCES,
      flows: REGISTRY,
      depth: DEPTH + 1,
      flowStack: FLOW_STACK.concat([flow.id]),
      input: input,
    })
    if (!sub || !sub.ok) {
      const reason = sub && sub.blocked && sub.blocked.reason ? sub.blocked.reason : (sub && sub.error ? sub.error : '子流程受阻')
      log('[' + flow.id + '] 子流程 "' + flowId + '" 未完成: ' + reason)
      rec.status = 'failed'
      rec.failReason = '子流程 "' + flowId + '" 未完成: ' + reason
      return 'failed'
    }
    // 子流程产出扁平挂载: {stepId.子步骤id.产出名}
    const flat = {}
    for (const item of sub.steps || []) {
      if (item.outputs) {
        for (const [k, v] of Object.entries(item.outputs)) flat[item.id + '.' + k] = v
      }
    }
    rec.outputs = flat
    ctx.produced[step.id] = flat
    rec.status = 'done'
    return 'done'
  }

  // ── 调度主循环:就绪集合逐轮并行发车(所有产出状态收敛于 ledger/produced) ────
  // 步骤异常不被 parallel 吞噬:当场记 failed,后续步骤依 skipped 传播不再执行
  const ctx = { produced: {}, input: INPUT }
  const stepResults = []
  while (true) {
    const ready = []
    for (const id of ORDER) {
      if (ledger.get(id).status !== 'pending') continue
      const step = BY_ID.get(id)
      const depStates = AFTER_OF.get(step.id).map(function (ref) { return ledger.get(ref).status })
      const depsDone = depStates.every(function (st) { return st === 'done' })
      const depDead = depStates.some(function (st) { return ['failed', 'blocked', 'skipped'].includes(st) })
      // for_each 数据源就绪但列表为空在步骤内判 blocked;数据源未 done 不就绪
      if (depDead) {
        ledger.get(id).status = 'skipped'
        continue
      }
      if (depsDone) ready.push(step)
    }
    if (ready.length === 0) break
    await parallel(ready.map(function (step) {
      return function () {
        return runStep(step, ctx).then(function (status) {
          log('[' + flow.id + '] 步骤 ' + step.id + ' → ' + status)
        }, function (error) {
          const rec = ledger.get(step.id)
          rec.status = 'failed'
          rec.failReason = '步骤异常: ' + String(error && error.message ? error.message : error)
          log('[' + flow.id + '] 步骤 ' + step.id + ' 异常: ' + rec.failReason)
        })
      }
    }))
  }
  for (const s of flow.steps) {
    const rec = ledger.get(s.id)
    stepResults.push({ id: s.id, label: s.label || '', status: rec.status, outputs: rec.outputs, failCount: rec.failCount })
  }
  // 未收敛兜底:任何步骤停在 pending/running 即流程不可宣称成功
  const unsettled = stepResults.find(function (r) { return r.status === 'pending' || r.status === 'running' })
  if (unsettled) {
    return { ok: false, flowId: flow.id, steps: stepResults, blocked: { stepId: unsettled.id, reason: '步骤未执行(unsettled): ' + unsettled.status } }
  }
  const blocked = stepResults.find(function (r) { return r.status === 'blocked' })
  const failed = stepResults.find(function (r) { return r.status === 'failed' })
  if (failed) {
    const rec = ledger.get(failed.id)
    return { ok: false, flowId: flow.id, steps: stepResults, blocked: { stepId: failed.id, reason: rec.failReason || '步骤失败,预算耗尽' } }
  }
  if (blocked) {
    return { ok: false, flowId: flow.id, steps: stepResults, blocked: { stepId: blocked.id, reason: '循环数据源为空/流程受阻' } }
  }
  return { ok: true, flowId: flow.id, steps: stepResults }
}

const MAX_FLOW_DEPTH = 3

if (!A.flow) throw new Error('rs-workflow: args.flow 缺失')
return await runFlow(A.flow, A)
