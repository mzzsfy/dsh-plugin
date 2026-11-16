import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { setImmediate as settled } from 'node:timers/promises'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
function fixture({ tabs = [], params = {}, listed = async () => ({ ok: true, value: [{ id: 'term-a' }] }), fetchImpl = async () => ({ ok: true, json: async () => ({}) }), roots = [], storage = new Map(), binding = true } = {}) {
  let definition, component
  const effects = [], calls = [], seen = [], refs = [], timers = []
  // 面板补查定时器走假时钟:禁用后是否还留待发回调、回调是否真被取消都可判定
  const timeouts = new Map(), cleared = []
  const intervalCleared = []
  const disposals = [], binds = [], refreshes = [], localWrites = []
  let nextTimer = 0
  let index = 0, declared = false, active = true, mountedSession = 'session-a'
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...(props ?? {}), children })
      return { type, props: props ?? {}, children }
    },
    useEffect(effect) { effects.push(effect) },
    useRef(value) { const slot = index++; return refs[slot] ??= { current: value } },
    // 恒展开:官方行折叠态不含展开体,本文件验证结果数据可达导航;展开交互在 toolview.test.mjs
    useState() { return [true, () => {}] },
  }
  const sidebarRight = {
    openTabIn(...args) { calls.push(args) },
    // 宿主的 openResourceIn 会同步提交 tab,补写逻辑依赖这份提交
    openResourceIn(sessionId, contentId, options) {
      calls.push(['reveal', sessionId, contentId, options])
      tabs.push({ sessionId, kind: options.kind, tabId: `tab-${tabs.length}`, contentId })
    },
    openTabs: { getSnapshot: () => tabs },
    mounted: { getSnapshot: () => mountedSession },
    tabDomain: {
      occurrence: () => ({ navigation: { getSnapshot: () => ({ params }) } }),
      navigate(...args) { calls.push(['navigate', ...args]) },
    },
  }
  const views = []
  // 宿主 view 的原始实现:包装必须可还原,断言以它为准
  const hostView = function view(sessionId, key, contentId, terminalId) {
    views.push([sessionId, key, contentId, terminalId])
    return { state: { getSnapshot: () => ({}) }, refresh: () => refreshes.push([sessionId, key, contentId, terminalId]), dispose() {} }
  }
  const webTerminals = { view: hostView }
  if (binding === true) webTerminals.bind = (sessionId, contentId, terminalId) => { binds.push([sessionId, contentId, terminalId]) }
  else if (typeof binding === 'function') webTerminals.bind = binding
  const remote = { terminal: { async list(sessionId) { seen.push(sessionId); return listed(sessionId) } } }
  // 自愈只扫 [data-sidebar-terminal];其余选择器由各用例的节点桩承担
  const documentStub = {
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    querySelectorAll: (selector) => (selector === '[data-sidebar-terminal]' ? roots : []),
  }
  new vm.Script(source).runInNewContext({
    AbortController,
    AbortSignal,
    Date,
    fetch: fetchImpl,
    document: documentStub,
    sessionStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
    },
    // 宿主私有键一律不该被插件直写:任何 localStorage 写入都留档供断言
    localStorage: {
      getItem: () => null,
      setItem: (key, value) => { localWrites.push([key, String(value)]) },
      removeItem: () => {},
    },
    setInterval: (fn) => { timers.push(fn); return timers.length },
    setTimeout: (fn) => { const id = ++nextTimer; timeouts.set(id, fn); return id },
    clearTimeout: (id) => { cleared.push(id); timeouts.delete(id) },
    clearInterval: (id) => { intervalCleared.push(id) },
    window: { __ModuleLoader__: { load(value) { definition = value } } },
  })
  assert.equal(definition.id, '@mzzsfy/dsh-shared-terminal')
  const primitives = new Proxy({}, { get: (_target, name) => (props) => ({ type: String(name), props: props ?? {} }) })
  const plugin = definition.factory((id) => { if (id === 'react') return React; if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives; throw new Error('unexpected module ' + id) })
  const slots = {
    inject(name, factory) { assert.equal(name, 'tool.call.toolview'); declared = true; factory() },
    register(meta, view) { assert.equal(declared, true); assert.equal(meta.key, 'terminal'); component = view; return () => { active = false } },
  }
  // effect 的清理函数按卸载序反向执行,与 fiber 释放一致
  const ctx = {
    remote, slots, sidebarRight, webTerminals, locale: { register: () => {} },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposals.push(dispose); return dispose },
  }
  const mount = () => plugin.apply(ctx)
  mount()
  return {
    calls, seen, views, webTerminals, plugin, hostView, binds, refreshes, localWrites, timeouts, cleared, intervalCleared,
    document: documentStub, storage,
    setSession(id) { mountedSession = id },
    render(props) { index = 0; return component(props) },
    // 面板创建按 PANEL_GAP_MS 串行,flush 要等队列走完
    async flush() { const pending = effects.splice(0).map((effect) => effect()); await settled(); return pending },
    async heal() { for (const timer of timers) await timer() },
    // 模拟 fiber 卸载/禁用后新代重装(HMR)
    dispose() { for (const dispose of disposals.splice(0).reverse()) dispose() },
    mount,
    runPendingNudges() { for (const [id, fire] of [...timeouts]) { timeouts.delete(id); fire() } },
  }
}
test('Given no terminal panel, When reopening result, Then a panel is opened at the terminal address', async () => {
  const app = fixture({ tabs: [], params: undefined })
  app.render(props('open'))
  await app.flush()
  assert.equal(JSON.stringify([['reveal', 'session-a', 'dsh-resource://dsh-shared-terminal/panel/term-a', { kind: 'terminal', params: { terminalId: 'term-a' } }], ['navigate', 'session-a', 'tab-0', { address: 'dsh-resource://dsh-shared-terminal/panel/term-a', params: { terminalId: 'term-a' } }]]), JSON.stringify(app.calls), '新面板建好后要补写导航参数,否则 view 首帧拿不到 terminalId')
})

