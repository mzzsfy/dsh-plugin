// template 校验器 BDD(场景名即 Given/When/Then;契约源 docs/rsww-v4/feat/*.md)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTemplate, parseErrorLine, validateTemplate, validateTemplateSet, buildSchema } from '../lib/template.mjs'

const parse = (text) => { try { return parseTemplate(text) } catch (e) { return { __parseError: e.message } } }
const targets = (errors) => errors.map((e) => e.target)
const hasMsg = (errors, frag) => errors.some((e) => e.message.includes(frag))

// 基准合法模板(default v4 形态,含审批 blocked 出口)
const DEFAULT_TPL = {
  id: 'default', label: '通用默认',
  description: '评估需求后拆解执行、审查修正、交付汇总的通用流程。',
  steps: [
    { id: 'triage', label: '需求评估', slot: 'planner', prompt: '评估需求。需求:{request}', outputs: { brief: '简报', tasks: '要点' } },
    { id: 'execute', label: '执行', after: ['triage'], prompt: '按简报执行。简报:{triage.brief} 要点:{triage.tasks}', outputs: { result: '结果', pending: '未完成项' } },
    { id: 'review', label: '审查', type: 'approve', slot: 'reviewer-approve', after: ['execute'], target: 'execute', rounds: 2, onExhausted: 'blocked', prompt: '对照验收口径审查。需求:{request}' },
    { id: 'deliver', label: '交付汇总', after: ['review'], prompt: '汇总交付。需求:{request}', outputs: { report: '交付说明' } },
  ],
}

// 基准合法模板(lite v4 形态,含升级步出口:审批对象上游可引用)
const LITE_TPL = {
  id: 'lite', label: '轻量直办',
  description: '单一任务直达,终审把关,僵局升级兜底。',
  inputs: { brief: '需求简报;独立运行时留空' },
  steps: [
    { id: 'task', label: '任务提炼', slot: 'planner', prompt: '提炼任务卡。需求:{request} 简报:{input.brief}', outputs: { task: '任务卡' } },
    { id: 'execute', label: '执行', after: ['task'], prompt: '执行。任务卡:{task.task}', outputs: { result: '结果' } },
    { id: 'final-approve', label: '终审', type: 'approve', slot: 'reviewer-approve', after: ['execute'], target: 'execute', rounds: 2, onExhausted: 'escalate', prompt: '终审。需求:{request}' },
    { id: 'escalate', label: '升级兜底', slot: 'executor-escalate', prompt: '保守交付。任务卡:{task.task}', outputs: { fallback: '降级交付' } },
  ],
}

test('Given 合法 default 模板 When 校验 Then 零错误', () => {
  assert.deepEqual(validateTemplate(DEFAULT_TPL), [])
})

test('Given 合法 lite 模板(升级步引用审批对象上游) When 校验 Then 零错误', () => {
  assert.deepEqual(validateTemplate(LITE_TPL), [])
})

test('Given 未知顶层字段 When 校验 Then top:<field> 错误', () => {
  const errors = validateTemplate({ ...DEFAULT_TPL, workflow: {} })
  assert.ok(targets(errors).includes('top:workflow'))
})

test('Given 未知步骤字段 When 校验 Then step:<id> 逐条错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[0].slot2 = 'planner'
  const errors = validateTemplate(t)
  assert.ok(targets(errors).includes('step:triage'))
  assert.ok(hasMsg(errors, 'slot2'))
})

test('Given id 不匹配 ^[a-z][a-z0-9-]*$ When 校验 Then top:id 错误', () => {
  const errors = validateTemplate({ ...DEFAULT_TPL, id: 'Bad_Id' })
  assert.ok(targets(errors).includes('top:id'))
})

test('Given 步骤 id 重复 When 校验 Then 错误含重复提示', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[1].id = 'triage'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '重复'))
})

test('Given approve.target 指向不存在步骤 When 校验 Then 错误含 target 引用', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[2].target = 'ghost'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'target'))
})

test('Given approve 步声明非 reviewer-approve 的 slot When 校验 Then 错误提示固定绑定', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[2].slot = 'reviewer'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'reviewer-approve'))
})

test('Given 普通步骤缺 outputs When 校验 Then 错误提示产出契约必填', () => {
  const t = structuredClone(DEFAULT_TPL)
  delete t.steps[0].outputs
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'outputs'))
})

test('Given 引用未声明入参 {input.x} When 校验 Then 入参引用错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.inputs = { topic: '主题' }
  t.steps[0].prompt = '主题:{input.topic} 缺失:{input.ghost}'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'input.ghost'))
})

test('Given 已声明入参引用 When 校验 Then 通过', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.inputs = { topic: '主题' }
  t.steps[0].prompt = '主题:{input.topic}'
  assert.deepEqual(validateTemplate(t), [])
})

