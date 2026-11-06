// 两条自激循环回归(行为级,不比对源码字符串):
// C1 fork 锚点映射每次 loadTurnEnds 都新建 Map,引用比较恒假 → setState→扫描→补拉
//    无界循环。断言同一缺失映射在一次扫描里只补拉一次,结果不变则不再 setState。
// C2 历史浮层 3s 轮询链不持句柄、卸载不取消 → 卸载后继续请求并叠加链。断言卸载后
//    不再出现定时请求。
// client.js 单文件自包含无法 import:经 __ModuleLoader__ 捕获模块,配最小 hooks
// 运行时(按调用序落槽、setState 触发重渲染、effect 按依赖重跑并支持卸载清理)后
// 挂载真实组件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 单测串行执行,activeRuntime 只指向当前挂载的运行时
let activeRuntime = null

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => activeRuntime.useState(init),
  useEffect: (effect, deps) => activeRuntime.useEffect(effect, deps),
  useRef: (value) => activeRuntime.useRef(value),
}

// 最小 hooks 运行时:组件树按路径复用槽位(等价 React 的同位复用),effect 在子组件
// 之后、父组件之前执行;setState 走微任务重渲染,卸载时逆序执行全部 cleanup。
function createRuntime(component, props) {
  const instances = new Map()
  const order = []
  let scheduled = false
  let unmounted = false
  let renderCount = 0
  let failure = null
  // 正常路径渲染次数为个位数;超过即视为 setState 自激,记录失败并停摆
  const MAX_RENDERS = 100

  function instanceFor(path) {
    let instance = instances.get(path)
    if (!instance) {
      instance = { path, index: 0, slots: [], effectSlots: [] }
      instances.set(path, instance)
      order.push(instance)
    }
    return instance
  }

  function slotAt(instance) {
    const index = instance.index
    instance.index += 1
    if (!instance.slots[index]) {
      instance.slots[index] = {
        value: undefined,
        hasValue: false,
        setter: null,
        ref: null,
        hasRef: false,
        deps: undefined,
        hasEffect: false,
        pending: null,
        cleanup: null,
      }
    }
    return instance.slots[index]
  }

  function runEffects(instance) {
    for (const slot of instance.effectSlots) {
      if (!slot.pending) continue
      const effect = slot.pending
      slot.pending = null
      if (typeof slot.cleanup === 'function') {
        const cleanup = slot.cleanup
        slot.cleanup = null
        cleanup()
      }
      const cleanup = effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  function renderComponent(target, componentProps, path) {
    if (renderCount >= MAX_RENDERS) {
      failure = failure || new Error('重渲染次数超过 ' + MAX_RENDERS + ',疑似 setState 自激循环')
      unmounted = true
      return
    }
    renderCount += 1
    const instance = instanceFor(path)
    instance.index = 0
    const previous = runtime.currentInstance
    runtime.currentInstance = instance
    let element
    try {
      element = target(componentProps || {})
    } finally {
      runtime.currentInstance = previous
    }
    if (element && typeof element === 'object' && typeof element.type === 'function') {
      renderComponent(element.type, element.props, path + '/0')
    }
    runEffects(instance)
  }

  function renderAll() {
    if (unmounted || failure) return
    renderComponent(component, props, 'root')
  }

  function schedule() {
    if (scheduled || unmounted || failure) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (unmounted || failure) return
      try {
        renderAll()
      } catch (error) {
        failure = error
        unmounted = true
      }
    })
  }

  const runtime = {
    currentInstance: null,
    useState(init) {
      const slot = slotAt(runtime.currentInstance)
      if (!slot.hasValue) {
        slot.value = typeof init === 'function' ? init() : init
        slot.hasValue = true
      }
      if (!slot.setter) {
        slot.setter = (next) => {
          if (unmounted) return
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          schedule()
        }
      }
      return [slot.value, slot.setter]
    },
    useEffect(effect, deps) {
      const instance = runtime.currentInstance
      const slot = slotAt(instance)
      const previous = slot.deps
      const unchanged = slot.hasEffect
        && deps !== undefined
        && previous !== undefined
        && deps.length === previous.length
        && deps.every((dep, index) => Object.is(dep, previous[index]))
      slot.hasEffect = true
      slot.deps = deps
      if (unchanged) return
      slot.pending = effect
      if (!instance.effectSlots.includes(slot)) instance.effectSlots.push(slot)
    },
    useRef(value) {
      const instance = runtime.currentInstance
      const slot = slotAt(instance)
      if (!slot.hasRef) {
        slot.ref = { current: value }
        slot.hasRef = true
      }
      return slot.ref
    },
    render() {
      activeRuntime = runtime
      try {
        renderAll()
      } catch (error) {
        failure = error
        unmounted = true
      }
    },
    async flush() {
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
      if (failure) throw failure
    },
    unmount() {
      if (unmounted) return
      unmounted = true
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const instance = order[i]
        for (let j = instance.effectSlots.length - 1; j >= 0; j -= 1) {
          const slot = instance.effectSlots[j]
          if (typeof slot.cleanup !== 'function') continue
          const cleanup = slot.cleanup
          slot.cleanup = null
          cleanup()
        }
      }
    },
    get renderCount() {
      return renderCount
    },
    get failure() {
      return failure
    },
  }
  activeRuntime = runtime
  return runtime
}

