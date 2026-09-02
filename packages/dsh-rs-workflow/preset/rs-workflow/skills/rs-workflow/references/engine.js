// ── rs-workflow 若水工作流编排脚本 v1 ──────────────────────────────────────
// 由主代理经 workflow 工具调用:
//   script = 本文件全文(原样, 不改写)
//   args   = { request, contextNotes?, slots?, lockedTemplate?, limits?, prefix? }
//     slots 值支持 string|object|array(候选依次故障转移, 被拒重做/重问换模型);
//     prefix 为断点续跑种子 [{id, description, output?, changedFiles?}], 仅
//     lite / plan-final / step-review 生效, multi-plan 忽略并记日志。
// 只用 agent / parallel / phase / log 钩子; 无 fs / network / timer。
// 结构化输出全部经 schema 约束; agent 返回 null 视为该次调用失败。
// 规则语义: 模板由引擎分诊矩阵决定(planner 不自选); 审批 fail-closed(审批者
// 不可用视为拒绝); APPROVED 必须附 evidence(空证据重问一次, 仍空转拒绝);
// 非 overall 审批通过清零升级账; 调度预算按图规模每轮现算。
// 阈值语义见 templates.md: 连续 2 次被拒/失败升级重规划, 重规划 2 次 blocked。

const A = args || {}
const REQ = String(A.request || '').trim()
if (!REQ) throw new Error('rs-workflow: 缺少 request(contextNotes 可空, request 必填)')

const TEMPLATES = ['lite', 'plan-final', 'step-review', 'multi-plan']
const SLOTS = (A.slots && typeof A.slots === 'object' && !Array.isArray(A.slots)) ? A.slots : {}
const LOCKED = TEMPLATES.includes(A.lockedTemplate) ? A.lockedTemplate : ''
const CONTEXT_NOTES = String(A.contextNotes || '').trim()
const LIMITS = (A.limits && typeof A.limits === 'object' && !Array.isArray(A.limits)) ? A.limits : {}

const MAX_TASKS = LIMITS.maxTasks > 0 ? Math.floor(LIMITS.maxTasks) : 8
const REJECT_BEFORE_ESCALATE = 2
const ESCALATION_LIMIT = 2
const MAX_SUBPLANS = 4
const LOOP_BUDGET_BASE = 8
const LOOP_BUDGET_PER_NODE = 3
// 每次升级最多新增的任务数(重规划上限), 供调度预算按升级次数增额
const LOOP_BUDGET_PER_ESCALATION = MAX_TASKS * LOOP_BUDGET_PER_NODE
// 提示词截断长度常量
const DONE_SUMMARY_CHARS = 400
const PLAN_SNIPPET_CHARS = 1500
const EXEC_SUMMARY_CHARS = 800

// 审批契约固定文案: fail-closed 与证据门槛的对外理由
const REVIEWER_UNAVAILABLE_REASON = '审批者不可用(视为拒绝), 可原样重交'
const EVIDENCE_REQUIRED_REASON = '审批缺少验证证据(视为拒绝), 补充证据后可原样重交'
const EVIDENCE_REASK_NOTE = '\n(审批必须附验证证据: evidence 填实际执行的检查命令与结果要点, 否则视为驳回)'
const SUBJECT_OVERALL = 'overall'
const SUBJECT_PLAN = 'plan'
const PLAN_REVIEW_NODE = 'pr'
const PREFIX_ID_MARK = 'x'

// 范围核查与计划审批的提示词强制规则
const SCOPE_RULE = '范围核查(强制规则): 以 git diff / git status 的实际变更为准; 实际变更命中【非本任务范围的申报文件】清单的, 是其他任务/已完成工作, 不算越界; 除此之外未在申报清单中出现且不在豁免清单中的文件 → verdict=REJECTED 并在 reasons 点名越界文件。'
const OVERALL_SCOPE_RULE = '终审范围核查(强制规则): 汇总各任务申报文件的并集, 与全量实际变更比对, 并集之外的文件 → verdict=REJECTED 并在 reasons 点名。'
const PLAN_REVIEW_CRITERIA = '审批基准(计划审批): 计划是否可执行、任务粒度是否均匀且可独立验收、依赖是否成立、并行任务文件是否互斥。'

// ── 工作位候选链: 细分位 → 基础位(前缀) → 会话默认模型; 值支持 string|object|array(依次故障转移) ──
function parseBinding(b) {
  if (!b) return null
  if (typeof b === 'string') {
    const i = b.indexOf('/')
    return i > 0 ? { provider: b.slice(0, i), model: b.slice(i + 1) } : { model: b }
  }
  if (typeof b === 'object') {
    const o = {}
    if (typeof b.provider === 'string' && b.provider) o.provider = b.provider
    if (typeof b.model === 'string' && b.model) o.model = b.model
    return Object.keys(o).length ? o : null
  }
  return null
}
function bindingsOf(v) {
  if (Array.isArray(v)) return v.map(parseBinding).filter(Boolean)
  const o = parseBinding(v)
  return o ? [o] : []
}
function slotOpts(slot) {
  const direct = bindingsOf(SLOTS[slot])
  if (direct.length) return direct
  const base = bindingsOf(SLOTS[String(slot).split('-')[0]])
  if (base.length) return base
  return [{}]
}

// 候选故障转移: 从游标位起依次试候选, 成功后游标指向下一候选(被拒重做/重问即换模型)
async function callAgent(holder, candidates, spec) {
  const list = (candidates && candidates.length) ? candidates : [{}]
  const start = (holder.i || 0) % list.length
  for (let k = 0; k < list.length; k++) {
    const idx = (start + k) % list.length
    const r = await agent(spec.prompt, { label: spec.label, schema: spec.schema, ...(list[idx]) })
    if (r) {
      holder.i = (idx + 1) % list.length
      return r
    }
    log(spec.label + ' 候选调用失败, 切换下一候选')
  }
  holder.i = (start + 1) % list.length
  return null
}

