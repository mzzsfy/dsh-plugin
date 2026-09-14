// flows.mjs DSL 校验单测:未知字段/依赖环/for_each 来源/嵌套 flow 校验逐条报错语义。
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateFlow, validateFlowSet, topoOrder, collectLoadRefs, parseFlowJson5, placeholders, SLOT_KEYS, MAX_FLOW_DEPTH, LOAD_SCHEMES } from '../lib/flows.mjs'
import JSON5 from 'json5'

const OK = {
  id: 'news', label: '新闻', description: 'd',
  steps: [
    { id: 'a', prompt: '做A', outputs: { x: 'X' } },
    { id: 'b', prompt: '做B {a.x}', outputs: { y: 'Y' } },
  ],
}

test('合法流程零错误;未声明依赖按文档序链式(topoOrder)', () => {
  assert.deepEqual(validateFlow(OK), [])
  const order = topoOrder(OK.steps)
  assert.deepEqual(order, ['a', 'b'], '缺省链式序')
})

test('未知字段拒绝(拼写错误防静默失效)', () => {
  const bad = { ...OK, steps: [{ id: 'a', prompt: 'p', outputz: { x: 'X' } }] }
  assert.ok(validateFlow(bad).some((e) => e.includes('未知字段') && e.includes('outputz')))
})

test('依赖环拒绝;after 引用不存在拒绝', () => {
  const cycle = { id: 'c', steps: [
    { id: 'a', prompt: 'p', after: ['b'] },
    { id: 'b', prompt: 'p', after: ['a'] },
  ] }
  assert.ok(validateFlow(cycle).some((e) => e.includes('环') || e.includes('不存在')))
  const ghost = { id: 'g', steps: [{ id: 'a', prompt: 'p', after: ['nope'] }] }
  assert.ok(validateFlow(ghost).some((e) => e.includes('nope')))
})

test('流程 label/description 必填;for_each 数据源必须是上游 listOutputs 产出', () => {
  const bare = { id: 'bare', steps: [{ id: 'a', prompt: 'p' }] }
  assert.ok(validateFlow(bare).some((e) => e.includes('label')))
  const bad = { id: 'f', label: 'L', description: 'd', steps: [
    { id: 'src', prompt: 'p', outputs: { items: '清单' } },
    { id: 'each', prompt: '{item}', for_each: 'src.items' },
  ] }
  assert.ok(validateFlow(bad).some((e) => e.includes('listOutputs')))
  const good = { id: 'f2', label: 'L', description: 'd', steps: [
    { id: 'src', prompt: 'p', outputs: { items: '清单' }, listOutputs: ['items'] },
    { id: 'each', prompt: '{item}', for_each: 'src.items' },
  ] }
  assert.deepEqual(validateFlow(good), [])
})

test('并行 for_each 禁止自引用产出', () => {
  const bad = { id: 'fp', steps: [
    { id: 'src', prompt: 'p', outputs: { items: 'L' }, listOutputs: ['items'] },
    { id: 'each', prompt: '前文:{each.s}', for_each: 'src.items', mode: 'parallel', outputs: { s: 'S' } },
  ] }
  assert.ok(validateFlow(bad).some((e) => e.includes('自引用') || e.includes('parallel')))
})

test('type=flow:flow 字段必填,outputs 禁止,input 必须单占位符', () => {
  const noFlow = { id: 'n1', steps: [{ id: 'go', type: 'flow' }] }
  assert.ok(validateFlow(noFlow).some((e) => e.includes('flow')))
  const withOut = { id: 'n2', steps: [{ id: 'go', type: 'flow', flow: 'x', outputs: { a: 'A' } }] }
  assert.ok(validateFlow(withOut).some((e) => e.includes('outputs')))
  const multiInput = { id: 'n3', steps: [{ id: 'go', type: 'flow', flow: 'x', input: { a: '{t.a} {t.b}' } }] }
  assert.ok(validateFlow(multiInput).some((e) => e.includes('占位符')))
})

test('validateFlowSet:跨流程字面量引用存在性', () => {
  const main = { id: 'm', steps: [{ id: 'go', type: 'flow', flow: 'sub' }, { id: 'use', prompt: '{go.r}', type: 'flow', flow: 'sub2' }] }
  const errors = validateFlowSet([main])
  assert.ok(errors.some((e) => e.includes('sub2')), '不存在的子流程目标应报错')
})

test('collectLoadRefs 汇总全部步骤 load(含嵌套目标)', () => {
  const flow = { id: 'r', steps: [
    { id: 'a', prompt: 'p', load: ['skill:web-search', 'doc:docs/a.md'] },
    { id: 'b', prompt: 'p', load: ['doc:docs/b.md'] },
  ] }
  assert.deepEqual(collectLoadRefs(flow).sort(), ['doc:docs/a.md', 'doc:docs/b.md', 'skill:web-search'])
})

test('parseFlowJson5:合法解析+校验;非法抛错', () => {
  assert.equal(parseFlowJson5(JSON5.stringify(OK)).id, 'news')
  assert.throws(() => parseFlowJson5('{ id: "x" }'), /校验|steps|必填/)
})

test('占位符提取与常量导出', () => {
  assert.deepEqual(placeholders('做{request} 引用{a.x} 输入{input.k}').sort(), ['a.x', 'input.k', 'request'])
  assert.equal(SLOT_KEYS.length, 16)
  assert.equal(MAX_FLOW_DEPTH, 3)
  assert.deepEqual(LOAD_SCHEMES, ['skill', 'doc'])
})
