import test from 'node:test'
import assert from 'node:assert/strict'
import { toolLayersOf } from '../src/registry.mjs'

test('合法形态:全局层 + scoped 层投影', () => {
  const globalData = new Map([['read', { name: 'read' }]])
  const agentData = new Map([['web_search', { name: 'web_search' }]])
  const layers = toolLayersOf({ layers: { global: { tools: { data: globalData } }, scoped: new Map([['agent#1', { tools: { data: agentData } }]]) } }).layers()
  assert.equal(layers.length, 2)
  assert.equal(layers[0].key, globalData)
  assert.equal(layers[0].label, 'global')
  assert.deepEqual(layers[0].names(), ['read'])
  assert.equal(layers[0].definitionOf('read'), globalData.get('read'))
  assert.equal(layers[1].key, agentData)
  assert.equal(layers[1].label, 'agent#1')
  assert.deepEqual(layers[1].names(), ['web_search'])
})

test('scoped 每次现读:新增 agent 层对后续 layers() 可见', () => {
  const globalData = new Map()
  const scoped = new Map()
  const store = toolLayersOf({ layers: { global: { tools: { data: globalData } }, scoped } })
  assert.equal(store.layers().length, 1)
  scoped.set('agent#2', { tools: { data: new Map([['later', { name: 'later' }]]) } })
  const layers = store.layers()
  assert.equal(layers.length, 2)
  assert.deepEqual(layers[1].names(), ['later'])
})

test('scoped 非 Map 或条目形态缺 → 只投影全局层', () => {
  const globalData = new Map([['read', { name: 'read' }]])
  const layers = toolLayersOf({ layers: { global: { tools: { data: globalData } } } }).layers()
  assert.equal(layers.length, 1)
  const layers2 = toolLayersOf({ layers: { global: { tools: { data: globalData } }, scoped: new Map([['bad', {}]]) } }).layers()
  assert.equal(layers2.length, 1)
})

test('缺 layers / data 非 Map → undefined(干净禁用)', () => {
  assert.equal(toolLayersOf({}), undefined)
  assert.equal(toolLayersOf(undefined), undefined)
  assert.equal(toolLayersOf({ layers: { global: { tools: { data: {} } } } }), undefined)
  assert.equal(toolLayersOf({ layers: { global: {} } }), undefined)
})
