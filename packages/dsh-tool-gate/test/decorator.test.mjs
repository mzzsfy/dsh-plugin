import test from 'node:test'
import assert from 'node:assert/strict'
import { PI_AI_ROW_ID, patchAdapterPrototype, sweepCollapseAdapters } from '../src/decorator.mjs'
import { planRequestTools } from '../src/fallback.mjs'

const identity = (options) => options
const dropShell = (options) => ({ ...options, tools: (options?.tools ?? []).filter((tool) => tool.name !== 'shell') })

class FakeAdapter {
  constructor() {
    this.calls = []
  }

  async *streamWithSnapshot(options, snapshot) {
    this.calls.push(options)
    return { options, snapshot }
  }

  async dispatch(options, snapshot) {
    return this.streamWithSnapshot(options, snapshot).next()
  }
}

test('patch:原型缺 streamWithSnapshot 返回 false(版本漂移防御)', () => {
  const adapter = { stream() {} }
  assert.equal(patchAdapterPrototype(adapter, identity), false)
})

test('SC-16 缝上改写:授权实例请求被 rewrite,原对象不变异', async () => {
  const adapter = new FakeAdapter()
  assert.equal(patchAdapterPrototype(adapter, dropShell), true)
  const options = { tools: [{ name: 'read' }, { name: 'shell' }] }
  await adapter.dispatch(options, { snap: 1 })
  assert.deepEqual(adapter.calls[0].tools.map((tool) => tool.name), ['read'])
  assert.equal(options.tools.length, 2)
})

test('SC-20 同原型非授权实例透传', async () => {
  const owner = new FakeAdapter()
  const stranger = new FakeAdapter()
  assert.equal(patchAdapterPrototype(owner, dropShell), true)
  await stranger.dispatch({ tools: [{ name: 'shell' }] }, {})
  assert.deepEqual(stranger.calls[0].tools.map((tool) => tool.name), ['shell'])
  await owner.dispatch({ tools: [{ name: 'shell' }] }, {})
  assert.deepEqual(owner.calls[0].tools.map((tool) => tool.name), [])
})

test('isActive=false 全量透传(SC-19 门关)', async () => {
  const adapter = new FakeAdapter()
  let active = true
  patchAdapterPrototype(adapter, dropShell, () => active)
  await adapter.dispatch({ tools: [{ name: 'shell' }] }, {})
  assert.deepEqual(adapter.calls[0].tools.map((tool) => tool.name), [])
  active = false
  await adapter.dispatch({ tools: [{ name: 'shell' }] }, {})
  assert.deepEqual(adapter.calls[1].tools.map((tool) => tool.name), ['shell'])
  active = true
  await adapter.dispatch({ tools: [{ name: 'shell' }] }, {})
  assert.deepEqual(adapter.calls[2].tools.map((tool) => tool.name), [])
})

test('sweep:仅官方 pi-ai 行 adapter 被 patch,deepseek 原生行不命中(INV-10)', async () => {
  const piAi = new FakeAdapter()
  const deepseek = new FakeAdapter()
  const other = new FakeAdapter()
  const llm = {
    adapters: new Map([
      ['pi-route', { provider: { id: 'pi-route' }, adapter: piAi }],
      ['deepseek', { provider: { id: 'deepseek' }, adapter: deepseek }],
      ['third', { provider: { id: 'third' }, adapter: other }],
    ]),
    directory: new Map([
      ['pi-route', { settingsNs: PI_AI_ROW_ID, provider: 'pi-route' }],
      ['deepseek', { settingsNs: 'llm-deepseek', provider: 'deepseek' }],
      ['third', { settingsNs: 'llm-other', provider: 'third' }],
    ]),
  }
  const count = sweepCollapseAdapters(llm, dropShell)
  assert.equal(count, 1)
  await piAi.dispatch({ tools: [{ name: 'shell' }] }, {})
  assert.deepEqual(piAi.calls[0].tools.map((tool) => tool.name), [])
  await deepseek.dispatch({ tools: [{ name: 'shell' }] }, {})
  assert.deepEqual(deepseek.calls[0].tools.map((tool) => tool.name), ['shell'])
})

test('sweep:llm 形态漂移返回 0(干净禁用)', () => {
  assert.equal(sweepCollapseAdapters(undefined, identity), 0)
  assert.equal(sweepCollapseAdapters({}, identity), 0)
  assert.equal(sweepCollapseAdapters({ adapters: new Map() }, identity), 0)
})

test('sweep:adapters entry 的 provider.id 不符跳过(漂移防御)', async () => {
  const adapter = new FakeAdapter()
  const llm = {
    adapters: new Map([['pi-route', { provider: { id: 'other' }, adapter }]]),
    directory: new Map([['pi-route', { settingsNs: PI_AI_ROW_ID, provider: 'pi-route' }]]),
  }
  assert.equal(sweepCollapseAdapters(llm, dropShell), 0)
  await adapter.dispatch({ tools: [{ name: 'shell' }] }, {})
  assert.deepEqual(adapter.calls[0].tools.map((tool) => tool.name), ['shell'])
})

test('rewrite 组合:planRequestTools 的 native 透传在缝上成立', async () => {
  const adapter = new FakeAdapter()
  const nativeTools = [{ name: 'shell', deferLoading: true }]
  patchAdapterPrototype(adapter, (options) => {
    const plan = planRequestTools(options?.tools, new Set(['shell']))
    if (plan.folded.length === 0) return options
    return { ...options, tools: plan.tools }
  })
  await adapter.dispatch({ tools: nativeTools }, {})
  assert.equal(adapter.calls[0].tools, nativeTools)
})