// ── 确定性分诊矩阵: 模板由引擎决定, planner 不做模板选型 ────────────────────
const SIGNAL_LEVELS = ['low', 'medium', 'high']
function normalizeSignal(v) { return SIGNAL_LEVELS.indexOf(v) >= 0 ? v : 'medium' }
function chooseTemplate(signals) {
  const s = signals || {}
  const complexity = normalizeSignal(s.complexity)
  const risk = normalizeSignal(s.risk)
  const scope = normalizeSignal(s.scope)
  if (risk === 'high' || scope === 'high') return 'multi-plan'
  if (complexity === 'high') return 'step-review'
  if (complexity === 'medium' || risk === 'medium') return 'plan-final'
  return 'lite'
}

// ── 规划协议规则(注入 planner 提示词) ────────────────────────────────────────
const TRIAGE_RULES = [
  '难度分诊三信号: complexity(改动面/步骤数) / risk(破坏面与回归风险) / scope(涉及模块与功能数), 各取 low|medium|high。',
  '信号到档位的引擎映射(仅供校准信号): 简单明确→lite; 中等、需先想清再做→plan-final; 多步且质量敏感→step-review; 多功能大型→multi-plan。',
  '只产出三信号与计划; 模板选型由引擎按确定性矩阵完成, 不由你选择。',
].join('\n')

const DECOMP_RULES = [
  '拆解规则: 每个任务是可独立验收的工作单元(自带必要的验证); 粒度均匀, 单任务应能在一个代理会话内完成; 有合并冲突风险的任务必须用 after 声明依赖串行 —— 无依赖关系的任务才会被并行执行, 并行候选必须文件互不相交。',
  '依赖声明: after 列出前置任务 id; 省略 after = 链式接续上一个任务。本规则同样适用于子计划内的任务: 文件互斥的任务可显式 after: [] 并行, 有冲突必须声明依赖。',
  '任务 id 用短标识(t1/t2/...)。任务数不超过 ' + MAX_TASKS + ' 个, 超出说明粒度不对, 合并相近任务。',
].join('\n')

// ── schema(仅用 type/properties/required/items/enum) ────────────────────────
const TASK_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    description: { type: 'string' },
    after: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'description'],
}
const TASKS_FIELD = { type: 'array', items: TASK_ITEM }
const SUBPLAN_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    after: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'description'],
}
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    scope: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasoning: { type: 'string' },
    plan: { type: 'string' },
    tasks: TASKS_FIELD,
    subplans: { type: 'array', items: SUBPLAN_ITEM },
  },
  required: ['complexity', 'risk', 'scope', 'plan', 'tasks'],
}
const EXEC_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'failed'] },
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary'],
}
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
    reasons: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['verdict', 'summary', 'evidence'],
}
const REPLAN_SCHEMA = {
  type: 'object',
  properties: {
    analysis: { type: 'string' },
    tasks: TASKS_FIELD,
  },
  required: ['tasks'],
}
const PLAN_REPLAN_SCHEMA = {
  type: 'object',
  properties: {
    analysis: { type: 'string' },
    plan: { type: 'string' },
    tasks: TASKS_FIELD,
  },
  required: ['plan', 'tasks'],
}
const SUBPLAN_GEN_SCHEMA = {
  type: 'object',
  properties: {
    plan: { type: 'string' },
    tasks: TASKS_FIELD,
  },
  required: ['plan', 'tasks'],
}

// ── 任务表规范化: 补 id / 链式缺省 / 清未知引用 / 破环 / 截断 ────────────────
function normalizeTasks(raw, prefix, seedSeen) {
  const seen = {}
  if (seedSeen) for (const k in seedSeen) seen[k] = true
  const out = []
  const list = Array.isArray(raw) ? raw : []
  for (const t of list) {
    if (!t || typeof t.description !== 'string' || !t.description.trim()) continue
    let id = (typeof t.id === 'string' && t.id.trim()) ? t.id.trim() : ''
    if (!id || seen[id]) {
      let k = 0
      do { k++; id = prefix + k } while (seen[id])
    }
    seen[id] = true
    out.push({
      id: id,
      description: t.description.trim(),
      after: Array.isArray(t.after) ? t.after.filter(function (x) { return typeof x === 'string' }) : null,
    })
    if (out.length >= MAX_TASKS) break
  }
  const ids = {}
  for (const t of out) ids[t.id] = true
  out.forEach(function (t, i) {
    if (!t.after) t.after = i > 0 ? [out[i - 1].id] : []
    t.after = t.after.filter(function (x) { return ids[x] && x !== t.id })
  })
  const resolved = {}
  let changed = true
  while (changed) {
    changed = false
    for (const t of out) {
      if (resolved[t.id]) continue
      let ok = true
      for (const d of t.after) if (!resolved[d]) { ok = false; break }
      if (ok) { resolved[t.id] = true; changed = true }
    }
  }
  for (const t of out) {
    if (!resolved[t.id]) { t.after = []; log('依赖成环, 已解除 ' + t.id + ' 的前置约束') }
  }
  return out
}

