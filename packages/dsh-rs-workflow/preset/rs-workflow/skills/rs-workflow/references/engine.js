// ── rs-workflow 若水工作流编排脚本 v2(原始 rs-tui 语义强制对齐) ─────────────
// 由主代理经 workflow 工具调用:
//   script = 本文件全文(原样, 不改写)
//   args   = { request, contextNotes?, slots?(16键), lockedTemplate?, defaultTemplate?, limits?, budgets?, prefix? }
//     slots 值支持 string|{provider,model}|{rotation:[...]}|array(候选依次故障转移);
//     budgets 四阈值 clamp [1,10]; defaultTemplate 'auto'/缺省 → multi-plan 兜底;
//     prefix 为断点续跑种子 [{id, description, output?, changedFiles?}], 仅
//     lite / plan-final / step-review 生效, multi-plan 忽略并记日志。
// 只用 agent / parallel / phase / log 钩子; 无 fs / network / timer / Node API。
// 结构化输出全部经 schema 约束; agent 返回 null 视为该次调用失败。
// 语义要点: 模板四级兜底链(锁定→planner 声明→矩阵→defaultTemplate); 审批
// fail-closed(审批者不可用视为拒绝+reviewerFault); APPROVED 必须附 evidence
// (重问预算 emptyOutputRetryLimit); 拒绝计数挂被审对象, plan 型阈值
// planRejectBeforeBlocked, 其余 reviewRejectBeforeEscalate, 达阈值升级重规划
// (ESCALATION_LIMIT 次后 blocked); pr 通过不清零升级账, 交付类通过清零;
// 调度预算按图规模每轮现算。

const A = args || {}
const REQ = String(A.request || '').trim()
if (!REQ) throw new Error('rs-workflow: 缺少 request(contextNotes 可空, request 必填)')

const TEMPLATES = ['lite', 'plan-final', 'step-review', 'multi-plan']
const SLOTS = (A.slots && typeof A.slots === 'object' && !Array.isArray(A.slots)) ? A.slots : {}
const LOCKED = TEMPLATES.indexOf(A.lockedTemplate) >= 0 ? A.lockedTemplate : ''
const CONTEXT_NOTES = String(A.contextNotes || '').trim()
const LIMITS = (A.limits && typeof A.limits === 'object' && !Array.isArray(A.limits)) ? A.limits : {}
const BUDGETS_SRC = (A.budgets && typeof A.budgets === 'object' && !Array.isArray(A.budgets)) ? A.budgets : {}
// 无信号兜底模板: 'auto'/非法/缺省 → multi-plan(原始 selectTemplate fallback 口径)
const DEFAULT_TEMPLATE = TEMPLATES.indexOf(A.defaultTemplate) >= 0 ? A.defaultTemplate : 'multi-plan'
const MAX_TASKS = LIMITS.maxTasks > 0 ? Math.floor(LIMITS.maxTasks) : 8

// ── budgets 四阈值: 引擎侧 clamp [1,10](workflow schema 不支持数值边界) ─────
const BUDGET_DEFAULTS = { reviewRejectBeforeEscalate: 2, planRejectBeforeBlocked: 2, emptyOutputRetryLimit: 3, reportNudgeLimit: 3 }
const BUDGET_MIN = 1
const BUDGET_MAX = 10
function clampBudget(name) {
  const raw = BUDGETS_SRC[name]
  if (raw === undefined || raw === null) return BUDGET_DEFAULTS[name]
  // 空串与纯空白同为无信号输入, 一并回落缺省
  const text = String(raw).trim()
  if (text === '') return BUDGET_DEFAULTS[name]
  const n = Math.floor(Number(text))
  if (!isFinite(n)) return BUDGET_DEFAULTS[name]
  // 数值一律钳入 [1,10](与 lib 侧 zod .min(1) 口径一致), 0<x<1 与负值同样钳到下界
  return Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, n))
}
const BUDGET = {
  reviewRejectBeforeEscalate: clampBudget('reviewRejectBeforeEscalate'),
  planRejectBeforeBlocked: clampBudget('planRejectBeforeBlocked'),
  emptyOutputRetryLimit: clampBudget('emptyOutputRetryLimit'),
  reportNudgeLimit: clampBudget('reportNudgeLimit'),
}

const ESCALATION_LIMIT = 2
const LOOP_BUDGET_BASE = 8
const LOOP_BUDGET_PER_NODE = 3
// 每次升级最多新增的任务数(重规划上限), 供调度预算按升级次数增额
const LOOP_BUDGET_PER_ESCALATION = MAX_TASKS * LOOP_BUDGET_PER_NODE
// 截断常量(对齐原始 HandoffSummary/规划口径)
const REQUEST_CHARS = 2 * 1000
const KEY_OUTPUT_CHARS = 500
const DONE_WINDOW = 10
const PLAN_EXCERPT_CHARS = 2 * 1000
const EXEC_SUMMARY_CHARS = 500
const ELLIPSIS = '...[已压缩]'
const TRIAGE_ATTEMPTS = 2
// 单任务连续执行失败原地重试的机器保险丝(正常路径由阈值先触发)
// 单任务原地重试保险丝(阈值+2): 仅防 fail/reject 合并记账判定被异常绕过后的死循环, 非业务阈值
const FAIL_RETRY_FUSE = BUDGET.reviewRejectBeforeEscalate + 2

const SUBJECT_OVERALL = 'overall'
const SUBJECT_PLAN = 'plan'
const PLAN_REVIEW_NODE = 'pr'
const PREFIX_ID_MARK = 'x'
const ALL_DONE = '无,全部完成'
const NONE = '无'

// task 节点进入语境 → executor 槽位(原始 TASK_SLOT_BY_REASON 映射)
const TASK_SLOT_BY_REASON = {
  advance: 'executor-task',
  reject: 'executor-enhance',
  fail: 'executor-retry',
  escalate: 'executor-escalate',
}

// 各模板执行语气(原始 TASK_TONE)
const TASK_TONE = {
  lite: '改动自行运行验证，报告需包含验证结果，终审只兜底',
  'plan-final': '严格按计划顺序执行，每完成一个任务报告进度',
  'step-review': '每完成一个任务报告变更与自验结果供审',
  'multi-plan': '子计划内按细化方案执行，子计划完成输出交付清单',
}
const TASK_TONE_DEFAULT = '完成后按 schema 返回执行结果'

// 审批契约固定文案: fail-closed 与证据门槛的对外理由
const REVIEWER_UNAVAILABLE_REASON = '审批者不可用(视为拒绝), 可原样重交'
const REVIEWER_UNAVAILABLE_PLAN_REASON = '审批者不可用(视为拒绝), 将带此原因重新规划'
const EVIDENCE_REQUIRED_REASON = '审批缺少验证证据(视为拒绝), 补充证据后可原样重交'
const EVIDENCE_REASK_NOTE = '\n(审批必须附验证证据: evidence 填实际执行的检查命令与结果要点, 否则视为驳回)'
const REVIEW_RESEND_NOTE = '\n裁决重申: 审查完成后按 schema 返回裁决, verdict 取 APPROVED 或 REJECTED, reasons 写结论理由。'
const REPORT_NUDGE_NOTE = '\n【回传补救】上一轮回传缺少有效任务报告(summary 为空白), 无法结算。请基于已有进度继续: 核对工作区实况, 剩余工作完成后按 schema 返回完整结果(status=completed|failed, summary=一句话结果, changedFiles=变更文件列表)。'

// 范围核查与各审批基准
const SCOPE_RULE = '范围核查(强制规则): 以 git diff / git status 的实际变更为准; 实际变更命中【非本任务范围的申报文件】清单的, 是其他任务/已完成工作, 不算越界; 除此之外未在申报清单中出现且不在豁免清单中的文件 → verdict=REJECTED 并在 reasons 点名越界文件。'
const OVERALL_SCOPE_RULE = '终审范围核查(强制规则): 汇总各任务申报文件的并集, 与全量实际变更比对, 并集之外的文件 → verdict=REJECTED 并在 reasons 点名。'
const GIT_EVIDENCE_RULE = '以只读命令收集 git 证据(git diff / git status 等变更统计与工作区状态), 与待审内容对照, 不信自报 summary。'
const PLAN_REVIEW_CRITERIA = '审批基准(计划审批): 计划是否可执行、任务粒度是否均匀且可独立验收、依赖是否成立、并行任务文件是否互斥。'
const TASK_REVIEW_CRITERIA = '审批基准(可判定清单): 1) 只审本任务范围内的交付; 2) 每条问题必须附证据(测试名/命令输出/file:line), 纯叙述不算; 3) 不确定的点写进 summary, 不猜测; 4) critical 级问题必须同时出现在 reasons; 5) 被审对象是否真正完成且正确, 是否引入明显缺陷、回归或破坏无关功能。'
const SUBPLAN_REVIEW_CRITERIA = '审批基准(可判定清单): 本子计划交付是否完整达成子计划目标; 每条问题必须附证据(测试名/命令输出/file:line), 纯叙述不算; 不确定的点写进 summary; critical 级问题必须出现在 reasons。'
const OVERALL_REVIEW_CRITERIA = '审批基准(可判定清单): 站在整体交付视角, 全部任务产出是否完整满足原始需求; 每条问题必须附证据(测试名/命令输出/file:line), 纯叙述不算; 不确定的点写进 summary; critical 级问题必须出现在 reasons。'
const PARALLEL_NOTE = '并行任务提示: 其他并行任务可能同时变更工作区，只处理本任务边界内的文件。\n工作区可能含其他并行任务的中间态改动，发现非本任务预期的未完成变更时，不得回滚或覆盖，实现应适应这些变更继续工作。'

