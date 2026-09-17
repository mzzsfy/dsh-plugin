// planner-gate BDD(场景源 docs/rsww-v5/feat/planner-gate.md;规则编号 #n 与文档一致)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gate } from '../lib/planner-gate.mjs'

// 夹具=default 形态(triage→execute→review(approve,target execute)→deliver)与 lite 形态(含升级兜底)
const mkTemplate = (steps, over = {}) => ({
  entry: { id: 'default', label: '通用默认', description: '评估需求后拆解执行、审查修正、交付汇总的通用流程。', enabled: true, json: '', ...over },
  parsed: { id: 'default', description: '评估需求后拆解执行、审查修正、交付汇总的通用流程。', ...over, steps },
})
const ai = (id, after, outs = { out: '说明' }) => ({ id, label: id, after, prompt: `做 {request}${after ? '' : ''}`, outputs: outs })
const defaultSteps = () => [
  ai('triage', undefined, { brief: '简报', tasks: '要点' }),
  { ...ai('execute', ['triage'], { result: '结果', pending: '未完' }), prompt: '按 {triage.brief} 执行 {request}' },
  { id: 'review', label: '审查', type: 'approve', after: ['execute'], target: 'execute', onExhausted: 'blocked', prompt: '审查 {request}' },
  ai('deliver', ['review'], { report: '交付说明' }),
]
const liteSteps = () => [
  ai('task', undefined, { task: '任务卡' }),
  ai('execute', ['task'], { result: '结果' }),
  { id: 'final-approve', label: '终审', type: 'approve', after: ['execute'], target: 'execute', rounds: 2, onExhausted: 'escalate', prompt: '终审 {request}' },
  { ...ai('escalate', undefined, { fallback: '降级交付' }), prompt: '保守完成 {request}' },
]
const anchored = { expectedTemplateId: 'default' }
const planOf = (over = {}) => ({ request: '整理文档', templateId: 'default', inputs: {}, ...over })
const fullSteps = () => [
  { ref: 'triage', note: '要点a', done: '口径a' },
  { ref: 'execute', note: '要点b', done: '口径b' },
  { ref: 'review', note: '要点c', done: '口径c' },
  { ref: 'deliver', note: '要点d', done: '口径d' },
]

test('Given 合法全序规划 When gate Then ok 且 deps 与模板依赖一致 source=model', () => {
  const r = gate(planOf({ brief: '口径', steps: fullSteps() }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, true)
  assert.equal(r.planScript.source, 'model')
  assert.deepEqual(r.planScript.deps, { triage: [], execute: ['triage'], review: ['execute'], deliver: ['review'] })
  assert.deepEqual(r.warnings, [])
})

test('Given 合法裁剪(execute,review 保留外) When gate Then ok 且 deliver 依赖压缩为 execute', () => {
  const r = gate(planOf({
    brief: '口径',
    steps: [
      { ref: 'triage', note: 'a', done: 'a' },
      { ref: 'execute', note: 'b', done: 'b' },
      { ref: 'deliver', note: 'd', done: 'd' },
    ],
  }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, true)
  assert.deepEqual(r.planScript.deps.deliver, ['execute'])
})

test('Given 裁剪破坏依赖(execute 被裁而 review 为 approve 步 target=execute) When gate Then 拒 target=steps', () => {
  const r = gate(planOf({
    brief: '口径',
    steps: [
      { ref: 'triage', note: 'a', done: 'a' },
      { ref: 'review', note: 'c', done: 'c' },
    ],
  }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'steps' && e.message.includes('approve 目标不在剧本')), JSON.stringify(r.errors))
})

test('Given 审批耗尽出口被裁 When gate Then ok 且 warnings 含 w1', () => {
  const r = gate(planOf({
    templateId: 'lite',
    brief: '口径',
    steps: [
      { ref: 'task', note: 'a', done: 'a' },
      { ref: 'execute', note: 'b', done: 'b' },
      { ref: 'final-approve', note: 'c', done: 'c' },
    ],
  }), mkTemplate(liteSteps(), { id: 'lite' }), { expectedTemplateId: 'lite' })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.target === 'steps' && w.message.includes('耗尽兜底降级为 blocked')), JSON.stringify(r.warnings))
})

test('Given 空口径(note 为空串) When gate Then 拒 target=steps[i].note', () => {
  const r = gate(planOf({ brief: '口径', steps: [{ ref: 'execute', note: '', done: '口径b' }] }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'steps[0].note' && e.message.includes('执行要点')), JSON.stringify(r.errors))
})

test('Given 锚定不符 When gate Then 拒 target=templateId', () => {
  // orchestrator 按 templateId 查表:novel 存在且 enabled,故 gate 收到 novel 条目;锚定为 default → #1b 拒
  const novel = mkTemplate(defaultSteps(), { id: 'novel' })
  const r = gate(planOf({ templateId: 'novel', brief: '口径', steps: fullSteps() }), novel, anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'templateId' && e.message.includes('与本组合锚定模板不符')), JSON.stringify(r.errors))
})

