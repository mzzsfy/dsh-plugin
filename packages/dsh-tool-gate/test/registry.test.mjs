import test from 'node:test'
import assert from 'node:assert/strict'
import { toolLayersOf } from '../src/registry.mjs'

// 宿主 0.2.2+ 层条目 = registration 包装({ definition, when })
const registrationOf = (definition) => ({ definition })

test('合法形态:全局层 + scoped 层投影', () => {
  const readTool = { name: 'read' }
  const searchTool = { name: 'web_search' }
  const globalData = new Map([['read', registrationOf(readTool)]])
  const agentData = new Map([['web_search', registrationOf(searchTool)]])
  const layers = toolLayersOf({ layers: { global: { tools: { data: globalData } }, scoped: new Map([['agent#1', { tools: { data: agentData } }]]) } }).layers()
  assert.equal(layers.length, 2)
  assert.equal(layers[0].key, globalData)
  assert.equal(layers[0].label, 'global')
  assert.deepEqual(layers[0].names(), ['read'])
  assert.equal(layers[0].definitionOf('read'), readTool)
  assert.equal(layers[1].key, agentData)
  assert.equal(layers[1].label, 'agent#1')
  assert.deepEqual(layers[1].names(), ['web_search'])
})

test('scoped 每次现读:新增 agent 层对后续 layers() 可见', () => {
  const globalData = new Map()
  const scoped = new Map()
  const store = toolLayersOf({ layers: { global: { tools: { data: globalData } }, scoped } })
  assert.equal(store.layers().length, 1)
  scoped.set('agent#2', { tools: { data: new Map([['later', registrationOf({ name: 'later' })]]) } })
  const layers = store.layers()
  assert.equal(layers.length, 2)
  assert.deepEqual(layers[1].names(), ['later'])
})

test('scoped 非 Map 或缺层数据 → 只投影全局层', () => {
  const globalData = new Map([['read', registrationOf({ name: 'read' })]])
  const layers = toolLayersOf({ layers: { global: { tools: { data: globalData } } } }).layers()
  assert.equal(layers.length, 1)
  const layers2 = toolLayersOf({ layers: { global: { tools: { data: globalData } }, scoped: new Map([['bad', {}]]) } }).layers()
  assert.equal(layers2.length, 1)
})

// 宿主 0.2.1 的裸 definition 条目形态即内部面漂移:必须干净禁用,
// 否则打标写在 registration 上、宿主投影读 definition,静默失效。
test('条目为裸 definition(旧形态)→ undefined(干净禁用)', () => {
  const legacy = new Map([['read', { name: 'read' }]])
  assert.equal(toolLayersOf({ layers: { global: { tools: { data: legacy } } } }), undefined)
  const scoped = new Map([['agent#1', { tools: { data: new Map([['web', { name: 'web' }]]) } }]])
  assert.equal(toolLayersOf({ layers: { global: { tools: { data: new Map() } }, scoped } }), undefined)
})

test('缺 layers / data 非 Map → undefined(干净禁用)', () => {
  assert.equal(toolLayersOf({}), undefined)
  assert.equal(toolLayersOf(undefined), undefined)
  assert.equal(toolLayersOf({ layers: { global: { tools: { data: {} } } } }), undefined)
  assert.equal(toolLayersOf({ layers: { global: {} } }), undefined)
})

// Given 全局表已投影;When 宿主 NamedEntries 在清空后换代(data 换成新 Map);
// Then layers() 现读新表,不返回旧空表(收敛不因缓存失明)。
test('layers() 现读全局表:换代后返回新表', () => {
  const store = { global: { tools: { data: new Map([['a', { definition: { name: 'a' } }]]) } }, scoped: new Map() }
  const reader = toolLayersOf({ layers: store })
  const before = reader.layers()[0]
  assert.deepEqual(before.names(), ['a'])
  store.global.tools.data = new Map([['b', { definition: { name: 'b' } }]])
  const next = reader.layers()[0]
  assert.deepEqual(next.names(), ['b'])
  assert.notEqual(next.key, before.key, '换代后层键指向新表')
  assert.equal(next.definitionOf('b')?.name, 'b')
})
