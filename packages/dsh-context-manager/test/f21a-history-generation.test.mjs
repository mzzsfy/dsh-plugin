// F21a 回归守护(可失败行为测试):历史浮层的代际隔离——旧代迟到响应必须丢弃。
// 原始缺陷(F21a):「关闭再重开」会新开一轮拉取,但旧一轮的在途响应回来时仍会落地;
// applyResult 只校验「范围下标未变」,而关闭重开后范围下标恰是同一个默认值,于是
// 旧代数据覆盖新代列表(并可能把已过时的条目塞回用户眼前)。
// 修复后契约:浮层每次打开推进代际,旧代在途 fetch 的响应整体作废;新代响应照常生效。
// (同族不变式「关闭再重开不叠加轮询链」已由 client-loop-regression.test.mjs 的 C2 覆盖,
//  本文件只补未覆盖的「迟到响应丢弃」半边。)
// client.js 单文件自包含无法 import:经 __ModuleLoader__ 捕获模块,配最小 hooks 运行时
// (按渲染路径复用槽位、setState 触发重渲染)后挂载真实浮层组件,断言只落在渲染出的列表文本上。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

let active = null
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }),
  useState: (init) => active.useState(init),
  useEffect: (effect, deps) => active.useEffect(effect, deps),
  useRef: (value) => active.useRef(value),
}

// 最小 hooks 运行时:组件树按路径复用槽位,effect 在子组件之后执行;
// setState 走微任务重渲染;unmount 逆序执行 cleanup
function createRuntime(component, props) {
  const instances = new Map()
  const order = []
  const captured = []
  let scheduled = false
  let unmounted = false
  let renderCount = 0
  let failure = null
  const MAX_RENDERS = 100

  const instanceFor = (path) => {
    let instance = instances.get(path)
    if (!instance) {
      instance = { path, index: 0, slots: [], effectSlots: [] }
      instances.set(path, instance)
      order.push(instance)
    }
    return instance
  }
  const slotAt = (instance) => {
    const index = instance.index
    instance.index += 1
    if (!instance.slots[index]) instance.slots[index] = { value: undefined, hasValue: false, setter: null, ref: null, hasRef: false, deps: undefined, hasEffect: false, pending: null, cleanup: null }
    return instance.slots[index]
  }
  const runEffects = (instance) => {
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
  const renderComponent = (target, componentProps, path) => {
    if (renderCount >= MAX_RENDERS) {
      failure = failure || new Error('重渲染次数超过 ' + MAX_RENDERS + ',疑似 setState 自激循环')
      unmounted = true
      return
    }
    renderCount += 1
    const instance = instanceFor(path)
    instance.index = 0
    const previous = active
    active = runtime
    active.currentInstance = instance
    let element
    try {
      element = target(componentProps || {})
    } finally {
      active.currentInstance = null
      active = previous
    }
    captured.push({ path, type: target, props: componentProps || {}, element })
    const walk = (node, childPath) => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, `${childPath}/${index}`))
        return
      }
      if (node === null || typeof node !== 'object') return
      if (typeof node.type === 'function') {
        renderComponent(node.type, node.props, childPath)
        return
      }
      ;(node.children ?? []).forEach((child, index) => walk(child, `${childPath}/${index}`))
    }
    ;(element?.children ?? []).forEach((child, index) => walk(child, `${path}/${index}`))
    runEffects(instance)
  }
  const renderAll = () => {
    if (unmounted || failure) return
    captured.length = 0
    renderComponent(component, props, 'root')
  }
  const schedule = () => {
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
      const unchanged = slot.hasEffect && deps !== undefined && previous !== undefined
        && deps.length === previous.length && deps.every((dep, index) => Object.is(dep, previous[index]))
      slot.hasEffect = true
      slot.deps = deps
      if (unchanged) return
      slot.pending = effect
      if (!instance.effectSlots.includes(slot)) instance.effectSlots.push(slot)
    },
    useRef(value) {
      const slot = slotAt(runtime.currentInstance)
      if (!slot.hasRef) {
        slot.ref = { current: value }
        slot.hasRef = true
      }
      return slot.ref
    },
    render() {
      active = runtime
      renderAll()
    },
    async flush() {
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve))
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
    captured,
    /** 当前渲染树的可读文本(断言只落在用户可见内容上) */
    text() {
      const collect = (node) => {
        if (typeof node === 'string') return node
        if (node === null || typeof node !== 'object') return ''
        return (node.children ?? []).map(collect).join(' ')
      }
      const root = captured.find((item) => item.path === 'root')
      return collect(root?.element)
    },
  }
  active = runtime
  return runtime
}

// ---- 宿主桩(document / 模块表) ----
function createDocumentStub() {
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
    setAttribute(name, value) { this.attrs[name] = value },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null },
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = []
      this.listeners[type].push(handler)
    },
    removeEventListener() {},
    appendChild(child) { this.children.push(child) },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  })
  // 官方输入工具排:行类名 _tools 直含 _add 按钮,供历史按钮注入寻行
  const officialAdd = createNode('button')
  officialAdd.className = 'host_add'
  const toolsRow = {
    className: 'host_tools',
    children: [officialAdd],
    querySelector(selector) {
      if (selector.includes('data-cx-hist-trigger')) return this.children.find((child) => 'data-cx-hist-trigger' in child.attrs) || null
      return selector.includes('_add') ? officialAdd : null
    },
    querySelectorAll(selector) { return selector.includes('_add') ? [officialAdd] : [] },
    insertBefore(node) { this.children.push(node) },
  }
  officialAdd.parentElement = toolsRow
  officialAdd.nextSibling = null
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
    querySelectorAll: (selector) => (selector === 'button[class$="_add"]' ? [officialAdd] : []),
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

