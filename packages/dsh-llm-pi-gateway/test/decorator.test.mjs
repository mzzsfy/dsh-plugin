// 验证原型 owner 隔离、Models facade 复用与生命周期旁路。

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
  const adapter = new Adapter()
  assert.equal(patchAdapterPrototype(adapter, baseInject()), true)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.equal(consumed[0].options.metadata.user_id, deriveMarker('session-a'))
})

test('原型级一次覆盖存量与未来实例;同 Models 实例幂等', () => {
  const { Adapter, models } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  const shadowed = models.streamSimple
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(models.streamSimple, shadowed) // 二次进入不重复 shadow
})

test('openai 协议不注入(未知键不进入其他传输)', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  adapter.streamWithSnapshot({ sessionId: 's1', api: 'openai-completions' }, { models })
  assert.equal(consumed[0].options.metadata, undefined)
})

test('metadata 其余键保留,冻结入参不被改写', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  const options = Object.freeze({ sessionId: 'session-a', metadata: { other: 1 } })
  adapter.streamWithSnapshot(options, { models })
  assert.equal(consumed[0].options.metadata.other, 1)
  assert.match(consumed[0].options.metadata.user_id, /^dsh:[0-9a-f]{40}$/)
  assert.equal(options.metadata.other, 1)
})

test('同会话标记缓存', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(consumed[0].options.metadata.user_id, consumed[1].options.metadata.user_id)
})

test('同一会话前缀热更新后保持旧标记', () => {
  let prefix = 'before'
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled: true, prefix }) }))
  adapter.streamWithSnapshot({ sessionId: 'stable-session' }, { models })
  prefix = 'after'
  adapter.streamWithSnapshot({ sessionId: 'stable-session' }, { models })
  adapter.streamWithSnapshot({ sessionId: 'new-session' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^before:/)
  assert.equal(consumed[1].options.metadata.user_id, consumed[0].options.metadata.user_id)
  assert.match(consumed[2].options.metadata.user_id, /^after:/)
})

test('sessionId 缺失按 model 去重 warn 并透传', () => {
  const warnings = []
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject({ onWarn: (model, message) => warnings.push(`${model}:${message}`) }))
  const options = { model: { id: 'claude-x' } }
  adapter.streamWithSnapshot(options, { models })
  adapter.streamWithSnapshot(options, { models })
  assert.equal(consumed[0].options, options)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^claude-x:/)
})

test('总开关关闭即纯透传,重开恢复', () => {
  let enabled = false
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled, prefix: PREFIX }) }))
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(consumed[0].options.metadata, undefined)
  enabled = true
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.match(consumed[1].options.metadata.user_id, /^dsh:/)
})

test('isActive false 即透传(卸载后不注入)', () => {
  let active = true
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject(), () => active)
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^dsh:/)
  active = false
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.equal(consumed[1].options.metadata, undefined)
})

test('fiber 卸载后重新启用:已有 Models 实例交由新 owner 重新注入', () => {
  const { Adapter, models, consumed } = makeParts()
  let firstActive = true
  const adapter = new Adapter()
  const firstInject = baseInject({ getConfig: () => ({ enabled: true, prefix: 'old' }) })
  patchAdapterPrototype(adapter, firstInject, () => firstActive)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^old:/)

  firstActive = false
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.equal(consumed[1].options.metadata, undefined)

  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled: true, prefix: 'new' }) }))
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.match(consumed[2].options.metadata.user_id, /^new:/)
})

test('相同实例被不同 gateway owner 重复授权时选择最近活跃 owner', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  let firstActive = true
  let secondActive = true
  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled: true, prefix: 'first' }) }), () => firstActive)
  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled: true, prefix: 'second' }) }), () => secondActive)

  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^second:/)

  secondActive = false
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.match(consumed[1].options.metadata.user_id, /^first:/)
})

test('重新扫描相同 owner 不重复叠加', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  const inject = baseInject({ getConfig: () => ({ enabled: true, prefix: 'same' }) })
  const isActive = () => true
  patchAdapterPrototype(adapter, inject, isActive)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  patchAdapterPrototype(adapter, inject, isActive)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.match(consumed[1].options.metadata.user_id, /^same:/)
})
test('重复 patch 幂等', () => {
  const { Adapter } = makeParts()
  const adapter = new Adapter()
  assert.equal(patchAdapterPrototype(adapter, baseInject()), true)
  assert.equal(patchAdapterPrototype(adapter, baseInject()), true)
})

test('原型方法缺失返回 false(版本漂移防御)', () => {
  const adapter = Object.create({ other: () => {} })
  assert.equal(patchAdapterPrototype(adapter, baseInject()), false)
})

test('冻结原型返回 false 不抛错', () => {
  const proto = Object.freeze({ streamWithSnapshot: () => {} })
  assert.equal(patchAdapterPrototype(Object.create(proto), baseInject()), false)
})

test('facade 旁路无效 Models 并透传 snapshot', () => {
  const { Adapter } = makeParts()
  let receivedSnapshot
  class SnapshotAdapter {
    streamWithSnapshot(options, snapshot) {
      receivedSnapshot = snapshot
      return snapshot.models?.streamSimple?.({ api: options.api ?? 'anthropic-messages', id: 'claude-x' }, [], options)
    }
  }
  const adapter = new SnapshotAdapter()
  patchAdapterPrototype(adapter, baseInject())
  const snapshot = { models: { streamSimple: null } }
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, snapshot)
  assert.equal(receivedSnapshot.models, snapshot.models)
})

