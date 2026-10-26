import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const PKG = '@mzzsfy/dsh-tunnel'
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(sidebarTab) {
  let definition, pendingEffects
  const owners = new Map(), requests = [], clocks = new Set()
  const window = { __ModuleLoader__: { load: value => { definition = value } } }
  const document = { getElementById: () => ({}) }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useRef: value => ({ current: value }),
    useCallback: fn => fn,
    useEffect: fn => pendingEffects.push(fn),
  }
  const tools = { createSnapshotRefresh: refresh => ({ refresh, dispose() {} }), setupCommonTools(ctx) {
    assert.equal(ctx.fiber.entry.options.name, PKG)
    const owner = { active: true, subscriptions: new Set() }
    owners.set(ctx, owner)
    ctx.effect(() => () => { owner.active = false; owner.subscriptions.clear() })
    return { subscribe(listener, { onReset } = {}) {
      assert.ok(owner.active, '不能订阅已卸载的 ctx')
      const subscription = { listener, onReset }
      owner.subscriptions.add(subscription)
      return () => owner.subscriptions.delete(subscription)
    } }
  } }
  const fetch = async path => {
    requests.push(path)
    return { ok: true, json: async () => ({ items: [], ui: { sidebarTab } }) }
  }
  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', source)(
    window, document, fetch,
    fn => { clocks.add(fn); return fn }, fn => clocks.delete(fn))
  const plugin = definition.factory(name => {
    if (name === 'react') return react
    if (name === 'react-dom/client') return {}
    assert.equal(name, '@mzzsfy/dsh-common-tools/client')
    return tools
  })
  function activate() {
    const cleanups = [], entries = new Set(), tabs = new Set()
    const service = { registerTab(tab) { tabs.add(tab); return () => tabs.delete(tab) } }
    const ctx = {
      fiber: { entry: { options: { name: PKG } } },
      get: name => name === 'betterSidebar' ? service : undefined,
      inject() {},
      effect(fn) {
        const cleanup = fn()
        let active = true
        const dispose = () => { if (active) { active = false; cleanup?.() } }
        cleanups.push(dispose)
        return dispose
      },
      slots: {
        inject(name, fn) { return name === 'main' || name === 'sidebar.panellist' ? fn() : () => {} },
        register(options, component) {
          const entry = { ...options, component }
          entries.add(entry)
          return () => entries.delete(entry)
        },
      },
    }
    plugin.apply(ctx)
    return {
      get subscriptions() { return owners.get(ctx).subscriptions },
      reset() { for (const item of [...this.subscriptions]) item.onReset?.() },
      emit() { for (const item of [...this.subscriptions]) item.listener(null) },
      mount() {
        const component = sidebarTab ? [...tabs][0]?.component : [...entries].find(item => item.name === 'main')?.component
        assert.equal(typeof component, 'function', '面板应已注册')
        pendingEffects = []
        const render = node => {
          if (Array.isArray(node)) return node.forEach(render)
          if (!node || typeof node !== 'object') return
          if (typeof node.type === 'function') render(node.type(node.props))
          else render(node.props.children)
        }
        render(component({ visible: true }))
        const disposers = pendingEffects.map(effect => effect()).filter(value => typeof value === 'function')
        return () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
      },
      dispose() { for (const dispose of [...cleanups].reverse()) dispose() },
      get registrations() { return entries.size + tabs.size },
    }
  }
  return { activate, requests, clocks }
}

for (const sidebarTab of [false, true]) {
  const surface = sidebarTab ? '侧栏' : '主面板'
  for (const survivorIndex of [0, 1]) {
    test(`Given 同 factory 的 A/B 已注册${surface} When 卸载 ${survivorIndex === 0 ? 'B' : 'A'} 后挂载存活面板 Then 仍用自己的租约订阅和刷新`, async () => {
      const f = fixture(sidebarTab), instances = [f.activate(), f.activate()]
      for (const instance of instances) instance.reset()
      await flush()
      const survivor = instances[survivorIndex], removed = instances[1 - survivorIndex]
      removed.dispose()
      assert.equal(removed.subscriptions.size, 0)
      assert.equal(removed.registrations, 0)
      const unmount = survivor.mount()
      assert.equal(survivor.subscriptions.size, 2)
      const before = f.requests.length
      survivor.reset()
      await flush()
      assert.equal(f.requests.length - before, 2)
      const afterReset = f.requests.length
      survivor.emit()
      await flush()
      assert.equal(f.requests.length - afterReset, 2)
      unmount()
      assert.equal(survivor.subscriptions.size, 1, '组件卸载仅清自己的数据订阅')
      const unmountAgain = survivor.mount()
      assert.equal(survivor.subscriptions.size, 2)
      survivor.dispose()
      assert.equal(survivor.subscriptions.size, 0)
      unmountAgain()
      survivor.dispose()
      assert.equal(f.clocks.size, 0)
    })
  }

  test(`Given A/B 的${surface}都已挂载 When 卸载 A Then 只清 A 的订阅并保留 B 的组件订阅`, async () => {
    const f = fixture(sidebarTab), a = f.activate(), b = f.activate()
    a.reset(); b.reset()
    await flush()
    const unmountA = a.mount(), unmountB = b.mount()
    assert.equal(a.subscriptions.size, 2)
    assert.equal(b.subscriptions.size, 2)
    a.dispose()
    assert.equal(a.subscriptions.size, 0)
    assert.equal(b.subscriptions.size, 2)
    unmountA()
    assert.equal(b.subscriptions.size, 2)
    unmountB()
    assert.equal(b.subscriptions.size, 1)
    b.dispose()
    assert.equal(b.subscriptions.size, 0)
    assert.equal(f.clocks.size, 0)
  })
}
