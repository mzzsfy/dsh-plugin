import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFERRED_PLACEHOLDER_DESCRIPTION } from '../src/fallback.mjs'
import { apply } from '../src/index.js'

// 假宿主:全局层 + per-agent scoped 层 + 行 ctx(on/effect/logger/get)。
// config 以 volatile ref 容器形态传入(与宿主行挂载一致),get 可变以驱动热改。
function harness(initialLayers, initialConfig = {}) {
  const globalData = new Map(Object.entries(initialLayers.global ?? {}))
  const scoped = new Map()
  for (const [key, defs] of Object.entries(initialLayers.scoped ?? {})) scoped.set(key, { tools: { data: new Map(Object.entries(defs)) } })
  const registered = new Map()
  const tools = {
    layers: { global: { tools: { data: globalData } }, scoped },
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const current = {
    allowlist: initialConfig.allowlist ?? ['read'],
    enabled: initialConfig.enabled ?? true,
    collapse: initialConfig.collapse ?? true,
  }
  const config = {
    allowlist: { get: () => [...current.allowlist] },
    enabled: { get: () => current.enabled },
    collapse: { get: () => current.collapse },
  }
  const listeners = new Map()
  const effects = []
  const logs = { info: [], warn: [] }
  const ctx = {
    get: (name) => (name === 'tools' ? tools : undefined),
    inject: (targets, fn) => {
      // 假宿主:声明即回调(真宿主服务在场同形);settings/llm 缺席由消费端兜
      const services = {
        on: (event, handler) => {
          if (!listeners.has(event)) listeners.set(event, [])
          listeners.get(event).push(handler)
        },
      }
      if (targets.includes('settings')) services.settings = { configure() {} }
      if (targets.includes('llm')) services.llm = initialConfig.llm
      fn(services)
    },
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    // 真宿主语义:effect 工厂即时执行,产物(注销器)登记到行退场
    effect: (factory) => {
      const dispose = factory()
      effects.push(() => { dispose?.() })
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
  }
  return {
    tools,
    current,
    logs,
    registered,
    definitionOf: (layerKey, name) => (layerKey === 'global' ? globalData : scoped.get(layerKey).tools.data).get(name),
    addAgentLayer: (key, defs) => {
      scoped.set(key, { tools: { data: new Map(Object.entries(defs)) } })
    },
    emit: (event) => {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    dispose: () => {
      for (const factory of effects) factory()?.()
    },
    applyRow: () => apply(ctx, config),
  }
}

test('SC-1 apply 收敛:全局层 + scoped 层逐层分野', () => {
  const h = harness({
    global: { read: { name: 'read' }, working_directory: { name: 'working_directory' } },
    scoped: { 'agent#1': { shell: { name: 'shell' }, web_search: { name: 'web_search' } } },
  }, { allowlist: ['read', 'shell'] })
  h.applyRow()
  assert.equal('deferLoading' in h.definitionOf('global', 'read'), false)
  assert.equal(h.definitionOf('global', 'working_directory').deferLoading, true)
  assert.equal('deferLoading' in h.definitionOf('agent#1', 'shell'), false)
  assert.equal(h.definitionOf('agent#1', 'web_search').deferLoading, true)
})

test('SC-2 白名单命中即清自带 defer(用户意图优先)', () => {
  const h = harness({ scoped: { 'agent#1': { web_search: { name: 'web_search', deferLoading: true } } } }, { allowlist: ['web_search'] })
  h.applyRow()
  assert.equal('deferLoading' in h.definitionOf('agent#1', 'web_search'), false)
})

test('SC-3 白名单热改:volatile-update 现读 ref 重收敛', () => {
  const h = harness({ scoped: { 'agent#1': { read: { name: 'read' }, shell: { name: 'shell' } } } }, { allowlist: ['read'] })
  h.applyRow()
  assert.equal(h.definitionOf('agent#1', 'shell').deferLoading, true)
  h.current.allowlist = ['read', 'shell']
  h.emit('loader/volatile-update')
  assert.equal('deferLoading' in h.definitionOf('agent#1', 'shell'), false)
})

test('SC-4 新 scoped 层(tools/change)收敛打标', () => {
  const h = harness({ global: { read: { name: 'read' } } })
  h.applyRow()
  h.addAgentLayer('agent#2', { web_fetch: { name: 'web_fetch' } })
  h.emit('tools/change')
  assert.equal(h.definitionOf('agent#2', 'web_fetch').deferLoading, true)
})

test('SC-5 重注册新对象:tools/change 后重新打标', () => {
  const h = harness({ scoped: { 'agent#1': { web_search: { name: 'web_search' } } } })
  h.applyRow()
  assert.equal(h.definitionOf('agent#1', 'web_search').deferLoading, true)
  const replacement = { name: 'web_search' }
  h.tools.layers.scoped.get('agent#1').tools.data.set('web_search', replacement)
  h.emit('tools/change')
  assert.equal(replacement.deferLoading, true)
})

test('SC-6 行退场还原:打标消失,自带 defer 声明恢复,顶替对象跳过', () => {
  const h = harness({
    scoped: {
      'agent#1': {
        read: { name: 'read' },
        web_search: { name: 'web_search', deferLoading: true },
        replaced: { name: 'replaced' },
      },
    },
  }, { allowlist: ['read', 'web_search'] })
  h.applyRow()
  assert.equal(h.definitionOf('agent#1', 'replaced').deferLoading, true)
  const fresh = { name: 'replaced' }
  h.tools.layers.scoped.get('agent#1').tools.data.set('replaced', fresh)
  h.dispose()
  assert.equal('deferLoading' in h.definitionOf('agent#1', 'read'), false)
  assert.equal(h.definitionOf('agent#1', 'web_search').deferLoading, true)
  assert.equal('deferLoading' in fresh, false)
})

test('SC-6 二次 dispose 幂等(journal 已清,空转)', () => {
  const h = harness({ global: { read: { name: 'read' }, web: { name: 'web' } } })
  h.applyRow()
  h.dispose()
  h.dispose()
  assert.equal('deferLoading' in h.definitionOf('global', 'web'), false)
})

test('SC-7 enabled=false 还原全部并停止打标;回 true 重新收敛', () => {
  const h = harness({ global: { read: { name: 'read' }, web: { name: 'web' } } })
  h.applyRow()
  assert.equal(h.definitionOf('global', 'web').deferLoading, true)
  h.current.enabled = false
  h.emit('loader/volatile-update')
  assert.equal('deferLoading' in h.definitionOf('global', 'web'), false)
  h.addAgentLayer('agent#2', { later: { name: 'later' } })
  h.emit('tools/change')
  assert.equal('deferLoading' in h.definitionOf('agent#2', 'later'), false)
  h.current.enabled = true
  h.emit('loader/volatile-update')
  assert.equal(h.definitionOf('global', 'web').deferLoading, true)
  assert.equal(h.definitionOf('agent#2', 'later').deferLoading, true)
})

test('SC-8 白名单未知名 warn 不阻断(以全部层并集判定)', () => {
  const h = harness({ scoped: { 'agent#1': { read: { name: 'read' } } } }, { allowlist: ['read', 'no_such_tool'] })
  h.applyRow()
  assert.ok(h.logs.warn.some((message) => message.includes('no_such_tool')))
  assert.ok(!h.logs.warn.some((message) => message.includes('read,')))
  assert.equal(h.definitionOf('agent#1', 'read').deferLoading, undefined)
})

test('SC-9 内部面缺失:warn 干净禁用零动作', () => {
  const logs = []
  const effects = []
  apply({
    get: () => ({ layers: {} }),
    on: () => {},
    effect: (factory) => effects.push(factory),
    logger: { warn: (message) => logs.push(message) },
  }, { allowlist: { get: () => [] }, enabled: { get: () => true } })
  assert.ok(logs.some((message) => message.includes('干净禁用')))
  assert.equal(effects.length, 0)
})

test('重复收敛幂等:同一目标态反复 emit 不产生重复副作用', () => {
  const h = harness({ global: { read: { name: 'read' }, web: { name: 'web' } } })
  h.applyRow()
  const convergenceLogs = () => h.logs.info.filter((message) => message.includes('收敛')).length
  assert.equal(convergenceLogs(), 1)
  h.emit('tools/change')
  h.emit('tools/change')
  assert.equal(convergenceLogs(), 1)
  assert.equal(h.definitionOf('global', 'web').deferLoading, true)
})

test('SC-22 tool_search 注册与隐式白名单:收敛不打标,退场注销', () => {
  const h = harness({ global: { read: { name: 'read' }, web: { name: 'web' } } }, { allowlist: ['read'] })
  h.applyRow()
  assert.ok(h.registered.has('tool_search'))
  assert.equal(h.definitionOf('global', 'web').deferLoading, true)
  h.dispose()
  assert.equal(h.registered.has('tool_search'), false)
})

test('SC-22 收敛不打标 tool_search(白名单外仍保持清标)', () => {
  const h = harness({ global: { read: { name: 'read' }, tool_search: { name: 'tool_search' } } }, { allowlist: ['read'] })
  h.applyRow()
  assert.equal('deferLoading' in h.definitionOf('global', 'tool_search'), false)
  assert.equal(h.definitionOf('global', 'read').deferLoading, undefined)
})

test('SC-19 llm 缺席:降级折叠 warn 禁用,打标不受影响', () => {
  const h = harness({ global: { read: { name: 'read' }, web: { name: 'web' } } })
  h.applyRow()
  assert.ok(h.logs.warn.some((message) => message.includes('降级折叠禁用')))
  assert.equal(h.definitionOf('global', 'web').deferLoading, true)
})

function makeLlm(piAdapter, dsAdapter) {
  return {
    adapters: new Map([
      ['pi', { provider: { id: 'pi' }, adapter: piAdapter }],
      ['ds', { provider: { id: 'ds' }, adapter: dsAdapter }],
    ]),
    directory: new Map([
      ['pi', { settingsNs: 'llm-pi-ai', provider: 'pi' }],
      ['ds', { settingsNs: 'llm-deepseek', provider: 'ds' }],
    ]),
  }
}

// 每次新建类:方法落原型,patch 不被自有属性遮蔽;类间原型隔离防串扰
function makeAdapterClass(calls) {
  return class Adapter {
    streamWithSnapshot(options) {
      calls.push(options)
      return 'stream'
    }
  }
}

test('SC-16 llm 在场:pi-ai adapter 改写生效,deepseek 原生不 patch', () => {
  const piCalls = []
  const dsCalls = []
  const piAdapter = new (makeAdapterClass(piCalls))()
  const dsAdapter = new (makeAdapterClass(dsCalls))()
  const h = harness(
    { global: { read: { name: 'read' }, web: { name: 'web' } } },
    { allowlist: ['read'], llm: makeLlm(piAdapter, dsAdapter) },
  )
  h.applyRow()
  piAdapter.streamWithSnapshot({ tools: [{ name: 'read' }, { name: 'web' }] }, {})
  // 折叠为名字占位而非剔除:名字保留(生成端可见),形态为占位定义
  assert.deepEqual(piCalls[0].tools.map((tool) => tool.name), ['read', 'web'])
  assert.equal(piCalls[0].tools[0].name, 'read')
  assert.deepEqual(piCalls[0].tools[1], { name: 'web', description: DEFERRED_PLACEHOLDER_DESCRIPTION, parameters: { type: 'object', properties: {} } })
  dsAdapter.streamWithSnapshot({ tools: [{ name: 'web' }] }, {})
  assert.deepEqual(dsCalls[0].tools.map((tool) => tool.name), ['web'])
})

test('SC-19 collapse=false:门关全量透传(打标维持)', () => {
  const piCalls = []
  const piAdapter = new (makeAdapterClass(piCalls))()
  const h = harness(
    { global: { read: { name: 'read' }, web: { name: 'web' } } },
    { allowlist: ['read'], collapse: false, llm: makeLlm(piAdapter, new (makeAdapterClass([]))()) },
  )
  h.applyRow()
  assert.equal(h.definitionOf('global', 'web').deferLoading, true)
  piAdapter.streamWithSnapshot({ tools: [{ name: 'read' }, { name: 'web' }] }, {})
  assert.deepEqual(piCalls[0].tools.map((tool) => tool.name), ['read', 'web'])
})
