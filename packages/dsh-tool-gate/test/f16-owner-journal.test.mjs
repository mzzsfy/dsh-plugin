// F16 回归守护(可失败行为测试):owner 代际活性 + undo journal 按定义身份回收。
// 与 lifecycle.test.mjs 的假宿主同构,但这里刻意构造「同一 adapter 先后被两行授权」
// 与「同名换定义对象后再收敛」两个真实宿主动作,断言只落在可观察行为上
// (请求 tools 是否被折叠 / 定义对象退场后 deferLoading 是否复原)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'
import { DEFERRED_PLACEHOLDER_DESCRIPTION } from '../src/fallback.mjs'

/** 假宿主工具层(全局层集合,行之间共享同一份 data Map;条目为宿主 registration 形态)。 */
function makeStore(names) {
  const data = new Map(names.map((name) => [name, { definition: { name } }]))
  const visible = () => ({ visible: new Map([...data].map(([name, entry]) => [name, entry.definition])) })
  return {
    data,
    definitionOf: (name) => data.get(name)?.definition,
    tools: {
      layers: { global: { tools: { data } }, scoped: new Map() },
      view: visible,
      definitions: (scope, toolSet) => (toolSet === undefined ? [...visible().visible.values()] : [...toolSet.view(scope).values()]),
      register: () => () => {},
    },
  }
}

/** volatile ref 配置容器(与宿主行挂载形态一致);state 可变即热改。 */
function makeConfig(state) {
  return {
    allowlist: { get: () => [...state.allowlist] },
    enabled: { get: () => state.enabled },
    collapse: { get: () => state.collapse },
  }
}

/** 一行 apply:收集 effect 注销器与事件监听,返回 dispose/emit。 */
function applyRow(tools, config, llm) {
  const effects = []
  const listeners = new Map()
  const on = (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(handler)
  }
  const ctx = {
    get: (name) => (name === 'tools' ? tools : undefined),
    inject: (targets, fn) => {
      const services = { on }
      if (targets.includes('llm')) services.llm = llm
      if (targets.includes('settings')) services.settings = { configure() {} }
      fn(services)
    },
    on,
    effect: (factory) => {
      const dispose = factory()
      effects.push(() => dispose?.())
    },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, config)
  return {
    emit: (event) => {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    dispose: () => {
      for (const dispose of effects.splice(0)) dispose()
    },
  }
}

/** pi-ai adapter 类工厂:每次新建类,原型 patch 互不串扰。 */
function makeAdapterClass(calls) {
  return class Adapter {
    streamWithSnapshot(options) {
      calls.push(options)
      return 'stream'
    }
  }
}

/** llm 服务内部面:pi 行 settingsNs 命中降级折叠面。 */
function makeLlm(adapter) {
  return {
    adapters: new Map([['pi', { provider: { id: 'pi' }, adapter }]]),
    directory: new Map([['pi', { settingsNs: 'llm-pi-ai', provider: 'pi' }]]),
  }
}

const request = () => ({ tools: [{ name: 'read' }, { name: 'web' }] })

test('F16-a owner 过滤:行卸载后旧 owner 的 collapse 开关不再生效,新行决定折叠', () => {
  const calls = []
  const adapter = new (makeAdapterClass(calls))()
  const store = makeStore(['read', 'web'])
  const llm = makeLlm(adapter)

  const first = { allowlist: ['read'], enabled: true, collapse: true }
  const row1 = applyRow(store.tools, makeConfig(first), llm)
  adapter.streamWithSnapshot(request(), {})
  assert.equal(calls.at(-1).tools[1].description, DEFERRED_PLACEHOLDER_DESCRIPTION, '首行 collapse=true 应折叠')
  row1.dispose()

  // 卸载后以 collapse=false 重装:宿主现实形态里用户关掉折叠后重载本行
  const second = { allowlist: ['read'], enabled: true, collapse: false }
  const row2 = applyRow(store.tools, makeConfig(second), llm)
  adapter.streamWithSnapshot(request(), {})
  assert.deepEqual(calls.at(-1).tools, [{ name: 'read' }, { name: 'web' }], '旧 owner 已失效,新行 collapse=false 必须全量透传')

  // 只有活着的这一行能改变折叠结果(证明起作用的不是被卸载行的旧配置)
  second.collapse = true
  adapter.streamWithSnapshot(request(), {})
  assert.equal(calls.at(-1).tools[1].description, DEFERRED_PLACEHOLDER_DESCRIPTION, '活行 collapse=true 应折叠')
  row2.dispose()
})

test('F16-b undo journal 按定义身份刷新:同名换对象后收敛,退场时新对象回原状', () => {
  const store = makeStore(['read', 'web'])
  const row = applyRow(store.tools, makeConfig({ allowlist: ['read'], enabled: true, collapse: true }))
  const original = store.definitionOf('web')
  assert.equal(original.deferLoading, true, '白名单外工具应被标记')

  // 宿主重挂同名定义(旧对象离场,新对象进场)
  const replacement = { name: 'web' }
  store.data.set('web', { definition: replacement })
  row.emit('tools/change')
  assert.equal(replacement.deferLoading, true, '重注册后新对象应重新打标')

  row.dispose()
  assert.equal('deferLoading' in replacement, false, '退场必须还原当前定义对象(旧 journal 记录不得挡住回收)')
  assert.equal(store.definitionOf('read').deferLoading, undefined, '白名单内工具始终无标')
})