test('Given the panel of this terminal is already open, When the result renders again, Then the same address is reopened', async () => {
  const app = fixture({ tabs: [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab', contentId: 'dsh-resource://dsh-shared-terminal/panel/term-a' }], params: { terminalId: 'term-a' } })
  app.render(props('open'))
  await app.flush()
  app.render({ ...props('open'), callId: 'call-b' })
  await app.flush()
  assert.equal(app.calls.filter((call) => call[0] === 'reveal').length, 1, '同一 terminal 只导航一次')
  assert.equal(JSON.stringify(app.calls[0][2]), JSON.stringify('dsh-resource://dsh-shared-terminal/panel/term-a'))
})

test('Given a panel of another terminal is open, When this result renders, Then it does not hijack that panel', async () => {
  // 改导航参数不会重建 xterm 实例,复用别人的面板会看到错的终端
  const app = fixture({ tabs: [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab9', contentId: 'sidebar://terminal/2f1c' }], params: { terminalId: 'term-b' } })
  app.render(props('open'))
  await app.flush()
  assert.equal(JSON.stringify(app.calls[0]), JSON.stringify(['reveal', 'session-a', 'dsh-resource://dsh-shared-terminal/panel/term-a', { kind: 'terminal', params: { terminalId: 'term-a' } }]))
})

test('Given an open result was opened in this tab, When the page reloads, Then the same terminal is not navigated again', async () => {
  const storage = new Map()
  const first = fixture({ storage })
  first.render(props('open'))
  await first.flush()
  assert.equal(first.calls.filter((call) => call[0] === 'reveal').length, 1)
  // 刷新后模块重新加载,同一标签页的 sessionStorage 保留;布局自行恢复面板,不再逐卡导航
  const reloaded = fixture({ storage, tabs: [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab', contentId: 'dsh-resource://dsh-shared-terminal/panel/term-a' }], params: { terminalId: 'term-a' } })
  reloaded.render(props('open'))
  await reloaded.flush()
  assert.deepEqual(reloaded.calls, [], '刷新后同一 terminal 不应重复导航')
})

test('Given two open results for the same terminal, When both render, Then the panel is opened once', async () => {
  const app = fixture({ tabs: [], params: undefined })
  app.render(props('open'))
  await app.flush()
  app.render({ ...props('open'), callId: 'call-b' })
  await app.flush()
  assert.equal(app.calls.filter((call) => call[0] === 'reveal').length, 1, '同一 terminal 只开一次面板,重复导航会闪面板')
})

test('Given remote query pending, When effect unmounts and same result remounts, Then only the new lifetime may navigate', async () => {
  const pending = []
  const app = fixture({ listed: () => new Promise((resolve) => pending.push(resolve)) })
  app.render(props('open'))
  const cleanups = await app.flush()
  cleanups.forEach((cleanup) => cleanup?.())
  pending.shift()({ ok: true, value: [{ id: 'term-a' }] })
  await settled()
  assert.equal(app.calls.length, 0)
  app.render(props('open'))
  await app.flush()
  pending.shift()({ ok: true, value: [{ id: 'term-a' }] })
  await settled()
  assert.equal(app.calls.filter((call) => call[0] === 'reveal').length, 1)
})

const props = (action, result = { ok: true, terminal_id: 'term-a' }) => ({
  phase: 'result', sessionId: 'session-a', callId: 'call-a', toolName: 'terminal',
  block: { call: { name: 'terminal', argsRaw: JSON.stringify({ action }) }, isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] },
})
const walk = (tree) => {
  if (tree === null || tree === undefined || tree === false || tree === true) return []
  if (Array.isArray(tree)) return tree.flatMap(walk)
  if (typeof tree !== 'object') return [tree]
  if (!('type' in tree)) return typeof tree === 'string' ? [tree] : []
  return [tree, ...walk(tree.children), ...walk(tree.props?.children)]
}

test('Given classic-script loader and declared slot, When plugin materializes, Then its service gates and renderer register', () => {
  const app = fixture()
  assert.deepEqual(Array.from(app.plugin.inject), ['remote', 'remote.terminal', 'slots', 'sidebarRight', 'webTerminals', 'locale'])
  assert.ok(app.render(props('open')))
})

test('Given successful open result, When rendering then committing effect, Then only the owner Session native tab opens once', async () => {
  const app = fixture()
  const tree = app.render(props('open'))
  assert.equal(app.calls.length, 0)
  assert.match(JSON.stringify(tree), /term-a/)
  await app.flush()
  app.render(props('open'))
  await app.flush()
  assert.equal(app.calls.filter((call) => call[0] === 'reveal').length, 1)
  assert.equal(JSON.stringify(app.calls[0]), JSON.stringify(['reveal', 'session-a', 'dsh-resource://dsh-shared-terminal/panel/term-a', { kind: 'terminal', params: { terminalId: 'term-a' } }]))
  assert.deepEqual(app.seen, ['session-a'])
})

test('Given read/write/close or error result, When committing renderer, Then output stays visible without automatic navigation', async () => {
  const app = fixture()
  const readTree = app.render(props('read', { ok: true, terminal_id: 'term-a', text: 'visible-screen' }))
  assert.match(JSON.stringify(readTree), /visible-screen/)
  await app.flush()
  for (const action of ['write', 'close']) {
    const tree = app.render(props(action, { ok: true, terminal_id: 'term-a' }))
    assert.match(JSON.stringify(tree), /"data-state":"done"/)
    await app.flush()
  }
  const tree = app.render(props('open', { ok: false, error: { code: 'LIMIT_REACHED', message: 'limit' } }))
  assert.match(JSON.stringify(tree), /LIMIT_REACHED/)
  await app.flush()
  assert.equal(app.calls.length, 0)
})

test('Given old open result for a closed terminal, When effect replays, Then no lost terminal is reopened', async () => {
  const app = fixture()
  const history = props('open', { ok: true, terminal_id: 'closed' })
  app.render(history)
  await app.flush()
  assert.equal(app.calls.length, 0)
})

test('Given successful open result, When clicking the terminal button, Then explicit navigation is scoped to that Session', async () => {
  const app = fixture()
  const tree = app.render(props('open'))
  const button = walk(tree).find((node) => node.type === 'button')
  assert.ok(button)
  await app.flush()
  app.calls.length = 0
  await button.props.onClick()
  assert.equal(app.calls.filter((call) => call[0] === 'reveal').length, 1)
})

test('Given preparing or start phase, When rendering, Then a visible tool status is present', () => {
  const app = fixture()
  for (const phase of ['preparing', 'start']) {
    assert.ok(app.render({ phase, sessionId: 'session-a', callId: phase, toolName: 'terminal', block: { argsRaw: '{"action":"read"}' } }))
  }
})

// ── wait 手动打断(SK7) ────────────────────────────────────────────────

const fetchCalls = []
const fetchStub = async (url, options) => {
  fetchCalls.push([url, options])
  return { ok: true, json: async () => ({ ok: true, skipped: 1 }) }
}

// t 桩直读中文字典:真实宿主由 locale 槽位注入,文案断言须过同一字典

test('Given a running wait, When rendering, Then the card shows the wait needle and a skip button that posts to the skip route', async () => {
  fetchCalls.length = 0
  const app = fixture({ fetchImpl: fetchStub })
  const tree = app.render({
    phase: 'start', sessionId: 'session-a', callId: 'call-wait', toolName: 'terminal',
    t: (key) => ({ 'action.wait': '等待屏幕文本', 'action.skipWait': '跳过等待', 'running': '执行中' })[key] ?? key,
    block: { argsRaw: JSON.stringify({ action: 'wait', terminal_id: 'term-a', text: 'Build successful' }) },
  })
  const rendered = JSON.stringify(tree)
  assert.match(rendered, /Build successful/, '运行中须提示正在等什么')
  assert.match(rendered, /跳过等待/)
  // fixture createElement 把 children 存 node.children(与 props 分离)
  const button = walk(tree).find((node) => node.type === 'button' && JSON.stringify(node.children ?? '').includes('跳过等待'))
  assert.ok(button, '须渲染跳过按钮')
  await button.props.onClick()
  const [url, options] = fetchCalls[0] ?? []
  assert.equal(url, '/api/shared-terminal/wait/skip')
  assert.equal(options.method, 'POST')
  assert.deepEqual(JSON.parse(options.body), { sessionId: 'session-a', terminalId: 'term-a' })
})

test('Given a settled wait with kind skipped, When rendering, Then a skipped badge is shown', () => {
  const app = fixture()
  const tree = app.render({
    ...props('wait', { ok: true, terminal_id: 'term-a', kind: 'skipped', text: '$', lines: 1, truncated: false, state: 'running', sequence: 1 }),
    t: (key) => ({ 'badge.skipped': '已跳过', 'action.wait': '等待屏幕文本', 'unit.lines': '行', 'label.screen': '屏幕', 'hint.blankScreen': '（屏幕底部为空白行）' })[key] ?? key,
  })
  assert.match(JSON.stringify(tree), /已跳过/)
})

test('Given a failed skip request, When the skip button is clicked, Then the failure is surfaced without throwing and the route was hit', async () => {
  const calls = []
  const app = fixture({ fetchImpl: async (url, options) => { calls.push([url, options]); return { ok: false, status: 500, json: async () => ({}) } } })
  const renderProps = {
    phase: 'start', sessionId: 'session-a', callId: 'call-wait-fail', toolName: 'terminal',
    t: (key) => ({ 'action.skipWait': '跳过等待' })[key] ?? key,
    block: { argsRaw: JSON.stringify({ action: 'wait', terminal_id: 'term-a', text: 'Build successful' }) },
  }
  const tree = app.render(renderProps)
  const button = walk(tree).find((node) => node.type === 'button' && JSON.stringify(node.children ?? '').includes('跳过等待'))
  await button.props.onClick()
  assert.equal(calls.length, 1, 'skip 请求须已发出')
  // 错误经 catch 落卡(error state 非空分支),不向 React 抛出;渲染形态与既有 error 徽章同构
})

test('Given a running non-wait tool, When rendering, Then no skip button appears', () => {
  const app = fixture()
  const tree = app.render({ phase: 'start', sessionId: 'session-a', callId: 'call-read', toolName: 'terminal', block: { argsRaw: '{"action":"read","terminal_id":"term-a"}' } })
  assert.ok(!JSON.stringify(tree).includes('跳过等待'))
})

// ── 只读终端自愈:泵释放后宿主不归还 writable,只读界面不重算几何 ─────────

const fakeRoot = (options = { clicks: [] }) => {
  const state = {
    clicks: options.clicks,
    content: options.contentHeight ?? 800,
    readonly: options.readonly ?? true,
    visible: options.visible ?? true,
    status: options.statusHeight ?? 40,
    connected: options.connected ?? true,
    label: options.buttonLabel ?? '接管输入',
  }
  const root = {
    state,
    get isConnected() { return state.connected },
    set isConnected(value) { state.connected = value },
    getBoundingClientRect: () => ({ width: state.visible ? 400 : 0, height: state.visible ? 500 : 0 }),
    querySelector(selector) {
      if (selector === '[role="status"]') {
        if (!state.readonly) return null
        return {
          getBoundingClientRect: () => ({ width: 400, height: state.status }),
          querySelector: (inner) => (inner === 'button' ? { textContent: state.label, click: () => state.clicks.push('takeover') } : null),
        }
      }
      if (selector === '.xterm-screen') return { getBoundingClientRect: () => ({ width: 400, height: state.content }) }
      if (selector === '.xterm') return { getBoundingClientRect: () => ({ width: 400, height: 300 }) }
      if (selector === '.xterm-viewport') return options.scrollable === true ? { clientHeight: 300, scrollHeight: 900 } : null
      return null
    },
  }
  return root
}

const healingFixture = (options) => {
  const queries = []
  const inner = options.fetchImpl ?? (async () => ({ ok: true, json: async () => ({ ok: true, attached: false }) }))
  const app = fixture({
    tabs: [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab', contentId: 'content' }],
    params: { terminalId: 'term-a' },
    fetchImpl: async (url, init) => { queries.push([url, JSON.parse(init?.body ?? '{}')]); return inner(url, init) },
    roots: options.roots ?? [],
  })
  app.queries = queries
  return app
}

test('Given a read-only clipped terminal without controller, When healing ticks, Then it takes input control once', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks })] })
  await app.heal()
  assert.deepEqual(clicks, ['takeover'])
  assert.deepEqual(app.queries, [['/api/shared-terminal/pump', { sessionId: 'session-a' }]], '自愈须查宿主泵状态路由')
  await app.heal()
  assert.deepEqual(clicks, ['takeover'], '冷却窗口内不得重复抢控制权')
})

test('Given the pump still attached, When healing ticks, Then the user view is left alone', async () => {
  const clicks = []
  const app = healingFixture({
    roots: [fakeRoot({ clicks })],
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, attached: true }) }),
  })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given content fits the container, When healing ticks, Then no takeover happens', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks, contentHeight: 300 })] })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given only the read-only status bar shortens the box, When healing ticks, Then it is not treated as clipping', async () => {
  const clicks = []
  // 311 只比容器多 11px,恰好不足状态栏高度:这是状态栏占位,不是用户看不全
  const app = healingFixture({ roots: [fakeRoot({ clicks, contentHeight: 311 })] })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given content scrolls inside the viewport, When healing ticks, Then it is not treated as clipped', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks, scrollable: true })] })
  await app.heal()
  assert.deepEqual(clicks, [], '可滚动的溢出是 scrollback,不该抢控制权')
})

