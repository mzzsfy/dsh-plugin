// apply 装配集成:宿主 llm 形态门槛、官方 adapter 授权、volatile 配置解箱与热更、
// 事件补扫、缺省配置回落与 dispose 旁路。原型/Models 细节由 decorator.test.mjs 覆盖。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject } from '../src/index.js'
import { deriveMarker } from '../src/marker.mjs'

const OFFICIAL_PROVIDER = 'echo-anthropic'

// 官方 adapter 形态:streamWithSnapshot 经 snapshot.models.streamSimple 消费 options
function makeHost({ registered = true } = {}) {
  const consumed = []
  const models = { streamSimple: (model, _context, options) => consumed.push({ api: model.api, options }) }
  class OfficialAdapter {
    streamWithSnapshot(options, snapshot) {
      return snapshot.models.streamSimple({ api: options.api ?? 'anthropic-messages', id: 'claude-x' }, [], options)
    }
  }
  const adapter = new OfficialAdapter()
  const llm = {
    adapters: new Map(),
    directory: new Map([[OFFICIAL_PROVIDER, { provider: OFFICIAL_PROVIDER, settingsNs: 'llm-pi-ai' }]]),
  }
  if (registered) llm.adapters.set(OFFICIAL_PROVIDER, { provider: { id: OFFICIAL_PROVIDER }, adapter })
  return { llm, adapter, models, consumed }
}

// cordis 形态的假 ctx:on 返回注销器,effect 立即执行并留存其注销器
function makeHarness(llm) {
  const listeners = new Map()
  const effects = []
  const warn = []
  const info = []
  const ctx = {
    llm,
    logger: { warn: (message) => warn.push(message), info: (message) => info.push(message) },
    on(event, handler, options) {
      listeners.set(event, [...(listeners.get(event) ?? []), { handler, options }])
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry.handler !== handler))
    },
    fiber: { effect: (callback) => effects.push(callback()) },
  }
  const entries = (event) => listeners.get(event) ?? []
  return {
    ctx, warn, info,
    emit(event, ...args) {
      for (const { handler } of entries(event)) handler(...args)
    },
    options: (event) => entries(event).map((entry) => entry.options),
    count: (event) => entries(event).length,
    dispose() {
      for (const off of effects.splice(0)) off?.()
    },
  }
}

test('插件契约:inject 声明 llm 依赖,Config/apply 导出形态稳定', () => {
  assert.deepEqual(inject, ['llm'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
  // 新旧 schemastery 对空节的解析形态不同(有 volatile 时会剥掉 volatile 字段),
  // 这里只锁可解析,不锁具体取值
  assert.doesNotThrow(() => Config({}))
})

test('apply 授权存量官方 adapter:Anthropic 注入标记,Chat 补会话头', async () => {
  const host = makeHost()
  const harness = makeHarness(host.llm)
  assert.equal(await apply(harness.ctx, { sessionMarker: { enabled: true, prefix: 'custom' } }), undefined)
  assert.deepEqual(harness.warn, [])
  assert.match(harness.info.at(-1), /装饰器就绪/)

  host.adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models: host.models })
  assert.equal(host.consumed[0].options.metadata.user_id, deriveMarker('session-a', 'custom'))

  host.adapter.streamWithSnapshot({ sessionId: 'session-a', api: 'openai-completions' }, { models: host.models })
  assert.deepEqual(host.consumed[1].options.headers, {
    session_id: 'session-a', 'x-client-request-id': 'session-a',
  })

  // adapter 注册可能发生在别的 fiber 域,补扫监听必须全局作用域
  assert.deepEqual(harness.options('llm/adapters-updated'), [{ global: true }])
  assert.equal(harness.count('loader/volatile-update'), 1)
})

test('apply 缺省配置(host 未给 config)回落默认前缀仍注入', async () => {
  const host = makeHost()
  const harness = makeHarness(host.llm)
  await apply(harness.ctx, undefined)
  host.adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models: host.models })
  assert.equal(host.consumed[0].options.metadata.user_id, deriveMarker('session-a'))
})