// 角色身份行(原始协议型短身份 + 规则列表, schema 契约行留尾部)
const EXECUTOR_IDENTITY = [
  '[rs executor] 执行编码任务。',
  '',
  '规则:',
  '- 专注当前子任务, 不重新规划, 不改动与任务无关的文件, 不启动新的 workflow 或子代理',
  '- 不得回滚非本任务引入的变更, 发现其他任务的改动时在其基础上工作',
  '- 失败不伪造: 无法完成时如实上报失败并说明原因',
].join('\n')
const REVIEWER_IDENTITY = [
  '[rs reviewer] 审查代码或计划。',
  '',
  '规则:',
  '- 工作结果审查基于 git 证据（变更统计/工作区状态）与待审内容对照，不信自报 summary',
  '- 只审批: 不修改任何文件, 不启动新的 workflow 或子代理',
  '- "代码看起来对"不算验证, 必须实际运行验证',
  '- "实现者自报测试通过"须独立复跑核验',
  '- "应该没问题"不算验证, 未验证的点写明不确定',
  '- 无法裁决时 REJECTED 并在 reasons 中说明疑问',
].join('\n')
const REVIEWER_FINAL_IDENTITY = [
  '[rs reviewer] 终审全部交付结果。',
  '',
  '规则:',
  '- 站在整体交付视角审查: 全部任务的最终产出是否完整满足原始需求',
  '- 工作结果审查基于 git 证据（变更统计/工作区状态）与全部待审内容对照，不信自报 summary',
  '- 只审批: 不修改任何文件, 不启动新的 workflow 或子代理',
  '- "代码看起来对"不算验证, 必须实际运行验证',
  '- "实现者自报测试通过"须独立复跑核验',
  '- "应该没问题"不算验证, 未验证的点写明不确定',
  '- 无法裁决时 REJECTED 并在 reasons 中说明疑问',
].join('\n')
const PLANNER_IDENTITY = [
  '[rs planner] 制定计划。',
  '',
  '规则:',
  '- 输出简洁的执行计划: 关键步骤 + 注意事项',
  '- 只规划, 不执行编码, 不修改文件',
].join('\n')

const EXEC_REPORT_CONTRACT = '完成后按 schema 返回: status=completed|failed; summary=给后续节点的交接摘要(做了什么/验证结果/遗留注意); changedFiles=你变更文件的相对路径清单。'
const REVIEW_REPORT_CONTRACT = '按 schema 返回: verdict=APPROVED|REJECTED; severity=可选问题分级(critical/important/minor); reasons=驳回时必须给出具体、可执行的修改意见; summary=审批结论摘要(不确定的点写在这里); evidence=实际执行的检查命令与结果要点(APPROVED 必填, 空证据按驳回处理)。无法裁决时 REJECTED 并在 reasons 中说明疑问。'
const PLAN_FIELD_REQUIREMENT = 'plan 字段: 简明实现计划(目标/方案要点/验证方式), 关键文件用精确路径列出(比论述抗截断)。'
const REPLAN_HEAD = '此前工作流多次未通过审批或执行失败，需要升级重规划。'

// ── 工作位候选链: 细分位 → 同域基础位 → 会话默认模型 ─────────────────────────
// 值支持 string('provider/model'|'model') | {provider,model} | {rotation:[...]} | array
function parseBinding(b) {
  if (!b) return null
  if (typeof b === 'string') {
    const i = b.indexOf('/')
    return i > 0 ? { provider: b.slice(0, i), model: b.slice(i + 1) } : { model: b }
  }
  if (typeof b === 'object' && !Array.isArray(b)) {
    const o = {}
    if (typeof b.provider === 'string' && b.provider) o.provider = b.provider
    if (typeof b.model === 'string' && b.model) o.model = b.model
    return Object.keys(o).length ? o : null
  }
  return null
}
function bindingsOf(v) {
  if (Array.isArray(v)) {
    const out = []
    for (const item of v) {
      if (item && typeof item === 'object' && !Array.isArray(item) && Array.isArray(item.rotation)) out.push.apply(out, bindingsOf(item.rotation))
      else {
        const o = parseBinding(item)
        if (o) out.push(o)
      }
    }
    return out
  }
  if (v && typeof v === 'object' && Array.isArray(v.rotation)) return bindingsOf(v.rotation)
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
    holder.lastTried = list[idx]
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

// 失败语境的真实最后尝试候选身份([上次失败模型] 段取值)
function failedModelOf(holder) {
  const b = holder.lastTried
  const id = b ? [b.provider, b.model].filter(Boolean).join('/') : ''
  return id || '(会话默认模型)'
}

// ── 确定性分诊矩阵: 缺失信号按 low/small 降级; 无信号由调用方走 defaultTemplate ──
function normalizeLevel(v, allowed) {
  return allowed.indexOf(v) >= 0 ? v : ''
}
const LEVELS_LMH = ['low', 'medium', 'high']
const LEVELS_SML = ['small', 'medium', 'large']
function chooseTemplate(s) {
  const complexity = normalizeLevel(s.complexity, LEVELS_LMH)
  const risk = normalizeLevel(s.risk, LEVELS_LMH)
  const scope = normalizeLevel(s.scope, LEVELS_SML)
  if (risk === 'high' || scope === 'large') return 'multi-plan'
  if (complexity === 'high') return 'step-review'
  if (complexity === 'medium' || risk === 'medium') return 'plan-final'
  return 'lite'
}

// 超限截断 + 省略标记
function compress(text, limit) {
  const s = String(text || '')
  return s.length <= limit ? s : s.slice(0, limit - ELLIPSIS.length) + ELLIPSIS
}

// ── schema(仅用 type/properties/required/items/enum) ────────────────────────
const TASK_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    description: { type: 'string' },
    acceptance: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
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
    templateId: { type: 'string' },
    complexity: { type: 'string', enum: LEVELS_LMH },
    risk: { type: 'string', enum: LEVELS_LMH },
    scope: { type: 'string', enum: LEVELS_SML },
    reasoning: { type: 'string' },
    plan: { type: 'string' },
    tasks: TASKS_FIELD,
    subplans: { type: 'array', items: SUBPLAN_ITEM },
  },
  required: ['plan', 'tasks'],
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
    severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
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
    subplans: { type: 'array', items: SUBPLAN_ITEM },
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

// 拆解规则(cap = 当前可用任务预算)
function decompRules(cap) {
  return [
    '拆解规则: 每个任务是可独立验收的工作单元(自带必要的验证); 粒度均匀, 单任务应能在一个代理会话内完成; 有合并冲突风险的任务必须用 after 声明依赖串行 —— 无依赖关系的任务才会被并行执行, 并行候选必须文件互不相交。',
    '依赖声明: after 列出前置任务 id; 省略 after = 链式接续上一个任务。本规则同样适用于子计划内的任务: 文件互斥的任务可显式 after: [] 并行, 有冲突必须声明依赖。',
    '每任务必须给 acceptance(可独立验证的完成判据)与 files(预期触达文件清单); 禁止 TBD、"适当处理"式占位描述。',
    '任务数匹配变更量级, 禁止机械均分; 任务数不超过 ' + cap + ' 个, 超出说明粒度不对, 合并相近任务。',
  ].join('\n')
}