test('Given {item} 出现在非 for_each 步骤 When 校验 Then 占位符错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[1].prompt = '处理:{item}'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'for_each'))
})

test('Given 自引用产出且为 sequential 循环 When 校验 Then 通过(首实例空串豁免)', () => {
  const t = {
    id: 'novel', label: '小说',
    steps: [
      { id: 'outline', slot: 'planner', prompt: '大纲:{request}', outputs: { chapters: '章节' }, listOutputs: ['chapters'] },
      { id: 'write', for_each: 'outline.chapters', mode: 'sequential', prompt: '上一章:{write.summary} 需求:{request}', outputs: { summary: '梗概' } },
    ],
  }
  assert.deepEqual(validateTemplate(t), [])
})

test('Given 自引用产出且非循环步骤 When 校验 Then 自引用错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[0].prompt = '自引:{triage.brief}'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '自引用'))
})

test('Given 引用不存在步骤产出 When 校验 Then 引用错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[3].prompt = '汇总:{ghost.report}'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '不存在'))
})

test('Given 引用未声明产出字段 When 校验 Then 产出未声明错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[3].prompt = '汇总:{triage.ghost}'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'triage.ghost'))
})

test('Given 引用审批步骤产出 When 校验 Then 拒绝(裁决不进产出账)', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[3].prompt = '结论:{review.verdict}'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '审批步骤'))
})

test('Given listOutputs 引用未声明产出 When 校验 Then 错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[0].listOutputs = ['ghost']
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'listOutputs'))
})

test('Given for_each 数据源未声明 listOutputs When 校验 Then 数据源错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[1].for_each = 'triage.tasks'
  t.steps[1].mode = 'sequential'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'listOutputs'))
})

test('Given for_each 步缺 mode When 校验 Then 要求显式声明 mode', () => {
  const t = {
    id: 'x', label: 'x',
    steps: [
      { id: 'a', slot: 'planner', prompt: '{request}', outputs: { items: '列表' }, listOutputs: ['items'] },
      { id: 'b', for_each: 'a.items', prompt: '{item}', outputs: { r: '结果' } },
    ],
  }
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'mode'))
})

test('Given load 资源无 skill:/doc: 前缀 When 校验 Then 前缀错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[0].load = ['web-search']
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'skill:'))
})

test('Given after 引用不存在步骤 When 校验 Then 引用错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[1].after = ['ghost']
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'ghost'))
})

test('Given 依赖环(b 显式依赖 c,c 缺省依赖 b) When 校验 Then 环错误', () => {
  const t = {
    id: 'cyc', label: 'cyc',
    steps: [
      { id: 'a', slot: 'planner', prompt: '{request}', outputs: { o: 'o' } },
      { id: 'b', prompt: '{request}', outputs: { o: 'o' }, after: ['c'] },
      { id: 'c', prompt: '{request}', outputs: { o: 'o' } },
    ],
  }
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '依赖环'))
})

test('Given 缺省依赖链(未声明 after 依赖文档序前一步) When 校验 Then 通过且无环', () => {
  const t = structuredClone(DEFAULT_TPL)
  for (const s of t.steps) delete s.after
  assert.deepEqual(validateTemplate(t), [])
})

test('Given 升级步被其他步骤 after 引用 When 校验 Then 拒绝', () => {
  const t = structuredClone(LITE_TPL)
  t.steps[3].outputs = { fallback: '降级' }
  t.steps.push({ id: 'wrap', prompt: '引用:{request}', outputs: { r: 'r' }, after: ['escalate'] })
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '升级步'))
})

test('Given 升级步声明 after When 校验 Then 拒绝(脱离常规调度图)', () => {
  const t = structuredClone(LITE_TPL)
  t.steps[3].after = ['task']
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '升级步'))
})

test('Given 升级步 prompt 引用审批对象(target)产出 When 校验 Then 拒绝', () => {
  const t = structuredClone(LITE_TPL)
  t.steps[3].prompt = '保守交付。执行结果:{execute.result}'
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '审批对象'))
})

test('Given approve 步声明 outputs When 校验 Then 拒绝(裁决契约引擎生成)', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[2].outputs = { verdict: '裁决' }
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'approve'))
})

test('Given flow 步动态路由且路由占位符合法 When 校验 Then 通过', () => {
  const t = {
    id: 'multi', label: '分诊',
    steps: [
      { id: 'triage', slot: 'planner', prompt: '分诊:{request}', outputs: { route: '路由', brief: '简报' } },
      { id: 'run', type: 'flow', after: ['triage'], flow: '{triage.route}', input: { brief: '{triage.brief}' } },
      { id: 'deliver', after: ['run'], prompt: '汇总:{request}', outputs: { report: '说明' } },
    ],
  }
  assert.deepEqual(validateTemplate(t), [])
})

