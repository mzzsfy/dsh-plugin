// BDD:整组写回基线合并 — 未编辑条目原样保留;settings 未声明的模型不被删除;
// 孤儿草稿(模型已被他方删除)可观测,不静默丢弃。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeBaselineModels, INPUT_TEXT_IMAGE } from '../src/logic.mjs'

const draft = (overrides) => ({
  checked: { off: true, high: true },
  spellings: { off: '', high: 'ultra' },
  inputMode: INPUT_TEXT_IMAGE,
  ...overrides,
})

const baseline = [
  { id: 'auto', name: 'Auto', reasoningEfforts: { off: null }, input: [] },
  { id: 'plain', compat: { supportsTemperature: false } },
]

test('未编辑条目原样保留(同一引用)', () => {
  const { models } = mergeBaselineModels(baseline, new Map())
  assert.equal(models[1], baseline[1])
  assert.deepEqual(models, baseline)
})

test('编辑条目仅写两字段,其余字段保留;词汇表外档位按最新条目基线透传', () => {
  const { models } = mergeBaselineModels(baseline, new Map([['auto', draft()]]))
  assert.equal(models[0].name, 'Auto')
  assert.deepEqual(models[0].reasoningEfforts, { off: null, high: 'ultra' })
  assert.deepEqual(models[0].input, ['text', 'image'])
})

test('显式把已声明 input 收窄为未声明时删除 input 字段', () => {
  // 基线已声明 ['text'],草稿显式改为未声明 → 投影不一致 → 执行删除
  const declared = [{ id: 'auto', name: 'Auto', reasoningEfforts: { off: null }, input: ['text'] }]
  const { models } = mergeBaselineModels(declared, new Map([['auto', draft({ inputMode: 'unset' })]]))
  assert.equal('input' in models[0], false)
})

test('未触及字段真正原样保留:私有模态与词汇表外档位不被整组保存抹除', () => {
  // 网关私有模态 audio 与他方写入的外档位 custom:草稿与基线投影一致 = 用户未编辑
  const exotic = [{ id: 'm', input: ['text', 'audio'], reasoningEfforts: { custom: 'x' } }]
  const seeded = { checked: {}, spellings: {}, inputMode: 'text' }
  const { models } = mergeBaselineModels(exotic, new Map([['m', seeded]]))
  assert.deepEqual(models[0].input, ['text', 'audio'], '未触及 input 不得被三态投影改写')
  assert.deepEqual(models[0].reasoningEfforts, { custom: 'x' }, '未触及档位不得整字段删除')
})

test('用户显式改动后投影语义照常生效', () => {
  const exotic = [{ id: 'm', input: ['text', 'audio'], reasoningEfforts: { custom: 'x' } }]
  const edited = { checked: { high: true }, spellings: { high: '' }, inputMode: 'text' }
  const { models } = mergeBaselineModels(exotic, new Map([['m', edited]]))
  // 档位被触及:外档位 custom 透传保留 + 新增 high
  assert.deepEqual(models[0].reasoningEfforts, { custom: 'x', high: 'high' })
  // inputMode('text')与基线投影('text')一致 = 未触及 input,私有模态保留
  assert.deepEqual(models[0].input, ['text', 'audio'])
})

test('非字符串 id 键归一:数字 id 命中草稿且不产生假孤儿', () => {
  const numeric = [{ id: 1, reasoningEfforts: { off: null }, input: [] }]
  const numDraft = { checked: { high: true }, spellings: { high: 'u' }, inputMode: 'unset' }
  const { models, droppedDraftIds } = mergeBaselineModels(numeric, new Map([['1', numDraft]]))
  assert.deepEqual(models[0].reasoningEfforts, { high: 'u' })
  assert.deepEqual(droppedDraftIds, [], 'String 归一后 1 与 1 视为同一条目')
  assert.deepEqual(models[0].input, [], 'inputMode 与空数组投影一致,未触及保留')
})

test('未编辑的模型条目数量与顺序不变', () => {
  const { models } = mergeBaselineModels(baseline, new Map([['plain', draft()]]))
  assert.deepEqual(models.map((model) => model.id), ['auto', 'plain'])
})

test('冲突重放:透传基线取最新条目值,他方新增词汇表外档位不丢', () => {
  // 他方在草稿加载后给 auto 新增词汇表外档位 custom64k
  const latest = [
    { id: 'auto', name: 'Auto', reasoningEfforts: { off: null, custom64k: 'thinking-64k' }, input: [] },
  ]
  const drafts = new Map([['auto', draft({ checked: { high: true }, spellings: { high: 'ultra' } })]])
  const { models } = mergeBaselineModels(latest, drafts)
  // 词汇表内键由勾选决定(off 未勾不写回);词汇表外键从写回时点最新条目透传
  assert.deepEqual(
    models[0].reasoningEfforts,
    { custom64k: 'thinking-64k', high: 'ultra' },
    '外档位必须来自写回时点最新条目,而非草稿快照',
  )
})

test('孤儿草稿:模型已被他方删除时草稿不落盘且 droppedDraftIds 可观测', () => {
  const drafts = new Map([
    ['auto', draft()],
    ['ghost', draft({ checked: { low: true }, spellings: {} })],
  ])
  const { models, droppedDraftIds } = mergeBaselineModels(baseline, drafts)
  assert.deepEqual(models.map((model) => model.id), ['auto', 'plain'])
  assert.deepEqual(droppedDraftIds, ['ghost'])
})

test('无孤儿草稿时 droppedDraftIds 为空数组', () => {
  const { droppedDraftIds } = mergeBaselineModels(baseline, new Map([['auto', draft()]]))
  assert.deepEqual(droppedDraftIds, [])
})

test('基线为不可表达形态(字符串)的条目跳过档位重写,其余字段照常', () => {
  const weird = [{ id: 'str', reasoningEfforts: 'high', input: ['text'] }]
  const { models } = mergeBaselineModels(weird, new Map([['str', draft({ checked: { low: true }, spellings: {} })]]))
  assert.equal(models[0].reasoningEfforts, 'high', '字符串形态基线原样保留')
  assert.deepEqual(models[0].input, ['text', 'image'], 'input 照常重写')
})
