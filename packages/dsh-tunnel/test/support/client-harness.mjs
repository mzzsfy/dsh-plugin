// client 半区测试夹具: 真实源码 + 最小 React/DOM/总线替身。
// 只替代环境, 不替代行为: settings.section 是否注册、挂载后是否请求、可见性门控是否生效, 全由源码决定。
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/client.js', import.meta.url), 'utf8')
export const PKG = '@mzzsfy/dsh-tunnel'
export const tick = () => new Promise((resolve) => setImmediate(resolve))

const SLOT_BUCKETS = ['main', 'sidebar.panellist', 'settings.plugin.item', 'plugins.bundle.config', 'settings.section', 'shell.bottom']

function attachRefs(element) {
  if (element === null || typeof element !== 'object') return
  if (element.props?.ref && typeof element.props.ref === 'object') {
    element.props.ref.current = { mockNode: true, contains: () => false }
  }
  for (const child of element.props?.children ?? []) attachRefs(child)
}

export function createClientHarness(options = {}) {
  const state = {
    definition: null,
    rows: options.rows ?? [],
    ports: options.ports ?? [],
    lanOrigin: options.lanOrigin ?? 'http://192.168.1.7:3080',
    visibilityState: options.visibilityState ?? 'visible',
    requests: [],
    buckets: new Map(SLOT_BUCKETS.map((name) => [name, new Set()])),
    subscriptions: new Set(),
    docListeners: new Map(),
    effectDisposers: [],
    pendingEffects: [],
    componentCleanups: [],
    warnings: [],
  }

  const document = {
    visibilityState: state.visibilityState,
    querySelector: () => null,
    getElementById: () => ({ textContent: '', setAttribute() {} }),
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
    // 布局副作用在替身里按普通副作用处理: 只验证效果, 不模拟帧时序
    useLayoutEffect: (fn) => { state.pendingEffects.push(fn) },
  }

  const tools = {
    createSnapshotRefresh: (refresh) => ({ refresh, dispose() {} }),
    setupCommonTools(ctx) {
      const owner = { active: true, subscriptions: new Set() }
      ctx.effect(() => () => {
        owner.active = false
        owner.subscriptions.clear()
      })
      state.owner = owner
      return {
        subscribe(listener, { onReset } = {}) {
          if (!owner.active) throw new Error('不能订阅已卸载的 ctx')
          const subscription = { listener, onReset }
          owner.subscriptions.add(subscription)
          state.subscriptions.add(subscription)
          return () => { owner.subscriptions.delete(subscription); state.subscriptions.delete(subscription) }
        },
      }
    },
  }

  const window = {
    __ModuleLoader__: { load: (value) => { state.definition = value } },
    location: options.location ?? { protocol: 'http:', hostname: '127.0.0.1', port: '3080', origin: 'http://127.0.0.1:3080' },
  }

  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'navigator', source)(
    window,
    document,
    async (url, init = {}) => {
      state.requests.push({ url, method: init.method ?? 'GET' })
      let payload = { ok: true }
      if (url.startsWith('/api/tunnel/tunnels')) payload = { items: state.rows }
      else if (url === '/api/tunnel/status') payload = { ui: { aiTools: true }, total: state.rows.length, lanOrigin: state.lanOrigin }
      else if (url.startsWith('/api/tunnel/ports')) payload = { supported: true, scannedAt: '2026-11-15T10:00:00.000Z', items: state.ports }
      else if (url.startsWith('/api/tunnel/probe')) payload = { ok: true, listening: true, health: { state: 'online' } }
      return { ok: true, status: 200, json: async () => payload }
    },
    () => 0,
    () => {},
    options.navigator ?? {},
  )

  const plugin = state.definition.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => ({ type: 'portal', props: { children: [node] } }) }
    if (name === '@mzzsfy/dsh-common-tools/client') return tools
    throw new Error('unexpected module: ' + name)
  })

  const ctx = {
    fiber: { entry: { options: { name: PKG } } },
    get: () => undefined,
    inject() {},
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') state.effectDisposers.push(disposer)
      return disposer
    },
    slots: {
      inject(name, fn) {
        if (name !== 'settings.section' && name !== 'shell.bottom') return () => {}
        const result = fn()
        return typeof result === 'function' ? result : () => result?.return?.()
      },
      register(options_, component) {
        const entry = { options: options_, component }
        state.buckets.get(options_.name).add(entry)
        return () => state.buckets.get(options_.name).delete(entry)
      },
    },
  }

  function renderTree(element) {
    if (element === null || element === undefined) return element
    if (Array.isArray(element)) return element.map(renderTree)
    if (typeof element !== 'object') return element
    if (typeof element.type === 'function') {
      const rendered = element.type({ ...element.props, children: element.props?.children })
      return renderTree(rendered)
    }
    attachRefs(element)
    return element
  }

  function renderBucket(name, missing) {
    const entry = [...state.buckets.get(name)][0]
    if (entry === undefined) throw new Error(missing)
    state.pendingEffects = []
    const tree = renderTree(entry.component())
    const effects = state.pendingEffects.splice(0)
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') state.componentCleanups.push(cleanup)
    }
    return tree
  }

  return {
    state,
    requests: state.requests,
    warnings: state.warnings,
    activate() {
      plugin.apply(ctx)
    },
    dispose() {
      for (const cleanup of state.componentCleanups.splice(0)) cleanup()
      for (const disposer of state.effectDisposers.splice(0).reverse()) disposer()
    },
    sectionCount: () => state.buckets.get('settings.section').size,
    bottomCount: () => state.buckets.get('shell.bottom').size,
    panelCount: () => state.buckets.get('main').size,
    panellistCount: () => state.buckets.get('sidebar.panellist').size,
    pluginCardCount: () => state.buckets.get('settings.plugin.item').size + state.buckets.get('plugins.bundle.config').size,
    publish() {
      for (const subscription of [...state.subscriptions]) subscription.listener(null)
    },
    reset() {
      for (const subscription of [...state.subscriptions]) subscription.onReset?.()
    },
    hidePage() {
      document.visibilityState = 'hidden'
      for (const listener of state.docListeners.get('visibilitychange') ?? []) listener()
    },
    showPage() {
      document.visibilityState = 'visible'
      for (const listener of state.docListeners.get('visibilitychange') ?? []) listener()
    },
    renderSection() {
      return renderBucket('settings.section', '设置分区未注册')
    },
    renderBottom() {
      return renderBucket('shell.bottom', '底部状态条未注册')
    },
  }
}