function loadSlots({ documentStub, fetchStub, Observer }) {
  const modules = []
  const registered = []
  const windowStub = {
    __ModuleLoader__: { load: (module) => modules.push(module) },
    addEventListener() {},
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    if (name === '@mzzsfy/dsh-common-tools/client') return { toast: { show: () => 0 } }
    throw new Error('模块表缺依赖:' + name)
  }
  const factory = new Function('window', 'require', 'document', 'MutationObserver', 'fetch', CLIENT_SRC + '\n;return null')
  factory(windowStub, requireStub, documentStub, Observer, fetchStub)
  assert.equal(modules.length, 1, 'client.js 未调用 __ModuleLoader__.load')
  const plugin = modules[0].factory(requireStub)
  const sessions = { binding: () => undefined, fork: () => Promise.resolve('child-1'), open() {} }
  plugin.apply({
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
    remote: undefined,
  })
  return registered
}

function createDocumentStub({ turnBubbles = [], withToolsRow = false } = {}) {
  const listeners = new Map()
  const createdButtons = []
  const createNode = (tagName) => ({
    tagName,
    className: '',
    title: '',
    type: '',
    attrs: {},
    children: [],
    listeners: {},
    style: {},
    dataset: {},
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null
    },
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child)
    },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  })
  let toolsRow = null
  let officialAdd = null
  if (withToolsRow) {
    // 官方输入工具排形态:行类名 _tools 直含 _add 按钮,供历史按钮注入寻行
    officialAdd = createNode('button')
    officialAdd.className = 'host_add'
    toolsRow = {
      className: 'host_tools',
      children: [officialAdd],
      querySelector(selector) {
        if (selector.includes('data-cx-hist-trigger')) {
          return this.children.find((child) => 'data-cx-hist-trigger' in child.attrs) || null
        }
        return selector.includes('_add') ? officialAdd : null
      },
      querySelectorAll(selector) {
        return selector.includes('_add') ? [officialAdd] : []
      },
      insertBefore(node) {
        this.children.push(node)
      },
    }
    officialAdd.parentElement = toolsRow
    officialAdd.nextSibling = null
  }
  return {
    documentElement: {},
    head: { appendChild() {} },
    body: { appendChild() {} },
    activeElement: null,
    createdButtons,
    createElement: (tag) => {
      const node = createNode(tag)
      if (tag === 'button') createdButtons.push(node)
      return node
    },
    createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === '[data-chat-turn]') return turnBubbles
      if (selector === 'button[class$="_add"]' && toolsRow) return [officialAdd]
      return []
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    removeEventListener(type, handler) {
      const handlers = listeners.get(type) || []
      const index = handlers.indexOf(handler)
      if (index >= 0) handlers.splice(index, 1)
    },
    fire(type, event) {
      for (const handler of [...(listeners.get(type) || [])]) handler(event)
    },
  }
}

function createObserverHub() {
  const active = new Set()
  class Observer {
    constructor(callback) {
      this.callback = callback
    }
    observe() {
      active.add(this)
    }
    disconnect() {
      active.delete(this)
    }
    takeRecords() {
      return []
    }
  }
  return {
    Observer,
    fireAll() {
      for (const observer of [...active]) observer.callback([])
    },
  }
}

// C1:映射内容恒定但缺第 7 轮(窗口外新轮的真实形态),每次挂载/扫描都会发现缺失
test('C1 回归:同一缺失映射连续扫描只补拉一次,签名相同不再 setState', async () => {
  const observerHub = createObserverHub()
  const bubble = {
    getAttribute(name) {
      if (name === 'data-chat-flow-kind') return 'user'
      if (name === 'data-chat-turn') return '7'
      return null
    },
    querySelector(selector) {
      if (selector === '[class$="_actions"]') return { querySelector: () => null }
      return null
    },
  }
  const documentStub = createDocumentStub({ turnBubbles: [bubble] })
  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ enabled: !String(url).includes('fork-auto-resend-enabled') }),
  })
  const registered = loadSlots({ documentStub, fetchStub, Observer: observerHub.Observer })
  const entry = registered.find((item) => item.options.id === 'context-manager-fork')
  assert.ok(entry, '未注册 fork dock 条目')

  let loadCalls = 0
  const loadTurnEnds = async () => {
    loadCalls += 1
    // 熔断:补拉风暴时尽快失败,而不是拖到运行时渲染上限
    if (loadCalls > 12) throw new Error('fork 锚点补拉风暴:同一缺失映射被反复重拉')
    // 生产 loadTurnEnds 每次返回新 Map;内容恒定且不含气泡上的第 7 轮
    return new Map([[0, { seq: 2, text: '首问', open: false }]])
  }
  const runtime = createRuntime(entry.component, {
    session: { sessionId: 's1' },
    inputActions: undefined,
    useInput: undefined,
    forkSession: async () => 'child-1',
    cancelSession: () => {},
    submitPrompt: null,
    loadTurnEnds,
  })
  runtime.render()
  await runtime.flush()

  assert.equal(loadCalls, 2, '挂载拉取 1 次 + 缺映射补拉 1 次后应终止;实际补拉 ' + loadCalls + ' 次')
  const settledRenders = runtime.renderCount
  observerHub.fireAll()
  await runtime.flush()
  assert.equal(loadCalls, 3, '一次新的扫描只应补拉一次')
  assert.equal(runtime.renderCount, settledRenders, '补拉结果与基线签名相同,不得 setState 触发重渲染')
  observerHub.fireAll()
  await runtime.flush()
  assert.equal(loadCalls, 4, '后续扫描仍只补拉一次')
  assert.equal(runtime.renderCount, settledRenders, '签名相同永不进入 setState 循环')
})