test('Given plan 存在但无 steps When gate Then 拒 至少保留一个步骤 且不落保底', () => {
  const r = gate(planOf({ brief: '口径' }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'steps' && e.message.includes('至少保留一个步骤')), JSON.stringify(r.errors))
})

test('Given plan 缺省 When gate Then ok 保底全序 note/done 空 brief=模板 description source=fallback', () => {
  const r = gate(undefined, mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, true)
  assert.equal(r.planScript.source, 'fallback')
  assert.equal(r.planScript.brief, '评估需求后拆解执行、审查修正、交付汇总的通用流程。')
  assert.deepEqual(r.planScript.steps.map((s) => s.ref), ['triage', 'execute', 'review', 'deliver'])
  assert.ok(r.planScript.steps.every((s) => s.note === '' && s.done === ''))
  // 保底全序的依赖压缩闭包=剧本全集:链式模板 deps 必须保持链式,不得全空
  assert.deepEqual(r.planScript.deps, { triage: [], execute: ['triage'], review: ['execute'], deliver: ['review'] })
})

test('Given 保底 × autoApprove=true When gate Then ok 且 warnings 含 w2', () => {
  const r = gate(undefined, mkTemplate(defaultSteps(), { autoApprove: true }), anchored)
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.target === 'plan' && w.message.includes('autoApprove')), JSON.stringify(r.warnings))
})

test('Given 未声明入参 When gate Then 拒 target=inputs.<k>', () => {
  const r = gate(planOf({ inputs: { ghost: 'x' }, brief: '口径', steps: fullSteps() }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'inputs.ghost' && e.message.includes('未声明的入参')), JSON.stringify(r.errors))
})

test('Given 入参非字符串 When gate Then 拒 target=inputs.<k>', () => {
  const t = mkTemplate(defaultSteps())
  t.parsed.inputs = { brief: '简报' }
  const r = gate(planOf({ inputs: { brief: 3 }, brief: '口径', steps: fullSteps() }), t, anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'inputs.brief' && e.message.includes('必须为字符串')), JSON.stringify(r.errors))
})

test('Given 未知 ref When gate Then 拒 target=steps[i].ref', () => {
  const r = gate(planOf({ brief: '口径', steps: [{ ref: 'ghost', note: 'a', done: 'a' }] }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'steps[0].ref' && e.message.includes('未知步骤')), JSON.stringify(r.errors))
})

test('Given 重复 ref When gate Then 拒 target=steps[i].ref', () => {
  const r = gate(planOf({
    brief: '口径',
    steps: [
      { ref: 'execute', note: 'a', done: 'a' },
      { ref: 'execute', note: 'b', done: 'b' },
    ],
  }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'steps[1].ref' && e.message.includes('步骤重复')), JSON.stringify(r.errors))
})

test('Given 顺序颠倒 When gate Then 拒 裁剪破坏依赖', () => {
  const r = gate(planOf({
    brief: '口径',
    steps: [
      { ref: 'execute', note: 'b', done: 'b' },
      { ref: 'triage', note: 'a', done: 'a' },
    ],
  }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'steps' && e.message.includes('顺序颠倒')), JSON.stringify(r.errors))
})

test('Given 保留步占位符引用被裁步 When gate Then 拒 裁剪破坏依赖', () => {
  const chain = [
    ai('x', undefined, { o: '产出o' }),
    { ...ai('y', ['x']), prompt: '用 {x.o} 做 {request}' },
    { ...ai('z', ['y']), prompt: '用 {y.o} 做 {request}' },
  ]
  const r = gate(planOf({
    brief: '口径',
    steps: [
      { ref: 'x', note: 'a', done: 'a' },
      { ref: 'z', note: 'c', done: 'c' },
    ],
  }), mkTemplate(chain), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'steps' && e.message.includes('裁剪破坏依赖') && e.message.includes('y')), JSON.stringify(r.errors))
})

test('Given 模板不存在 When gate Then 拒 target=templateId', () => {
  const r = gate(planOf({ templateId: 'ghost', brief: '口径', steps: fullSteps() }), null, anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'templateId' && e.message.includes('模板不存在')), JSON.stringify(r.errors))
})

test('Given 模板已禁用 When gate Then 拒 target=templateId', () => {
  const r = gate(planOf({ brief: '口径', steps: fullSteps() }), mkTemplate(defaultSteps(), { enabled: false }), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'templateId' && e.message.includes('模板已禁用')), JSON.stringify(r.errors))
})

test('Given steps 有而 brief 空 When gate Then 拒 target=brief', () => {
  const r = gate(planOf({ brief: '  ', steps: fullSteps() }), mkTemplate(defaultSteps()), anchored)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.target === 'brief' && e.message.includes('验收口径为空')), JSON.stringify(r.errors))
})
