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

test('Chat 冻结入参补原始会话头,保留其他头且不新增 metadata', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  const options = Object.freeze({
    sessionId: 'session-a', api: 'openai-completions',
    headers: Object.freeze({ 'x-gateway-group': 'pool-a' }),
  })
  adapter.streamWithSnapshot(options, { models })
  assert.deepEqual(consumed[0].options.headers, {
    'x-gateway-group': 'pool-a', session_id: 'session-a', 'x-client-request-id': 'session-a',
  })
  assert.equal(consumed[0].options.metadata, undefined)
  assert.deepEqual(options.headers, { 'x-gateway-group': 'pool-a' })
})

test('Chat 同会话多轮头稳定,不同会话隔离', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  for (const sessionId of ['session-a', 'session-a', 'session-b']) {
    adapter.streamWithSnapshot({ sessionId, api: 'openai-completions' }, { models })
  }
  assert.deepEqual(consumed.map(({ options }) => options.headers), [
    { session_id: 'session-a', 'x-client-request-id': 'session-a' },
    { session_id: 'session-a', 'x-client-request-id': 'session-a' },
    { session_id: 'session-b', 'x-client-request-id': 'session-b' },
  ])
})

test('Chat 显式头按大小写无关匹配保留,只补缺失键', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  adapter.streamWithSnapshot({
    sessionId: 'session-a', api: 'openai-completions', headers: { Session_ID: 'explicit-session' },
  }, { models })
  assert.deepEqual(consumed[0].options.headers, {
    Session_ID: 'explicit-session', 'x-client-request-id': 'session-a',
  })
})

test('Chat 显式 null 抑制头,不被自动注入覆盖', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  const options = { sessionId: 'session-a', api: 'openai-completions', headers: { SESSION_ID: null, 'X-Client-Request-Id': null } }
  adapter.streamWithSnapshot(options, { models })
  assert.deepEqual(consumed[0].options.headers, { SESSION_ID: null, 'X-Client-Request-Id': null })
})

test('Chat model.headers 显式值优先,不生成其他大小写的重复头', () => {
  const consumed = []
  const model = { api: 'openai-completions', id: 'chat-x', headers: { SESSION_ID: 'model-session' } }
  const models = { streamSimple: (_model, _context, options) => consumed.push(options) }
  class Adapter {
    streamWithSnapshot(options, snapshot) {
      return snapshot.models.streamSimple(model, [], options)
    }
  }
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.deepEqual(consumed[0].headers, { 'x-client-request-id': 'session-a' })
  assert.deepEqual(model.headers, { SESSION_ID: 'model-session' })
})

test('Chat 两来源显式头均保留,模型 null 抑制且 options 引用不变', () => {
  const model = Object.freeze({ api: 'openai-completions', id: 'chat-x', headers: Object.freeze({ SESSION_ID: null }) })
  const options = Object.freeze({ sessionId: 'session-a', headers: Object.freeze({ 'X-CLIENT-REQUEST-ID': 'caller-request' }) })
  const inject = baseInject()
  assert.equal(inject(options, model), options)
  assert.deepEqual(model.headers, { SESSION_ID: null })
  assert.deepEqual(options.headers, { 'X-CLIENT-REQUEST-ID': 'caller-request' })
})

test('Chat cacheRetention none 原样透传,显式头仍保留', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  const options = { sessionId: 'session-a', api: 'openai-completions', cacheRetention: 'none', headers: { session_id: 'explicit' } }
  adapter.streamWithSnapshot(options, { models })
  assert.equal(consumed[0].options, options)
})

test('Chat 无有效 sessionId 时原样透传且按实际模型去重告警', () => {
  const warnings = []
  const consumed = []
  const models = { streamSimple: (_model, _context, options) => consumed.push(options) }
  class Adapter {
    streamWithSnapshot(options, snapshot) {
      return snapshot.models.streamSimple({ api: 'openai-completions', id: options.actualModel }, [], options)
    }
  }
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject({ onWarn: (model) => warnings.push(model) }))
  for (const actualModel of ['chat-a', 'chat-b']) {
    for (const sessionId of [undefined, '', null, 0]) {
      const options = { sessionId, actualModel, model: { id: 'conflicting-options-model' } }
      adapter.streamWithSnapshot(options, { models })
      assert.equal(consumed.at(-1), options)
    }
  }
  assert.deepEqual(warnings, ['chat-a', 'chat-b'])
})

test('Chat 总开关热切换与 owner 卸载控制自动头', () => {
  let enabled = false
  let active = true
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled, prefix: PREFIX }) }), () => active)
  const options = { sessionId: 'session-a', api: 'openai-completions' }
  adapter.streamWithSnapshot(options, { models })
  assert.equal(consumed.at(-1).options, options)
  enabled = true
  adapter.streamWithSnapshot(options, { models })
  assert.equal(consumed.at(-1).options.headers.session_id, 'session-a')
  active = false
  adapter.streamWithSnapshot(options, { models })
  assert.equal(consumed.at(-1).options, options)
})

test('Chat sweep 授权不扩散到共享原型的其他实例', () => {
  const { Adapter, models, consumed } = makeParts()
  const official = new Adapter()
  const foreign = new Adapter()
  sweepRegisteredAdapters({
    adapters: new Map([['route', { provider: { id: 'route' }, adapter: official }]]),
    directory: new Map([['route', { provider: 'route', settingsNs: 'llm-pi-ai' }]]),
  }, baseInject())
  official.streamWithSnapshot({ sessionId: 'official-session', api: 'openai-completions' }, { models })
  const foreignOptions = { sessionId: 'foreign-session', api: 'openai-completions' }
  foreign.streamWithSnapshot(foreignOptions, { models })
  assert.equal(consumed[0].options.headers.session_id, 'official-session')
  assert.equal(consumed[1].options, foreignOptions)
})

test('Responses 和其他协议原样透传,不重复注入原生会话键', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject())
  for (const api of ['openai-responses', 'openai-codex-responses', 'azure-openai-responses', 'unknown']) {
    const options = { sessionId: 'session-a', api, headers: { session_id: 'explicit' } }
    adapter.streamWithSnapshot(options, { models })
    assert.equal(consumed.at(-1).options, options)
  }
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