// prefix 续跑种子校验: 只保留可识别的已完成任务条目, id 去重
function validPrefix(raw) {
  if (!Array.isArray(raw)) return []
  const seen = {}
  const out = []
  for (const p of raw) {
    if (!p || typeof p.id !== 'string' || !p.id.trim() || typeof p.description !== 'string' || !p.description.trim()) continue
    const id = p.id.trim()
    if (seen[id]) continue
    seen[id] = true
    out.push({
      id: id,
      description: p.description.trim(),
      output: String(p.output || ''),
      changedFiles: Array.isArray(p.changedFiles) ? p.changedFiles.filter(function (x) { return typeof x === 'string' }) : [],
    })
  }
  return out
}

// ── 引擎状态 ────────────────────────────────────────────────────────────────
const nodes = []
let escalations = 0
// 全程累计升级次数(不随审批通过清零), 供调度预算增额, 防振荡兜底失效
let lifetimeEscalations = 0
let blocked = null
let escalating = false
let triage = null
let templateId = ''
let OUTLINE = []
let PLAN_TEXT = ''

function addNode(n) { nodes.push(n); return n }
function taskNode(id, description, after) {
  return addNode({ id: id, type: 'task', description: description, deps: (after || []).slice(), status: 'pending', output: '', changedFiles: [], failCount: 0, reviewNote: '', dead: false, cursor: { i: 0 } })
}
function reviewNode(id, description, deps, subject, slot, cross) {
  return addNode({ id: id, type: 'review', description: description, deps: (deps || []).slice(), status: 'pending', output: '', subject: subject, slot: slot || '', cross: !!cross, failCount: 0, fixPending: false, warn: false, dead: false, cursor: { i: 0 } })
}
function planNode(id, description, deps, outlineIndex) {
  return addNode({ id: id, type: 'plan', description: description, deps: (deps || []).slice(), status: 'pending', output: '', outlineIndex: outlineIndex, failCount: 0, dead: false, cursor: { i: 0 } })
}
function subjOf(id) {
  for (const n of nodes) if (n.id === id && !n.dead) return n
  return null
}
function liveIds() {
  const m = {}
  for (const n of nodes) if (!n.dead) m[n.id] = true
  return m
}
function unionChangedFiles() {
  const out = []
  for (const n of nodes) {
    if (n.dead || n.type === 'review') continue
    for (const f of (n.changedFiles || [])) if (out.indexOf(f) < 0) out.push(f)
  }
  return out
}
function doneSummary() {
  return nodes.filter(function (n) { return !n.dead && n.status === 'done' })
    .map(function (n) { return '- [' + n.id + '] ' + n.description + ' → ' + String(n.output || '完成').slice(0, DONE_SUMMARY_CHARS) })
    .join('\n')
}
// 交接摘要(context-bridge 语义): 原始需求 + 总计划 + 已完成节点 + 额外段 + 当前任务
function handoff(currentDesc, extra) {
  return [
    '【原始需求】' + REQ,
    PLAN_TEXT ? '【总计划】' + PLAN_TEXT.slice(0, PLAN_SNIPPET_CHARS) : '',
    '【已完成节点】\n' + (doneSummary() || '(无)'),
    extra || '',
    '【当前任务】' + currentDesc,
  ].filter(Boolean).join('\n\n')
}

// ── 阶段 1: 分诊与规划 ──────────────────────────────────────────────────────
// prefix 种子在规划前解析, 供 plannerPrompt 注入"已完成工作"清单(续跑不重做)
const PREFIX_ITEMS = validPrefix(A.prefix)
function prefixHandoff() {
  if (!PREFIX_ITEMS.length) return ''
  return '【已完成工作(断点续跑, 禁止重复规划)】\n' + PREFIX_ITEMS.map(function (p) {
    return '- [' + PREFIX_ID_MARK + p.id + '] ' + p.description + ' → ' + String(p.output || '完成').slice(0, DONE_SUMMARY_CHARS)
  }).join('\n') + '\n只规划剩余任务; 与已完成工作重复的任务不要产出。'
}
function plannerPrompt() {
  return [
    '你是 rs-workflow 多模型协作工作流中的 planner(规划者)。只规划, 不动手改代码。',
    '【需求】' + REQ,
    CONTEXT_NOTES ? '【仓库上下文(主代理勘察所得)】\n' + CONTEXT_NOTES : '',
    prefixHandoff(),
    '',
    TRIAGE_RULES,
    '',
    DECOMP_RULES,
    LOCKED
      ? '【模板锁定】用户已指定模板: ' + LOCKED + '。按该模板形态拆解。'
      : '输出三信号分诊即可, 模板由引擎矩阵选定。tasks 始终按拆解规则产出; scope=high 或多功能并行时另产出 subplans 子计划大纲(id/title/description/after, 不超过 ' + MAX_SUBPLANS + ' 个)。',
    '',
    'plan 字段: 简明实现计划(目标/方案要点/验证方式), 会作为后续执行者的交接上下文。',
    '严格按 schema 返回。',
  ].filter(Boolean).join('\n')
}

phase('分诊与规划')
log('planner 正在分诊与拆解')
const triageCursor = { i: 0 }
const triageCandidates = slotOpts('planner-triage')
for (let attempt = 0; attempt < 2 && !triage; attempt++) {
  triage = await callAgent(triageCursor, triageCandidates, { prompt: plannerPrompt(), label: 'planner:分诊', schema: PLAN_SCHEMA })
  if (!triage) log('planner 第 ' + (attempt + 1) + ' 次调用失败' + (attempt === 0 ? ', 重试' : ''))
}
templateId = LOCKED || (triage ? chooseTemplate(triage) : 'plan-final')
if (!triage) {
  log('planner 不可用, 规则兜底: ' + templateId)
  triage = { complexity: 'medium', risk: 'medium', scope: 'medium', reasoning: 'planner 不可用, 规则兜底', plan: '', tasks: [{ id: 't1', description: REQ }], subplans: [] }
}
PLAN_TEXT = String(triage.plan || '')