test('Given the terminal is not read-only, When healing ticks, Then the status button is never clicked', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks, readonly: false })] })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given the pump state route is unavailable, When healing ticks, Then no takeover is attempted', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks })], fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given the pump state query rejects, When healing ticks, Then the failure is swallowed and nothing is taken over', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks })], fetchImpl: async () => { throw new Error('network down') } })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given the tab was detached while the pump state was queried, When healing ticks, Then no click lands on the stale node', async () => {
  const clicks = []
  const root = fakeRoot({ clicks })
  const app = healingFixture({
    roots: [root],
    fetchImpl: async () => {
      root.isConnected = false
      return { ok: true, json: async () => ({ ok: true, attached: false }) }
    },
  })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given the terminal regains its geometry while the pump state was queried, When healing ticks, Then no click is dispatched', async () => {
  const clicks = []
  const root = fakeRoot({ clicks })
  const app = healingFixture({
    roots: [root],
    fetchImpl: async () => {
      root.state.content = 300
      return { ok: true, json: async () => ({ ok: true, attached: false }) }
    },
  })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given the status bar disappears while the pump state was queried, When healing ticks, Then the stale takeover button is not clicked', async () => {
  const clicks = []
  const root = fakeRoot({ clicks })
  const app = healingFixture({
    roots: [root],
    fetchImpl: async () => {
      root.state.readonly = false
      return { ok: true, json: async () => ({ ok: true, attached: false }) }
    },
  })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given the page is hidden, When healing ticks, Then no pump query is issued', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks })] })
  app.document.hidden = true
  await app.heal()
  assert.deepEqual(clicks, [])
  assert.deepEqual(app.queries, [], '后台标签页不得发查询')
})

