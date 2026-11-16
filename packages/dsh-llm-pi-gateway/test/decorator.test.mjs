// 验证原型 owner 隔离、Models facade 复用与生命周期旁路。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMarkerInject, ownerCount, patchAdapterPrototype, sweepRegisteredAdapters,
  MARKER_CACHE_LIMIT, WARNED_CACHE_LIMIT,
} from '../src/decorator.mjs'
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

test('同一会话在 prefix 热更后按新前缀重算,同前缀内保持稳定且 Chat 头不受影响', () => {
  let prefix = 'before'
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled: true, prefix }) }))
  adapter.streamWithSnapshot({ sessionId: 'stable-session' }, { models })
  prefix = 'after'
  adapter.streamWithSnapshot({ sessionId: 'stable-session' }, { models })
  adapter.streamWithSnapshot({ sessionId: 'stable-session' }, { models })
  adapter.streamWithSnapshot({ sessionId: 'stable-session', api: 'openai-completions' }, { models })
  prefix = 'before'
  adapter.streamWithSnapshot({ sessionId: 'stable-session' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^before:/)
  assert.equal(consumed[1].options.metadata.user_id, deriveMarker('stable-session', 'after'))
  assert.equal(consumed[2].options.metadata.user_id, consumed[1].options.metadata.user_id)
  assert.deepEqual(consumed[3].options.headers, {
    session_id: 'stable-session', 'x-client-request-id': 'stable-session',
  })
  assert.equal(consumed[4].options.metadata.user_id, consumed[0].options.metadata.user_id)
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
  const llm = {
    adapters: new Map([['route', { provider: { id: 'route' }, adapter }]]),
    directory: new Map([['route', { provider: 'route', settingsNs: 'llm-pi-ai' }]]),
  }
  const inject = baseInject({ getConfig: () => ({ enabled: true, prefix: 'same' }) })
  const isActive = () => true
  sweepRegisteredAdapters(llm, inject, isActive)
  sweepRegisteredAdapters(llm, inject, isActive)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^same:/)
  assert.equal(ownerCount(adapter), 1)
})
test('重复 patch 幂等:同一 inject/isActive 引用只登记一个 owner', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  const inject = baseInject()
  const isActive = () => true
  assert.equal(patchAdapterPrototype(adapter, inject, isActive), true)
  assert.equal(patchAdapterPrototype(adapter, inject, isActive), true)
  assert.equal(ownerCount(adapter), 1)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.equal(consumed[0].options.metadata.user_id, deriveMarker('session-a'))
})

test('省略 isActive 的重复 patch 与 sweep 共用模块级缺省活性,owner 不重复登记', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  const inject = baseInject()
  const llm = {
    adapters: new Map([['route', { provider: { id: 'route' }, adapter }]]),
    directory: new Map([['route', { provider: 'route', settingsNs: 'llm-pi-ai' }]]),
  }
  assert.equal(patchAdapterPrototype(adapter, inject), true)
  assert.equal(patchAdapterPrototype(adapter, inject), true)
  assert.equal(sweepRegisteredAdapters(llm, inject), 1)
  sweepRegisteredAdapters(llm, inject)
  assert.equal(ownerCount(adapter), 1)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.equal(consumed[0].options.metadata.user_id, deriveMarker('session-a'))
})

test('显式传入不同 isActive 的重复 patch 仍分别登记(多代 owner 并存语义保留)', () => {
  const { Adapter } = makeParts()
  const adapter = new Adapter()
  const inject = baseInject()
  patchAdapterPrototype(adapter, inject)
  patchAdapterPrototype(adapter, inject, () => true)
  assert.equal(ownerCount(adapter), 2)
})

test('原型方法被外部替换后按当前方法重新包装,注入不失效且 owner 不重复登记', () => {
  const { Adapter, models, consumed } = makeParts()
  const official = Adapter.prototype.streamWithSnapshot
  const adapter = new Adapter()
  const inject = baseInject()
  const isActive = () => true
  assert.equal(patchAdapterPrototype(adapter, inject, isActive), true)

  const externalCalls = []
  Adapter.prototype.streamWithSnapshot = function (...args) {
    externalCalls.push(args)
    return official.apply(this, args)
  }
  assert.equal(patchAdapterPrototype(adapter, inject, isActive), true)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.equal(externalCalls.length, 1) // 外部包装仍在外层链上
  assert.equal(consumed[0].options.metadata.user_id, deriveMarker('session-a'))
  assert.equal(ownerCount(adapter), 1)
})

test('原型方法被外部替换为非函数时返回 false 不抛错', () => {
  const { Adapter } = makeParts()
  const adapter = new Adapter()
  assert.equal(patchAdapterPrototype(adapter, baseInject()), true)
  Adapter.prototype.streamWithSnapshot = null
  assert.equal(patchAdapterPrototype(adapter, baseInject()), false)
})

test('无活跃 owner 时直通原始方法,不复制 snapshot、不建 Models facade', () => {
  const seen = []
  class Adapter {
    streamWithSnapshot(options, snapshot) {
      seen.push({ options, snapshot })
      return 'raw'
    }
  }
  const official = new Adapter()
  const foreign = new Adapter()
  let active = true
  const models = { streamSimple: () => assert.fail('不应构造 facade') }
  patchAdapterPrototype(official, baseInject(), () => active)

  const unauthorized = { models, extra: 1 }
  assert.equal(foreign.streamWithSnapshot({ sessionId: 'session-a' }, unauthorized), 'raw')
  assert.equal(seen[0].snapshot, unauthorized) // 未授权实例:snapshot 原引用直通

  active = false
  const disposed = { models, extra: 1 }
  assert.equal(official.streamWithSnapshot({ sessionId: 'session-a' }, disposed), 'raw')
  assert.equal(seen[1].snapshot, disposed) // owner 失活:同样原引用直通
})