// ── 阶段 2: 按模板蓝图实例化节点树 ──────────────────────────────────────────
if (templateId === 'multi-plan') {
  OUTLINE = (Array.isArray(triage.subplans) ? triage.subplans : [])
    .filter(function (s) { return s && typeof s.title === 'string' && typeof s.description === 'string' })
    .slice(0, MAX_SUBPLANS)
  const rawTaskCount = Array.isArray(triage.tasks) ? triage.tasks.length : 0
  if (!OUTLINE.length && rawTaskCount) { log('multi-plan 缺子计划大纲, 降级为 step-review'); templateId = 'step-review' }
  else if (!OUTLINE.length) { log('multi-plan 缺子计划大纲且无任务, 降级为 lite'); templateId = 'lite' }
}

// ── 断点续跑种子: prefix 种为已完成任务节点(仅 task 级模板, multi-plan 忽略) ──
let PREFIX_IDS = []
if (PREFIX_ITEMS.length && templateId === 'multi-plan') log('multi-plan 忽略 prefix 断点续跑种子')
else PREFIX_IDS = PREFIX_ITEMS.map(function (p) { return PREFIX_ID_MARK + p.id })
const seedSeen = {}
PREFIX_IDS.forEach(function (id) { seedSeen[id] = true })
// 续跑标注: 兜底单任务与其他模板共用, 提示执行器只补剩余部分
const REMAIN_NOTE = PREFIX_IDS.length ? '(续跑: 已完成部分见交接摘要【已完成节点】, 只需完成剩余部分)' : ''

// 强制去重: 与种子描述相同的原始任务先剔除再规范化(描述匹配在 trim 口径),
// normalize 会清理指向被剔除任务的 after 引用, 不产生悬空依赖(续跑不重做的机器兜底)
let rawTasks = Array.isArray(triage.tasks) ? triage.tasks.slice() : []
if (PREFIX_IDS.length) {
  const seedDescSet = {}
  PREFIX_ITEMS.forEach(function (p) { seedDescSet[p.description] = true })
  const before = rawTasks.length
  rawTasks = rawTasks.filter(function (t) { return !(t && typeof t.description === 'string' && seedDescSet[t.description.trim()]) })
  if (rawTasks.length < before) log('续跑去重: 剔除与已完成工作重复的任务 ' + (before - rawTasks.length) + ' 个')
}
let tasks = normalizeTasks(rawTasks, 't-', seedSeen)
PREFIX_ITEMS.forEach(function (p, i) {
  const n = taskNode(PREFIX_IDS[i], p.description, [])
  n.status = 'done'
  n.output = p.output
  n.changedFiles = p.changedFiles
})

if (templateId === 'lite') {
  // lite 恒单任务(原版拆解约束), 任务描述即需求原文
  tasks = [{ id: 't1', description: REQ + REMAIN_NOTE, after: [] }]
  tasks.forEach(function (t) { taskNode(t.id, t.description, t.after) })
  reviewNode('fr', '终审: 整个需求交付质量', ['t1'].concat(PREFIX_IDS), 't1', 'reviewer-final', false)
}
if (templateId === 'step-review') {
  if (!tasks.length) tasks = [{ id: 't1', description: REQ + REMAIN_NOTE, after: [] }]
  tasks.forEach(function (t) {
    const deps = t.after.map(function (x) { return 'r-' + x })
    taskNode(t.id, t.description, deps)
    reviewNode('r-' + t.id, '审批: ' + t.description.slice(0, 60), [t.id], t.id, 'reviewer', false)
  })
}
if (templateId === 'plan-final') {
  if (!tasks.length) tasks = [{ id: 't1', description: REQ + REMAIN_NOTE, after: [] }]
  // 计划审批节点先行于全部任务(原版 plan-final 蓝图), 任务与终审挂其后
  reviewNode(PLAN_REVIEW_NODE, '计划审批: 实施计划可执行性/粒度/依赖/文件互斥', [], SUBJECT_PLAN, 'reviewer-plan', false)
  tasks.forEach(function (t) { taskNode(t.id, t.description, [PLAN_REVIEW_NODE].concat(t.after)) })
  reviewNode('fr', '终审: 整个需求交付质量', tasks.map(function (t) { return t.id }).concat(PREFIX_IDS), SUBJECT_OVERALL, 'reviewer-final', false)
}
if (templateId === 'multi-plan') {
  const outlineIds = OUTLINE.map(function (s, i) { return (typeof s.id === 'string' && s.id.trim()) ? s.id.trim() : 'p' + (i + 1) })
  OUTLINE.forEach(function (s, i) {
    const pid = 'p' + (i + 1)
    const after = Array.isArray(s.after)
      ? s.after.map(function (x) { const j = outlineIds.indexOf(x); return j >= 0 ? 'p' + (j + 1) : null }).filter(Boolean)
      : (i > 0 ? ['p' + i] : [])
    planNode(pid, '子计划[' + s.title + ']: ' + s.description, after, i)
    reviewNode('sr' + (i + 1), '子计划审批[' + s.title + ']', [pid], pid, 'reviewer', false)
  })
  const srIds = OUTLINE.map(function (s, i) { return 'sr' + (i + 1) })
  reviewNode('xr1', '交叉终审 A(reviewer-final 位)', srIds, 'overall', 'reviewer-final', true)
  reviewNode('xr2', '交叉终审 B(reviewer 位)', srIds, 'overall', 'reviewer', true)
}

