// 公共悬浮提示:tipPlacement 纯函数契约。定位算法迁移自 dsh-usage-dash 的
// Tooltip(1:1 同构),这里锁定指针跟随换侧、元素锚点翻转与边界夹取。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadModule(options = {}) {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
  const win = options.window ?? { __ModuleLoader__: { load: (module) => modules.push(module) } }
  if (options.window !== undefined) win.__ModuleLoader__.load = (module) => modules.push(module)
  const react = options.react ?? {
    useSyncExternalStore: () => [],
    useEffect() {},
    useLayoutEffect() {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useState: () => [null, () => {}],
    createElement: () => null,
  }
  const requireStub = (name) => {
    if (name === 'react') return react
    if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    throw new Error('模块表未提供 ' + name)
  }
  const doc = options.doc ?? { createElement: () => ({}), getElementById: () => null, querySelector: () => null }
  const factory = new Function('window', 'require', 'document', 'console', 'EventSource', source + '\n;return null')
  factory(win, requireStub, doc, { warn() {}, log() {} }, function EventSourceStub() {})
  assert.equal(modules.length, 1, 'client.js 未捕获')
  return modules[0].factory(requireStub)
}

// 最小 hook 运行时:按调用序保存 hook 槽,手动执行 effect,用于驱动 Tooltip 的接线逻辑
function makeHookRuntime() {
  const hooks = [], effects = [], cleanups = []
  let cursor = 0
  const react = {
    useSyncExternalStore: () => [],
    createElement: (type, props, ...children) => ({ type, props: props || null, children }),
    useRef: (initial) => {
      const index = cursor++
      hooks[index] ??= { current: initial }
      return hooks[index]
    },
    useState: (initial) => {
      const index = cursor++
      hooks[index] ??= [typeof initial === 'function' ? initial() : initial, (next) => {
        hooks[index][0] = typeof next === 'function' ? next(hooks[index][0]) : next
      }]
      return hooks[index]
    },
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => effects.push({ fn, deps }),
    useLayoutEffect: (fn, deps) => effects.push({ fn, deps }),
  }
  return {
    react,
    hooks,
    render(component, props) {
      for (const cleanup of cleanups.splice(0)) cleanup()
      cursor = 0
      effects.length = 0
      return component(props)
    },
    runEffects() {
      for (const { fn } of effects.splice(0)) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    },
  }
}

function makeEventTarget() {
  const listeners = new Map()
  const key = (type, capture) => type + (capture === true ? ':capture' : '')
  return {
    addEventListener(type, fn, capture) {
      const name = key(type, capture)
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    removeEventListener(type, fn, capture) {
      const name = key(type, capture)
      listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== fn))
    },
    count(type, capture) { return (listeners.get(key(type, capture)) ?? []).length },
    fire(type, capture, arg) { for (const fn of [...(listeners.get(key(type, capture)) ?? [])]) fn(arg) },
  }
}

function makeTooltipDocument(panel = null) {
  const state = { queries: 0 }
  return {
    state,
    doc: {
      getElementById: () => null,
      createElement: () => ({ id: '', style: {}, attrs: {}, setAttribute(name, value) { this.attrs[name] = value }, remove() {} }),
      head: { appendChild() {} },
      querySelector: () => { state.queries += 1; return panel },
    },
  }
}

const mod = loadModule()
const VIEW = { left: 0, top: 0, right: 1000, bottom: 800 }
const TIP = { width: 200, height: 100 }

test('导出契约:Tooltip 组件与 tipPlacement 同时可用', () => {
  assert.equal(typeof mod.Tooltip, 'function')
  assert.equal(typeof mod.tipPlacement, 'function')
})

test('指针锚点:右侧放得下时右下偏移,跟随模式不画箭头', () => {
  const pos = mod.tipPlacement({ kind: 'point', x: 500, y: 400 }, TIP, VIEW)
  assert.deepEqual(pos, { left: 514, top: 414, side: 'bottom', arrowX: null })
})

test('指针锚点:右侧越界翻到指针左侧并夹取进边界', () => {
  const pos = mod.tipPlacement({ kind: 'point', x: 920, y: 400 }, TIP, VIEW)
  assert.equal(pos.left, 706)
  assert.equal(pos.side, 'bottom')
})

test('指针锚点:下方越界翻到指针上方', () => {
  const pos = mod.tipPlacement({ kind: 'point', x: 500, y: 760 }, TIP, VIEW)
  assert.equal(pos.side, 'top')
  assert.equal(pos.top, 646)
})

test('元素锚点:上方优先,箭头对齐锚点中心', () => {
  const pos = mod.tipPlacement({ kind: 'rect', left: 400, top: 300, width: 100, height: 20 }, TIP, VIEW)
  assert.deepEqual(pos, { left: 350, top: 192, side: 'top', arrowX: 100 })
})