test('Given flow 步声明 prompt When 校验 Then 拒绝', () => {
  const t = {
    id: 'multi', label: '分诊',
    steps: [
      { id: 'run', type: 'flow', flow: 'lite', prompt: '不该有', },
    ],
  }
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'prompt'))
})

test('Given input 值非单占位符 When 校验 Then 格式错误', () => {
  const t = {
    id: 'multi', label: '分诊',
    steps: [
      { id: 'run', type: 'flow', flow: 'lite', input: { brief: '硬编码' } },
    ],
  }
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, '单占位符'))
})

test('Given maxFail 越界 When 校验 Then 范围错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[0].maxFail = 11
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'maxFail'))
})

test('Given rounds 越界 When 校验 Then 范围错误', () => {
  const t = structuredClone(DEFAULT_TPL)
  t.steps[2].rounds = 0
  const errors = validateTemplate(t)
  assert.ok(hasMsg(errors, 'rounds'))
})

test('Given steps 为空数组 When 校验 Then top:steps 错误', () => {
  const errors = validateTemplate({ id: 'x', label: 'x', steps: [] })
  assert.ok(targets(errors).includes('top:steps'))
})

test('Given JSON 文本合法 When parseTemplate Then 得到对象', () => {
  const parsed = parse(JSON.stringify({ id: 'x', label: 'X', steps: [{ id: 'a', prompt: '{request}', outputs: { o: 'o' } }] }))
  assert.equal(parsed.id, 'x')
})

test('Given JSON 语法错误 When parseTemplate 抛错 Then parseErrorLine 提取行号', () => {
  let msg = ''
  try { parseTemplate('{"id":"x"} extra }') } catch (e) { msg = e.message }
  assert.ok(msg)
  const line = parseErrorLine('Unexpected token at 3:5')
  assert.equal(line, 3)
})

test('Given 模板集合字面 flow 引用存在 When validateTemplateSet Then 零错误', () => {
  const errors = validateTemplateSet([structuredClone(LITE_TPL), {
    id: 'entry', label: '入口',
    steps: [{ id: 'run', type: 'flow', flow: 'lite' }],
  }])
  assert.deepEqual(errors, [])
})

test('Given 字面 flow 引用不存在集合 When validateTemplateSet Then 存在性错误', () => {
  const errors = validateTemplateSet([{ id: 'entry', label: '入口', steps: [{ id: 'run', type: 'flow', flow: 'ghost' }] }])
  assert.ok(hasMsg(errors, '不存在于模板集合'))
})

test('Given 集合嵌套深度超 3 When validateTemplateSet Then 深度错误', () => {
  const mk = (id, flow) => ({ id, label: id, steps: [{ id: 'run', type: 'flow', flow }] })
  const errors = validateTemplateSet([mk('a', 'b'), mk('b', 'c'), mk('c', 'd'), mk('d', 'lite'), structuredClone(LITE_TPL)])
  assert.ok(hasMsg(errors, '嵌套深度'))
})

test('Given 集合含损坏成员 When validateTemplateSet Then 其余成员照常校验(跳过不阻塞)', () => {
  const broken = { id: 'BROKEN', label: '坏' }
  const errors = validateTemplateSet([broken, structuredClone(LITE_TPL)])
  assert.ok(targets(errors).includes('top:id'))
  assert.deepEqual(validateTemplate(structuredClone(LITE_TPL)), [])
})

test('Given 普通步骤 outputs When buildSchema Then object+required 全集+additionalProperties false', () => {
  const schema = buildSchema({ outputs: { a: '甲', b: '乙' }, listOutputs: ['b'] })
  assert.deepEqual(schema, {
    type: 'object', required: ['a', 'b'], additionalProperties: false,
    properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' } } },
  })
})

test('Given approve 步 When buildSchema Then 固定裁决契约(verdict 枚举+comments)', () => {
  const schema = buildSchema({ type: 'approve' })
  assert.deepEqual(schema.properties.verdict, { type: 'string', enum: ['APPROVED', 'REJECTED'] })
  assert.deepEqual(schema.required, ['verdict', 'comments'])
})

test('Given 顶层 autoApprove 布尔 When validateTemplate Then 通过(v5 新增键)', () => {
  const t = { id: 'x', label: 'X', autoApprove: true, steps: [{ id: 'a', prompt: 'p', outputs: { o: '说明' } }] }
  assert.deepEqual(validateTemplate(t), [])
})

test('Given 顶层 autoApprove 非布尔 When validateTemplate Then 拒 top:autoApprove', () => {
  const t = { id: 'x', label: 'X', autoApprove: 'yes', steps: [{ id: 'a', prompt: 'p', outputs: { o: '说明' } }] }
  const errs = validateTemplate(t)
  assert.ok(errs.some((e) => e.target === 'top:autoApprove' && e.message.includes('布尔')), JSON.stringify(errs))
})