// ── 节点执行器 ──────────────────────────────────────────────────────────────
async function execTask(node) {
  const slot = node.reviewNote ? 'executor-retry' : 'executor'
  const prompt = [
    '你是 rs-workflow 工作流中的 executor(执行者)。只负责完成当前任务: 不重新规划, 不改动与任务无关的文件, 不启动新的 workflow 或子代理。',
    handoff(node.description, node.reviewNote ? '【审批驳回意见(本次必须解决)】\n' + node.reviewNote : ''),
    '',
    '直接使用你的工具在工作区完成该任务(编码、运行验证均可)。',
    '完成后按 schema 返回: status=completed|failed; summary=给后续节点的交接摘要(做了什么/验证结果/遗留注意); changedFiles=你变更文件的相对路径清单。',
    '无法完成时 status=failed 并在 summary 说明原因, 不要伪造完成。',
  ].filter(Boolean).join('\n')
  const r = await callAgent(node.cursor, slotOpts(slot), { prompt: prompt, label: 'executor:' + node.id, schema: EXEC_SCHEMA })
  if (!r) {
    node.failCount++
    node.output = 'executor 子代理调用失败'
    return
  }
  node.output = String(r.summary || '')
  node.changedFiles = Array.isArray(r.changedFiles) ? r.changedFiles.filter(function (x) { return typeof x === 'string' }) : []
  if (r.status !== 'completed') {
    node.failCount++
    node.output = '任务自报失败: ' + node.output
  }
}

async function runTaskWithRetry(node) {
  try {
    let guard = 0
    while (guard++ < 4) {
      node.status = 'active'
      const before = node.failCount
      await execTask(node)
      if (node.failCount === before) { node.status = 'done'; node.reviewNote = ''; return }
      if (node.failCount >= REJECT_BEFORE_ESCALATE) { node.status = 'failed'; await escalate(node); return }
      log('任务 ' + node.id + ' 失败, 原地重试 (' + node.failCount + '/' + REJECT_BEFORE_ESCALATE + ')')
    }
    node.status = 'failed'
    await escalate(node)
  } catch (e) {
    node.status = 'failed'
    node.output = 'executor 异常: ' + (e && e.message ? e.message : String(e))
  }
}

// 审批证据判定: evidence 必须是非空白字符串
function hasEvidence(r) {
  return r && typeof r.evidence === 'string' && !!r.evidence.trim()
}

async function runReview(node) {
  node.fixPending = false
  node.status = 'active'
  const isPlanReview = node.subject === SUBJECT_PLAN
  const isOverall = node.subject === SUBJECT_OVERALL
  let subjDesc = node.description
  let subjFiles = []
  let subjOut = ''
  if (isOverall) {
    subjDesc = '整个需求的整体交付(全部已完成任务)'
    subjFiles = unionChangedFiles()
  } else if (isPlanReview) {
    subjDesc = '实施计划(计划审批)'
    subjOut = PLAN_TEXT
  } else {
    const s = subjOf(node.subject)
    if (s) { subjDesc = s.description; subjFiles = s.changedFiles || []; subjOut = s.output || '' }
  }
  const prompt = [
    '你是 rs-workflow 工作流中的 reviewer(审批者)。独立、严格、不吹毛求疵; 只审批, 不修改任何文件, 不启动 workflow 或子代理。',
    isPlanReview ? '审批手段(只读): 审阅计划文本本身, 不需要运行命令。' : '审批手段(只读): 查看变更(git diff / git status)、阅读相关文件、运行测试或构建验证。',
    handoff(subjDesc, node.fixNote ? '【上一轮驳回意见(检查是否已解决)】\n' + node.fixNote : ''),
    isPlanReview
      ? '【实施计划全文】' + String(subjOut).slice(0, PLAN_SNIPPET_CHARS)
      : (subjOut ? '【被审对象执行摘要】' + String(subjOut).slice(0, EXEC_SUMMARY_CHARS) : ''),
    isPlanReview ? '' : '【被审对象申报的变更文件】' + (subjFiles.join(', ') || '(未申报, 以 git diff 为准)'),
    isPlanReview || isOverall ? '' : '【非本任务范围的申报文件(豁免清单)】' + (function () {
      const others = unionChangedFiles().filter(function (f) { return subjFiles.indexOf(f) < 0 })
      return others.length ? others.join(', ') : '(无)'
    })(),
    isPlanReview ? PLAN_REVIEW_CRITERIA : '审批基准: 被审对象是否真正完成且正确; 是否引入明显缺陷、回归或破坏无关功能。',
    isOverall ? OVERALL_SCOPE_RULE : (isPlanReview ? '' : SCOPE_RULE),
    '按 schema 返回: verdict=APPROVED|REJECTED; reasons=驳回时必须给出具体、可执行的修改意见; summary=审批结论摘要; evidence=实际执行的检查命令与结果要点(APPROVED 必填, 空证据按驳回处理)。',
  ].filter(Boolean).join('\n')
  const candidates = slotOpts(node.slot || 'reviewer')
  let r = await callAgent(node.cursor, candidates, { prompt: prompt, label: 'reviewer:' + node.id, schema: REVIEW_SCHEMA })
  if (!r) {
    log('reviewer ' + node.id + ' 调用失败, 重试一次')
    r = await callAgent(node.cursor, candidates, { prompt: prompt + '\n(上次调用失败, 务必返回结构化结论)', label: 'reviewer:' + node.id + ':重试', schema: REVIEW_SCHEMA })
  }
  if (!r) {
    // fail-closed: 审批者不可用折算拒绝, 走既有驳回路由, 不再警告通过
    node.reviewerFault = true
    log('reviewer 不可用, ' + node.id + ' 视为拒绝')
    r = { verdict: 'REJECTED', reasons: [REVIEWER_UNAVAILABLE_REASON], summary: REVIEWER_UNAVAILABLE_REASON, evidence: '' }
  }
  if (r.verdict === 'APPROVED' && !hasEvidence(r)) {
    log(node.id + ' 通过缺验证证据, 重问一次')
    const reask = await callAgent(node.cursor, candidates, { prompt: prompt + EVIDENCE_REASK_NOTE, label: 'reviewer:' + node.id + ':证据重问', schema: REVIEW_SCHEMA })
    if (reask && reask.verdict === 'APPROVED' && hasEvidence(reask)) r = reask
    else if (!(reask && reask.verdict === 'REJECTED')) r = { verdict: 'REJECTED', reasons: [EVIDENCE_REQUIRED_REASON], summary: EVIDENCE_REQUIRED_REASON, evidence: '' }
    else r = reask
  }
  node.output = (r.verdict === 'APPROVED' ? 'APPROVED: ' : 'REJECTED: ') + String(r.summary || '')
  node.reviewEvidence = String(r.evidence || '')
  node.verdict = r.verdict
  if (r.verdict === 'APPROVED') {
    node.status = 'done'
    if (node.subject !== SUBJECT_OVERALL) {
      const s = subjOf(node.subject)
      if (s) s.failCount = 0
      // 非 overall 审批通过清零升级账(计划审批通过同享), 防历史累计误判 blocked
      escalations = 0
    }
    return
  }
  // REJECTED: 沿 reject 边路由
  node.status = 'pending'
  const reasons = Array.isArray(r.reasons) && r.reasons.length ? r.reasons.map(String) : [String(r.summary || '未给出理由')]
  if (isPlanReview) {
    await replanFromPlanReview(node, reasons)
    return
  }
  const s = node.subject === SUBJECT_OVERALL ? null : subjOf(node.subject)
  if (s && s.type === 'task') {
    s.failCount++
    if (s.failCount >= REJECT_BEFORE_ESCALATE) {
      s.status = 'failed'
      await escalate(s)
      return
    }
    s.status = 'pending'
    s.reviewNote = '审批驳回(' + node.id + '): ' + reasons.join('; ')
    log('任务 ' + s.id + ' 被拒, 带驳回意见重试')
  } else {
    const peers = node.cross ? nodes.filter(function (x) { return x.type === 'review' && x.cross && !x.dead && x.id !== node.id }) : []
    await escalateAggregate([node].concat(peers), reasons)
  }
}