test('元素锚点:贴右边界时左移,箭头夹取在圆角内', () => {
  const pos = mod.tipPlacement({ kind: 'rect', left: 950, top: 300, width: 40, height: 20 }, TIP, VIEW)
  assert.equal(pos.left, 792)
  assert.equal(pos.arrowX, 178)
})

test('样式契约:提示自带令牌、中号圆角与 layer-2 底色', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  // .dct-tip 规则体:portal 到 body,令牌必须落在规则自身,不能依赖 toast 作用域
  const rule = source.slice(source.indexOf('.dct-tip {'), source.indexOf('.dct-tip--on'))
  assert.match(rule, /--dct-tip-radius:var\(--dsw-radius-md\)/, '圆角令牌必须自包含')
  assert.match(rule, /--dct-tip-bg:var\(--dsw-alias-bg-layer-2\)/, '提示底色取 layer-2,不复用 toast 的 layer-1')
  assert.match(rule, /border-radius:var\(--dct-tip-radius\)/)
  assert.match(rule, /background:var\(--dct-tip-bg\)/)
  assert.doesNotMatch(rule, /--dct-panel-bg/)
})

test('元素锚点:上方放不下翻到下方;尺寸为零时不定位', () => {
  const below = mod.tipPlacement({ kind: 'rect', left: 400, top: 20, width: 100, height: 20 }, TIP, VIEW)
  assert.equal(below.side, 'bottom')
  assert.equal(below.top, 48)
  assert.equal(mod.tipPlacement({ kind: 'rect', left: 400, top: 20, width: 0, height: 20 }, TIP, VIEW), null)
  assert.equal(mod.tipPlacement({ kind: 'point', x: 10, y: 10 }, { width: 0, height: 0 }, VIEW), null)
})

test('Given 指针提示连续移动 When 定位 Then 面板与尺寸只测一次且缺 ResizeObserver 不抛错', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = Object.assign(makeEventTarget(), { __ModuleLoader__: { load() {} }, innerWidth: 1000, innerHeight: 800 })
  const { doc, state } = makeTooltipDocument()
  const runtime = makeHookRuntime()
  const mod = loadModule({ react: runtime.react, doc, window: win })
  const original = globalThis.ResizeObserver
  delete globalThis.ResizeObserver
  try {
    runtime.render(mod.Tooltip, { anchor: { kind: 'point', x: 10, y: 10 }, panelSelector: '.panel', children: '内容' })
    let reads = 0
    runtime.hooks[0].current = {
      get offsetWidth() { reads += 1; return 120 },
      get offsetHeight() { reads += 1; return 40 },
    }
    assert.doesNotThrow(() => runtime.runEffects(), '缺 ResizeObserver 必须退化为窗口 resize,不得抛错')
    assert.equal(state.queries, 1, '首次定位查询一次面板')
    assert.equal(reads, 2, '首次定位读取一次提示尺寸')
    for (let i = 0; i < 10; i++) win.fire('mousemove', false, { clientX: i, clientY: i })
    assert.equal(state.queries, 1, '指针移动不得重复全文档查询面板')
    assert.equal(reads, 2, '指针移动不得强制读取提示尺寸')
    assert.equal(win.count('scroll', true), 1, '滚动定位只有一处监听')
    assert.equal(win.count('mousemove', false), 1)
  } finally {
    if (original === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = original
  }
})

test('Given 元素提示与 ResizeObserver When 滚动 Then 只收起不重复定位且观察提示节点', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = Object.assign(makeEventTarget(), { __ModuleLoader__: { load() {} }, innerWidth: 1000, innerHeight: 800 })
  const { doc, state } = makeTooltipDocument()
  const runtime = makeHookRuntime()
  const observers = []
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.nodes = []; observers.push(this) }
    observe(node) { this.nodes.push(node) }
    disconnect() { this.disconnected = true }
  }
  const original = globalThis.ResizeObserver
  globalThis.ResizeObserver = FakeResizeObserver
  try {
    const mod = loadModule({ react: runtime.react, doc, window: win })
    runtime.render(mod.Tooltip, { anchor: { kind: 'rect', left: 10, top: 10, width: 20, height: 20 }, panelSelector: '.panel', children: '内容' })
    let reads = 0
    const tip = {
      get offsetWidth() { reads += 1; return 100 },
      get offsetHeight() { reads += 1; return 40 },
    }
    runtime.hooks[0].current = tip
    runtime.runEffects()
    assert.equal(observers.length, 1, '有 ResizeObserver 时创建观察器')
    assert.deepEqual(observers[0].nodes, [tip], '无面板时只观察提示节点')
    assert.equal(win.count('scroll', true), 1, '元素模式也只有一处滚动监听')
    const readsBefore = reads, queriesBefore = state.queries
    win.fire('scroll', true, {})
    assert.equal(reads, readsBefore, '滚动收起不得再做一次尺寸读取')
    assert.equal(state.queries, queriesBefore, '滚动收起不得再做一次面板查询')
  } finally {
    if (original === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = original
  }
})