test('节内只配 enabled 缺 prefix 时派生回落默认前缀', async () => {
  const host = makeHost()
  const harness = makeHarness(host.llm)
  await apply(harness.ctx, Config({ sessionMarker: { enabled: true } }))
  host.adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models: host.models })
  assert.match(host.consumed[0].options.metadata.user_id, /^dsh:[0-9a-f]{40}$/)
})

test('volatile ref 逐层解箱,loader/volatile-update 后按新配置注入', async () => {
  const host = makeHost()
  const harness = makeHarness(host.llm)
  let section = { enabled: false, prefix: 'before' }
  await apply(harness.ctx, { get: () => ({ sessionMarker: { get: () => section } }) })

  const disabled = { sessionId: 'session-a' }
  host.adapter.streamWithSnapshot(disabled, { models: host.models })
  assert.equal(host.consumed.at(-1).options, disabled)

  section = { enabled: true, prefix: 'after' }
  harness.emit('loader/volatile-update')
  host.adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models: host.models })
  assert.match(host.consumed.at(-1).options.metadata.user_id, /^after:/)
})

test('prefix 热更对已有会话生效:同 sessionId 下一轮按新前缀注入,Chat 头不变', async () => {
  const host = makeHost()
  const harness = makeHarness(host.llm)
  let section = { enabled: true, prefix: 'before' }
  await apply(harness.ctx, { get: () => ({ sessionMarker: { get: () => section } }) })

  host.adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models: host.models })
  assert.match(host.consumed[0].options.metadata.user_id, /^before:/)

  section = { enabled: true, prefix: 'after' }
  harness.emit('loader/volatile-update')
  host.adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models: host.models })
  assert.equal(host.consumed[1].options.metadata.user_id, deriveMarker('session-a', 'after'))

  host.adapter.streamWithSnapshot({ sessionId: 'session-a', api: 'openai-completions' }, { models: host.models })
  assert.deepEqual(host.consumed[2].options.headers, {
    session_id: 'session-a', 'x-client-request-id': 'session-a',
  })
})

test('宿主 llm 形态不符时告警禁用,不注册任何监听', async () => {
  for (const llm of [undefined, {}, { adapters: new Set() }]) {
    const harness = makeHarness(llm)
    assert.equal(await apply(harness.ctx, { sessionMarker: { enabled: true, prefix: 'dsh' } }), undefined)
    assert.match(harness.warn[0], /宿主 llm 服务形态不符/)
    assert.equal(harness.count('llm/adapters-updated'), 0)
    assert.equal(harness.count('loader/volatile-update'), 0)
    assert.deepEqual(harness.info, [])
  }
})

test('apply 时无官方 adapter 仅告警,adapters-updated 补扫后注入', async () => {
  const host = makeHost({ registered: false })
  const harness = makeHarness(host.llm)
  await apply(harness.ctx, { sessionMarker: { enabled: true, prefix: 'late' } })
  assert.equal(harness.warn.length, 1)
  assert.match(harness.warn[0], /无官方 adapter/)

  host.llm.adapters.set(OFFICIAL_PROVIDER, { provider: { id: OFFICIAL_PROVIDER }, adapter: host.adapter })
  harness.emit('llm/adapters-updated')
  host.adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models: host.models })
  assert.match(host.consumed[0].options.metadata.user_id, /^late:/)
})

test('dispose 后停止注入并注销监听,同进程 reapply 以新配置恢复', async () => {
  const host = makeHost()
  const harness = makeHarness(host.llm)
  await apply(harness.ctx, { sessionMarker: { enabled: true, prefix: 'first' } })
  harness.dispose()
  assert.equal(harness.count('llm/adapters-updated'), 0)
  assert.equal(harness.count('loader/volatile-update'), 0)

  const options = { sessionId: 'session-a' }
  host.adapter.streamWithSnapshot(options, { models: host.models })
  assert.equal(host.consumed.at(-1).options, options)

  await apply(harness.ctx, { sessionMarker: { enabled: true, prefix: 'again' } })
  host.adapter.streamWithSnapshot({ sessionId: 'session-a' }, { models: host.models })
  assert.match(host.consumed.at(-1).options.metadata.user_id, /^again:/)
})
