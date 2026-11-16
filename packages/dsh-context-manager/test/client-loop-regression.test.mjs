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
  let currentProps = props
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
    renderComponent(component, currentProps, 'root')
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
    setProps(next) {
      currentProps = next
      runtime.render()
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
  // 外层 ctx.slots 的注册:fork 入口必须归属 remote.session inject 子 fiber,
  // 不得落在外层(服务重启重跑注入回调时会叠加注册)
  const outerRegistered = []
  const injectCallbacks = []
  const injectedContexts = []
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
  const remote = { session: { follow: () => (async function* () { yield { type: 'snapshot', cursor: 0, records: [] }; await new Promise(() => {}) })() } }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => {
        outerRegistered.push({ options, component })
        registered.push({ options, component })
      },
    },
    remote,
    inject: (deps, register) => {
      if (!deps.includes('remote.session') || !remote.session) return
      injectCallbacks.push(register)
      const childRegistered = []
      const childCtx = {
        remote,
        slots: {
          inject: (name, mount) => mount(),
          register: (options, component) => {
            childRegistered.push({ options, component })
            registered.push({ options, component })
          },
        },
      }
      injectedContexts.push({ childCtx, childRegistered })
      register(childCtx)
    },
  }
  plugin.apply(ctx)
  return { registered, outerRegistered, injectCallbacks, injectedContexts }
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
  const { registered } = loadSlots({ documentStub, fetchStub, Observer: observerHub.Observer })
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
  await new Promise((resolve) => setTimeout(resolve, 0))
  await runtime.flush()
  assert.equal(loadCalls, 3, '一次新的扫描只应补拉一次')
  assert.equal(runtime.renderCount, settledRenders, '补拉结果与基线签名相同,不得 setState 触发重渲染')
  observerHub.fireAll()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await runtime.flush()
  assert.equal(loadCalls, 4, '后续扫描仍只补拉一次')
  assert.equal(runtime.renderCount, settledRenders, '签名相同永不进入 setState 循环')
})

// P1-4 行为回归:挂载时映射只有第 0 轮,挂载后新增第 1 轮气泡——前向补拉快照后
// 按钮必须出现(旧实现同签名抑制 re-snapshot,只补历史页,永远看不到新轮)
test('P1-4 行为:挂载后新增轮经前向补快照获得锚点并注入按钮', async () => {
  const appended = []
  const officialButton = { className: 'official-action' }
  const actionsRow = {
    querySelector: (selector) => (selector.startsWith('button:not(') ? officialButton : null),
    appendChild: (node) => appended.push(node),
  }
  const bubble = {
    getAttribute(name) {
      if (name === 'data-chat-flow-kind') return 'user'
      if (name === 'data-chat-turn') return '1'
      return null
    },
    querySelector(selector) {
      if (selector === '[class$="_actions"]') return actionsRow
      return null
    },
  }
  const documentStub = createDocumentStub({ turnBubbles: [bubble] })
  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ enabled: !String(url).includes('fork-auto-resend-enabled') }),
  })
  const { registered } = loadSlots({ documentStub, fetchStub, Observer: createObserverHub().Observer })
  const entry = registered.find((item) => item.options.id === 'context-manager-fork')
  assert.ok(entry, '未注册 fork dock 条目')

  const calls = []
  const loadTurnEnds = async (options) => {
    calls.push(options)
    if (options && options.forward === true) {
      return new Map([
        [0, { seq: 2, text: '首问', open: false }],
        [1, { seq: 5, text: '第二问', open: false }],
      ])
    }
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

  assert.equal(calls.length, 2, '挂载首拉 + 发现新轮前向补拉')
  assert.deepEqual(calls[1], { forward: true, turn: 1 }, '第 1 轮缺失且大于已知最大轮号,应按轮前向补拉')
  assert.equal(documentStub.createdButtons.filter((button) => 'data-cx-fork' in button.attrs).length, 1,
    '前向补拉拿到第 1 轮锚点后应注入分叉按钮')
  assert.equal(appended.length, 1, '按钮应挂到该轮操作排')
})

// C9 回归:宿主轮号从 1 起,首轮气泡没有可用的更早 turn/end(分叉边界不可表达)。
// 旧实现为它走「前一轮比映射里最早轮还早」分支,每次 DOM 变异翻一页更早锚点,
// 40 页预算被首轮气泡耗尽;首轮必须在补拉分支前短路
test('C9 回归:首轮气泡不触发非前向补拉,不注入按钮', async () => {
  const observerHub = createObserverHub()
  const actionsRow = {
    querySelector: (selector) => (selector.startsWith('button:not(') ? { className: 'official-action' } : null),
    appendChild() {},
  }
  const bubble = {
    getAttribute(name) {
      if (name === 'data-chat-flow-kind') return 'user'
      if (name === 'data-chat-turn') return '1'
      return null
    },
    querySelector(selector) {
      if (selector === '[class$="_actions"]') return actionsRow
      return null
    },
  }
  const documentStub = createDocumentStub({ turnBubbles: [bubble] })
  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ enabled: !String(url).includes('fork-auto-resend-enabled') }),
  })
  const { registered } = loadSlots({ documentStub, fetchStub, Observer: observerHub.Observer })
  const entry = registered.find((item) => item.options.id === 'context-manager-fork')
  assert.ok(entry, '未注册 fork dock 条目')
  let loadCalls = 0
  const loadTurnEnds = async () => {
    loadCalls += 1
    // 首轮已闭合:映射里有第 1 轮,且它就是最早一轮
    return new Map([[1, { seq: 2, text: '首问', open: false }]])
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
  assert.equal(loadCalls, 1, '挂载只做首拉')
  const forkButtons = () => documentStub.createdButtons.filter((button) => 'data-cx-fork' in button.attrs)
  assert.equal(forkButtons().length, 0, '首轮无更早锚点,不得注入按钮')
  for (let round = 0; round < 3; round += 1) {
    observerHub.fireAll()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await runtime.flush()
  }
  assert.equal(loadCalls, 1, '首轮气泡不得为更早锚点补拉(每次变异翻一页会把 40 页预算耗尽)')
  assert.equal(forkButtons().length, 0, '连续扫描仍不得注入首轮按钮')
})

