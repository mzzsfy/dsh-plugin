// undo journal 单元层:原状只记首次、还原两形态、同名换定义各自成条,
// 以及"定义被回收后记录随 sweep 释放"(P3:journal 只增不减)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUndoJournal } from '../src/journal.mjs'

/** 可控 ref:模拟存活/已回收两种状态。 */
function controllableRef(makeDefinition) {
  const definitions = []
  return {
    definitions,
    makeRef: (definition) => {
      const slot = { definition }
      definitions.push(slot)
      return { deref: () => slot.definition }
    },
  }
}

test('J1 原状只记首次:同一定义重复 record 不覆盖现场', () => {
  const journal = createUndoJournal()
  const definition = { name: 'web' }
  journal.record(definition)
  assert.equal(journal.size, 1)
  definition.deferLoading = true
  journal.record(definition)
  assert.equal(journal.size, 1, '同一定义只有一条记录')
  journal.restoreAll()
  assert.equal('deferLoading' in definition, false, '还原为首次现场(无该字段)')
})

test('J2 还原两形态:本包打标 → 删字段;本包清标 → 原值回填', () => {
  const journal = createUndoJournal()
  const marked = { name: 'web' }
  const cleared = { name: 'read', deferLoading: true }
  journal.record(marked)
  marked.deferLoading = true
  journal.record(cleared)
  delete cleared.deferLoading
  journal.restoreAll()
  assert.equal('deferLoading' in marked, false)
  assert.equal(cleared.deferLoading, true, '被清掉的自带声明按原值恢复')
  assert.equal(journal.size, 0, '还原后清空')
})

test('J3 同名换定义:新旧对象各自成条,退场逐条还原', () => {
  const journal = createUndoJournal()
  const original = { name: 'web' }
  const replacement = { name: 'web' }
  journal.record(original)
  original.deferLoading = true
  journal.record(replacement)
  replacement.deferLoading = true
  assert.equal(journal.size, 2, '旧记录不得挡住新对象另记一条')
  journal.restoreAll()
  assert.equal('deferLoading' in original, false)
  assert.equal('deferLoading' in replacement, false)
})

// Given 旧 definition 已离开注册表且无人持引用(已被回收);
// When 记录原状后 sweep;
// Then 记录释放(不再钉住),restoreAll 跳过死引用不抛。
test('J4 已回收定义的记录随 sweep 释放', () => {
  const refs = controllableRef()
  const journal = createUndoJournal(refs.makeRef)
  const gone = { name: 'gone' }
  journal.record(gone)
  gone.deferLoading = true
  assert.equal(journal.size, 1)
  refs.definitions[0].definition = undefined // 模拟 V8 回收
  journal.sweep()
  assert.equal(journal.size, 0, '回收后的记录必须释放')
  journal.restoreAll()
  assert.equal(journal.size, 0)
})

test('J5 记录释放后可重新记录同一名的新定义', () => {
  const refs = controllableRef()
  const journal = createUndoJournal(refs.makeRef)
  const first = { name: 'web' }
  journal.record(first)
  first.deferLoading = true
  refs.definitions[0].definition = undefined
  journal.sweep()
  const second = { name: 'web' }
  journal.record(second)
  second.deferLoading = true
  assert.equal(journal.size, 1)
  journal.restoreAll()
  assert.equal('deferLoading' in second, false)
})

test('J6 存活定义的记录不被 sweep 丢弃(层换代后重建仍可还原)', () => {
  const journal = createUndoJournal()
  const definition = { name: 'churn' }
  journal.record(definition)
  definition.deferLoading = true
  journal.sweep()
  assert.equal(journal.size, 1, '仍被持有的定义保留原状记录')
  journal.restoreAll()
  assert.equal('deferLoading' in definition, false)
})

// Given 记录已被 sweep 丢弃;When 同一定义再次被打标(仅测试构造,生产由回收互斥);
// Then 记录重新纳入集合,退场照常还原该定义。
test('J7 记录释放后同一定义再次记录:重新纳入并还原', () => {
  const refs = controllableRef()
  const journal = createUndoJournal(refs.makeRef)
  const definition = { name: 'web' }
  journal.record(definition)
  refs.definitions[0].definition = undefined
  journal.sweep()
  assert.equal(journal.size, 0)
  refs.definitions[0].definition = definition
  journal.record(definition)
  assert.equal(journal.size, 1)
  definition.deferLoading = true
  journal.restoreAll()
  assert.equal('deferLoading' in definition, false)
  assert.equal(journal.size, 0)
})
