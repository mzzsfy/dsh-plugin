// client 半区测试夹具: 以真实源码 + 最小 React/DOM/总线替身驱动模块的 apply 与组件渲染。
// 只替代环境, 不替代行为: 面板/页签是否挂载、订阅是否触发、可见性门控是否生效, 全由源码决定。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/client.js', import.meta.url), 'utf8')
export const PKG = '@mzzsfy/dsh-tunnel'
export const tick = () => new Promise((resolve) => setImmediate(resolve))

const SLOT_BUCKETS = ['main', 'sidebar.panellist', 'settings.plugin.item', 'plugins.bundle.config']

function findComponent(element) {
  if (typeof element?.type === 'function') return element
  for (const child of element?.props?.children ?? []) {
    const found = findComponent(child)
    if (found !== undefined) return found
  }
  return undefined
}

function attachRefs(element) {
  if (element === null || typeof element !== 'object') return
  if (element.props?.ref && typeof element.props.ref === 'object') element.props.ref.current = { mockNode: true }
  for (const child of element.props?.children ?? []) attachRefs(child)
}

export function createClientHarness(options = {}) {
  const state = {
    definition: null,
    ui: { sidebarTab: false, aiTools: true, ...(options.ui ?? {}) },
    visibilityState: options.visibilityState ?? 'visible',
    requests: [],
    buckets: new Map(SLOT_BUCKETS.map((name) => [name, new Set()])),
    tabs: new Set(),
    subscriptions: new Set(),
    docListeners: new Map(),
    effectDisposers: [],
    pendingEffects: [],
    componentCleanups: [],
    pendingSidebarCallbacks: [],
    observerCallback: null,
    observerDisconnected: false,
    warnings: [],
  }

  const sidebarService = {
    registerTab(tab) {
      options.onRegisterTab?.()
      if (options.failRegisterTab === true) throw new Error('boom')
      state.tabs.add(tab)
      return () => state.tabs.delete(tab)
    },
  }
  state.sidebar = options.sidebar === true ? sidebarService : undefined

  const document = {
    visibilityState: state.visibilityState,
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, select() {}, id: '', textContent: '' }),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    addEventListener(type, listener) {
      if (!state.docListeners.has(type)) state.docListeners.set(type, new Set())
      state.docListeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      state.docListeners.get(type)?.delete(listener)
    },
    execCommand: () => false,
  }

  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useEffect: (fn) => { state.pendingEffects.push(fn) },
  }

  const tools = {
    setupCommonTools() {
      return {
        subscribe(listener, { onReset } = {}) {
          const subscription = { listener, onReset }
          state.subscriptions.add(subscription)
          return () => state.subscriptions.delete(subscription)
        },
      }
    },
    createSnapshotRefresh(refresh) {
      return { refresh, dispose() {} }
    },
  }

  const window = { __ModuleLoader__: { load: (definition) => { state.definition = definition } } }

  class FakeIntersectionObserver {
    constructor(callback) { state.observerCallback = callback }
    observe(node) { state.observedNode = node }
    disconnect() { state.observerDisconnected = true }
  }

  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'IntersectionObserver', source)(
    window, document,
    async (path) => {
      state.requests.push(path)
      const payload = path === '/api/tunnel/status' ? { ui: state.ui } : { items: [], ok: true }
      return { ok: true, status: 200, json: async () => payload }
    },
    () => 0, () => {},
    FakeIntersectionObserver,
  )

  const plugin = state.definition.factory((name) => {
    if (name === 'react') return react
    if (name === '@mzzsfy/dsh-common-tools/client') return tools
    throw new Error('unexpected module: ' + name)
  })

  const ctx = {
    get: (name) => (name === 'betterSidebar' ? state.sidebar : undefined),
    inject(names, callback) {
      if (!names.includes('betterSidebar')) return
      if (state.sidebar !== undefined) callback({ betterSidebar: state.sidebar })
      else state.pendingSidebarCallbacks.push(callback)
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') state.effectDisposers.push(disposer)
      return disposer
    },
    slots: {
      inject(name, fn) {
        const result = fn()
        if (typeof result === 'function') return result
        const first = result.next()
        const dispose = typeof first.value === 'function' ? first.value : () => {}
        return () => { dispose(); result.return?.() }
      },
      register(options_, component) {
        const entry = { options: options_, component }
        state.buckets.get(options_.name).add(entry)
        return () => state.buckets.get(options_.name).delete(entry)
      },
    },
  }

  return {
    state,
    requests: state.requests,
    warnings: state.warnings,
    activate() {
      const originalWarn = console.warn
      console.warn = (...args) => state.warnings.push(args.map(String).join(' '))
      state.restoreWarn = () => { console.warn = originalWarn }
      plugin.apply(ctx)
    },
    dispose() {
      for (const cleanup of state.componentCleanups.splice(0)) cleanup()
      for (const disposer of state.effectDisposers.splice(0).reverse()) disposer()
      state.restoreWarn?.()
    },
    panelCount: () => state.buckets.get('main').size,
    panellistCount: () => state.buckets.get('sidebar.panellist').size,
    tabCount: () => state.tabs.size,
    provideSidebar() {
      state.sidebar = sidebarService
      for (const callback of state.pendingSidebarCallbacks.splice(0)) callback({ betterSidebar: sidebarService })
    },
    setSidebarTab(value) {
      state.ui = { ...state.ui, sidebarTab: value }
    },
    publish() {
      for (const subscription of state.subscriptions) subscription.listener()
    },
    hidePage() {
      document.visibilityState = 'hidden'
      for (const listener of state.docListeners.get('visibilitychange') ?? []) listener()
    },
    showPage() {
      document.visibilityState = 'visible'
      for (const listener of state.docListeners.get('visibilitychange') ?? []) listener()
    },
    setNodeVisible(visible) {
      state.observerCallback?.([{ isIntersecting: visible }])
    },
    renderPanel() {
      const entry = [...state.buckets.get('main')][0]
      if (entry === undefined) throw new Error('主面板未注册')
      const tree = entry.component()
      const nested = findComponent(tree)
      if (nested === undefined) throw new Error('主面板未包含组件')
      state.pendingEffects = []
      const panelTree = nested.type(nested.props)
      attachRefs(panelTree)
      const effects = state.pendingEffects
      state.pendingEffects = []
      for (const effect of effects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') state.componentCleanups.push(cleanup)
      }
      return tree
    },
  }
}