// 历史浮层挂载工位:统计 /api/context/inputs 请求,记录 document 级键盘监听
async function mountHistory({ withToolsRow = false } = {}) {
  const documentStub = createDocumentStub({ withToolsRow })
  const requests = []
  const fetchStub = async (url) => {
    const target = String(url)
    if (target.startsWith('/api/context/inputs')) {
      requests.push(target)
      return { ok: true, status: 200, json: async () => ({ inputs: [], aligned: true }) }
    }
    return { ok: true, status: 200, json: async () => ({ enabled: true }) }
  }
  const registered = loadSlots({ documentStub, fetchStub, Observer: createObserverHub().Observer })
  const entry = registered.find((item) => item.options.id === 'context-manager-history')
  assert.ok(entry, '未注册历史浮层 dock 条目')
  const runtime = createRuntime(entry.component, {
    session: { sessionId: 's1' },
    inputActions: { setDraft() {} },
  })
  runtime.render()
  await runtime.flush()
  return { runtime, documentStub, requests }
}

function pressAltUp(documentStub) {
  documentStub.fire('keydown', {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: 'ArrowUp',
    isComposing: false,
    preventDefault() {},
    stopPropagation() {},
  })
}

// 注入的历史按钮:点击经 toggleRef 走最新渲染闭包(与键盘快捷键的 R0 闭包不同,
// 旧代令牌按渲染局部变量置位时旧定时器会在重开后复活)
function clickHistoryButton(documentStub) {
  const button = documentStub.createdButtons.find((node) => 'data-cx-hist-trigger' in node.attrs)
  assert.ok(button, '历史按钮未注入')
  assert.equal(button.listeners.click.length, 1, '历史按钮应有唯一点击处理器')
  button.listeners.click[0]()
}

// C2:打开浮层后挂载态轮询确实活着;卸载后定时链必须停,不得继续请求
test('C2 回归:历史浮层轮询链在卸载后不再发起请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runtime, documentStub, requests } = await mountHistory()
  assert.equal(requests.length, 0, '浮层未打开不应拉取历史列表')

  pressAltUp(documentStub)
  await runtime.flush()
  assert.equal(requests.length, 2, '打开浮层应并行拉取收藏与当前范围列表')

  // 挂载态:轮询链必须在 3s 后再次请求,证明定时链处于活动状态
  t.mock.timers.tick(3 * 1000)
  await runtime.flush()
  assert.equal(requests.length, 3, '浮层打开期间轮询链应在 3s 后重拉')

  const beforeUnmount = requests.length
  runtime.unmount()
  for (let i = 0; i < 3; i += 1) {
    t.mock.timers.tick(3 * 1000)
    await runtime.flush()
  }
  assert.equal(requests.length, beforeUnmount, '卸载后轮询链必须停止,不得再发起定时请求')
})

// 关闭再重开:旧代定时器若不被代际/句柄作废,会在浮层重开后复活,与新链叠加双倍轮询
test('C2 回归:关闭浮层再重开不复活旧轮询链,单次 tick 只重拉一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { runtime, documentStub, requests } = await mountHistory({ withToolsRow: true })

  clickHistoryButton(documentStub)
  await runtime.flush()
  assert.equal(requests.length, 2, '首次打开拉取收藏与当前范围')
  t.mock.timers.tick(3 * 1000)
  await runtime.flush()
  assert.equal(requests.length, 3, '首条轮询链已排定下一次定时器')

  clickHistoryButton(documentStub)
  await runtime.flush()
  clickHistoryButton(documentStub)
  await runtime.flush()
  assert.equal(requests.length, 5, '重开浮层只应有一条新链的两次拉取')

  t.mock.timers.tick(3 * 1000)
  await runtime.flush()
  assert.equal(requests.length, 6, '关闭后重开不得让旧定时器复活叠加,一次 tick 只重拉一次')
})