async function runPlanNode(node) {
  node.status = 'active'
  const sp = OUTLINE[node.outlineIndex] || { title: node.description, description: node.description }
  const prompt = [
    '你是 rs-workflow 的 planner。为下面的子计划产出任务拆解(只规划, 不动手):',
    '【子计划】' + sp.title + ' — ' + sp.description,
    handoff('子计划任务拆解: ' + sp.title, ''),
    DECOMP_RULES,
    '本子计划任务数不超过 4。按 schema 返回。',
  ].join('\n')
  let r = await callAgent(node.cursor, slotOpts('planner'), { prompt: prompt, label: 'planner:' + node.id, schema: SUBPLAN_GEN_SCHEMA })
  if (!r || !Array.isArray(r.tasks) || !r.tasks.length) {
    log('子计划生成失败, 降级为单任务: ' + sp.title)
    r = { plan: sp.description, tasks: [{ id: 'st1', description: sp.title + ': ' + sp.description }] }
  }
  node.output = String(r.plan || sp.description)
  node.status = 'done'
  const st = normalizeTasks(r.tasks, node.id + '-').slice(0, 4)
  st.forEach(function (t) {
    const deps = t.after.map(function (x) { return 'r-' + x })
    taskNode(t.id, t.description, deps)
    reviewNode('r-' + t.id, '审批[' + sp.title + ']: ' + t.description.slice(0, 50), [t.id], t.id, 'reviewer', false)
  })
  const sr = subjOf('sr' + (node.outlineIndex + 1))
  if (sr && sr.type === 'review') sr.deps = st.map(function (t) { return t.id })
  log('子计划[' + sp.title + '] 产出任务: ' + st.map(function (t) { return t.id }).join(', '))
}

// ── 升级重规划: 尾段替换(replaceTailSubtree 语义) 与 返工重挂 ────────────────
function reachableFrom(startId) {
  const bad = {}
  bad[startId] = true
  let changed = true
  while (changed) {
    changed = false
    for (const n of nodes) {
      if (bad[n.id]) continue
      let hit = false
      for (const d of n.deps) if (bad[d]) { hit = true; break }
      if (hit) { bad[n.id] = true; changed = true }
    }
  }
  return bad
}

async function escalate(node) {
  if (escalating) {
    node.status = 'pending'
    node.reviewNote = '(并发失败, 待重规划后重试) ' + node.reviewNote
    return
  }
  escalating = true
  try {
    if (escalations >= ESCALATION_LIMIT) {
      blocked = { nodeId: node.id, reason: '连续失败/被拒且升级重规划次数已达上限', detail: String(node.output || '') }
      return
    }
    escalations++
    lifetimeEscalations++
    phase('升级重规划')
    log('任务 ' + node.id + ' 连续失败/被拒 ' + node.failCount + ' 次, 第 ' + escalations + ' 次升级重规划(尾段替换)')
    const prompt = [
      '你是 rs-workflow 的 planner。下面这个任务连续失败/被拒, 请换一种更稳妥的方案, 重新规划剩余工作:',
      handoff(node.description, '【累计失败原因】\n' + String(node.output || '')),
      '',
      DECOMP_RULES,
      '要求: 已完成的工作保留、不重复; 只产出从当前状态继续的剩余任务。',
      '按 schema 返回 tasks。',
    ].join('\n')
    const r = await callAgent(node.cursor, slotOpts('planner-escalate'), { prompt: prompt, label: 'planner:重规划#' + escalations, schema: REPLAN_SCHEMA })
    const nt = r && Array.isArray(r.tasks) ? normalizeTasks(r.tasks, 'e' + escalations + '-', liveIds()) : []
    if (!nt.length) {
      blocked = { nodeId: node.id, reason: '重规划无产出', detail: String(node.output || '') }
      return
    }
    replaceTail(node, nt)
  } finally {
    escalating = false
  }
}