test('Given 面板部分滚出视口 When 定位 Then 夹取边界与视口求交', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = Object.assign(makeEventTarget(), { __ModuleLoader__: { load() {} }, innerWidth: 1000, innerHeight: 800 })
  const panel = {
    isConnected: true,
    rect: { left: -100, top: -100, right: 400, bottom: 300, width: 500, height: 400 },
    getBoundingClientRect() { return this.rect },
  }
  const { doc } = makeTooltipDocument(panel)
  const runtime = makeHookRuntime()
  const mod = loadModule({ react: runtime.react, doc, window: win })
  runtime.render(mod.Tooltip, { anchor: { kind: 'rect', left: 20, top: 20, width: 20, height: 20 }, panelSelector: '.panel', children: '内容' })
  runtime.hooks[0].current = { offsetWidth: 160, offsetHeight: 40 }
  runtime.runEffects()
  const pos = runtime.hooks[2][0]
  assert.equal(pos.left, 8, '左侧越界夹取到视口/面板交集的左边界')
  assert.equal(pos.top, 48, '上方越界后翻到下方,不被负坐标面板带出视口')
})

test('Given active 切换或提示节点替换 When 观察器重连 Then 新提示节点仍被观察', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = Object.assign(makeEventTarget(), { __ModuleLoader__: { load() {} }, innerWidth: 1000, innerHeight: 800 })
  const { doc } = makeTooltipDocument()
  const runtime = makeHookRuntime()
  const observers = []
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.nodes = []; observers.push(this) }
    observe(node) { this.nodes.push(node) }
    disconnect() { this.disconnected = true }
  }
  const original = globalThis.ResizeObserver
  globalThis.ResizeObserver = FakeResizeObserver
  try {
    const mod = loadModule({ react: runtime.react, doc, window: win })
    runtime.render(mod.Tooltip, { anchor: null, children: '内容' })
    runtime.runEffects()
    assert.equal(observers.length, 0, '无 active 锚点时不创建观察器')

    runtime.render(mod.Tooltip, { anchor: { kind: 'rect', left: 10, top: 10, width: 20, height: 20 }, children: '内容' })
    const firstTip = { offsetWidth: 100, offsetHeight: 40 }
    runtime.hooks[0].current = firstTip
    runtime.runEffects()
    assert.deepEqual(observers[0].nodes, [firstTip], 'active 切换后观察当前提示节点')

    runtime.render(mod.Tooltip, { anchor: { kind: 'rect', left: 10, top: 10, width: 20, height: 20 }, children: '替换内容' })
    const secondTip = { offsetWidth: 120, offsetHeight: 44 }
    runtime.hooks[0].current = secondTip
    runtime.runEffects()
    assert.equal(observers.length, 2, '每次渲染重连观察器')
    assert.deepEqual(observers[1].nodes, [secondTip], '节点替换后观察新提示节点')
    assert.equal(observers[0].disconnected, true, '旧观察器已断开')
  } finally {
    if (original === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = original
  }
})

test('Given 元素提示位于面板内 When 面板尺寸变化 Then ResizeObserver 同时观察面板并重测边界', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = Object.assign(makeEventTarget(), { __ModuleLoader__: { load() {} }, innerWidth: 1000, innerHeight: 800 })
  const panel = {
    isConnected: true,
    rect: { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 },
    getBoundingClientRect() { return this.rect },
  }
  const { doc, state } = makeTooltipDocument(panel)
  const runtime = makeHookRuntime()
  const observers = []
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.nodes = []; observers.push(this) }
    observe(node) { this.nodes.push(node) }
    disconnect() {}
  }
  const original = globalThis.ResizeObserver
  globalThis.ResizeObserver = FakeResizeObserver
  try {
    const mod = loadModule({ react: runtime.react, doc, window: win })
    runtime.render(mod.Tooltip, { anchor: { kind: 'rect', left: 250, top: 250, width: 20, height: 20 }, panelSelector: '.panel', children: '内容' })
    let reads = 0
    const tip = {
      get offsetWidth() { reads += 1; return 160 },
      get offsetHeight() { reads += 1; return 40 },
    }
    runtime.hooks[0].current = tip
    runtime.runEffects()
    assert.equal(state.queries, 1, '首次定位查询一次面板')
    assert.deepEqual(observers[0].nodes, [tip, panel], '提示与面板节点均被观察')
    const beforePos = runtime.hooks[2][0]
    const readsBefore = reads, queriesBefore = state.queries
    panel.rect = { left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }
    observers[0].callback()
    assert.ok(reads > readsBefore, '面板尺寸变化触发提示尺寸重测')
    assert.equal(state.queries, queriesBefore, '面板仍连接时复用缓存,不重复全文档查询')
    assert.notEqual(runtime.hooks[2][0], beforePos, '重测后用新边界重新定位')
    assert.equal(runtime.hooks[2][0].left, 132, '提示夹取进缩小后的面板边界')
  } finally {
    if (original === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = original
  }
})