// C8 回归:remote.session 服务重启会让点分 inject 回调重跑;插槽注册必须归属
// inject 子 fiber(随子 fiber 回收),挂外层 ctx.slots 时每次重跑叠加一份 fork 入口
test('C8 回归:fork 插槽注册归属 remote.session inject 子 fiber,重跑不落外层', async () => {
  const documentStub = createDocumentStub()
  const fetchStub = async (url) => ({ ok: true, status: 200, json: async () => ({ enabled: true }) })
  const { registered, outerRegistered, injectCallbacks, injectedContexts } = loadSlots({
    documentStub, fetchStub, Observer: createObserverHub().Observer,
  })
  const forkEntries = (list) => list.filter((item) => item.options.id === 'context-manager-fork')
  assert.equal(forkEntries(registered).length, 1, 'apply 时 fork 入口注册一份')
  assert.equal(forkEntries(outerRegistered).length, 0, 'fork 入口不得注册在外层 ctx.slots')
  assert.equal(forkEntries(injectedContexts[0].childRegistered).length, 1, 'fork 入口应归属 inject 子 fiber')
  // 模拟 remote.session 服务重启:inject 回调以新子 fiber 重跑
  const rerunRegistered = []
  const rerunCtx = {
    remote: { session: { follow: () => (async function* () { yield { type: 'snapshot', cursor: 0, records: [] } })() } },
    slots: {
      inject: (name, mount) => mount(),
      register: (options, component) => rerunRegistered.push({ options, component }),
    },
  }
  injectCallbacks[0](rerunCtx)
  assert.equal(forkEntries(rerunRegistered).length, 1, '重跑后新子 fiber 持有一份注册')
  assert.equal(forkEntries(injectedContexts[0].childRegistered).length, 1, '旧子 fiber 的注册不因重跑叠加')
  assert.equal(forkEntries(outerRegistered).length, 0, '外层始终不得持有 fork 注册(否则每次重跑叠加)')
})

// P2-32 行为回归:切会话后旧会话的慢响应迟到,不得覆盖新会话映射

test('P2-32 行为:切会话后旧会话迟到响应按 sessionId+代际丢弃', async () => {
  const appended = []
  const officialButton = { className: 'official-action' }
  const actionsRow = {
    querySelector: (selector) => (selector.startsWith('button:not(') ? officialButton : null),
    appendChild: (node) => appended.push(node),
  }
  const bubble = {
    getAttribute(name) {
      if (name === 'data-chat-flow-kind') return 'user'
      if (name === 'data-chat-turn') return '1'
      return null
    },
    querySelector(selector) {
      if (selector === '[class$="_actions"]') return actionsRow
      return null
    },
  }
  const documentStub = createDocumentStub({ turnBubbles: [bubble] })
  const fetchStub = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ enabled: !String(url).includes('fork-auto-resend-enabled') }),
  })
  const { registered } = loadSlots({ documentStub, fetchStub, Observer: createObserverHub().Observer })
  const entry = registered.find((item) => item.options.id === 'context-manager-fork')
  assert.ok(entry, '未注册 fork dock 条目')

  const calls = []
  let resolveOld
  const loadTurnEnds = () => {
    calls.push(true)
    if (calls.length === 1) return new Promise((resolve) => { resolveOld = resolve })
    return Promise.resolve(new Map([
      [0, { seq: 2, text: '首问', open: false }],
      [1, { seq: 4, text: '第二问', open: false }],
    ]))
  }
  const forkCalls = []
  const common = {
    inputActions: undefined,
    useInput: undefined,
    cancelSession: () => {},
    submitPrompt: null,
    loadTurnEnds,
    forkSession: async (opts) => { forkCalls.push(opts); return 'child-1' },
  }
  const runtime = createRuntime(entry.component, { ...common, session: { sessionId: 's1' } })
  runtime.render()
  await runtime.flush()
  assert.equal(calls.length, 1, 's1 首拉应在途')

  runtime.setProps({ ...common, session: { sessionId: 's2' } })
  await runtime.flush()
  assert.equal(calls.length, 2, '切到 s2 应重新拉取')
  // 旧会话响应最后才到:必须按 sessionId+代际丢弃,不得覆盖 s2 映射
  resolveOld(new Map([
    [0, { seq: 999, text: '旧首问', open: false }],
    [1, { seq: 1000, text: '旧第二问', open: false }],
  ]))
  await runtime.flush()

  const forkButtons = documentStub.createdButtons.filter((button) => 'data-cx-fork' in button.attrs)
  assert.equal(forkButtons.length, 1, '旧会话迟到响应不得触发重扫再次注入')
  forkButtons[0].listeners.click[0]()
  await runtime.flush()
  assert.equal(forkCalls.length, 1, '点击应执行分叉')
  assert.equal(forkCalls[0].atSeq, 2, '锚点必须来自 s2 映射,旧会话 seq=999 不得泄漏')
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
  const { registered } = loadSlots({ documentStub, fetchStub, Observer: createObserverHub().Observer })
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