function replaceTail(failedNode, newTasks) {
  const bad = reachableFrom(failedNode.id)
  const deadSrs = []
  const deadXrs = []
  const removed = []
  for (const n of nodes) {
    if (!bad[n.id] || n.status === 'done') continue
    n.dead = true
    removed.push(n.id)
    if (n.type === 'review' && !n.cross && subjOf(n.subject) && subjOf(n.subject).type === 'plan') deadSrs.push(n)
    if (n.type === 'review' && n.cross) deadXrs.push(n)
  }
  // 逐任务审批模板(step-review/multi-plan 子计划): 新任务链式经各自审批节点放行(蓝图配对不变量)
  const pairedReview = templateId === 'step-review' || templateId === 'multi-plan'
  newTasks.forEach(function (t, i) {
    t.after = (pairedReview && i > 0) ? ['r-' + newTasks[i - 1].id] : (i > 0 ? [newTasks[i - 1].id] : [])
  })
  newTasks.forEach(function (t) { taskNode(t.id, t.description, t.after) })
  if (pairedReview) {
    newTasks.forEach(function (t) {
      reviewNode('r-' + t.id, '审批: ' + t.description.slice(0, 60), [t.id], t.id, 'reviewer', false)
    })
  }
  // 终审重建: 任务级升级不得让 lite/plan-final 静默失去终审(蓝图不变量)
  if (templateId === 'lite' || templateId === 'plan-final') {
    reviewNode('fr', '终审: 整个需求交付质量', newTasks.map(function (t) { return t.id }).concat(PREFIX_IDS), SUBJECT_OVERALL, 'reviewer-final', false)
  }
  // multi-plan: 被尾段替换波及的子计划审与交叉终审随新任务段重建
  if (deadSrs.length) {
    deadSrs.forEach(function (sr) {
      reviewNode(sr.id, sr.description, newTasks.map(function (t) { return t.id }), sr.subject, sr.slot, false)
    })
    const liveSrIds = nodes.filter(function (n) { return !n.dead && n.type === 'review' && !n.cross && subjOf(n.subject) && subjOf(n.subject).type === 'plan' }).map(function (n) { return n.id })
    deadXrs.forEach(function (xr) {
      reviewNode(xr.id, xr.description, liveSrIds, xr.subject, xr.slot, true)
    })
  }
  log('尾段替换: 移除 [' + removed.join(', ') + '], 接入 [' + newTasks.map(function (t) { return t.id }).join(', ') + ']')
}

async function escalateAggregate(reviewNodes, reasons) {
  if (reviewNodes.some(function (n) { return n.fixPending })) {
    reviewNodes.forEach(function (n) { n.status = 'pending' })
    return
  }
  const label = reviewNodes.map(function (n) { return n.id }).join('/')
  if (escalations >= ESCALATION_LIMIT) {
    blocked = { nodeId: label, reason: '终审/计划被拒且升级重规划次数已达上限', detail: reasons.join('; ') }
    return
  }
  escalations++
  lifetimeEscalations++
  phase('升级重规划')
  log(label + ' 被拒, 第 ' + escalations + ' 次返工重规划')
  const prompt = [
    '你是 rs-workflow 的 planner。整体交付被审批驳回, 请生成返工任务(只修被驳回的问题, 不重复已完成的工作):',
    '【原始需求】' + REQ,
    '【驳回原因】\n- ' + reasons.join('\n- '),
    '【已完成任务摘要】\n' + (doneSummary() || '(无)'),
    DECOMP_RULES,
    '按 schema 返回 tasks。',
  ].join('\n')
  const r = await callAgent(reviewNodes[0].cursor, slotOpts('planner-escalate'), { prompt: prompt, label: 'planner:返工#' + escalations, schema: REPLAN_SCHEMA })
  const nt = r && Array.isArray(r.tasks) ? normalizeTasks(r.tasks, 'f' + escalations + '-', liveIds()) : []
  if (!nt.length) {
    blocked = { nodeId: label, reason: '返工重规划无产出', detail: reasons.join('; ') }
    return
  }
  nt.forEach(function (t, i) { t.after = i > 0 ? [nt[i - 1].id] : [] })
  nt.forEach(function (t) { taskNode(t.id, t.description, t.after) })
  reviewNodes.forEach(function (n) { n.fixPending = true; n.fixNote = reasons.join('; '); n.status = 'pending'; n.deps = nt.map(function (t) { return t.id }) })
  log('追加返工任务 [' + nt.map(function (t) { return t.id }).join(', ') + '], 审批重挂到返工之后')
}