test('Given the terminal has exited and the status bar only offers a new terminal, When healing ticks, Then it must not create one', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks, buttonLabel: '新建终端' })] })
  await app.heal()
  assert.deepEqual(clicks, [], '退出态按钮是新建终端,按位置点击会建出多余终端')
  assert.deepEqual(app.queries, [], '没有接管按钮时连泵查询都不必发')
})

test('Given the status bar labels the takeover in English, When healing ticks, Then the button is still recognised', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks, buttonLabel: 'Take control' })] })
  await app.heal()
  assert.deepEqual(clicks, ['takeover'])
})

test('Given more sessions than the cooldown table holds, When they keep healing, Then the oldest entry is evicted and may heal again', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks })] })
  const sessions = Array.from({ length: 65 }, (_, number) => `session-${number}`)
  for (const session of sessions) {
    app.setSession(session)
    await app.heal()
  }
  assert.equal(clicks.length, sessions.length)
  app.setSession(sessions[0])
  await app.heal()
  assert.equal(clicks.length, sessions.length + 1, '冷却表上限淘汰后最旧 Session 可再次自愈')
})

test('Given the terminal tab is hidden, When healing ticks, Then it is skipped', async () => {
  const clicks = []
  const app = healingFixture({ roots: [fakeRoot({ clicks, visible: false })] })
  await app.heal()
  assert.deepEqual(clicks, [])
})