test('facade 保持底层 Models 为 streamSimple receiver', () => {
  const { Adapter, models, consumed } = makeParts()
  let receivedThis
  models.streamSimple = function (model, context, options) {
    receivedThis = this
    consumed.push({ api: model.api, options })
    return 'stream'
  }
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.equal(receivedThis, models)
  assert.equal(consumed.length, 1)
})
test('不同 adapter 原型共享 Models 时各自使用所属 owner', () => {
  const { Adapter: OfficialAdapter, models, consumed } = makeParts()
  class OtherAdapter {
    streamWithSnapshot(options, snapshot) {
      return snapshot.models.streamSimple({ api: options.api ?? 'anthropic-messages', id: 'claude-x' }, [], options)
    }
  }
  const official = new OfficialAdapter()
  const other = new OtherAdapter()
  const originalStreamSimple = models.streamSimple
  patchAdapterPrototype(official, baseInject({ getConfig: () => ({ enabled: true, prefix: 'official' }) }))
  patchAdapterPrototype(other, baseInject({ getConfig: () => ({ enabled: true, prefix: 'other' }) }))

  other.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  official.streamWithSnapshot({ sessionId: 'session-a' }, { models })

  assert.match(consumed[0].options.metadata.user_id, /^other:/)
  assert.match(consumed[1].options.metadata.user_id, /^official:/)
  assert.equal(models.streamSimple, originalStreamSimple)
})

test('directory route 撤销后旧 owner 仍持续至其所属 gateway dispose', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  let active = true
  const directory = new Map([['route', { provider: 'route', settingsNs: 'llm-pi-ai' }]])
  const llm = { adapters: new Map([['route', { provider: { id: 'route' }, adapter }]]), directory }
  assert.equal(sweepRegisteredAdapters(llm, baseInject(), () => active), 1)
  adapter.streamWithSnapshot({ sessionId: 'before-revoke' }, { models })
  assert.ok(consumed[0].options.metadata.user_id)
  directory.delete('route')
  assert.equal(sweepRegisteredAdapters(llm, baseInject(), () => active), 0)
  adapter.streamWithSnapshot({ sessionId: 'after-revoke-before-dispose' }, { models })
  assert.ok(consumed[1].options.metadata.user_id)
  active = false
  adapter.streamWithSnapshot({ sessionId: 'after-dispose' }, { models })
  assert.equal(consumed[2].options.metadata, undefined)
})

test('sweep 授权只绑定官方 adapter 实例而不扩散到同原型其他 namespace 实例', () => {
  const { Adapter, models, consumed } = makeParts()
  const officialAdapter = new Adapter()
  const foreignAdapter = new Adapter()
  const llm = {
    adapters: new Map([
      ['official-route', { provider: { id: 'official-route' }, adapter: officialAdapter }],
      ['foreign-route', { provider: { id: 'foreign-route' }, adapter: foreignAdapter }],
    ]),
    directory: new Map([
      ['official-route', { provider: 'official-route', settingsNs: 'llm-pi-ai' }],
      ['foreign-route', { provider: 'foreign-route', settingsNs: 'other-plugin' }],
    ]),
  }
  assert.equal(sweepRegisteredAdapters(llm, baseInject()), 1)
  officialAdapter.streamWithSnapshot({ sessionId: 'official-session' }, { models })
  foreignAdapter.streamWithSnapshot({ sessionId: 'foreign-session' }, { models })
  assert.equal(consumed[0].options.metadata.user_id, deriveMarker('official-session'))
  assert.equal(consumed[1].options.metadata, undefined)
})

test('sweep 仅装饰官方 llm-pi-ai namespace 的 adapter，多 route 共用原型', () => {
  const official = makeParts()
  const unrelated = makeParts()
  const officialAdapter = new official.Adapter()
  const unrelatedAdapter = new unrelated.Adapter()
  const llm = {
    adapters: new Map([
      ['echo-anthropic', { provider: { id: 'echo-anthropic' }, adapter: officialAdapter }],
      ['echo-openai', { provider: { id: 'echo-openai' }, adapter: officialAdapter }],
      ['other-anthropic', { provider: { id: 'other-anthropic' }, adapter: unrelatedAdapter }],
    ]),
    directory: new Map([
      ['directory-alias-a', { provider: 'echo-anthropic', settingsNs: 'llm-pi-ai' }],
      ['directory-alias-b', { provider: 'echo-openai', settingsNs: 'llm-pi-ai' }],
      ['other-anthropic', { provider: 'other-anthropic', settingsNs: 'other-plugin' }],
    ]),
  }
  assert.equal(sweepRegisteredAdapters(llm, baseInject()), 2)

  officialAdapter.streamWithSnapshot({ sessionId: 's1' }, { models: official.models })
  unrelatedAdapter.streamWithSnapshot({ sessionId: 's1' }, { models: unrelated.models })
  assert.match(official.consumed[0].options.metadata.user_id, /^dsh:/)
  assert.equal(unrelated.consumed[0].options.metadata, undefined)
})
test('sweepRegisteredAdapters:匹配官方 namespace 且无效服务返回零', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  const llm = {
    adapters: new Map([['llm-pi-ai', { provider: { id: 'llm-pi-ai' }, adapter }]]),
    directory: new Map([['llm-pi-ai', { provider: 'llm-pi-ai', settingsNs: 'llm-pi-ai' }]]),
  }
  assert.equal(sweepRegisteredAdapters(llm, baseInject()), 1)
  adapter.streamWithSnapshot({ sessionId: 's1' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^dsh:/)
  assert.equal(sweepRegisteredAdapters(undefined, baseInject()), 0)
  assert.equal(sweepRegisteredAdapters({ adapters: new Set(), directory: new Map() }, baseInject()), 0)
})