test('已保存的 Models facade 在 owner dispose 后旁路,reapply 后跟随新 owner', () => {
  const consumed = []
  const facades = []
  const models = { streamSimple: (_model, _context, options) => { consumed.push(options); return 'stream' } }
  class Adapter {
    streamWithSnapshot(options, snapshot) {
      facades.push(snapshot.models)
      return snapshot.models.streamSimple({ api: 'anthropic-messages', id: 'claude-x' }, [], options)
    }
  }
  const adapter = new Adapter()
  let active = true
  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled: true, prefix: 'old' }) }), () => active)
  adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  const facade = facades[0]
  assert.notEqual(facade, models) // 有活跃 owner 时确有 facade
  assert.match(consumed[0].metadata.user_id, /^old:/)

  active = false
  const afterDispose = { sessionId: 'session-a' }
  facade.streamSimple({ api: 'anthropic-messages', id: 'claude-x' }, [], afterDispose)
  assert.equal(consumed[1], afterDispose) // 旧 facade 不得复用创建时捕获的 owner inject

  patchAdapterPrototype(adapter, baseInject({ getConfig: () => ({ enabled: true, prefix: 'new' }) }))
  facade.streamSimple({ api: 'anthropic-messages', id: 'claude-x' }, [], { sessionId: 'session-a' })
  assert.match(consumed[2].metadata.user_id, /^new:/) // 旧 facade 由新 owner 恢复注入
})

test('patchAdapterPrototype 拒绝 null 与非对象 adapter', () => {
  for (const adapter of [null, undefined, 42, 'adapter', true]) {
    assert.equal(patchAdapterPrototype(adapter, baseInject()), false)
  }
})

test('sweep 跳过畸形 registration,不阻断其余官方 adapter', () => {
  const { Adapter, models, consumed } = makeParts()
  const good = new Adapter()
  const routes = ['missing-adapter', 'null-entry', 'null-adapter', 'primitive-adapter', 'good']
  const llm = {
    adapters: new Map([
      ['missing-adapter', { provider: { id: 'missing-adapter' } }],
      ['null-entry', null],
      ['null-adapter', { provider: { id: 'null-adapter' }, adapter: null }],
      ['primitive-adapter', { provider: { id: 'primitive-adapter' }, adapter: 42 }],
      ['good', { provider: { id: 'good' }, adapter: good }],
    ]),
    directory: new Map(routes.map((provider) => [provider, { provider, settingsNs: 'llm-pi-ai' }])),
  }
  assert.equal(sweepRegisteredAdapters(llm, baseInject()), 1)
  good.streamWithSnapshot({ sessionId: 'session-a' }, { models })
  assert.match(consumed[0].options.metadata.user_id, /^dsh:/)
  assert.equal(ownerCount(null), 0)
  assert.equal(ownerCount(undefined), 0)
  assert.equal(ownerCount(42), 0)
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

test('标记缓存条目数封顶,淘汰后同会话按当前 prefix 重算为稳定值', () => {
  const { Adapter, models, consumed } = makeParts()
  const adapter = new Adapter()
  const inject = baseInject()
  patchAdapterPrototype(adapter, inject)
  adapter.streamWithSnapshot({ sessionId: 'oldest' }, { models })
  for (let index = 0; index < MARKER_CACHE_LIMIT; index += 1) {
    adapter.streamWithSnapshot({ sessionId: `fill-${index}` }, { models })
  }
  assert.equal(inject.markerCacheSize, MARKER_CACHE_LIMIT) // oldest 已按最久未用淘汰
  adapter.streamWithSnapshot({ sessionId: 'oldest' }, { models })
  assert.equal(inject.markerCacheSize, MARKER_CACHE_LIMIT)
  assert.equal(consumed.at(-1).options.metadata.user_id, deriveMarker('oldest'))
})

test('缺 sessionId 告警去重达上限后按最近使用淘汰,热模型不重复告警', () => {
  const warnings = []
  const inject = baseInject({ onWarn: (model) => warnings.push(model) })
  const options = {}
  for (let index = 0; index < WARNED_CACHE_LIMIT; index += 1) {
    inject(options, { api: 'anthropic-messages', id: `model-${index}` })
  }
  assert.equal(warnings.length, WARNED_CACHE_LIMIT)
  // 命中已告警模型:不重复告警,并刷新为最近使用
  inject(options, { api: 'anthropic-messages', id: 'model-0' })
  assert.equal(warnings.length, WARNED_CACHE_LIMIT)
  // 新模型触发淘汰,被淘汰的是最久未用的 model-1 而非刚命中的 model-0
  inject(options, { api: 'anthropic-messages', id: 'model-overflow' })
  assert.equal(warnings.length, WARNED_CACHE_LIMIT + 1)
  inject(options, { api: 'anthropic-messages', id: 'model-0' })
  assert.equal(warnings.length, WARNED_CACHE_LIMIT + 1)
  inject(options, { api: 'anthropic-messages', id: 'model-1' })
  assert.equal(warnings.length, WARNED_CACHE_LIMIT + 2)
  assert.equal(warnings.at(-1), 'model-1')
})