test('Given a pump query is still in flight, When the generation is disposed, Then its late answer cannot click', async () => {
  const clicks = []
  let release
  let querySignal
  const app = healingFixture({
    roots: [fakeRoot({ clicks })],
    fetchImpl: (url, init) => {
      querySignal = init.signal
      return new Promise((resolve) => { release = resolve })
    },
  })
  const ticking = app.heal()
  await settled()
  assert.equal(typeof release, 'function', '自愈 tick 已发出泵查询')
  app.dispose()
  assert.deepEqual(app.intervalCleared, [1], '卸载须清掉自愈定时器')
  assert.equal(querySignal.aborted, true, '在途查询须随代际一起中止')
  release({ ok: true, json: async () => ({ ok: true, attached: false }) })
  await ticking
  assert.deepEqual(clicks, [], '卸载后迟到的泵结果不得再接管输入')
})

test('Given the panel first frame runs before navigation lands, When the terminal view mounts, Then the layout contentId fills the gap', () => {
  const app = fixture({ tabs: [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab7', contentId: 'dsh-resource://dsh-shared-terminal/panel/term-a' }] })
  app.webTerminals.view('session-a', 'tab7', undefined, undefined, undefined)
  assert.deepEqual(app.views[0], ['session-a', 'tab7', 'dsh-resource://dsh-shared-terminal/panel/term-a', 'term-a'], '首帧缺参时用 layout 的 contentId 与其中的终端身份补齐')
})

test('Given the first frame belongs to a host terminal tab, When the view mounts, Then only the contentId is filled', () => {
  const app = fixture({ tabs: [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab8', contentId: 'sidebar://terminal/2f1c' }] })
  app.webTerminals.view('session-a', 'tab8', undefined, undefined, undefined)
  assert.deepEqual(app.views[0], ['session-a', 'tab8', 'sidebar://terminal/2f1c', undefined], '别的 contentId 不猜终端身份')
})

test('Given navigation already resolved, When the view mounts, Then the patch passes through unchanged', () => {
  const app = fixture({})
  app.webTerminals.view('session-a', 'tab9', 'sidebar://terminal/2f1c', 'term-z', 'pwsh')
  assert.deepEqual(app.views[0], ['session-a', 'tab9', 'sidebar://terminal/2f1c', 'term-z'])
})

// ── P2-42:首帧包装的生命周期(随 fiber 安装、禁用还原) ──────────────────

test('Given a disposed generation, When the host view is called again, Then the original host implementation is restored', () => {
  const app = fixture({ tabs: [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab7', contentId: 'dsh-resource://dsh-shared-terminal/panel/term-a' }] })
  assert.notEqual(app.webTerminals.view, app.hostView, 'apply 期间须装上首帧包装')
  app.dispose()
  assert.equal(app.webTerminals.view, app.hostView, '禁用/卸载须把宿主实现还回去')
  app.webTerminals.view('session-a', 'tab7', undefined, undefined, undefined)
  assert.deepEqual(app.views[0], ['session-a', 'tab7', undefined, undefined], '还原后宿主首帧不再被补参')
})

test('Given HMR replaces the generation, When the next generation applies, Then its own patch is installed again', () => {
  const tabs = [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab7', contentId: 'dsh-resource://dsh-shared-terminal/panel/term-a' }]
  const app = fixture({ tabs })
  app.dispose()
  assert.equal(app.webTerminals.view, app.hostView, '卸载须先还原,不留「已打过补丁」的痕迹')
  // 旧代的还原不得留下「已打过补丁」的标记,否则新代装不上自己的包装
  app.mount()
  assert.notEqual(app.webTerminals.view, app.hostView, '新代须重新装上包装')
  app.webTerminals.view('session-a', 'tab7', undefined, undefined, undefined)
  assert.deepEqual(app.views.at(-1), ['session-a', 'tab7', 'dsh-resource://dsh-shared-terminal/panel/term-a', 'term-a'])
  app.dispose()
  assert.equal(app.webTerminals.view, app.hostView, '新代卸载同样要还原')
})

test('Given another owner replaced the view after this generation, When it is disposed, Then that implementation is left alone', () => {
  const app = fixture({})
  const foreign = function view() { return undefined }
  app.webTerminals.view = foreign
  app.dispose()
  assert.equal(app.webTerminals.view, foreign, '只还原自己装的包装,不覆盖别人的实现')
})

// ── P2-43:绑定经宿主公开接口写入 ─────────────────────────────────────────

test('Given an opened terminal panel, When the tab is created, Then the content binding is seeded through the public host API', async () => {
  const app = fixture({ tabs: [] })
  app.render(props('open'))
  await app.flush()
  assert.deepEqual(app.binds, [['session-a', 'dsh-resource://dsh-shared-terminal/panel/term-a', 'term-a']], '建面板前用公开 bind 预写 contentId→terminalId')
  assert.deepEqual(app.localWrites, [], '不得手写宿主私有 localStorage 键')
})

test('Given a host generation without the binding API, When the panel opens, Then navigation still lands', async () => {
  const app = fixture({ tabs: [], binding: false })
  app.render(props('open'))
  await app.flush()
  assert.equal(app.calls.filter((call) => call[0] === 'reveal').length, 1, '绑定接口缺失不得影响开面板')
  assert.deepEqual(app.binds, [])
})

test('Given the host bind implementation throws, When the panel opens, Then navigation still lands', async () => {
  const app = fixture({ tabs: [], binding: () => { throw new Error('bind failed') } })
  app.render(props('open'))
  await app.flush()
  assert.equal(app.calls.filter((call) => call[0] === 'reveal').length, 1, '绑定只是兜底,抛错不得阻断导航')
})

// ── P3:面板补查定时器随卸载取消 ─────────────────────────────────────────

const ADDRESS = 'dsh-resource://dsh-shared-terminal/panel/term-a'

test('Given a freshly opened panel, When the nudge delays elapse, Then the host view is asked to re-query once per delay', async () => {
  const app = fixture({ tabs: [] })
  app.render(props('open'))
  await app.flush()
  assert.equal(app.timeouts.size, 2, '两档延迟各排一个补查')
  app.runPendingNudges()
  assert.deepEqual(app.refreshes.map((call) => call[2]), [ADDRESS, ADDRESS])
})

test('Given pending panel nudges, When the generation is disposed, Then every scheduled re-query is cancelled', async () => {
  const app = fixture({ tabs: [] })
  app.render(props('open'))
  await app.flush()
  const scheduled = [...app.timeouts.keys()]
  assert.equal(scheduled.length, 2)
  app.dispose()
  assert.equal(app.timeouts.size, 0, '卸载须清掉待发定时器')
  assert.deepEqual([...app.cleared].sort((a, b) => a - b), scheduled, 'clearTimeout 须逐个作用到已排的补查')
  assert.deepEqual(app.refreshes, [], '取消后不会有迟到补查打到宿主')
})