// ── 计划审批驳回: 计升级账, 带意见重规划并重建任务段(原版 planReview reject→plan 边) ──
async function replanFromPlanReview(node, reasons) {
  node.status = 'pending'
  if (escalations >= ESCALATION_LIMIT) {
    blocked = { nodeId: node.id, reason: '计划审批被拒且升级重规划次数已达上限', detail: reasons.join('; ') }
    return
  }
  escalations++
  lifetimeEscalations++
  phase('升级重规划')
  log('计划审批被拒, 第 ' + escalations + ' 次计划重规划(任务段重建)')
  const prompt = [
    '你是 rs-workflow 的 planner。实施计划被计划审批驳回, 请吸收驳回意见重新产出实施计划与任务拆解(只规划, 不动手):',
    '【原始需求】' + REQ,
    prefixHandoff(),
    '【驳回意见】\n- ' + reasons.join('\n- '),
    '【已完成节点】\n' + (doneSummary() || '(无)'),
    '',
    DECOMP_RULES,
    '按 schema 返回: plan=修订后的实施计划; tasks=重建后的任务段。',
  ].join('\n')
  const r = await callAgent(node.cursor, slotOpts('planner-escalate'), { prompt: prompt, label: 'planner:计划重规划#' + escalations, schema: PLAN_REPLAN_SCHEMA })
  const nt = (r && Array.isArray(r.tasks)) ? normalizeTasks(r.tasks, 'u' + escalations + '-', liveIds()) : []
  if (!r || !String(r.plan || '').trim() || !nt.length) {
    blocked = { nodeId: node.id, reason: '计划重规划无产出', detail: reasons.join('; ') }
    return
  }
  PLAN_TEXT = String(r.plan)
  // 任务段重建: 废弃自计划审批以降的全部未完成节点, 终审随段重建(原版 plan-final 蓝图不变量)
  const bad = reachableFrom(node.id)
  const removed = []
  for (const n of nodes) {
    if (n.id !== node.id && bad[n.id] && n.status !== 'done') { n.dead = true; removed.push(n.id) }
  }
  nt.forEach(function (t, i) { t.after = i > 0 ? [nt[i - 1].id] : [node.id] })
  nt.forEach(function (t) { taskNode(t.id, t.description, t.after) })
  reviewNode('fr', '终审: 整个需求交付质量', nt.map(function (t) { return t.id }).concat(PREFIX_IDS), SUBJECT_OVERALL, 'reviewer-final', false)
  node.fixNote = reasons.join('; ')
  log('计划重规划: 移除 [' + removed.join(', ') + '], 重建 [' + nt.map(function (t) { return t.id }).join(', ') + '] 与终审')
}

// ── 主调度循环: 就绪集合驱动, plan 先行, 任务并行, 审批串行 ──────────────────
// 调度预算按当前图规模每轮现算, 大图不误杀
function loopBudget() { return LOOP_BUDGET_BASE + (nodes.length + lifetimeEscalations * LOOP_BUDGET_PER_ESCALATION) * LOOP_BUDGET_PER_NODE }
phase('执行与审批')
let loops = 0
while (!blocked) {
  loops++
  if (loops > loopBudget()) { blocked = { nodeId: '-', reason: '调度循环超出预算(' + loopBudget() + ' 轮)', detail: '可能存在无法收敛的审批循环' }; break }
  const doneMap = {}
  for (const n of nodes) if (!n.dead && n.status === 'done') doneMap[n.id] = true
  const ready = nodes.filter(function (n) { return !n.dead && n.status === 'pending' && n.deps.every(function (d) { return doneMap[d] }) })
  if (!ready.length) {
    const stuck = nodes.filter(function (n) { return !n.dead && n.status === 'pending' })
    if (stuck.length) blocked = { nodeId: '-', reason: '存在无法就绪的节点(依赖失败或缺失)', detail: stuck.map(function (n) { return n.id }).join(', ') }
    break
  }
  const planReady = ready.filter(function (n) { return n.type === 'plan' })
  const taskReady = ready.filter(function (n) { return n.type === 'task' })
  const reviewReady = ready.filter(function (n) { return n.type === 'review' })
  for (const n of planReady) { await runPlanNode(n); if (blocked) break }
  if (blocked) break
  if (taskReady.length) {
    await parallel(taskReady.map(function (n) { return function () { return runTaskWithRetry(n) } }))
  }
  if (blocked) break
  for (const n of reviewReady) {
    if (n.dead || n.status !== 'pending') continue
    let ok = true
    for (const d of n.deps) if (!doneMap[d]) { ok = false; break }
    if (!ok) continue // 依赖刚被重挂(返工在途), 下轮再审
    await runReview(n)
    if (blocked) break
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
phase('汇总')
const live = nodes.filter(function (n) { return !n.dead })
const allDone = live.length > 0 && live.every(function (n) { return n.status === 'done' })
return {
  ok: allDone && !blocked,
  templateId: templateId,
  difficulty: { complexity: triage.complexity, risk: triage.risk, scope: triage.scope },
  triageReasoning: String(triage.reasoning || ''),
  plan: PLAN_TEXT,
  escalations: escalations,
  blocked: blocked,
  reviews: live.filter(function (n) { return n.type === 'review' }).map(function (n) {
    // verdict 只取实审记录; blocked 时未运行到的评审标 UNREVIEWED, 不冒充 REJECTED
    const verdict = n.verdict || (blocked ? 'UNREVIEWED' : 'REJECTED')
    return { id: n.id, description: n.description, verdict: verdict, warn: !!n.warn, reviewerFault: !!n.reviewerFault, summary: String(n.output || ''), evidence: String(n.reviewEvidence || '') }
  }),
  tasks: live.filter(function (n) { return n.type !== 'review' }).map(function (n) {
    return { id: n.id, type: n.type, description: n.description, status: n.status, summary: String(n.output || ''), changedFiles: n.changedFiles || [] }
  }),
  changedFiles: unionChangedFiles(),
}
