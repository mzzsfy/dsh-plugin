// rs-workflow engine.js 编排脚本验收测试
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
  return { templateId: 'lite', complexity: 'low', risk: 'low', scope: 'low', reasoning: '分诊理由', plan: '总计划', tasks: [], subplans: [], ...over }
}
// executor 响应构造器
function exec(over = {}) {
  return { status: 'completed', summary: '任务完成', changedFiles: ['src/a.js'], ...over }
}
// reviewer 响应构造器
function review(verdict, over = {}) {
  return { verdict, reasons: verdict === 'REJECTED' ? ['存在问题'] : [], summary: '审批结论', evidence: '已运行测试验证', ...over }
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

// ── S1 基线: 对当前未修改的 engine.js 全绿 ──────────────────────────────────

test('lite 主路径: 低信号单任务直干并通过终审', async () => {
  const { result, calls } = await runEngine({ request: '单点小改' }, [
    plan({ templateId: 'lite' }),
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
})

test('plan-final 主路径: 两任务顺序执行后终审通过', async () => {
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
  assert.equal(result.reviews[1].verdict, 'APPROVED')
})

test('step-review 主路径: 每任务执行完即审', async () => {
  const { result, calls } = await runEngine({ request: '多步质量敏感需求' }, [
    plan({
      templateId: 'step-review', complexity: 'high',
      tasks: [
        { id: 't1', description: '任务一', after: [] },
        { id: 't2', description: '任务二', after: ['t1'] },
      ],
    }),
    exec(), review('APPROVED'), exec(), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.templateId, 'step-review')
  assert.deepEqual(calls.slice(1).map(function (c) { return c.opts.label }), [
    'executor:t1', 'reviewer:r-t1', 'executor:t2', 'reviewer:r-t2',
  ])
})

test('multi-plan 全流程: 两子计划动态生成并交叉终审', async () => {
  const { result } = await runEngine({ request: '多功能大型需求' }, [
    plan({
      templateId: 'multi-plan', scope: 'high',
      subplans: [
        { id: 's1', title: '子计划一', description: '功能一', after: [] },
        { id: 's2', title: '子计划二', description: '功能二', after: ['s1'] },
      ],
    }),
    { plan: '子计划一方案', tasks: [{ id: 'a1', description: '功能一任务一' }, { id: 'a2', description: '功能一任务二' }] },
    { plan: '子计划二方案', tasks: [{ id: 'b1', description: '功能二任务一' }, { id: 'b2', description: '功能二任务二' }] },
    exec(), exec(), review('APPROVED'),
    exec(), review('APPROVED'),
    exec(), review('APPROVED'), review('APPROVED'),
    review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.templateId, 'multi-plan')
  assert.deepEqual(result.reviews.map(function (r) { return r.id }), [
    'sr1', 'sr2', 'xr1', 'xr2', 'r-a1', 'r-a2', 'r-b1', 'r-b2',
  ])
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
  const { result } = await runEngine({ request: '两点小改' }, [
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

test('分诊矩阵: planner 模板偏好被忽略, risk=high 必选 multi-plan', async () => {
  const { result } = await runEngine({ request: '高风险需求' }, [
    plan({ templateId: 'lite', risk: 'high', subplans: [{ title: '子计划一', description: '功能一' }] }),
    { plan: '子方案', tasks: [{ id: 'a1', description: '功能一任务' }] },
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'multi-plan')
  assert.equal(result.ok, true)
})

test('分诊矩阵: 缺失信号按 medium 计, 落 plan-final', async () => {
  const { result } = await runEngine({ request: '未评估信号的需求' }, [
    { reasoning: '只给计划不给信号', plan: '计划', tasks: [{ id: 't1', description: '唯一任务' }] },
    review('APPROVED'),
    exec(), review('APPROVED'),
  ])
  assert.equal(result.templateId, 'plan-final')
  assert.equal(result.ok, true)
})

test('分诊契约: planner 提示词不再要求自选模板', async () => {
  const { calls } = await runEngine({ request: '单点小改' }, [
    plan(), exec(), review('APPROVED'),
  ])
  const prompt = byLabel(calls, 'planner:分诊')[0].prompt
  assert.equal(prompt.indexOf('templateId'), -1)
  assert.ok(prompt.indexOf('引擎') >= 0)
})

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

test('审批证据: 重问后仍空证据, 降级 REJECTED 走返工', async () => {
  const { result } = await runEngine({ request: '两点小改' }, [
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
  const frReview = result.reviews.find(function (r) { return r.id === 'fr' })
  assert.equal(frReview.verdict, 'REJECTED')
  assert.ok(frReview.summary.indexOf('验证证据') >= 0)
})

test('升级账: overall 审批通过不清零', async () => {
  const { result } = await runEngine({ request: '两点小改' }, [
    plan({
      templateId: 'plan-final', complexity: 'medium',
      tasks: [
        { id: 't1', description: '任务一', after: [] },
        { id: 't2', description: '任务二', after: [] },
      ],
    }),
    review('APPROVED'),
    exec(), exec(),
    review('REJECTED', { reasons: ['质量不达标'] }),
    { tasks: [{ id: 'rw1', description: '修复质量问题' }] },
    exec(),
    review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.escalations, 1)
  assert.ok(result.tasks.some(function (t) { return t.id === 'rw1' }))
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

// ── S3: 拓扑与治理 ──────────────────────────────────────────────────────────

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

test('计划审批: 连续三次拒绝计满升级账后 blocked', async () => {
  const { result } = await runEngine({ request: '计划始终不合格的需求' }, [
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

test('断点续跑: prefix 种为已完成节点进入交接, 终审依赖含种子', async () => {
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
  assert.ok(execPrompt.indexOf('xt1') >= 0)
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
      templateId: 'multi-plan', scope: 'high',
      subplans: [{ title: '子计划一', description: '功能一' }],
    }),
    { plan: '子方案', tasks: [{ id: 'a1', description: '功能一任务' }] },
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(logs.some(function (m) { return m.indexOf('忽略 prefix') >= 0 }))
  assert.ok(!result.tasks.some(function (t) { return t.id === 'xt9' }))
})

test('调度预算: 四子计划大图完整跑完, 不触发预算 blocked', async () => {
  const subplan = function (n) {
    return { plan: '子计划' + n + '方案', tasks: [
      { id: n + '1', description: '子计划' + n + '任务一' },
      { id: n + '2', description: '子计划' + n + '任务二' },
    ] }
  }
  const { result, logs } = await runEngine({ request: '四个功能点的大型需求' }, [
    plan({
      templateId: 'multi-plan', scope: 'high',
      subplans: [
        { title: '甲', description: '功能甲' },
        { title: '乙', description: '功能乙' },
        { title: '丙', description: '功能丙' },
        { title: '丁', description: '功能丁' },
      ],
    }),
    subplan('a'), subplan('b'),
    exec(), subplan('c'), exec(), review('APPROVED'),
    subplan('d'), exec(), exec(), review('APPROVED'),
    exec(), exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'),
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
    review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(!logs.some(function (m) { return m.indexOf('超出预算') >= 0 }))
  assert.equal(result.reviews.length, 14)
})

// ── S4: 模型故障转移 ────────────────────────────────────────────────────────

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

test('拆解契约: 子计划生成提示词包含并行适用规则', async () => {
  const { calls } = await runEngine({ request: '多功能大型需求' }, [
    plan({
      templateId: 'multi-plan', scope: 'high',
      subplans: [{ title: '子计划一', description: '功能一' }],
    }),
    { plan: '子计划一方案', tasks: [{ id: 'a1', description: '功能一任务一' }] },
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  const subplanCalls = byLabel(calls, 'planner:p')
  assert.ok(subplanCalls.length >= 1)
  for (const c of subplanCalls) {
    assert.ok(c.prompt.indexOf('同样适用于子计划内的任务') >= 0, '子计划提示词缺少并行适用规则')
  }
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

test('尾段替换: multi-plan 子任务升级后子计划审与交叉终审重建', async () => {
  const { result } = await runEngine({ request: '多功能大型需求' }, [
    plan({
      templateId: 'multi-plan', risk: 'high',
      subplans: [{ title: '子计划一', description: '功能一' }],
    }),
    { plan: '子方案', tasks: [{ id: 'a1', description: '功能一任务' }] },
    exec({ status: 'failed', summary: '环境损坏' }),
    exec({ status: 'failed', summary: '环境损坏' }),
    { plan: '换方案', tasks: [{ id: 'e1', description: '换方案重做' }] },
    exec(), review('APPROVED'), review('APPROVED'), review('APPROVED'), review('APPROVED'),
  ])
  assert.equal(result.ok, true)
  assert.ok(result.reviews.some(function (r) { return r.id === 'sr1' && r.verdict === 'APPROVED' }), '子计划审应重建')
  assert.ok(result.reviews.some(function (r) { return r.id === 'xr1' && r.verdict === 'APPROVED' }), '交叉终审 A 应重建')
  assert.ok(result.reviews.some(function (r) { return r.id === 'xr2' && r.verdict === 'APPROVED' }), '交叉终审 B 应重建')
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

test('范围核查: 任务级审批注入非本任务豁免清单', async () => {
  const { calls } = await runEngine({
    request: '两点小改',
    prefix: [{ id: 'p1', description: '无关前置工作', output: '已做', changedFiles: ['src/b.js'] }],
  }, [
    plan({
      templateId: 'step-review', complexity: 'high',
      tasks: [{ id: 't1', description: '任务一', after: [] }],
    }),
    exec(), review('APPROVED'),
  ])
  const reviewCall = byLabel(calls, 'reviewer:r-t1')[0]
  assert.ok(reviewCall.prompt.indexOf('非本任务范围的申报文件') >= 0, '任务级审批缺豁免清单')
  assert.ok(reviewCall.prompt.indexOf('不算越界') >= 0, '范围规则缺豁免语义')
  assert.ok(reviewCall.prompt.indexOf('src/b.js') >= 0, '豁免清单应含种子任务申报文件')
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