// ── 任务表规范化: 补 id / 链式缺省 / 清未知引用 / 破环 / 预算截断 ────────────
function normalizeTasks(raw, idPrefix, seedSeen, cap) {
  const seen = {}
  if (seedSeen) for (const k in seedSeen) seen[k] = true
  const picked = []
  const list = Array.isArray(raw) ? raw : []
  for (const t of list) {
    if (!t || typeof t.description !== 'string' || !t.description.trim()) continue
    let id = (typeof t.id === 'string' && t.id.trim()) ? t.id.trim() : ''
    if (!id || seen[id]) {
      let k = 0
      do { k++; id = idPrefix + k } while (seen[id])
    }
    seen[id] = true
    picked.push({
      id: id,
      description: t.description.trim(),
      acceptance: typeof t.acceptance === 'string' ? t.acceptance.trim() : '',
      files: Array.isArray(t.files) ? t.files.filter(function (x) { return typeof x === 'string' }) : [],
      after: Array.isArray(t.after) ? t.after.filter(function (x) { return typeof x === 'string' }) : null,
    })
  }
  if (picked.length > cap) {
    log('任务数超预算 ' + cap + ', 截断保留前 ' + cap + ' 个')
    picked.length = cap
  }
  const out = picked
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
// 全程累计升级次数(不随审批通过清零), 供调度预算增额
let lifetimeEscalations = 0
let blocked = null
let escalating = false
let triage = null
let templateId = ''
let OUTLINE = []
let PLAN_TEXT = ''
let templateSource = ''
let replanSeq = 0
let PREFIX_ITEMS = []
let PREFIX_IDS = []

function addNode(n) { nodes.push(n); return n }
function taskNode(id, description, after, planSource, extra) {
  const n = addNode({
    id: id, type: 'task', description: description, deps: (after || []).slice(), status: 'pending',
    output: '', changedFiles: [], plannedFiles: [], acceptance: '',
    failCount: 0, rejectCount: 0, nudgeCount: 0,
    enterReason: 'advance', rejectPrefix: '', failedModel: '', siblings: [],
    planSource: planSource || 'PLAN', seed: false, outlineDeps: [],
    reviewNote: '', dead: false, cursor: { i: 0 },
  })
  if (extra) Object.assign(n, extra)
  return n
}
function reviewNode(id, description, deps, subject, slot, kind) {
  return addNode({
    id: id, type: 'review', description: description, deps: (deps || []).slice(), status: 'pending',
    output: '', kind: kind, subject: subject || '', slot: slot || '',
    rejectCount: 0, fixNote: '', reviewerFault: false,
    verdict: '', reviewEvidence: '', warn: false, dead: false, cursor: { i: 0 },
  })
}
function planNode(id, description, deps, outlineIndex) {
  return addNode({
    id: id, type: 'plan', description: description, deps: (deps || []).slice(), status: 'pending',
    output: '', outlineIndex: outlineIndex, outlineDeps: [], rejectCount: 0,
    dead: false, cursor: { i: 0 },
  })
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
function liveTasks() {
  return nodes.filter(function (n) { return !n.dead && n.type === 'task' })
}
// 全局任务预算: prefix 种子不计入
function remainingTaskBudget() {
  let used = 0
  for (const n of nodes) if (!n.dead && n.type === 'task' && !n.seed) used++
  return MAX_TASKS - used
}
function doneTasks() {
  return liveTasks().filter(function (n) { return n.status === 'done' })
}
function lastDoneTask() {
  const done = doneTasks()
  return done.length ? done[done.length - 1] : null
}
function unionChangedFiles() {
  const out = []
  for (const n of nodes) {
    if (n.dead || n.type === 'review') continue
    for (const f of (n.changedFiles || [])) if (out.indexOf(f) < 0) out.push(f)
  }
  return out
}
function planTextFor(node) {
  if (node.planSource === 'PLAN') return PLAN_TEXT
  const p = subjOf(node.planSource)
  return (p && String(p.output || '').trim()) || PLAN_TEXT
}
// 拒绝计数挂载点: subplan 挂子计划节点, task/带 task 主语终审挂任务, 其余挂审批节点自身
function reviewCountHolder(node) {
  if (node.kind === 'plan') return node
  if (node.kind === 'subplan' || node.kind === 'task') return subjOf(node.subject)
  if (node.kind === 'final' && node.subject !== SUBJECT_OVERALL) return subjOf(node.subject)
  return node
}
// plan 型被审对象(pr 计划/sr 子计划)阈值 = planRejectBeforeBlocked, 其余 = reviewRejectBeforeEscalate
function planTypeReview(node) {
  return node.kind === 'plan' || node.kind === 'subplan'
}
// 从节点沿依赖前向可达(含 reject/fail 回边语义的依赖传播), 供尾段替换
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
// 活跃节点前向首个 pending 后继(BFS 沿依赖, 可跨 done), 供交接摘要[下一步]
function nextPendingFrom(nodeId) {
  const seen = {}
  const queue = []
  for (const n of nodes) if (!n.dead && n.deps.indexOf(nodeId) >= 0) queue.push(n.id)
  while (queue.length) {
    const id = queue.shift()
    if (seen[id]) continue
    seen[id] = true
    const n = subjOf(id)
    if (!n) continue
    if (n.status === 'pending') return n.description
    for (const m of nodes) if (!m.dead && m.deps.indexOf(id) >= 0) queue.push(m.id)
  }
  return ''
}
// 已完成子任务列表行: 最近 DONE_WINDOW 条带 keyOutput, 更早仅描述
function completedLines() {
  const done = doneTasks()
  const lines = []
  done.forEach(function (n, i) {
    const ko = i >= done.length - DONE_WINDOW ? compress(n.output, KEY_OUTPUT_CHARS) : ''
    lines.push(ko ? (i + 1) + '. ' + n.description + ': ' + ko : (i + 1) + '. ' + n.description)
  })
  return lines.join('\n')
}
function doneSummaryText() { return completedLines() }

// ── 交接摘要(原始 HandoffSummary 序列化格式) ────────────────────────────────
function handoff(currentDesc, opts) {
  const o = opts || {}
  const sections = ['[原始需求] ' + compress(REQ, REQUEST_CHARS)]
  const tasks = liveTasks()
  const total = tasks.length
  if (total > 0) {
    let idx = -1
    for (let i = 0; i < total; i++) if (tasks[i].status !== 'done') { idx = i; break }
    sections.push('[进度] ' + (idx < 0 ? total : idx + 1) + '/' + total)
  }
  sections.push('[已完成子任务]\n' + (completedLines() || NONE))
  sections.push('[当前子任务]\n' + currentDesc)
  const parallel = o.parallel || []
  if (parallel.length) sections.push('[并行执行中]\n' + parallel.map(function (d) { return '- ' + d }).join('\n'))
  sections.push('[下一步]\n' + (o.next || ALL_DONE))
  const files = unionChangedFiles()
  sections.push('[关键文件变更]\n' + (files.length ? files.map(function (f) { return '- ' + f }).join('\n') : NONE))
  if (o.failedModel) sections.push('[上次失败模型] ' + o.failedModel)
  if (o.forced) sections.push('[强制续跑] 请继续推进工作，不要停止。')
  return sections.join('\n\n')

}

// prefix 续跑清单注入(规划/重规划上下文)
function prefixHandoff() {
  if (!PREFIX_ITEMS.length) return ''
  return '【已完成工作(断点续跑, 禁止重复规划)】\n' + PREFIX_ITEMS.map(function (p) {
    return '- [' + PREFIX_ID_MARK + p.id + '] ' + p.description + ' → ' + String(p.output || '完成').slice(0, KEY_OUTPUT_CHARS)
  }).join('\n') + '\n只规划剩余任务; 与已完成工作重复的任务不要产出。'
}

// 拒绝重入前缀三分支(reviewerFault 折算/正常拒绝/裸拒绝)
function rejectionPrefix(reasons, reviewerFault) {
  const text = reasons.filter(Boolean).join('; ')
  if (reviewerFault) return '审批环节未产出有效结论（原因: ' + text + '），交付未被实质否决；若无修改可原样重新提交，等待复审。'
  const bare = text.trim() ? '' : '\n审阅者未给出具体理由，请对照待审内容自查证据缺口与明显缺陷后再提交，勿原样重交。'
  return '审批不通过，原因: ' + text + '\n请修改后重新提交。' + bare
}

// ── 提示词构建 ──────────────────────────────────────────────────────────────
// 首次分诊规划提示词(原始四步教学, 第四步改 schema 提交, XML 示例改同构 JSON)
function plannerPrompt() {
  const parts = [
    PLANNER_IDENTITY,
    '',
    '请对以下需求进行工作流规划，分四步完成：',
    '',
    '第一步 评估三信号：',
    '- complexity（复杂度）: low / medium / high',
    '- risk（风险）: low / medium / high',
    '- scope（变更范围）: small / medium / large',
    '无法评估的信号留空不填, 引擎按低档处理。',
    '',
    '第二步 选择工作流模板：',
    '- lite 单发终审: 简单明确，一眼能看完的活',
    '- plan-final 计划终审: 中等，需先想清步骤，执行可信',
    '- step-review 逐步审批: 多步且每步质量敏感',
    '- multi-plan 多计划交叉: 多功能大型，多计划多验证',
    '信号与模板的对应关系：高风险或大范围用 multi-plan；高复杂度用 step-review；中复杂度或中风险用 plan-final；低复杂低风险小范围用 lite。',
    '',
    '第三步 按所选模板的档位形态写计划：',
    '- lite: 恰 1 个任务，原文即任务描述，不拆步骤',
    '- plan-final / step-review: 1..N 个任务',
    '- multi-plan: K 个子计划(subplans, title+目标描述)表达子计划大纲，不直接列任务',
    '',
    '任务依赖声明（id/after，均省略则链式）:',
    '- 显式声明: {"id":"t1", ...}；省略 id 时自动编号',
    '- 依赖前置: after:["t1"] 或多值 after:["t1","t2"]（汇合）',
    '- 并行: 彼此独立的任务声明相同 after（如两个任务都 after:["t1"] 即并行）',
    '- 无依赖根任务: after:[]；省略 after = 依赖前一任务（保守链式，忘标不意外并行）',
    '- after 只能引用前面已声明的任务 id，禁止前向引用',
    '- 并行任务按模块/文件边界拆分，避免改同一文件相互冲突',
    '- 并行任务 description 末尾声明主要涉及文件，如「实现 X（主要涉及 src/a.ts）」',
    '',
    '第四步 严格按 schema 返回提交计划。',
    '',
    '示例（step-review 形态，t2/t3 并行依赖 t1）：',
    '{"templateId":"step-review","complexity":"high","risk":"medium","scope":"medium","plan":"...","tasks":[{"id":"t1","description":"实现用户登录 API","acceptance":"接口返回预期结果","files":["src/a.ts"],"after":[]},{"id":"t2","description":"编写登录集成测试","after":["t1"]},{"id":"t3","description":"编写登录前端页面","after":["t1"]}]}',
    '',
    '示例（multi-plan 形态，子计划也可声明依赖，s2/s3 并行依赖 s1）：',
    '{"templateId":"multi-plan","complexity":"high","scope":"large","plan":"...","subplans":[{"id":"s1","title":"认证模块","description":"实现登录注册与令牌管理","after":[]},{"id":"s2","title":"权限模块","description":"实现角色与资源级权限校验","after":["s1"]},{"id":"s3","title":"审计模块","description":"实现操作审计日志","after":["s1"]}]}',
    '',
    '需求: ' + compress(REQ, REQUEST_CHARS),
    CONTEXT_NOTES ? '【仓库上下文(主代理勘察所得)】\n' + CONTEXT_NOTES : '',
    prefixHandoff(),
    LOCKED ? '【模板锁定】用户已指定模板: ' + LOCKED + '。templateId 按该值填写, 并按该模板形态拆解。' : '',
    decompRules(MAX_TASKS),
    PLAN_FIELD_REQUIREMENT,
  ]
  return parts.filter(function (x) { return x !== undefined && x !== null }).join('\n')
}

// executor 任务指令(buildTaskInstruction + §4.7 并行提示 + v1 纪律行)
function buildExecutorPrompt(node, nudge) {
  const parallelDescs = node.siblings || []
  const isFailContext = node.enterReason === 'fail'
  const forced = node.enterReason === 'fail' || node.enterReason === 'escalate'
  const sections = [EXECUTOR_IDENTITY]
  if (node.rejectPrefix) sections.push(node.rejectPrefix)
  sections.push(handoff(node.description, {
    parallel: parallelDescs,
    next: nextPendingFrom(node.id),
    failedModel: isFailContext ? node.failedModel : '',
    forced: forced,
  }))
  const planText = planTextFor(node)
  if (templateId !== 'lite' && planText.trim()) sections.push('[执行计划]\n' + compress(planText, PLAN_EXCERPT_CHARS))
  const depLines = []
  for (const d of node.deps) {
    const dn = subjOf(d)
    if (dn && dn.type !== 'review' && dn.status === 'done') depLines.push('- ' + dn.description + ': ' + compress(dn.output, KEY_OUTPUT_CHARS))
  }
  if (depLines.length) sections.push('[前序任务产出]\n' + depLines.join('\n'))
  if (node.acceptance) sections.push('[验收判据]\n' + node.acceptance)
  sections.push('[要求] ' + (TASK_TONE[templateId] || TASK_TONE_DEFAULT))
  if (parallelDescs.length) sections.push(PARALLEL_NOTE)
  sections.push(EXEC_REPORT_CONTRACT)
  if (nudge) sections.push(nudge)
  return sections.filter(Boolean).join('\n\n')
}

// reviewer 指令(buildReviewInstruction 结构 + git 证据 + v1 范围核查)
function buildReviewPrompt(node) {
  const isPlan = node.kind === 'plan'
  const finalView = node.kind === 'final' || node.kind === 'cross'
  const sections = [finalView ? REVIEWER_FINAL_IDENTITY : REVIEWER_IDENTITY]
  sections.push(handoff(node.description, { next: nextPendingFrom(node.id) }))
  sections.push(node.description)
  if (isPlan) {
    sections.push('[待审执行计划]\n实施计划全文:\n' + compress(PLAN_TEXT, PLAN_EXCERPT_CHARS))
    sections.push('[git 证据]\n计划审批只需审阅计划文本本身, 不需要运行命令。')
    sections.push(PLAN_REVIEW_CRITERIA)
  } else if (node.kind === 'task') {
    const s = subjOf(node.subject)
    const sOut = s ? String(s.output || '') : ''
    sections.push('[待审工作结果]\n' + (s ? s.description : node.description) + (sOut ? '\n' + compress(sOut, EXEC_SUMMARY_CHARS) : ''))
    if (s && s.acceptance) sections.push('[验收判据]\n' + s.acceptance)
    sections.push('[自报变更文件]\n' + ((s && s.changedFiles.length) ? s.changedFiles.join(', ') : '(未申报, 以 git diff 为准)'))
    if (s && s.plannedFiles.length) sections.push('[规划期申报文件(基线)]\n' + s.plannedFiles.join(', '))
    sections.push('[git 证据]\n' + GIT_EVIDENCE_RULE)
    const exempt = unionChangedFiles().filter(function (f) { return !s || (s.changedFiles.indexOf(f) < 0 && s.plannedFiles.indexOf(f) < 0) })
    sections.push('[非本任务范围的申报文件(豁免清单)]\n' + (exempt.length ? exempt.join(', ') : '(无)'))
    sections.push(TASK_REVIEW_CRITERIA)
    sections.push(SCOPE_RULE)
  } else if (node.kind === 'subplan') {
    const p = subjOf(node.subject)
    const spTasks = p ? nodes.filter(function (n) { return !n.dead && n.type === 'task' && n.planSource === p.id }) : []
    const detail = ['本子计划交付:']
    if (p && String(p.output || '').trim()) detail.push('[细化方案]\n' + compress(p.output, PLAN_EXCERPT_CHARS))
    const outs = spTasks.map(function (t) { return '- ' + t.description + ': ' + compress(t.output, KEY_OUTPUT_CHARS) })
    if (outs.length) detail.push('[任务产出]\n' + outs.join('\n'))
    sections.push('[待审工作结果]\n' + detail.join('\n'))
    const files = []
    for (const t of spTasks) for (const f of t.changedFiles) if (files.indexOf(f) < 0) files.push(f)
    sections.push('[自报变更文件]\n' + (files.length ? files.join(', ') : '(未申报, 以 git diff 为准)'))
    sections.push('[git 证据]\n' + GIT_EVIDENCE_RULE)
    sections.push(SUBPLAN_REVIEW_CRITERIA)
  } else {
    sections.push('[待审工作结果]\n整个需求的整体交付(全部已完成任务, 明细见交接摘要[已完成子任务])')
    sections.push('[自报变更文件]\n' + (unionChangedFiles().join(', ') || '(无)'))
    sections.push('[git 证据]\n' + GIT_EVIDENCE_RULE)
    sections.push(finalView ? OVERALL_REVIEW_CRITERIA : TASK_REVIEW_CRITERIA)
    if (finalView) sections.push(OVERALL_SCOPE_RULE)
  }
  if (node.fixNote) sections.push('【上一轮驳回意见(检查是否已解决)】\n' + node.fixNote + '\n本轮只判定驳回点是否解决与是否引入新问题, 不扩大审查范围。')
  sections.push(REVIEW_REPORT_CONTRACT)
  return sections.filter(Boolean).join('\n\n')
}

// ── 阶段 1: 分诊与规划 ──────────────────────────────────────────────────────
// prefix 种子在规划前解析, 供 plannerPrompt 注入"已完成工作"清单(续跑不重做)
PREFIX_ITEMS = validPrefix(A.prefix)
const seedDescSet = {}
PREFIX_ITEMS.forEach(function (p) { seedDescSet[p.description] = true })

phase('分诊与规划')
log('planner 正在分诊与拆解')
const triageCursor = { i: 0 }
const triageCandidates = slotOpts('planner-triage')
for (let attempt = 0; attempt < TRIAGE_ATTEMPTS && !triage; attempt++) {
  triage = await callAgent(triageCursor, triageCandidates, { prompt: plannerPrompt(), label: 'planner:分诊', schema: PLAN_SCHEMA })
  if (!triage) log('planner 第 ' + (attempt + 1) + ' 次调用失败' + (attempt === 0 ? ', 重试' : ''))
}
if (!triage) {
  log('planner 不可用, 无信号走 defaultTemplate 兜底: ' + DEFAULT_TEMPLATE)
  triage = { complexity: '', risk: '', scope: '', reasoning: 'planner 不可用, 规则兜底', plan: '', tasks: [{ id: 't1', description: REQ }], subplans: [] }
}
PLAN_TEXT = String(triage.plan || '')

// 模板四级兜底链: 锁定 → planner 声明(合法才采纳) → 信号矩阵 → defaultTemplate
const declaredTemplate = triage && TEMPLATES.indexOf(triage.templateId) >= 0 ? triage.templateId : ''
const hasSignals = !!(triage.complexity || triage.risk || triage.scope)
templateId = LOCKED || declaredTemplate || (hasSignals ? chooseTemplate(triage) : DEFAULT_TEMPLATE)
// 模板来源: 供汇报注明(planner 全挂无信号同样落 defaultTemplate 链)
templateSource = LOCKED ? 'locked' : declaredTemplate ? 'declared' : hasSignals ? 'matrix' : 'default-fallback'

// 与种子同描述的原始任务先剔除(续跑不重做的机器兜底, normalize 清理悬空引用)
let rawTasks = Array.isArray(triage.tasks) ? triage.tasks.slice() : []
if (PREFIX_ITEMS.length) {
  const before = rawTasks.length
  rawTasks = rawTasks.filter(function (t) { return !(t && typeof t.description === 'string' && seedDescSet[t.description.trim()]) })
  if (rawTasks.length < before) log('续跑去重: 剔除与已完成工作重复的任务 ' + (before - rawTasks.length) + ' 个')
}
// 兜底/声明选中 lite 但拆了多任务(信号与拆解自相矛盾, lite 蓝图无法承载) → 升 plan-final
if (!LOCKED && templateId === 'lite' && rawTasks.length > 1) {
  templateId = 'plan-final'
  log('lite 与多任务拆解自相矛盾, 升级为 plan-final')
}
// multi-plan 实例化前置检查: 缺大纲按剩余任务降档
if (templateId === 'multi-plan') {
  OUTLINE = (Array.isArray(triage.subplans) ? triage.subplans : [])
    .filter(function (s) { return s && typeof s.title === 'string' && typeof s.description === 'string' })
  const rawTaskCount = rawTasks.length
  if (!OUTLINE.length && rawTaskCount) { log('multi-plan 缺子计划大纲, 降级为 step-review'); templateId = 'step-review' }
  else if (!OUTLINE.length) { log('multi-plan 缺子计划大纲且无任务, 降级为 lite'); templateId = 'lite' }
  else if (OUTLINE.length > MAX_TASKS) { log('子计划大纲数超预算 ' + MAX_TASKS + ', 截断保留前 ' + MAX_TASKS + ' 个'); OUTLINE.length = MAX_TASKS }
}

// prefix 种子: 仅 task 级模板生效, multi-plan 忽略并记日志
if (PREFIX_ITEMS.length && templateId === 'multi-plan') {
  PREFIX_IDS = []
  log('multi-plan 忽略 prefix 断点续跑种子')
} else {
  PREFIX_IDS = PREFIX_ITEMS.map(function (p) { return PREFIX_ID_MARK + p.id })
}
const seedSeen = {}
PREFIX_IDS.forEach(function (id) { seedSeen[id] = true })
// 续跑标注: 兜底单任务共用, 提示执行器只补剩余部分
const REMAIN_NOTE = PREFIX_IDS.length ? '(续跑: 已完成部分见交接摘要[已完成子任务], 只需完成剩余部分)' : ''

let tasks = normalizeTasks(rawTasks, 't-', seedSeen, Math.max(remainingTaskBudget(), 1))
PREFIX_ITEMS.forEach(function (p, i) {
  taskNode(PREFIX_IDS[i], p.description, [], 'PLAN', { seed: true, status: 'done', output: p.output, changedFiles: p.changedFiles })
})

// ── 阶段 2: 按模板蓝图实例化节点树 ──────────────────────────────────────────
// step-review 任务段: 计划审先行, 根任务挂 pr(approve), 其余挂前序任务审
function buildStepReviewTasks(list) {
  list.forEach(function (t) {
    const deps = t.after.length ? t.after.map(function (x) { return 'r-' + x }) : [PLAN_REVIEW_NODE]
    taskNode(t.id, t.description, deps, 'PLAN', { acceptance: t.acceptance, plannedFiles: t.files })
    reviewNode('r-' + t.id, '审批: ' + t.description.slice(0, 60), [t.id], t.id, 'reviewer-task', 'task')
  })
}
// plan-final 任务段: 计划审先行, 任务对任务依赖, 末尾终审
function buildPlanFinalTasks(list) {
  list.forEach(function (t) {
    taskNode(t.id, t.description, [PLAN_REVIEW_NODE].concat(t.after), 'PLAN', { acceptance: t.acceptance, plannedFiles: t.files })
  })
  reviewNode('fr', '终审: 整个需求交付质量', list.map(function (t) { return t.id }).concat(PREFIX_IDS), SUBJECT_OVERALL, 'reviewer-final', 'final')
}
// multi-plan 大纲单元: pr → 子计划单元(p → r-* → sr) → 交叉终审串行链
function buildOutlineUnits(rootId) {
  const outlineIds = OUTLINE.map(function (s, i) { return (typeof s.id === 'string' && s.id.trim()) ? s.id.trim() : 'p' + (i + 1) })
  OUTLINE.forEach(function (s, i) {
    const pid = 'p' + (i + 1)
    const afterPids = Array.isArray(s.after)
      ? s.after.map(function (x) { const j = outlineIds.indexOf(x); return j >= 0 ? 'p' + (j + 1) : null }).filter(Boolean)
      : (i > 0 ? ['p' + i] : [])
    const p = planNode(pid, '子计划[' + s.title + ']: ' + s.description, [rootId].concat(afterPids), i)
    p.outlineDeps = afterPids.map(function (x) { return 'sr' + x.slice(1) })
    reviewNode('sr' + (i + 1), '子计划审批[' + s.title + ']', [pid], pid, 'reviewer-subplan', 'subplan')
  })
  const srIds = OUTLINE.map(function (s, i) { return 'sr' + (i + 1) })
  reviewNode('xr1', '交叉终审(正确性)', srIds, SUBJECT_OVERALL, 'reviewer-cross', 'cross')
  reviewNode('xr2', '交叉终审(边界与安全)', ['xr1'], SUBJECT_OVERALL, 'reviewer-cross', 'cross')
}

if (templateId === 'lite') {
  // lite 恒单任务(原版拆解约束), 任务描述即需求原文
  const liteTasks = [{ id: 't1', description: REQ + REMAIN_NOTE, after: [] }]
  liteTasks.forEach(function (t) { taskNode(t.id, t.description, t.after, 'PLAN') })
  reviewNode('fr', '终审: 整个需求交付质量', ['t1'].concat(PREFIX_IDS), 't1', 'reviewer-final', 'final')
}
if (templateId === 'step-review') {
  if (!tasks.length) tasks = [{ id: 't1', description: REQ + REMAIN_NOTE, after: [], acceptance: '', files: [] }]
  reviewNode(PLAN_REVIEW_NODE, '计划审批: 实施计划可执行性/粒度/依赖/文件互斥', [], SUBJECT_PLAN, 'reviewer-plan', 'plan')
  buildStepReviewTasks(tasks)
}
if (templateId === 'plan-final') {
  if (!tasks.length) tasks = [{ id: 't1', description: REQ + REMAIN_NOTE, after: [], acceptance: '', files: [] }]
  reviewNode(PLAN_REVIEW_NODE, '计划审批: 实施计划可执行性/粒度/依赖/文件互斥', [], SUBJECT_PLAN, 'reviewer-plan', 'plan')
  buildPlanFinalTasks(tasks)
}
if (templateId === 'multi-plan') {
  reviewNode(PLAN_REVIEW_NODE, '大纲审批: 子计划划分/依赖/粒度与文件边界', [], SUBJECT_PLAN, 'reviewer-plan', 'plan')
  buildOutlineUnits(PLAN_REVIEW_NODE)
}

// ── 节点执行器 ──────────────────────────────────────────────────────────────
async function execTask(node) {
  const slot = TASK_SLOT_BY_REASON[node.enterReason] || 'executor-task'
  const candidates = slotOpts(slot)
  let r = await callAgent(node.cursor, candidates, { prompt: buildExecutorPrompt(node, ''), label: 'executor:' + node.id, schema: EXEC_SCHEMA })
  // completed 但 summary 空白 → 按 reportNudgeLimit 预算带补救指引重问
  while (r && r.status === 'completed' && !String(r.summary || '').trim() && node.nudgeCount < BUDGET.reportNudgeLimit) {
    node.nudgeCount++
    log('任务 ' + node.id + ' 报告摘要空白, 补救追问(' + node.nudgeCount + '/' + BUDGET.reportNudgeLimit + ')')
    r = await callAgent(node.cursor, candidates, { prompt: buildExecutorPrompt(node, REPORT_NUDGE_NOTE), label: 'executor:' + node.id + ':报告追问', schema: EXEC_SCHEMA })
  }
  if (!r) {
    node.failedModel = failedModelOf(node.cursor)
    node.failCount++
    node.output = 'executor 子代理调用失败'
    return
  }
  node.changedFiles = Array.isArray(r.changedFiles) ? r.changedFiles.filter(function (x) { return typeof x === 'string' }) : []
  node.output = String(r.summary || '')
  if (r.status !== 'completed') {
    node.failedModel = failedModelOf(node.cursor)
    node.failCount++
    node.output = '任务自报失败: ' + node.output
    return
  }
  if (!node.output.trim()) {
    node.failedModel = failedModelOf(node.cursor)
    node.failCount++
    node.output = '报告摘要空白(补救追问预算耗尽)'
  }
}

async function runTaskWithRetry(node) {
  try {
    let guard = 0
    while (guard++ < FAIL_RETRY_FUSE) {
      node.status = 'active'
      const before = node.failCount
      await execTask(node)
      if (node.failCount === before) {
        node.status = 'done'
        node.reviewNote = ''
        node.rejectPrefix = ''
        return
      }
      // fail/reject 合并记账达阈值即升级
      if (node.failCount + node.rejectCount >= BUDGET.reviewRejectBeforeEscalate) {
        node.status = 'failed'
        await escalateTask(node, [String(node.output || '任务失败')])
        return
      }
      node.enterReason = 'fail'
      log('任务 ' + node.id + ' 失败, 换模型原地重试(合并账 ' + (node.failCount + node.rejectCount) + '/' + BUDGET.reviewRejectBeforeEscalate + ')')
    }
    node.status = 'failed'
    await escalateTask(node, [String(node.output || '任务反复失败')])
  } catch (e) {
    node.status = 'failed'
    node.output = 'executor 异常: ' + (e && e.message ? e.message : String(e))
  }
}

// 审批证据判定: evidence 必须是非空白字符串
function hasEvidence(r) {
  return r && typeof r.evidence === 'string' && !!r.evidence.trim()
}

// ── 审批执行与拒绝路由(契约 B7/B8) ──────────────────────────────────────────
async function runReview(node) {
  node.status = 'active'
  const prompt = buildReviewPrompt(node)
  const candidates = slotOpts(node.slot)
  let r = await callAgent(node.cursor, candidates, { prompt: prompt, label: 'reviewer:' + node.id, schema: REVIEW_SCHEMA })
  if (!r) {
    log('reviewer ' + node.id + ' 调用失败, 重试一次')
    r = await callAgent(node.cursor, candidates, { prompt: prompt + REVIEW_RESEND_NOTE, label: 'reviewer:' + node.id + ':重试', schema: REVIEW_SCHEMA })
  }
  if (!r) {
    // fail-closed: 审批者不可用折算拒绝, 走既有驳回路由; plan/subplan 型走重规划路由, 不用"原样重交"口径
    node.reviewerFault = true
    const planTypeFail = node.kind === 'plan' || node.kind === 'subplan'
    const unavailable = planTypeFail ? REVIEWER_UNAVAILABLE_PLAN_REASON : REVIEWER_UNAVAILABLE_REASON
    log('reviewer 不可用, ' + node.id + ' 视为拒绝')
    r = { verdict: 'REJECTED', reasons: [unavailable], summary: unavailable, evidence: '', reviewerFault: true }
  }
  // 证据契约: APPROVED 空证据按 emptyOutputRetryLimit 预算重问, 耗尽折算拒绝
  let asks = 0
  while (r.verdict === 'APPROVED' && !hasEvidence(r) && asks < BUDGET.emptyOutputRetryLimit) {
    asks++
    log(node.id + ' 通过缺验证证据, 重问(' + asks + '/' + BUDGET.emptyOutputRetryLimit + ')')
    const reask = await callAgent(node.cursor, candidates, { prompt: prompt + EVIDENCE_REASK_NOTE, label: 'reviewer:' + node.id + ':证据重问', schema: REVIEW_SCHEMA })
    if (!reask) break
    r = reask
  }
  if (r.verdict === 'APPROVED' && !hasEvidence(r)) {
    log(node.id + ' 证据预算耗尽, 视为拒绝')
    node.reviewerFault = true
    r = { verdict: 'REJECTED', reasons: [EVIDENCE_REQUIRED_REASON], summary: EVIDENCE_REQUIRED_REASON, evidence: '', reviewerFault: true }
  }
  node.output = (r.verdict === 'APPROVED' ? 'APPROVED: ' : 'REJECTED: ') + String(r.summary || '')
  node.reviewEvidence = String(r.evidence || '')
  node.verdict = r.verdict
  if (r.verdict === 'APPROVED') {
    node.status = 'done'
    const holder = reviewCountHolder(node)
    // approve 只清 rejectCount; 合并账中的 failCount 作为失败历史保留参与后续记账(有意设计, 防误判为遗漏)
    if (holder) holder.rejectCount = 0
    // pr 通过只放行计划, 不清零升级账; 交付类通过清零
    if (node.kind !== 'plan') {
      escalations = 0
      log(node.id + ' 交付审批通过, 升级账清零')
    }
    return
  }
  await routeRejection(node, r)
}

async function routeRejection(node, r) {
  node.status = 'pending'
  const reasons = Array.isArray(r.reasons) && r.reasons.length ? r.reasons.map(String) : [String(r.summary || '')]
  const holder = reviewCountHolder(node)
  if (holder) holder.rejectCount++
  const threshold = planTypeReview(node) ? BUDGET.planRejectBeforeBlocked : BUDGET.reviewRejectBeforeEscalate
  // task 级合并记账: 失败与被拒共占同一阈值账; plan 型/整体交付仅拒绝计数
  const count = holder ? (holder.type === 'task' ? holder.failCount + holder.rejectCount : holder.rejectCount) : 1
  log(node.id + ' 驳回(' + count + '/' + threshold + '): ' + compress(reasons.join('; '), 100))
  // 达阈值: 升级重规划(计升级账)
  if (count >= threshold) {
    if (node.kind === 'plan') return replanPlan(node, reasons, true)
    if (node.kind === 'subplan') return escalateSubplan(holder, reasons)
    if (holder && holder.type === 'task') return escalateTask(holder, reasons)
    return rework([node], reasons)
  }
  // 未达阈值: 原位重做路由
  if (node.kind === 'plan') return replanPlan(node, reasons, false)
  if (node.kind === 'subplan') {
    node.fixNote = reasons.join('; ')
    return runPlanNode(holder, reasons)
  }
  const prefix = rejectionPrefix(reasons, !!r.reviewerFault)
  if (holder && holder.type === 'task') {
    holder.status = 'pending'
    holder.enterReason = 'reject'
    holder.rejectPrefix = prefix
    log('任务 ' + holder.id + ' 被拒, 带驳回意见重做')
    return
  }
  const last = lastDoneTask()
  if (!last) return rework([node], reasons)
  last.status = 'pending'
  last.enterReason = 'reject'
  last.rejectPrefix = prefix
  node.deps = [last.id]
  node.fixNote = reasons.join('; ')
  log('交付被拒, 最后完成任务 ' + last.id + ' 带驳回意见重做, ' + node.id + ' 重挂其后')
}

// ── 子计划细化(planner-subplan): 首次细化与被拒重建共用 ─────────────────────
function killSubplanSection(pId) {
  const killed = {}
  for (const n of nodes) {
    if (!n.dead && n.type === 'task' && n.planSource === pId) { n.dead = true; killed[n.id] = true }
  }
  for (const n of nodes) {
    if (!n.dead && n.type === 'review' && n.kind === 'task' && killed[n.subject]) n.dead = true
  }
  return Object.keys(killed)
}

async function runPlanNode(node, rejectReasons) {
  node.status = 'active'
  const sp = OUTLINE[node.outlineIndex] || { title: node.description, description: node.description }
  const remaining = remainingTaskBudget()
  const cap = remaining > 0 ? remaining : 1
  if (remaining < 1) log('全局任务预算已满, 子计划[' + sp.title + ']仍保底 1 个任务')
  const parts = [
    PLANNER_IDENTITY,
    '',
    rejectReasons ? '本子计划交付未通过审批，需要带驳回意见重新细化并重建任务段。' : ('请完成规划: ' + node.description),
    '',
    '[原始需求] ' + compress(REQ, REQUEST_CHARS),
    '',
    '[子计划] ' + sp.title + ' — ' + sp.description,
    '',
    '[已完成工作]',
    doneSummaryText() || NONE,
  ]
  if (rejectReasons) {
    parts.push('', '[未通过原因]', rejectReasons.filter(Boolean).join('; ') || '未提供', '', '[待重规划范围]', '本子计划的执行方案与任务段(重建后重审)。')
  }
  parts.push('', decompRules(cap), '本子计划任务数不超过 ' + cap + '。', PLAN_FIELD_REQUIREMENT, '严格按 schema 返回: plan=执行方案; tasks=任务段(每任务给 acceptance 验收判据与 files 预期触达文件)。')
  const r = await callAgent(node.cursor, slotOpts('planner-subplan'), { prompt: parts.join('\n'), label: 'planner:' + node.id, schema: SUBPLAN_GEN_SCHEMA })
  let gen = r
  if (!gen || !Array.isArray(gen.tasks) || !gen.tasks.length) {
    log('子计划生成失败, 降级为单任务: ' + sp.title)
    gen = { plan: sp.description, tasks: [{ id: 'st1', description: sp.title + ': ' + sp.description }] }
  }
  if (rejectReasons) {
    const removed = killSubplanSection(node.id)
    log('子计划[' + sp.title + ']任务段重建: 移除 [' + removed.join(', ') + ']')
  }
  node.output = String(gen.plan || sp.description)
  node.status = 'done'
  const st = normalizeTasks(gen.tasks, node.id + '-', liveIds(), cap)
  st.forEach(function (t) {
    const deps = [node.id].concat(node.outlineDeps).concat(t.after.map(function (x) { return 'r-' + x }))
    taskNode(t.id, t.description, deps, node.id, { acceptance: t.acceptance, plannedFiles: t.files })
    reviewNode('r-' + t.id, '审批[' + sp.title + ']: ' + t.description.slice(0, 50), [t.id], t.id, 'reviewer-task', 'task')
  })
  const sr = subjOf('sr' + (node.outlineIndex + 1))
  if (sr && sr.kind === 'subplan') sr.deps = st.map(function (t) { return 'r-' + t.id })
  log('子计划[' + sp.title + '] 产出任务: ' + st.map(function (t) { return t.id }).join(', '))
}

// ── 计划审批驳回重规划(planner-command 未达阈值 / planner-escalate 达阈值) ──
function rebuildBelowPlanReview(prNode) {
  const bad = reachableFrom(prNode.id)
  const removed = []
  for (const n of nodes) {
    if (n.id !== prNode.id && bad[n.id] && n.status !== 'done') { n.dead = true; removed.push(n.id) }
  }
  return removed
}

async function replanPlan(node, reasons, atThreshold) {
  if (escalating) {
    node.status = 'pending'
    node.fixNote = '(重规划在途, 待重审) ' + reasons.join('; ')
    return
  }
  if (atThreshold && escalations >= ESCALATION_LIMIT) {
    blocked = { nodeId: node.id, reason: '计划审批被拒且升级重规划次数已达上限', detail: reasons.join('; ') }
    return
  }
  escalating = true
  try {
    if (atThreshold) {
      escalations++
      lifetimeEscalations++
      phase('升级重规划')
      log('计划审批连续被拒, 第 ' + escalations + ' 次升级重规划(计划与任务段重建)')
    } else {
      log('计划审批被拒未达阈值, 由 planner-command 重规划, 不计升级账')
    }
    replanSeq++
    const isMulti = templateId === 'multi-plan'
    const prompt = [
      atThreshold ? REPLAN_HEAD : '实施计划未通过计划审批，需要吸收驳回意见重新规划。',
      '',
      '[原始需求] ' + compress(REQ, REQUEST_CHARS),
      '',
      '[已完成工作]',
      doneSummaryText() || NONE,
      '',
      '[未通过原因]',
      reasons.filter(Boolean).join('; ') || '未提供',
      '',
      '[待重规划范围]',
      isMulti ? '子计划大纲与各子计划任务段(全部重建)。' : '实施计划全文与任务段(重建)。',
      '',
      prefixHandoff(),
      isMulti
        ? '子计划大纲规则: subplans 每项含 id/title/description/after; after 引用其他子计划 id 表达依赖, 省略 after = 链式接续; 彼此独立的子计划声明相同 after 并行; 大纲表达子计划划分, 不直接列任务。'
        : decompRules(Math.max(remainingTaskBudget(), 1)),
      PLAN_FIELD_REQUIREMENT,
      '请重新产出' + (isMulti ? '实施计划与子计划大纲' : '实施计划与任务段') + ', 按 schema 返回。可重排任务依赖: after 列出前置 id, 彼此独立的任务声明相同 after 并行执行, 省略 after = 依赖前一任务。',
    ].join('\n')
    const r = await callAgent(node.cursor, slotOpts(atThreshold ? 'planner-escalate' : 'planner-command'), { prompt: prompt, label: 'planner:计划重规划#' + replanSeq, schema: PLAN_REPLAN_SCHEMA })
    const cap = Math.max(remainingTaskBudget(), 1)
    const planText = r ? String(r.plan || '') : ''
    if (isMulti) {
      const ol = r && Array.isArray(r.subplans)
        ? r.subplans.filter(function (s) { return s && typeof s.title === 'string' && typeof s.description === 'string' })
        : []
      const hasTasks = r && Array.isArray(r.tasks) && r.tasks.length
      if (!planText.trim() || (!ol.length && !hasTasks)) {
        blocked = { nodeId: node.id, reason: '计划重规划无产出', detail: reasons.join('; ') }
        return
      }
      PLAN_TEXT = planText
      const removed = rebuildBelowPlanReview(node)
      if (ol.length) {
        OUTLINE = ol.slice(0, cap)
        if (ol.length > cap) log('子计划大纲数超预算 ' + cap + ', 截断')
        buildOutlineUnits(PLAN_REVIEW_NODE)
      } else {
        templateId = 'step-review'
        log('重规划未产出子计划大纲, 降级 step-review 重建任务段')
        buildStepReviewTasks(normalizeTasks(r.tasks, 'u' + replanSeq + '-', liveIds(), cap))
      }
      log('计划重规划#' + replanSeq + ': 移除 [' + removed.join(', ') + '], 大纲/任务段已重建, 待计划复审')
    } else {
      const nt = (r && Array.isArray(r.tasks)) ? normalizeTasks(r.tasks, 'u' + replanSeq + '-', liveIds(), cap) : []
      if (!planText.trim() || !nt.length) {
        blocked = { nodeId: node.id, reason: '计划重规划无产出', detail: reasons.join('; ') }
        return
      }
      PLAN_TEXT = planText
      const removed = rebuildBelowPlanReview(node)
      if (templateId === 'plan-final') buildPlanFinalTasks(nt)
      else buildStepReviewTasks(nt)
      log('计划重规划#' + replanSeq + ': 移除 [' + removed.join(', ') + '], 重建 [' + nt.map(function (t) { return t.id }).join(', ') + '], 待计划复审')
    }
    node.fixNote = reasons.join('; ')
    node.status = 'pending'
  } finally {
    escalating = false
  }
}

// ── 升级重规划: 尾段替换 / 子计划重建 / 交付返工(达阈值, 计升级账) ──────────
function tailScopeText(fromId) {
  const bad = reachableFrom(fromId)
  const lines = []
  for (const n of nodes) {
    if (!bad[n.id] || n.status === 'done' || n.dead) continue
    lines.push('- [' + n.id + '] ' + n.description)
  }
  return lines.length ? lines.join('\n') : '(尾段重建)'
}

async function escalateTask(node, reasons) {
  if (escalating) {
    node.status = 'pending'
    // 覆盖式标记: 并发升级在途可能多次命中, 拼接会让备注无界增长
    node.reviewNote = '(并发失败, 待重规划后重试)'
    return
  }
  escalating = true
  try {
    if (escalations >= ESCALATION_LIMIT) {
      blocked = { nodeId: node.id, reason: '连续失败/被拒且升级重规划次数已达上限', detail: reasons.join('; ') }
      return
    }
    escalations++
    lifetimeEscalations++
    phase('升级重规划')
    log('任务 ' + node.id + ' 连续失败/被拒, 第 ' + escalations + ' 次升级重规划(尾段替换)')
    const prompt = [
      REPLAN_HEAD,
      '',
      '[原始需求] ' + compress(REQ, REQUEST_CHARS),
      '',
      '[已完成工作]',
      doneSummaryText() || NONE,
      '',
      '[未通过原因]',
      reasons.filter(Boolean).join('; ') || '未提供',
      '',
      '[待重规划范围]',
      tailScopeText(node.id),
      '',
      '请重新评估剩余工作, 按 schema 返回新任务。可重排任务依赖: after 列出前置任务 id, 彼此独立的任务声明相同 after 并行执行, 省略 after = 依赖前一任务。',
    ].join('\n')
    const r = await callAgent(node.cursor, slotOpts('planner-escalate'), { prompt: prompt, label: 'planner:重规划#' + escalations, schema: REPLAN_SCHEMA })
    const nt = r && Array.isArray(r.tasks) ? normalizeTasks(r.tasks, 'e' + escalations + '-', liveIds(), Math.max(remainingTaskBudget(), 1)) : []
    if (!nt.length) {
      blocked = { nodeId: node.id, reason: '重规划无产出', detail: reasons.join('; ') }
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
    if (n.type === 'review' && n.kind === 'subplan') deadSrs.push(n)
    if (n.type === 'review' && n.kind === 'cross') deadXrs.push(n)
  }
  // 逐任务审批模板(step-review/multi-plan 子计划): 新任务链式经各自审批节点放行
  const pairedReview = templateId === 'step-review' || templateId === 'multi-plan'
  const planSource = (deadSrs.length && subjOf(deadSrs[0].subject)) ? deadSrs[0].subject : 'PLAN'
  newTasks.forEach(function (t, i) {
    t.after = (pairedReview && i > 0) ? ['r-' + newTasks[i - 1].id] : (i > 0 ? [newTasks[i - 1].id] : [])
  })
  newTasks.forEach(function (t) {
    taskNode(t.id, t.description, t.after, planSource, { acceptance: t.acceptance, plannedFiles: t.files, enterReason: 'escalate' })
  })
  if (pairedReview) {
    newTasks.forEach(function (t) {
      reviewNode('r-' + t.id, '审批: ' + t.description.slice(0, 60), [t.id], t.id, 'reviewer-task', 'task')
    })
  }
  // 终审重建: 任务级升级不得让 lite/plan-final 静默失去终审(蓝图不变量)
  if (templateId === 'lite' || templateId === 'plan-final') {
    reviewNode('fr', '终审: 整个需求交付质量', newTasks.map(function (t) { return t.id }).concat(PREFIX_IDS), SUBJECT_OVERALL, 'reviewer-final', 'final')
  }
  // multi-plan: 被波及的子计划审与交叉终审串行链随新任务段重建
  if (deadSrs.length) {
    deadSrs.forEach(function (sr) {
      reviewNode(sr.id, sr.description, newTasks.map(function (t) { return t.id }), sr.subject, 'reviewer-subplan', 'subplan')
    })
    const liveSrIds = nodes.filter(function (n) { return !n.dead && n.kind === 'subplan' }).map(function (n) { return n.id })
    deadXrs.forEach(function (xr, i) {
      const deps = i === 0 ? liveSrIds : [deadXrs[i - 1].id]
      reviewNode(xr.id, xr.description, deps, xr.subject, 'reviewer-cross', 'cross')
    })
  }
  log('尾段替换: 移除 [' + removed.join(', ') + '], 接入 [' + newTasks.map(function (t) { return t.id }).join(', ') + ']')
}

async function escalateSubplan(pNode, reasons) {
  if (!pNode) return
  if (escalating) {
    pNode.status = 'pending'
    return
  }
  if (escalations >= ESCALATION_LIMIT) {
    blocked = { nodeId: pNode.id, reason: '子计划连续被拒且升级重规划次数已达上限', detail: reasons.join('; ') }
    return
  }
  escalating = true
  try {
    escalations++
    lifetimeEscalations++
    phase('升级重规划')
    const sp = OUTLINE[pNode.outlineIndex] || { title: pNode.description, description: pNode.description }
    log('子计划[' + sp.title + ']连续被拒, 第 ' + escalations + ' 次升级重规划(任务段重建)')
    const prompt = [
      REPLAN_HEAD,
      '',
      '[原始需求] ' + compress(REQ, REQUEST_CHARS),
      '',
      '[已完成工作]',
      doneSummaryText() || NONE,
      '',
      '[未通过原因]',
      reasons.filter(Boolean).join('; ') || '未提供',
      '',
      '[待重规划范围]',
      '子计划[' + sp.title + ']的任务段(重建, 该子计划在途产物作废)。',
      '',
      '请重新评估该子计划的剩余工作, 按 schema 返回新任务。可重排任务依赖: after 列出前置任务 id, 彼此独立的任务声明相同 after 并行执行, 省略 after = 依赖前一任务。',
    ].join('\n')
    const r = await callAgent(pNode.cursor, slotOpts('planner-escalate'), { prompt: prompt, label: 'planner:子计划重规划#' + escalations, schema: REPLAN_SCHEMA })
    const nt = r && Array.isArray(r.tasks) ? normalizeTasks(r.tasks, 'e' + escalations + '-', liveIds(), Math.max(remainingTaskBudget(), 1)) : []
    if (!nt.length) {
      blocked = { nodeId: pNode.id, reason: '子计划重规划无产出', detail: reasons.join('; ') }
      return
    }
    replaceTail(pNode, nt)
  } finally {
    escalating = false
  }
}

// 交付类(fr/xr)达阈值: 返工重规划, 追加返工任务链, 审批重挂其后
async function rework(reviewNodes, reasons) {
  const label = reviewNodes.map(function (n) { return n.id }).join('/')
  if (escalations >= ESCALATION_LIMIT) {
    blocked = { nodeId: label, reason: '终审/交叉终审被拒且升级重规划次数已达上限', detail: reasons.join('; ') }
    return
  }
  escalating = true
  try {
    escalations++
    lifetimeEscalations++
    phase('升级重规划')
    log(label + ' 被拒, 第 ' + escalations + ' 次返工重规划')
    const prompt = [
      REPLAN_HEAD,
      '',
      '[原始需求] ' + compress(REQ, REQUEST_CHARS),
      '',
      '[已完成工作]',
      doneSummaryText() || NONE,
      '',
      '[未通过原因]',
      reasons.filter(Boolean).join('; ') || '未提供',
      '',
      '[待重规划范围]',
      '被驳回交付的问题修复(只追加返工任务, 不重复已完成工作)。',
      '',
      '请重新评估, 按 schema 返回返工任务。可重排任务依赖: after 列出前置任务 id, 省略 after = 依赖前一任务。',
    ].join('\n')
    const r = await callAgent(reviewNodes[0].cursor, slotOpts('planner-escalate'), { prompt: prompt, label: 'planner:返工#' + escalations, schema: REPLAN_SCHEMA })
    const nt = r && Array.isArray(r.tasks) ? normalizeTasks(r.tasks, 'f' + escalations + '-', liveIds(), Math.max(remainingTaskBudget(), 1)) : []
    if (!nt.length) {
      blocked = { nodeId: label, reason: '返工重规划无产出', detail: reasons.join('; ') }
      return
    }
    nt.forEach(function (t, i) { t.after = i > 0 ? [nt[i - 1].id] : [] })
    nt.forEach(function (t) { taskNode(t.id, t.description, t.after, 'PLAN', { acceptance: t.acceptance, plannedFiles: t.files, enterReason: 'escalate' }) })
    reviewNodes.forEach(function (n) {
      n.fixNote = reasons.join('; ')
      n.status = 'pending'
      n.deps = nt.map(function (t) { return t.id })
    })
    log('追加返工任务 [' + nt.map(function (t) { return t.id }).join(', ') + '], 审批重挂到返工之后')
  } finally {
    escalating = false
  }
}

// ── 主调度循环: 就绪集合驱动, plan 先行, 任务并行, 审批串行 ──────────────────
// 调度预算按当前图规模每轮现算, 大图不误杀
// 每个任务节点可被拒绝/失败打回 reviewRejectBeforeEscalate 次, 调度预算按此扩容防大阈值图误杀
function loopBudget() {
  return LOOP_BUDGET_BASE + (nodes.length * (1 + BUDGET.reviewRejectBeforeEscalate) + lifetimeEscalations * LOOP_BUDGET_PER_ESCALATION) * LOOP_BUDGET_PER_NODE
}
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
    taskReady.forEach(function (n) {
      n.siblings = taskReady.filter(function (x) { return x !== n }).map(function (x) { return x.description })
    })
    await parallel(taskReady.map(function (n) { return function () { return runTaskWithRetry(n) } }))
  }
  if (blocked) break
  for (const n of reviewReady) {
    if (n.dead || n.status !== 'pending') continue
    let ok = true
    for (const d of n.deps) if (!doneMap[d]) { ok = false; break }
    if (!ok) continue // 依赖刚被重挂(重做在途), 下轮再审
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
  templateSource: templateSource,
  difficulty: { complexity: triage.complexity || '', risk: triage.risk || '', scope: triage.scope || '' },
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
