import test from 'node:test'
import assert from 'node:assert/strict'
import { planLayer, planConvergence } from '../src/converge.mjs'

const defs = (map) => {
  const data = new Map(Object.entries(map))
  return [(name) => [...data.keys()], (name) => data.get(name)]
}

test('planLayer 白名单内外分野:内清外打(SC-1)', () => {
  const [names, definitionOf] = defs({ read: { name: 'read' }, shell: { name: 'shell' }, web_search: { name: 'web_search' } })
  assert.deepEqual(planLayer(names(), definitionOf, new Set(['read', 'shell'])), { toDefer: ['web_search'], toClear: [] })
})

test('planLayer 覆盖作者声明:白名单命中即清自带 defer(SC-2)', () => {
  const [names, definitionOf] = defs({ read: { name: 'read' }, web_search: { name: 'web_search', deferLoading: true } })
  assert.deepEqual(planLayer(names(), definitionOf, new Set(['web_search'])), { toDefer: ['read'], toClear: ['web_search'] })
})

test('planLayer 幂等:已处目标态的名不出现在决策里', () => {
  const [names, definitionOf] = defs({ read: { name: 'read' }, web_search: { name: 'web_search', deferLoading: true } })
  assert.deepEqual(planLayer(names(), definitionOf, new Set(['read'])), { toDefer: [], toClear: [] })
})

test('planLayer deferLoading: false 视为未打标,进 toDefer', () => {
  const [names, definitionOf] = defs({ odd: { name: 'odd', deferLoading: false } })
  assert.deepEqual(planLayer(names(), definitionOf, new Set()), { toDefer: ['odd'], toClear: [] })
})

test('planLayer 空白名单 = 全部 defer', () => {
  const [names, definitionOf] = defs({ a: { name: 'a' }, b: { name: 'b' } })
  assert.deepEqual(planLayer(names(), definitionOf, new Set()), { toDefer: ['a', 'b'], toClear: [] })
})

test('planConvergence 全层汇总 + 未知名以层名并集判定(SC-8)', () => {
  const [globalNames, globalOf] = defs({ read: { name: 'read' } })
  const [agentNames, agentOf] = defs({ web_search: { name: 'web_search' } })
  const layers = [
    { key: 'global', names: globalNames, definitionOf: globalOf },
    { key: 'agent#1', names: agentNames, definitionOf: agentOf },
  ]
  const plan = planConvergence(layers, ['read', 'todo_write', 'no_such_tool'])
  assert.deepEqual(plan.perLayer, [
    { key: 'global', toDefer: [], toClear: [] },
    { key: 'agent#1', toDefer: ['web_search'], toClear: [] },
  ])
  assert.deepEqual(plan.unknownAllowlisted, ['todo_write', 'no_such_tool'])
})

test('planConvergence 空白名单 = 全层全部 defer', () => {
  const [agentNames, agentOf] = defs({ a: { name: 'a' }, b: { name: 'b' } })
  const plan = planConvergence([{ key: 'agent#1', names: agentNames, definitionOf: agentOf }], [])
  assert.deepEqual(plan.perLayer, [{ key: 'agent#1', toDefer: ['a', 'b'], toClear: [] }])
  assert.deepEqual(plan.unknownAllowlisted, [])
})

test('planConvergence 隐式白名单:tool_search 不进 toDefer 也不进未知名(SC-22)', () => {
  const [globalNames, globalOf] = defs({ tool_search: { name: 'tool_search' }, web: { name: 'web' } })
  const plan = planConvergence([{ key: 'global', names: globalNames, definitionOf: globalOf }], [], ['tool_search'])
  assert.deepEqual(plan.perLayer, [{ key: 'global', toDefer: ['web'], toClear: [] }])
  assert.deepEqual(plan.unknownAllowlisted, [])
})
