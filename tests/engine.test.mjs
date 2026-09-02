// rs-workflow engine.js 编排脚本验收测试(原始 rs-tui 语义对齐版)
// 驱动方式: new Function 把 engine.js 全文包成 async 函数体, 注入 agent/parallel/phase/log 钩子
// 剧本式 agent: 按调用次序弹出响应对象(结构化返回)或 null(调用失败); 每次调用的 prompt/opts 留存供断言
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ENGINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..',
  'packages', 'dsh-rs-workflow', 'preset', 'rs-workflow', 'skills', 'rs-workflow', 'references', 'engine.js',
)
const ENGINE_SRC = readFileSync(ENGINE_PATH, 'utf8')

// planner 分诊响应构造器(信号缺省全低)
function plan(over = {}) {
  return { templateId: 'lite', complexity: 'low', risk: 'low', scope: 'small', reasoning: '分诊理由', plan: '总计划', tasks: [], subplans: [], ...over }
}
// executor 响应构造器
function exec(over = {}) {
  return { status: 'completed', summary: '任务完成', changedFiles: ['src/a.js'], ...over }
}
// reviewer 响应构造器
function review(verdict, over = {}) {
  return { verdict, reasons: verdict === 'REJECTED' ? ['存在问题'] : [], summary: '审批结论', evidence: '已运行测试验证', ...over }
}
// 子计划细化响应构造器
function subplanGen(ids, over = {}) {
  return { plan: '子计划方案', tasks: ids.map(function (id) { return { id: id, description: '任务' + id } }), ...over }
}

async function runEngine(args, script) {
  const calls = []
  const phases = []
  const logs = []
  const queue = script.slice()
  async function agent(prompt, opts) {
    calls.push({ prompt: String(prompt), opts: opts || {} })
    if (!queue.length) throw new Error('响应剧本耗尽: ' + (opts && opts.label))
    return queue.shift()
  }
  async function parallel(fns) { for (const fn of fns) await fn() }
  function phase(name) { phases.push(name) }
  function log(msg) { logs.push(String(msg)) }
  const driver = new Function('args', 'agent', 'parallel', 'phase', 'log',
    'return (async () => {\n' + ENGINE_SRC + '\n})()')
  const result = await driver(args, agent, parallel, phase, log)
  return { result, calls, phases, logs }
}

function byLabel(calls, prefix) {
  return calls.filter(function (c) { return String((c.opts && c.opts.label) || '').indexOf(prefix) === 0 })
}
function callIdx(calls, prefix, nth) {
  const hits = byLabel(calls, prefix)
  for (let i = 0; i < calls.length; i++) if (calls[i] === hits[nth || 0]) return i
  return -1
}

// ── S1 基线: 各模板主路径 ───────────────────────────────────────────────────

test('lite 主路径: 低信号单任务直干并通过终审', async () => {
  const { result, calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: '' }),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.templateId, 'lite')
  assert.equal(result.escalations, 0)
  assert.equal(result.blocked, null)
  assert.deepEqual(result.tasks.map(function (t) { return t.id }), ['t1'])
  assert.equal(result.reviews.length, 1)
  assert.equal(result.reviews[0].id, 'fr')
  assert.equal(result.reviews[0].verdict, 'APPROVED')
  assert.equal(byLabel(calls, 'planner:分诊').length, 1)
  assert.equal(result.templateSource, 'matrix')
})

test('模板来源: Given 用户点名锁定模板 When 运行 Then templateSource=locked', async () => {
  const { result } = await runEngine({ request: '单点小改', lockedTemplate: 'lite' }, [
    plan({ templateId: 'plan-final' }),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.templateId, 'lite')
  assert.equal(result.templateSource, 'locked')
  assert.equal(result.ok, true)
})

test('plan-final 主路径: pr 审通过后两任务顺序执行并终审通过', async () => {
  const { result } = await runEngine({ request: '中等需求' }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [
        { id: 't1', description: '任务一', after: [] },
        { id: 't2', description: '任务二', after: ['t1'] },
      ],
    }),
    review('APPROVED'),
    exec(), exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.templateId, 'plan-final')
  assert.deepEqual(result.reviews.map(function (r) { return r.id }), ['pr', 'fr'])
  assert.equal(result.reviews[0].verdict, 'APPROVED')
  assert.equal(result.reviews[1].verdict, 'APPROVED')
})

test('step-review 主路径: pr 先审, 每任务执行完即审', async () => {
  const { result, calls } = await runEngine({ request: '多步质量敏感需求' }, [
    plan({
      templateId: 'step-review', complexity: 'high',
      tasks: [
        { id: 't1', description: '任务一', after: [] },
        { id: 't2', description: '任务二', after: ['t1'] },
      ],
    }),
    review('APPROVED'),
    exec(), review('APPROVED'), exec(), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.templateId, 'step-review')
  assert.deepEqual(calls.slice(2).map(function (c) { return c.opts.label }), [
    'executor:t1', 'reviewer:r-t1', 'executor:t2', 'reviewer:r-t2',
  ])
})

test('multi-plan 主路径: pr 大纲审后两子计划单元链与串行交叉终审', async () => {
  const { result, calls } = await runEngine({ request: '多功能大型需求' }, [
    plan({
      templateId: 'multi-plan', scope: 'large',
      subplans: [
        { id: 's1', title: '子计划一', description: '功能一', after: [] },
        { id: 's2', title: '子计划二', description: '功能二', after: [] },
      ],
    }),
    review('APPROVED'),
    subplanGen(['a1', 'a2']), subplanGen(['b1', 'b2']),
    exec(), exec(),
    review('APPROVED'), review('APPROVED'),
    exec(), exec(),
    review('APPROVED'), review('APPROVED'),
    review('APPROVED'), review('APPROVED'),
    review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.templateId, 'multi-plan')
  assert.deepEqual(result.reviews.map(function (r) { return r.id }), [
    'pr', 'sr1', 'sr2', 'xr1', 'xr2', 'r-a1', 'r-a2', 'r-b1', 'r-b2',
  ])
  // 串行交叉链: xr2 在 xr1 通过之前不被调用
  const xr1Ok = callIdx(calls, 'reviewer:xr1')
  const xr2Call = callIdx(calls, 'reviewer:xr2')
  assert.ok(xr1Ok >= 0 && xr2Call > xr1Ok, 'xr2 必须晚于 xr1 通过')
})

test('blocked 路径: 任务连败两次且重规划无产出', async () => {
  const { result } = await runEngine({ request: '注定失败的需求' }, [
    plan({ templateId: 'lite' }),
    exec({ status: 'failed', summary: '依赖缺失' }),
    exec({ status: 'failed', summary: '依赖缺失' }),
    null,
  ])
  assert.equal(result.ok, false)
  assert.equal(result.escalations, 1)
  assert.equal(result.blocked.reason, '重规划无产出')
  assert.equal(result.blocked.nodeId, 't1')
})

test('审批者失效: fail-closed 视为拒绝, 原样重交后恢复通过', async () => {
  const { result, calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec(),
    null, null,
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.escalations, 0)
  assert.equal(result.reviews[0].verdict, 'APPROVED')
  assert.equal(result.reviews[0].reviewerFault, true)
  assert.equal(result.reviews[0].warn, false)
  const redoPrompt = byLabel(calls, 'executor:t1')[1].prompt
  assert.ok(redoPrompt.indexOf('审批者不可用(视为拒绝), 可原样重交') >= 0)
})

test('审批者失效: 终审层面不可用走返工, 无产出则 blocked 而非假通过', async () => {
  const { result } = await runEngine({
    request: '两点小改',
    budgets: { reviewRejectBeforeEscalate: 1 },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [
        { id: 't1', description: '任务一', after: [] },
        { id: 't2', description: '任务二', after: [] },
      ],
    }),
    review('APPROVED'),
    exec(), exec(),
    null, null,
    null,
  ])
  assert.equal(result.ok, false)
  assert.equal(result.escalations, 1)
  assert.equal(result.blocked.reason, '返工重规划无产出')
  const frReview = result.reviews.find(function (r) { return r.id === 'fr' })
  assert.equal(frReview.verdict, 'REJECTED')
  assert.equal(frReview.reviewerFault, true)
  assert.ok(frReview.summary.indexOf('审批者不可用(视为拒绝)') >= 0)
})