function createObserver() {
  return class Observer {
    constructor(callback) { this.callback = callback }
    observe() {}
    disconnect() {}
    takeRecords() { return [] }
  }
}

/**
 * 挂载历史浮层。inputs 路由按范围分流:收藏(scope=prompts)即时返回空,
 * 列表(scope=session)返回可控 deferred,便于按需放行迟到响应。
 */
function mountOverlay() {
  const modules = []
  const registered = []
  const documentStub = createDocumentStub()
  const deferred = []
  const fetchStub = async (url) => {
    const target = String(url)
    if (target.includes('/api/context/inputs')) {
      if (target.includes('scope=prompts')) return { ok: true, status: 200, json: async () => ({ inputs: [], aligned: true }) }
      return new Promise((resolve) => {
        deferred.push({ url: target, push: (inputs) => resolve({ ok: true, status: 200, json: async () => ({ inputs, aligned: true }) }) })
      })
    }
    return { ok: true, status: 200, json: async () => payloadFor(target) }
  }
  const payloadFor = () => ({ enabled: true })
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener() {} }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    if (name === '@mzzfyy/dsh-common-tools/client') return { toast: { show: () => 0 } }
    if (name === '@mzzsfy/dsh-common-tools/client') return { toast: { show: () => 0 } }
    throw new Error('模块表缺依赖:' + name)
  }
  new Function('window', 'require', 'document', 'MutationObserver', 'fetch', `${CLIENT_SRC}\n;return null`)(windowStub, requireStub, documentStub, createObserver(), fetchStub)
  assert.equal(modules.length, 1, 'client.js 未调用 __ModuleLoader__.load')
  const plugin = modules[0].factory(requireStub)
  plugin.apply({
    get: (name) => (name === 'sessions' ? { binding: () => undefined, fork: () => Promise.resolve('child'), open() {} } : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
  })
  const entry = registered.find((item) => item.options.id === 'context-manager-history')
  assert.ok(entry, '未注册历史浮层插槽')
  const runtime = createRuntime(entry.component, { session: { sessionId: 's1' }, inputActions: { setDraft() {} } })
  const clickHistoryButton = () => {
    const button = documentStub.createdButtons.find((node) => 'data-cx-hist-trigger' in node.attrs)
    assert.ok(button, '历史按钮未注入工具排')
    assert.equal(button.listeners.click.length, 1, '历史按钮应有唯一点击处理器')
    button.listeners.click[0]()
  }
  return { runtime, deferred, clickHistoryButton, documentStub }
}

const ITEM_OLD = { text: '旧一代迟到的历史条目', at: 1_000 }
const ITEM_NEW = { text: '新一代当前的历史条目', at: 2_000 }

test('F21a 迟到响应:关闭重开后旧代在途响应不得覆盖新代列表', async (t) => {
  const overlay = mountOverlay()
  t.after(() => overlay.runtime.unmount())
  overlay.runtime.render()
  await overlay.runtime.flush()
  assert.equal(overlay.deferred.length, 0, '浮层未打开不应拉取列表')

  // 第一次打开:列表请求在途
  overlay.clickHistoryButton()
  await overlay.runtime.flush()
  assert.equal(overlay.deferred.length, 1, '打开浮层应发起一次列表拉取')
  const firstGeneration = overlay.deferred[0]

  // 关闭再打开:新代列表请求在途(旧代请求仍未落地)
  overlay.clickHistoryButton()
  await overlay.runtime.flush()
  overlay.clickHistoryButton()
  await overlay.runtime.flush()
  assert.equal(overlay.deferred.length, 2, '重开浮层应发起新代拉取')
  const secondGeneration = overlay.deferred[1]

  // 新代先落地
  secondGeneration.push([ITEM_NEW])
  await overlay.runtime.flush()
  assert.match(overlay.runtime.text(), /新一代当前的历史条目/, '新代响应应正常呈现')

  // 旧代迟到:必须整体作废
  firstGeneration.push([ITEM_OLD])
  await overlay.runtime.flush()
  const text = overlay.runtime.text()
  assert.match(text, /新一代当前的历史条目/, '旧代迟到响应不得覆盖新代列表')
  assert.doesNotMatch(text, /旧一代迟到的历史条目/, '旧代条目不得重新出现在列表中')
})

test('F21a 对照:同一代内的响应照常落地(证明丢弃只针对旧代)', async (t) => {
  const overlay = mountOverlay()
  t.after(() => overlay.runtime.unmount())
  overlay.runtime.render()
  await overlay.runtime.flush()

  overlay.clickHistoryButton()
  await overlay.runtime.flush()
  assert.equal(overlay.deferred.length, 1, '打开浮层应发起一次列表拉取')
  overlay.deferred[0].push([ITEM_NEW])
  await overlay.runtime.flush()
  assert.match(overlay.runtime.text(), /新一代当前的历史条目/, '当前代响应必须生效')
})
