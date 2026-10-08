// 装饰器 BDD(snapshot.models.streamSimple 缝):
// 原型 patch 触达 snapshot / anthropic GenerateOptions 注入 / openai 透传 /
// sessionId 防御 / 总开关与活性旁路 / Models 实例幂等 / 漂移防御 / sweep。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMarkerInject, patchAdapterPrototype, sweepRegisteredAdapters } from '../src/decorator.mjs'
import { deriveMarker } from '../src/marker.mjs'

const PREFIX = 'dsh'

function baseInject(overrides = {}) {
  return createMarkerInject(
    overrides.getConfig ?? (() => ({ enabled: true, prefix: PREFIX })),
    overrides.onWarn,
  )
}

// mimic 官方形态:adapter 原型方法收 (options, snapshot),snapshot.models.streamSimple
// 是 pi-ai GenerateOptions 的最终消费入口
function makeParts() {
  const consumed = []
  const models = {
    streamSimple: (model, context, options) => {
      consumed.push({ api: model.api, options })
      return 'stream'
    },
  }
  class Adapter {
    streamWithSnapshot(options, snapshot) {
      return snapshot.models.streamSimple({ api: options.api ?? 'anthropic-messages', id: 'claude-x' }, [], options)
    }
  }
  return { Adapter, models, consumed }
}

test('原型 patch 后,anthropic 请求注入派生标记', () => {
  const { Adapter, models, consumed } = makeParts()
  assert.equal(patchAdapterPrototype(new Adapter(), baseInject()), true)
  new Adapter().streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.equal(consumed[0].options.metadata.user_id, deriveMarker('session-a'))
})

test('原型级一次覆盖存量与未来实例;同 Models 实例幂等', () => {
  const { Adapter, models } = makeParts()
  patchAdapterPrototype(new Adapter(), baseInject())
  const adapter = new Adapter()
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  const shadowed = models.streamSimple
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(models.streamSimple, shadowed) // 二次进入不重复 shadow
})

test('openai 协议不注入(未知键不进入其他传输)', () => {
  const { Adapter, models, consumed } = makeParts()
  patchAdapterPrototype(new Adapter(), baseInject())
  new Adapter().streamWithSnapshot({ sessionId: 's1', api: 'openai-completions' }, { models })
  assert.equal(consumed[0].options.metadata, undefined)
})

test('metadata 其余键保留,冻结入参不被改写', () => {
  const { Adapter, models, consumed } = makeParts()
  patchAdapterPrototype(new Adapter(), baseInject())
  const options = Object.freeze({ sessionId: 'session-a', metadata: { other: 1 } })
  new Adapter().streamWithSnapshot(options, { models })
  assert.equal(consumed[0].options.metadata.other, 1)
  assert.match(consumed[0].options.metadata.user_id, /^dsh:[0-9a-f]{40}$/)
  assert.equal(options.metadata.other, 1)
})

test('同会话标记缓存', () => {
  const { Adapter, models, consumed } = makeParts()
  patchAdapterPrototype(new Adapter(), baseInject())
  const adapter = new Adapter()
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(consumed[0].options.metadata.user_id, consumed[1].options.metadata.user_id)
})

test('sessionId 缺失按 model 去重 warn 并透传', () => {
  const warnings = []
  const { Adapter, models, consumed } = makeParts()
  patchAdapterPrototype(new Adapter(), baseInject({ onWarn: (model, message) => warnings.push(`${model}:${message}`) }))
  const options = { model: { id: 'claude-x' } }
  const adapter = new Adapter()
  adapter.streamWithSnapshot(options, { models })
  adapter.streamWithSnapshot(options, { models })
  assert.equal(consumed[0].options, options)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^claude-x:/)
})

test('总开关关闭即纯透传,重开恢复', () => {
  let enabled = false
  const { Adapter, models, consumed } = makeParts()
  patchAdapterPrototype(new Adapter(), baseInject({ getConfig: () => ({ enabled, prefix: PREFIX }) }))
  const adapter = new Adapter()
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(consumed[0].options.metadata, undefined)
  enabled = true
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.match(consumed[1].options.metadata.user_id, /^dsh:/)
})

test('isActive false 即透传(卸载后不注入)', () => {
  let active = true
  const { Adapter, models, consumed } = makeParts()
  patchAdapterPrototype(new Adapter(), baseInject(), () => active)
  const adapter = new Adapter()
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^dsh:/)
  active = false
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(consumed[1].options.metadata, undefined)
})

test('重复 patch 幂等', () => {
  const { Adapter } = makeParts()
  assert.equal(patchAdapterPrototype(new Adapter(), baseInject()), true)
  assert.equal(patchAdapterPrototype(new Adapter(), baseInject()), true)
})

test('原型方法缺失返回 false(版本漂移防御)', () => {
  const adapter = Object.create({ other: () => {} })
  assert.equal(patchAdapterPrototype(adapter, baseInject()), false)
})

test('冻结原型返回 false 不抛错', () => {
  const proto = Object.freeze({ streamWithSnapshot: () => {} })
  assert.equal(patchAdapterPrototype(Object.create(proto), baseInject()), false)
})

test('sweepRegisteredAdapters:扫描注册表覆盖,llm 形态不符返回 0', () => {
  const { Adapter, models, consumed } = makeParts()
  const llm = { adapters: new Map([['llm-pi-ai', { provider: 'p', adapter: new Adapter() }]]) }
  assert.equal(sweepRegisteredAdapters(llm, baseInject()), 1)
  new Adapter().streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^dsh:/)
  assert.equal(sweepRegisteredAdapters(undefined, baseInject()), 0)
  assert.equal(sweepRegisteredAdapters({ adapters: new Set() }, baseInject()), 0)
})