// ── S2 分诊矩阵与四级兜底链 ─────────────────────────────────────────────────

test('分诊兜底: Given planner 声明合法模板 When 信号矩阵另选 Then 声明被采纳', async () => {
  const { result } = await runEngine({ request: '低信号但声明逐步审' }, [
    plan({ templateId: 'step-review', complexity: 'low', risk: 'low', scope: 'small' }),
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'step-review')
  assert.equal(result.templateSource, 'declared')
  assert.equal(result.ok, true)
})

test('分诊兜底: Given planner 声明非法模板值 When 走矩阵 Then 落信号矩阵模板', async () => {
  const { result } = await runEngine({ request: '声明无效值的需求' }, [
    plan({ templateId: 'mega-flow', complexity: 'medium', risk: 'low', scope: 'small',
      tasks: [{ id: 't1', description: '任务一', after: [] }, { id: 't2', description: '任务二', after: [] }] }),
    review('APPROVED'),
    exec(), exec(),
    review('APPROVED'),
  ])
  assert.equal(result.templateId, 'plan-final')
  assert.equal(result.ok, true)
})

test('分诊矩阵: risk=high 落 multi-plan', async () => {
  const { result } = await runEngine({ request: '高风险需求' }, [
    plan({ templateId: '', risk: 'high', subplans: [{ title: '子计划一', description: '功能一' }] }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'multi-plan')
  assert.equal(result.ok, true)
})

test('信号降级: Given complexity 缺省 When risk/scope 低 Then 按 low 计落 lite', async () => {
  const { result } = await runEngine({ request: '未评估复杂度的需求' }, [
    plan({ templateId: '', complexity: '', risk: 'low', scope: 'small' }),
    exec(), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'lite')
  assert.equal(result.ok, true)
})

test('信号降级: Given scope=large When 复杂度风险低 Then 仍落 multi-plan', async () => {
  const { result } = await runEngine({ request: '大范围低复杂需求' }, [
    plan({ templateId: '', complexity: 'low', risk: 'low', scope: 'large', subplans: [{ title: '子计划一', description: '功能一' }] }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'multi-plan')
  assert.equal(result.ok, true)
})

test('无信号兜底: Given 三信号全缺且 defaultTemplate=auto Then 落 multi-plan', async () => {
  const { result } = await runEngine({ request: '未评估的需求', defaultTemplate: 'auto' }, [
    plan({ templateId: '', complexity: '', risk: '', scope: '', subplans: [{ title: '子计划一', description: '功能一' }] }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'multi-plan')
  assert.equal(result.ok, true)
})

test('无信号兜底: Given 三信号全缺且 defaultTemplate=lite Then 落 lite', async () => {
  const { result } = await runEngine({ request: '未评估的需求', defaultTemplate: 'lite' }, [
    plan({ templateId: '', complexity: '', risk: '', scope: '' }),
    exec(), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'lite')
  assert.equal(result.ok, true)
})

test('分诊教学: planner 提示词恢复模板选择教学并含信号矩阵口径', async () => {
  const { calls } = await runEngine({ request: '单点小改' }, [
    plan(), exec(), review('APPROVED'),
  ])
  const prompt = byLabel(calls, 'planner:分诊')[0].prompt
  assert.ok(prompt.indexOf('第二步 选择工作流模板') >= 0, '缺第二步模板教学')
  assert.ok(prompt.indexOf('lite 单发终审') >= 0)
  assert.ok(prompt.indexOf('multi-plan') >= 0)
  assert.ok(prompt.indexOf('无法评估的信号留空不填') >= 0)
})

test('兜底链: Given 声明 lite 但拆多任务 When 非锁定 Then 升 plan-final', async () => {
  const { result, logs } = await runEngine({ request: '两点小改' }, [
    plan({
      templateId: 'lite', complexity: 'low', risk: 'low', scope: 'small',
      tasks: [{ id: 't1', description: '任务一', after: [] }, { id: 't2', description: '任务二', after: [] }],
    }),
    review('APPROVED'),
    exec(), exec(),
    review('APPROVED'),
  ])
  assert.equal(result.templateId, 'plan-final')
  assert.ok(logs.some(function (m) { return m.indexOf('升级为 plan-final') >= 0 }))
  assert.equal(result.ok, true)
})

// ── S2 审批证据与升级账 ────────────────────────────────────────────────────

test('审批证据: APPROVED 空证据重问一次, 补充后通过', async () => {
  const { result, calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('APPROVED', { evidence: '' }),
    review('APPROVED', { evidence: '实际跑了 npm test' }),
  ])
  assert.equal(result.ok, true)
  const reask = byLabel(calls, 'reviewer:fr:证据重问')
  assert.equal(reask.length, 1)
  assert.ok(reask[0].prompt.indexOf('验证证据') >= 0)
  assert.equal(result.reviews[0].evidence, '实际跑了 npm test')
})

test('审批证据: Given emptyOutputRetryLimit=1 When 重问后仍空证据 Then 折算 REJECTED 走升级', async () => {
  const { result, calls } = await runEngine({
    request: '两点小改',
    budgets: { reviewRejectBeforeEscalate: 1, emptyOutputRetryLimit: 1 },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [
        { id: 't1', description: '任务一', after: [] },
        { id: 't2', description: '任务二', after: [] },
      ],
    }),
    review('APPROVED'),
    exec(), exec(),
    review('APPROVED', { evidence: '' }),
    review('APPROVED', { evidence: '   ' }),
    null,
  ])
  assert.equal(result.ok, false)
  assert.equal(result.escalations, 1)
  assert.equal(result.blocked.reason, '返工重规划无产出')
  assert.equal(byLabel(calls, 'reviewer:fr:证据重问').length, 1, '证据重问预算应为 1 次')
  const frReview = result.reviews.find(function (r) { return r.id === 'fr' })
  assert.equal(frReview.verdict, 'REJECTED')
  assert.equal(frReview.reviewerFault, true, '证据耗尽折算拒绝应标 reviewerFault')
  assert.ok(frReview.summary.indexOf('验证证据') >= 0)
})

test('升级账: Given 交付类审批通过 When 此前有升级 Then escalations 清零', async () => {
  const { result } = await runEngine({
    request: '两点小改',
    budgets: { reviewRejectBeforeEscalate: 1 },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('APPROVED'),
    exec(),
    review('REJECTED', { reasons: ['质量不达标'] }),
    { tasks: [{ id: 'rw1', description: '修复质量问题' }] },
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.escalations, 0, '终审通过应清零升级账')
  assert.ok(result.tasks.some(function (t) { return t.id === 'rw1' }), '返工任务应存在')
})

test('升级账: 任务级审批通过清零', async () => {
  const { result } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('REJECTED', { reasons: ['实现有误'] }),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.escalations, 0)
})

// ── S3 计划审批路由: 两级阈值 ───────────────────────────────────────────────

test('计划审批: pr 拒绝后带意见重规划重建任务段, 再审通过并清零升级账', async () => {
  const { result, calls } = await runEngine({ request: '需要先想清的需求' }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [
        { id: 't1', description: '任务一', after: [] },
        { id: 't2', description: '任务二', after: ['t1'] },
      ],
    }),
    review('REJECTED', { reasons: ['缺少验证方式与文件互斥声明'] }),
    { plan: '修订后的计划', tasks: [{ id: 'u1', description: '重建后的唯一任务' }] },
    review('APPROVED'),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.templateId, 'plan-final')
  assert.equal(result.plan, '修订后的计划')
  assert.equal(result.escalations, 0)
  assert.deepEqual(result.tasks.map(function (t) { return t.id }), ['u1'])
  assert.deepEqual(result.reviews.map(function (r) { return r.id }), ['pr', 'fr'])
  assert.equal(result.reviews[0].verdict, 'APPROVED')
  const prCall = byLabel(calls, 'reviewer:pr')[0]
  assert.ok(prCall.prompt.indexOf('计划全文') >= 0)
  assert.ok(prCall.prompt.indexOf('互斥') >= 0)
  const replanCall = byLabel(calls, 'planner:计划重规划#1')[0]
  assert.ok(replanCall.prompt.indexOf('缺少验证方式') >= 0)
})

test('pr 首拒: Given 未达 planRejectBeforeBlocked When 拒绝 Then planner-command 重规划且升级账不增', async () => {
  const { result, calls } = await runEngine({
    request: '需要先想清的需求',
    slots: { 'planner-command': 'pc/mc' },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('REJECTED', { reasons: ['粒度不均'] }),
    { plan: '修订计划', tasks: [{ id: 'u1', description: '重建任务' }] },
    review('APPROVED'),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.escalations, 0, '未达阈值重规划不计升级账')
  const replan = byLabel(calls, 'planner:计划重规划#1')[0]
  assert.equal(replan.opts.provider, 'pc', '未达阈值应由 planner-command 位执行')
  assert.ok(replan.prompt.indexOf('粒度不均') >= 0)
})

test('pr 连拒: Given planRejectBeforeBlocked=2 When 连拒两次 Then 第二次起 planner-escalate 升级且 pr 通过不清零', async () => {
  const { result, calls, logs } = await runEngine({
    request: '计划难产的需求',
    budgets: { planRejectBeforeBlocked: 2 },
    slots: { 'planner-command': 'pc/mc', 'planner-escalate': 'pe/me' },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('REJECTED', { reasons: ['不可执行一'] }),
    { plan: '计划二', tasks: [{ id: 'u1', description: '重建任务一' }] },
    review('REJECTED', { reasons: ['不可执行二'] }),
    { plan: '计划三', tasks: [{ id: 'v1', description: '重建任务二' }] },
    review('APPROVED'),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(byLabel(calls, 'planner:计划重规划#1')[0].opts.provider, 'pc', '首次拒绝走 planner-command')
  assert.equal(byLabel(calls, 'planner:计划重规划#2')[0].opts.provider, 'pe', '达阈值走 planner-escalate')
  assert.ok(logs.some(function (m) { return m.indexOf('第 1 次升级重规划(计划与任务段重建)') >= 0 }), '达阈值重规划应计一次升级账')
})

test('pr 连拒达上限: Given planRejectBeforeBlocked=1 When 连拒至 ESCALATION_LIMIT Then blocked', async () => {
  const { result } = await runEngine({
    request: '计划始终不合格的需求',
    budgets: { planRejectBeforeBlocked: 1 },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('REJECTED', { reasons: ['不可执行'] }),
    { plan: '计划二', tasks: [{ id: 'u1', description: '重建任务' }] },
    review('REJECTED', { reasons: ['仍不可执行'] }),
    { plan: '计划三', tasks: [{ id: 'v1', description: '再重建任务' }] },
    review('REJECTED', { reasons: ['依旧不可执行'] }),
  ])
  assert.equal(result.ok, false)
  assert.equal(result.escalations, 2)
  assert.ok(result.blocked.reason.indexOf('计划审批被拒') >= 0)
})

// ── S3 交付审批路由: fr/xr 首拒与升级 ──────────────────────────────────────

test('fr 首拒: Given 未达阈值 When 终审拒绝 Then 最后完成任务取 enhance 位重做且 fr 重挂, 升级账不增', async () => {
  const { result, calls } = await runEngine({
    request: '两点小改',
    slots: { 'executor-enhance': 'ee/me' },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('APPROVED'),
    exec(),
    review('REJECTED', { reasons: ['实现有缺陷'] }),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.escalations, 0, '首拒不升级')
  const redo = byLabel(calls, 'executor:t1')[1]
  assert.equal(redo.opts.provider, 'ee', '被拒重做应取 executor-enhance 位')
  assert.ok(redo.prompt.indexOf('审批不通过，原因: 实现有缺陷') >= 0)
  assert.ok(redo.prompt.indexOf('请修改后重新提交') >= 0)
  assert.ok(byLabel(calls, 'reviewer:fr').length === 2, 'fr 应重挂复审')
})

test('fr 连拒: Given reviewRejectBeforeEscalate=1 When 终审一拒 Then 返工重规划走 planner-escalate', async () => {
  const { result, calls } = await runEngine({
    request: '两点小改',
    budgets: { reviewRejectBeforeEscalate: 1 },
    slots: { 'planner-escalate': 'pe/me' },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('APPROVED'),
    exec(),
    review('REJECTED', { reasons: ['整体质量不达标'] }),
    { tasks: [{ id: 'rw1', description: '返工修复' }] },
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const rework = byLabel(calls, 'planner:返工#1')[0]
  assert.ok(rework, '应触发返工重规划')
  assert.equal(rework.opts.provider, 'pe', '返工重规划应取 planner-escalate 位')
  assert.ok(rework.prompt.indexOf('整体质量不达标') >= 0)
})

test('xr 拒绝: Given 交叉终审首拒 When 未达阈值 Then 最后完成任务重做且 xr1 重挂, xr2 在 xr1 通过前不调用', async () => {
  const { result, calls } = await runEngine({ request: '多功能大型需求' }, [
    plan({
      templateId: 'multi-plan', scope: 'large',
      subplans: [{ id: 's1', title: '子计划一', description: '功能一', after: [] }],
    }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(),
    review('APPROVED'),
    review('APPROVED'),
    review('REJECTED', { reasons: ['边界用例缺失'] }),
    exec(),
    review('APPROVED'),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const xr1Reject = callIdx(calls, 'reviewer:xr1')
  const redo = byLabel(calls, 'executor:a1')[1]
  assert.ok(redo, '最后完成任务应重做')
  assert.ok(redo.prompt.indexOf('边界用例缺失') >= 0)
  const xr1Re = callIdx(calls, 'reviewer:xr1', 1)
  const xr2 = callIdx(calls, 'reviewer:xr2')
  assert.ok(xr1Re >= 0 && xr2 > xr1Re, 'xr2 必须在 xr1 复审通过后调用')
  assert.ok(callIdx(calls, 'reviewer:xr2') > callIdx(calls, 'reviewer:xr1', 1))
  assert.equal(result.escalations, 0, '首拒不升级')
})

// ── S3 budgets 接线 ────────────────────────────────────────────────────────

test('任务一拒即升级: Given reviewRejectBeforeEscalate=1 When 任务被拒一次 Then 升级尾段替换', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    budgets: { reviewRejectBeforeEscalate: 1 },
  }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('REJECTED', { reasons: ['实现有误'] }),
    { tasks: [{ id: 'e1', description: '换法重做' }] },
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(byLabel(calls, 'planner:重规划#1').length === 1, '一拒应即升级重规划')
  assert.ok(result.tasks.some(function (t) { return t.id === 'e1' && t.status === 'done' }))
})

test('报告追问: Given reportNudgeLimit=1 When completed 但 summary 空白 Then 按 HEAL 语义追问一次后正常结算', async () => {
  const { result, calls, logs } = await runEngine({
    request: '单点小改',
    budgets: { reportNudgeLimit: 1 },
  }, [
    plan({ templateId: 'lite' }),
    exec({ status: 'completed', summary: '' }),
    exec({ status: 'completed', summary: '' }),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const nudges = byLabel(calls, 'executor:t1:报告追问')
  assert.equal(nudges.length, 1, '追问次数应受 reportNudgeLimit 控制')
  assert.ok(nudges[0].prompt.indexOf('回传补救') >= 0, '追问应带 HEAL 补救指引')
  assert.ok(logs.some(function (m) { return m.indexOf('补救追问(1/1)') >= 0 }))
})

// ── S3 断点续跑 ────────────────────────────────────────────────────────────

test('断点续跑: prefix 种为已完成节点进入交接, 任务提示词含已完成产出', async () => {
  const { result, calls } = await runEngine({
    request: '分两段执行的需求',
    prefix: [{ id: 't1', description: '上游任务', output: '上游产出摘要', changedFiles: ['docs/up.md'] }],
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't2', description: '剩余工作', after: [] }],
    }),
    review('APPROVED'),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const execPrompt = byLabel(calls, 'executor:t2')[0].prompt
  assert.ok(execPrompt.indexOf('上游任务') >= 0)
  assert.ok(execPrompt.indexOf('上游产出摘要') >= 0)
  const seeded = result.tasks.find(function (t) { return t.id === 'xt1' })
  assert.equal(seeded.status, 'done')
  assert.deepEqual(seeded.changedFiles, ['docs/up.md'])
  assert.ok(result.changedFiles.indexOf('docs/up.md') >= 0)
})

test('断点续跑: multi-plan 忽略 prefix 并记录日志', async () => {
  const { result, logs } = await runEngine({
    request: '多功能大型需求',
    prefix: [{ id: 't9', description: '历史任务', output: 'o', changedFiles: [] }],
  }, [
    plan({
      templateId: 'multi-plan', scope: 'large',
      subplans: [{ id: 's1', title: '子计划一', description: '功能一', after: [] }],
    }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(logs.some(function (m) { return m.indexOf('忽略 prefix') >= 0 }))
  assert.ok(!result.tasks.some(function (t) { return t.id === 'xt9' }))
})

test('续跑不重做: prefix 清单注入分诊提示词, 与种子同描述的新任务被剔除', async () => {
  const { result, calls } = await runEngine({
    request: '两点小改',
    prefix: [{ id: 't1', description: '任务一', output: '已做完任务一', changedFiles: ['src/a.js'] }],
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一' }, { id: 't2', description: '任务二', after: [] }],
    }),
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const triagePrompt = byLabel(calls, 'planner:分诊')[0].prompt
  assert.ok(triagePrompt.indexOf('禁止重复规划') >= 0, '分诊提示词缺 prefix 清单')
  assert.ok(triagePrompt.indexOf('任务一') >= 0, '分诊提示词缺已完成工作')
  const doneIds = result.tasks.filter(function (t) { return t.status === 'done' }).map(function (t) { return t.id })
  assert.ok(doneIds.indexOf('xt1') >= 0, '种子节点应存在')
  assert.equal(result.tasks.filter(function (t) { return t.id === 't1' && t.id !== 'xt1' }).length, 0, '与种子同描述的新任务应被剔除')
  assert.ok(result.tasks.some(function (t) { return t.id === 't2' && t.status === 'done' }))
})

test('续跑不重做: 被剔除任务的下游 after 引用不悬空', async () => {
  const { result } = await runEngine({
    request: '两点小改',
    prefix: [{ id: 't1', description: '任务一', output: '已做完任务一', changedFiles: ['src/a.js'] }],
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一' }, { id: 't2', description: '任务二', after: ['t1'] }],
    }),
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(result.tasks.some(function (t) { return t.id === 't2' && t.status === 'done' }), '下游任务应正常执行, 不因悬空引用误 blocked')
  assert.ok(result.tasks.some(function (t) { return t.id === 'xt1' && t.status === 'done' }))
})

test('调度预算: 四子计划大图完整跑完, 不触发预算 blocked', async () => {
  const { result, logs } = await runEngine({ request: '四个功能点的大型需求' }, [
    plan({
      templateId: 'multi-plan', scope: 'large',
      subplans: [
        { id: 's1', title: '甲', description: '功能甲', after: [] },
        { id: 's2', title: '乙', description: '功能乙', after: [] },
        { id: 's3', title: '丙', description: '功能丙', after: [] },
        { id: 's4', title: '丁', description: '功能丁', after: [] },
      ],
    }),
    review('APPROVED'),
    subplanGen(['a1', 'a2']), subplanGen(['b1', 'b2']), subplanGen(['c1', 'c2']), subplanGen(['d1', 'd2']),
    exec(), exec(), exec(), exec(),
    review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
    exec(), exec(), exec(), exec(),
    review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
    review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
    review('APPROVED'),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(!logs.some(function (m) { return m.indexOf('超出预算') >= 0 }))
  assert.equal(result.reviews.length, 15)
})

// ── S4 模型故障转移与槽位 ───────────────────────────────────────────────────

test('故障转移: 首候选失效, 第二候选接管执行', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    slots: { executor: ['ea/ma', 'eb/mb'] },
  }, [
    plan({ templateId: 'lite' }),
    null, exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const execCalls = byLabel(calls, 'executor:t1')
  assert.equal(execCalls.length, 2)
  assert.equal(execCalls[0].opts.provider, 'ea')
  assert.equal(execCalls[1].opts.provider, 'eb')
  assert.equal(execCalls[1].opts.model, 'mb')
})

test('故障转移: 被拒重做从下一候选换模型', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    slots: { executor: ['ea/ma', 'eb/mb'] },
  }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('REJECTED', { reasons: ['实现有误'] }),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const execCalls = byLabel(calls, 'executor:t1')
  assert.equal(execCalls.length, 2)
  assert.equal(execCalls[0].opts.provider, 'ea')
  assert.equal(execCalls[1].opts.provider, 'eb')
})

test('故障转移: 细分位缺省降级基础位数组并轮换', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    slots: { reviewer: ['ra/m1', 'rb/m2'] },
  }, [
    plan({ templateId: 'lite' }),
    exec(),
    null, review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const frCalls = byLabel(calls, 'reviewer:fr')
  assert.equal(frCalls.length, 2)
  assert.equal(frCalls[0].opts.provider, 'ra')
  assert.equal(frCalls[1].opts.provider, 'rb')
})

test('故障转移: 全候选耗尽视为该次调用失败, 走既有失败路径', async () => {
  const { result, calls } = await runEngine({
    request: '注定失败的需求',
    slots: { executor: ['ea/ma'] },
  }, [
    plan({ templateId: 'lite' }),
    null, null,
    null,
  ])
  assert.equal(result.ok, false)
  assert.equal(result.blocked.reason, '重规划无产出')
  const execCalls = byLabel(calls, 'executor:t1')
  assert.equal(execCalls.length, 2)
  assert.equal(execCalls[0].opts.provider, 'ea')
  assert.equal(execCalls[1].opts.provider, 'ea')
})

test('slot 降级链: 细分位优先, 基础位兜底, 缺省回会话默认', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    slots: { 'planner-triage': 'pa/ma', reviewer: 'pr/mr' },
  }, [plan({ templateId: 'lite' }), exec(), review('APPROVED')])
  assert.equal(result.ok, true)
  const triageCall = byLabel(calls, 'planner:分诊')[0]
  assert.equal(triageCall.opts.provider, 'pa')
  assert.equal(triageCall.opts.model, 'ma')
  const frCall = byLabel(calls, 'reviewer:fr')[0]
  assert.equal(frCall.opts.provider, 'pr')
  assert.equal(frCall.opts.model, 'mr')
  const execCall = byLabel(calls, 'executor:t1')[0]
  assert.equal(execCall.opts.provider, undefined)
  assert.equal(execCall.opts.model, undefined)
})

test('rotation 绑定: Given slots 值为 {rotation:[...]} When 解析 Then 与 array 等价轮换', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    slots: { executor: { rotation: ['ea/ma', 'eb/mb'] } },
  }, [
    plan({ templateId: 'lite' }),
    null, exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const execCalls = byLabel(calls, 'executor:t1')
  assert.equal(execCalls[0].opts.provider, 'ea')
  assert.equal(execCalls[1].opts.provider, 'eb')
})

test('细分位 executor-task: 正常推进任务取任务位', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    slots: { 'executor-task': 'et/mt' },
  }, [plan({ templateId: 'lite' }), exec(), review('APPROVED')])
  assert.equal(result.ok, true)
  const execCall = byLabel(calls, 'executor:t1')[0]
  assert.equal(execCall.opts.provider, 'et')
  assert.equal(execCall.opts.model, 'mt')
})

test('细分位 executor-retry: 失败原地重试取重试位', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    slots: { 'executor-retry': 'er/mr' },
  }, [
    plan({ templateId: 'lite' }),
    exec({ status: 'failed', summary: '环境未就绪' }),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const execCalls = byLabel(calls, 'executor:t1')
  assert.equal(execCalls[0].opts.provider, undefined, '首次推进取会话默认')
  assert.equal(execCalls[1].opts.provider, 'er', '失败重试应取 executor-retry 位')
})

test('细分位 executor-escalate: 升级产出新任务取升级位', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    budgets: { reviewRejectBeforeEscalate: 1 },
    slots: { 'executor-escalate': 'es/ms' },
  }, [
    plan({ templateId: 'lite' }),
    exec({ status: 'failed', summary: '依赖缺失' }),
    { tasks: [{ id: 'e1', description: '换法重做' }] },
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const escalatedExec = byLabel(calls, 'executor:e1')[0]
  assert.equal(escalatedExec.opts.provider, 'es', '升级新任务应取 executor-escalate 位')
})

test('细分位 reviewer: pr 取 reviewer-plan, fr 取 reviewer-final, r-* 取 reviewer-task', async () => {
  const runA = await runEngine({
    request: '两点小改',
    slots: { 'reviewer-plan': 'rp/mp', 'reviewer-final': 'rf/mf' },
  }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  assert.equal(runA.result.ok, true)
  assert.equal(byLabel(runA.calls, 'reviewer:pr')[0].opts.provider, 'rp')
  assert.equal(byLabel(runA.calls, 'reviewer:fr')[0].opts.provider, 'rf')
  const runB = await runEngine({
    request: '多步质量敏感需求',
    slots: { 'reviewer-task': 'rt/mt' },
  }, [
    plan({
      templateId: 'step-review', complexity: 'high',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  assert.equal(runB.result.ok, true)
  assert.equal(byLabel(runB.calls, 'reviewer:r-t1')[0].opts.provider, 'rt')
})

test('细分位 reviewer: sr 取 reviewer-subplan, xr 取 reviewer-cross', async () => {
  const { result, calls } = await runEngine({
    request: '多功能大型需求',
    slots: { 'reviewer-subplan': 'rvs/ms', 'reviewer-cross': 'rvc/mc' },
  }, [
    plan({
      templateId: 'multi-plan', scope: 'large',
      subplans: [{ id: 's1', title: '子计划一', description: '功能一', after: [] }],
    }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(byLabel(calls, 'reviewer:sr1')[0].opts.provider, 'rvs')
  assert.equal(byLabel(calls, 'reviewer:xr1')[0].opts.provider, 'rvc')
  assert.equal(byLabel(calls, 'reviewer:xr2')[0].opts.provider, 'rvc')
})

test('细分位 planner-subplan: 子计划细化取 planner-subplan 位', async () => {
  const { result, calls } = await runEngine({
    request: '多功能大型需求',
    slots: { 'planner-subplan': 'ps/ms' },
  }, [
    plan({
      templateId: 'multi-plan', scope: 'large',
      subplans: [{ id: 's1', title: '子计划一', description: '功能一', after: [] }],
    }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const gen = byLabel(calls, 'planner:p1')[0]
  assert.equal(gen.opts.provider, 'ps')
})

// ── S5 提示词契约 ──────────────────────────────────────────────────────────

test('交接摘要: executor 提示词含 HandoffSummary 五段结构', async () => {
  const { calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('APPROVED'),
  ])
  const prompt = byLabel(calls, 'executor:t1')[0].prompt
  for (const section of ['[原始需求]', '[进度]', '[已完成子任务]', '[当前子任务]', '[下一步]', '[关键文件变更]']) {
    assert.ok(prompt.indexOf(section) >= 0, '交接摘要缺 ' + section)
  }
})

test('交接摘要: fail 语境注入 [上次失败模型] 与 [强制续跑]', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    slots: { executor: ['ea/ma', 'eb/mb'] },
  }, [
    plan({ templateId: 'lite' }),
    null, null,
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const retryPrompt = byLabel(calls, 'executor:t1')[2].prompt
  assert.ok(retryPrompt.indexOf('[上次失败模型] eb/mb') >= 0, '全候选耗尽应取真实最后尝试候选 eb/mb')
  assert.ok(retryPrompt.indexOf('[强制续跑]') >= 0)
})

test('拒绝前缀: Given 正常拒绝意见 When 重做 Then 注入审批不通过文案', async () => {
  const { calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('REJECTED', { reasons: ['实现有误'] }),
    exec(),
    review('APPROVED'),
  ])
  const redoPrompt = byLabel(calls, 'executor:t1')[1].prompt
  assert.ok(redoPrompt.indexOf('审批不通过，原因: 实现有误') >= 0)
  assert.ok(redoPrompt.indexOf('请修改后重新提交') >= 0)
})

test('拒绝前缀: Given 裸拒绝无理由 When 重做 Then 追加自查指引', async () => {
  const { calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('REJECTED', { reasons: [], summary: '' }),
    exec(),
    review('APPROVED'),
  ])
  const redoPrompt = byLabel(calls, 'executor:t1')[1].prompt
  assert.ok(redoPrompt.indexOf('审阅者未给出具体理由') >= 0)
  assert.ok(redoPrompt.indexOf('勿原样重交') >= 0)
})

test('拒绝前缀: Given reviewerFault 折算拒绝 When 重做 Then 注入原样重交折算文案', async () => {
  const { calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec(),
    null, null,
    exec(),
    review('APPROVED'),
  ])
  const redoPrompt = byLabel(calls, 'executor:t1')[1].prompt
  assert.ok(redoPrompt.indexOf('审批环节未产出有效结论') >= 0)
  assert.ok(redoPrompt.indexOf('原样重新提交') >= 0)
})

test('审查契约: reviewer 提示词要求 severity 分级且 critical 必须进 reasons', async () => {
  const { calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('APPROVED'),
  ])
  const prompt = byLabel(calls, 'reviewer:fr')[0].prompt
  assert.ok(prompt.indexOf('severity') >= 0, '审查契约缺 severity 字段')
  assert.ok(prompt.indexOf('critical') >= 0, '审查契约缺 critical 进 reasons 规则')
})

test('拆解契约: planner 提示词含 acceptance/files 拆解规则并透传到执行与审批', async () => {
  const { calls } = await runEngine({ request: '多步质量敏感需求' }, [
    plan({
      templateId: 'step-review', complexity: 'high',
      tasks: [{ id: 't1', description: '任务一', acceptance: '单测通过', files: ['src/a.js'], after: [] }],
    }),
    review('APPROVED'),
    exec(),
    review('APPROVED'),
    review('APPROVED'),
  ])
  const planPrompt = byLabel(calls, 'planner:分诊')[0].prompt
  assert.ok(planPrompt.indexOf('acceptance') >= 0, '拆解规则缺 acceptance 条款')
  assert.ok(planPrompt.indexOf('files') >= 0, '拆解规则缺 files 条款')
  const execPrompt = byLabel(calls, 'executor:t1')[0].prompt
  assert.ok(execPrompt.indexOf('[验收判据]') >= 0)
  assert.ok(execPrompt.indexOf('单测通过') >= 0)
  const reviewPrompt = byLabel(calls, 'reviewer:r-t1')[0].prompt
  assert.ok(reviewPrompt.indexOf('规划期申报文件(基线)') >= 0)
  assert.ok(reviewPrompt.indexOf('src/a.js') >= 0)
})

test('拆解契约: 子计划生成提示词包含并行适用规则', async () => {
  const { calls } = await runEngine({ request: '多功能大型需求' }, [
    plan({
      templateId: 'multi-plan', scope: 'large',
      subplans: [{ id: 's1', title: '子计划一', description: '功能一', after: [] }],
    }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  const subplanCalls = byLabel(calls, 'planner:p')
  assert.ok(subplanCalls.length >= 1)
  for (const c of subplanCalls) {
    assert.ok(c.prompt.indexOf('同样适用于子计划内的任务') >= 0, '子计划提示词缺少并行适用规则')
  }
})

test('范围核查: 任务级审批注入非本任务豁免清单', async () => {
  const { calls } = await runEngine({
    request: '两点小改',
    prefix: [{ id: 'p1', description: '无关前置工作', output: '已做', changedFiles: ['src/b.js'] }],
  }, [
    plan({
      templateId: 'step-review', complexity: 'high',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  const reviewCall = byLabel(calls, 'reviewer:r-t1')[0]
  assert.ok(reviewCall.prompt.indexOf('非本任务范围的申报文件') >= 0, '任务级审批缺豁免清单')
  assert.ok(reviewCall.prompt.indexOf('不算越界') >= 0, '范围规则缺豁免语义')
  assert.ok(reviewCall.prompt.indexOf('src/b.js') >= 0, '豁免清单应含种子任务申报文件')
})

// ── S6 升级与尾段替换 ──────────────────────────────────────────────────────

test('任务级升级达上限: 两次升级后仍失败 → blocked', async () => {
  const { result } = await runEngine({ request: '注定失败的需求' }, [
    plan({ templateId: 'plan-final', complexity: 'medium', tasks: [{ id: 't1', description: '任务一', after: [] }] }),
    review('APPROVED'),
    exec({ status: 'failed', summary: '失败一' }), exec({ status: 'failed', summary: '失败一' }),
    { plan: '换法一', tasks: [{ id: 'e1', description: '换法一重做' }] },
    exec({ status: 'failed', summary: '失败二' }), exec({ status: 'failed', summary: '失败二' }),
    { plan: '换法二', tasks: [{ id: 'e2', description: '换法二重做' }] },
    exec({ status: 'failed', summary: '失败三' }), exec({ status: 'failed', summary: '失败三' }),
    null,
  ])
  assert.equal(result.ok, false)
  assert.ok(result.blocked, '应达 blocked 终态')
  assert.equal(result.escalations, 2)
})

test('尾段替换: plan-final 任务级升级后终审随段重建并放行', async () => {
  const { result } = await runEngine({ request: '两点小改' }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('APPROVED'),
    exec({ status: 'failed', summary: '依赖缺失' }),
    exec({ status: 'failed', summary: '依赖缺失' }),
    { plan: '换方案', tasks: [{ id: 'e1', description: '换方案重做' }] },
    exec(), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const fr = result.reviews.filter(function (r) { return r.id === 'fr' })
  assert.equal(fr.length, 1, '终审应重建且仅一份')
  assert.equal(fr[0].verdict, 'APPROVED')
  const frTask = result.tasks.filter(function (t) { return t.id === 'e1' })
  assert.equal(frTask.length, 1)
  assert.equal(frTask[0].status, 'done')
})

test('尾段替换: multi-plan 子任务升级后子计划审与交叉终审串行链重建', async () => {
  const { result, calls } = await runEngine({ request: '多功能大型需求' }, [
    plan({
      templateId: 'multi-plan', risk: 'high',
      subplans: [{ id: 's1', title: '子计划一', description: '功能一', after: [] }],
    }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec({ status: 'failed', summary: '环境损坏' }),
    exec({ status: 'failed', summary: '环境损坏' }),
    { tasks: [{ id: 'e1', description: '换方案重做' }] },
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(result.reviews.some(function (r) { return r.id === 'sr1' && r.verdict === 'APPROVED' }), '子计划审应重建')
  const xr1 = callIdx(calls, 'reviewer:xr1')
  const xr2 = callIdx(calls, 'reviewer:xr2')
  assert.ok(xr1 >= 0 && xr2 > xr1, '重建后 xr1→xr2 仍须串行')
  assert.ok(result.reviews.some(function (r) { return r.id === 'xr1' && r.verdict === 'APPROVED' }), '交叉终审 A 应重建')
  assert.ok(result.reviews.some(function (r) { return r.id === 'xr2' && r.verdict === 'APPROVED' }), '交叉终审 B 应重建')
})

test('返工任务 id 防撞: 与已完成节点重名的返工任务被重编号', async () => {
  const { result } = await runEngine({ request: '两点小改' }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    review('APPROVED'),
    exec(), review('REJECTED'),
    { plan: '返工', tasks: [{ id: 't1', description: '修被驳回的问题' }] },
    exec(), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const t1s = result.tasks.filter(function (t) { return t.id === 't1' })
  assert.equal(t1s.length, 1, '返工任务不应与已完成 t1 重名共存')
})

// ── S7 补充契约: 锁定/兜底耗尽/子计划升级/追问耗尽/预算钳制/合并记账 ────────

test('锁定模板: Given lockedTemplate=step-review When 全链路 Then templateSource=locked 且按锁定蓝图实例化', async () => {
  const { result, calls } = await runEngine({
    request: '用户点名的需求',
    lockedTemplate: 'step-review',
  }, [
    plan({ templateId: 'step-review', complexity: 'low', risk: 'low', scope: 'small',
      tasks: [{ id: 't1', description: '任务一', after: [] }] }),
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'step-review')
  assert.equal(result.templateSource, 'locked', '应返回 templateSource=locked')
  assert.ok(result.reviews.some(function (r) { return r.id === 'pr' && r.verdict === 'APPROVED' }), '锁定 step-review 应有计划审')
  const prompt = byLabel(calls, 'planner:分诊')[0].prompt
  assert.ok(prompt.indexOf('【模板锁定】') >= 0, '规划提示词应含锁定段')
  assert.ok(prompt.indexOf('step-review') >= 0)
})

test('分诊兜底耗尽: Given planner 两次调用均失败 When 无信号走 defaultTemplate 缺省 Then 降级 step-review 跑通', async () => {
  const { result, logs } = await runEngine({ request: 'planner 挂掉的需求' }, [
    null, null,
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.templateId, 'step-review', '无信号缺省 multi-plan 缺大纲有任务应降 step-review')
  assert.ok(logs.some(function (m) { return m.indexOf('planner 不可用') >= 0 }))
  assert.ok(logs.some(function (m) { return m.indexOf('降级为 step-review') >= 0 }))
})

test('子计划升级: Given sr 连拒达 planRejectBeforeBlocked=1 When 拒绝一次 Then planner-escalate 重建任务段', async () => {
  const { result, calls } = await runEngine({
    request: '多功能大型需求',
    budgets: { planRejectBeforeBlocked: 1 },
    slots: { 'planner-escalate': 'pe/me' },
  }, [
    plan({
      templateId: 'multi-plan', scope: 'large',
      subplans: [{ id: 's1', title: '子计划一', description: '功能一', after: [] }],
    }),
    review('APPROVED'),
    subplanGen(['a1']),
    exec(),
    review('APPROVED'),
    review('REJECTED', { reasons: ['子计划交付不完整'] }),
    { tasks: [{ id: 'e1', description: '换法重做子计划交付' }] },
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  const replan = byLabel(calls, 'planner:子计划重规划#1')[0]
  assert.ok(replan, 'sr 达阈值应触发子计划重规划')
  assert.equal(replan.opts.provider, 'pe', '子计划重规划应取 planner-escalate 位')
  assert.ok(replan.prompt.indexOf('子计划交付不完整') >= 0)
  assert.ok(result.tasks.some(function (t) { return t.id === 'e1' && t.status === 'done' }), '重建任务应完成')
})

test('报告追问耗尽: Given reportNudgeLimit=1 When 追问后仍空白 Then failCount 累计走失败升级路径', async () => {
  const { result, calls, logs } = await runEngine({
    request: '单点小改',
    budgets: { reviewRejectBeforeEscalate: 1, reportNudgeLimit: 1 },
  }, [
    plan({ templateId: 'lite' }),
    exec({ status: 'completed', summary: '' }),
    exec({ status: 'completed', summary: '' }),
    { tasks: [{ id: 'e1', description: '换法重做' }] },
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(logs.some(function (m) { return m.indexOf('补救追问(1/1)') >= 0 }), '追问应按 reportNudgeLimit 只问一次')
  assert.ok(logs.some(function (m) { return m.indexOf('第 1 次升级重规划') >= 0 }), '追问耗尽失败应达阈值升级')
  assert.equal(byLabel(calls, 'executor:t1:报告追问').length, 1)
  assert.ok(byLabel(calls, 'planner:重规划#1').length === 1, '追问耗尽失败应达阈值升级')
  assert.ok(result.tasks.some(function (t) { return t.id === 'e1' && t.status === 'done' }))
  assert.ok(!result.tasks.some(function (t) { return t.id === 't1' }), '失败任务应被尾段替换移除')
})

test('预算钳制上界: Given reviewRejectBeforeEscalate=11 When clamp 到 10 Then 第 10 次拒绝才升级', async () => {
  // 多枚 prefix 种子抬高图规模, 避免调度循环预算(按节点数)在高阈值合法流上先杀
  const seeds = [1, 2, 3, 4, 5, 6].map(function (n) {
    return { id: 's' + n, description: '种子' + n, output: 'o' + n, changedFiles: [] }
  })
  const script = [plan({ templateId: 'lite' }), exec()]
  for (let i = 0; i < 9; i++) {
    script.push(review('REJECTED', { reasons: ['仍不通过' + (i + 1)] }), exec())
  }
  script.push(
    review('REJECTED', { reasons: ['第 10 次拒绝'] }),
    { tasks: [{ id: 'e1', description: '换法重做' }] },
    exec(),
    review('APPROVED'),
  )
  const { result, calls } = await runEngine({
    request: '单点小改',
    prefix: seeds,
    budgets: { reviewRejectBeforeEscalate: 11 },
  }, script)
  assert.equal(result.ok, true)
  // 10 次拒绝 + 升级重建后的 1 次通过终审
  assert.equal(byLabel(calls, 'reviewer:fr').length, 11, '前 9 次拒绝不应升级, 第 10 次拒绝才触发升级')
  assert.ok(byLabel(calls, 'planner:重规划#1').length === 1, '第 10 次拒绝应恰好触发一次升级')
})

test('预算钳制空白口径: Given 阈值传纯空白串 When 与空串同回落缺省 Then 首次拒绝不升级', async () => {
  const { result, calls, logs } = await runEngine({
    request: '单点小改',
    budgets: { reviewRejectBeforeEscalate: '   ' },
  }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('REJECTED', { reasons: ['实现有误'] }),
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(logs.some(function (m) { return m.indexOf('驳回(1/2)') >= 0 }), '空白串应回落缺省阈值 2, 首次拒绝只记账不升级')
  assert.equal(byLabel(calls, 'planner:重规划#1').length, 0, '首次拒绝不应触发升级')
})

test('预算钳制数值串: Given 阈值传带空白的有效数 When 按数值解析 Then 首次拒绝即达阈值升级', async () => {
  const { result, calls } = await runEngine({
    request: '单点小改',
    budgets: { reviewRejectBeforeEscalate: ' 1 ' },
  }, [
    plan({ templateId: 'lite' }),
    exec(),
    review('REJECTED', { reasons: ['实现有误'] }),
    { tasks: [{ id: 'e1', description: '换法重做' }] },
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(byLabel(calls, 'planner:重规划#1').length === 1, '带空白的有效数应按数值 1 解析, 首次拒绝即升级')
})

test('合并记账: Given 默认阈值 2 下失败一次+被拒一次 When 记账合计达阈值 Then 升级重规划', async () => {
  const { result, calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
    exec({ status: 'failed', summary: '环境未就绪' }),
    exec(),
    review('REJECTED', { reasons: ['实现有误'] }),
    { tasks: [{ id: 'e1', description: '换法重做' }] },
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(byLabel(calls, 'planner:重规划#1').length === 1, '失败 1 次+被拒 1 次应合计达阈值 2 触发升级')
  assert.ok(result.tasks.some(function (t) { return t.id === 'e1' && t.status === 'done' }))
})
