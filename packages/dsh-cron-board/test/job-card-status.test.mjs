// 任务卡颜色语义:圆点/左侧竖线只表达启用态,运行结果不得让停用任务看起来仍然健康。
// client.js 单文件自包含,经 __ModuleLoader__ 捕获模块,配最小 hooks 运行时驱动真实面板。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')
const API = '/api/cron-board/'
const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

// ---- 最小 hooks 运行时(同位复用槽位,与 automation-group 测试同构) ----
let active = null

const ReactStub = {
  createElement: (type, props, ...children) => {
    const element = {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }
    if (element.props.ref && typeof element.props.ref === 'object') element.props.ref.current = element
    if (typeof type === 'string') element.querySelector = () => null
    return element
  },
  useState: (init) => active.useState(init),
  useEffect: (effect, deps) => active.useEffect(effect, deps),
  useRef: (value) => active.useRef(value),
  useCallback: (fn) => fn,
}

function createRuntime(component, props) {
  const instances = new Map()
  const order = []
  const captured = []
  let scheduled = false
  let unmounted = false
  let renderCount = 0
  let failure = null
  const MAX_RENDERS = 300

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
      failure = failure || new Error('重渲染次数超过 ' + MAX_RENDERS)
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
      for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve))
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
    find(predicate) {
      return captured.find((item) => predicate(item)) ?? null
    },
  }
  active = runtime
  return runtime
}

function createDocumentStub() {
  const node = () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {}, querySelector: () => null })
  const attributes = new Set()
  const documentElement = {
    setAttribute(name) { attributes.add(name) },
    removeAttribute(name) { attributes.delete(name) },
    hasAttribute(name) { return attributes.has(name) },
  }
  return {
    documentElement,
    head: { appendChild() {} },
    body: { appendChild() {} },
    getElementById: () => null,
    createElement: () => node(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
}

// 一条启用但从未运行、一条已停用但上次成功:修复前两者颜色语义互斥(灰点配开启开关、绿点配关闭开关)
const JOBS = [
  {
    id: 'job-on', name: '启用未运行', kind: 'shell', command: 'echo hi', schedule: '20 9 * * *',
    summary: '每天 09:20', enabled: true, nextRunAt: NOW + 16 * HOUR, lastStatus: null, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'job-off', name: '停用但上次成功', kind: 'session', prompt: '检查网关', schedule: '0 22 * * *',
    summary: '每天 22:00', enabled: false, lastStatus: 'success', lastDurationMs: 2900,
    session: { mode: 'pinned', pinnedSessionId: 'session-1' }, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'job-running', name: '正在执行', kind: 'shell', command: 'sleep 60', schedule: '* * * * *',
    summary: '每分钟', enabled: true, lastStatus: 'running', createdAt: NOW, updatedAt: NOW,
  },
]

function createHarness() {
  const calls = []
  const bus = { subscribe: (fn, options) => { const initial = options?.onReset ?? fn; queueMicrotask(() => initial()); return () => {} }, publish: () => {} }
  const tools = {
    setupCommonTools: () => bus,
    createSnapshotRefresh: (fn) => ({ refresh: () => { void fn() }, dispose() {} }),
    toast: { show() {} },
    subscribeChanges: () => () => {},
  }
  const fetchStub = async (url, options = {}) => {
    const target = String(url)
    const method = (options.method ?? 'GET').toUpperCase()
    calls.push({ method, target })
    const respond = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'GET' && target === API + 'jobs') return respond({ items: JOBS })
    if (method === 'GET' && target === API + 'envs') return respond({ items: [] })
    if (method === 'GET' && target === API + 'status') return respond({ scheduler: { active: 0, queued: 0 }, serverTzOffset: 8, ui: { sidebarTab: false, showAutomationTasks: false } })
    return respond({})
  }
  const registered = []
  const holder = {}
  const windowStub = {
    __ModuleLoader__: { load: (definition) => { holder.definition = definition } },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    if (name === '@mzzsfy/dsh-common-tools/client') return tools
    throw new Error('模块表缺依赖:' + name)
  }
  const documentStub = createDocumentStub()
  new Function('window', 'document', 'navigator', 'fetch', `${CLIENT_SRC}\n;return null`)(windowStub, documentStub, {}, fetchStub)
  assert.ok(holder.definition, 'client.js 未自注册')
  const plugin = holder.definition.factory(requireStub)
  plugin.apply({
    fiber: { entry: { options: { name: '@mzzsfy/dsh-cron-board' } } },
    layout: null,
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); return () => dispose?.() },
    inject: () => () => {},
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, component) => { registered.push({ meta, component }); return () => {} },
    },
  })
  const entry = registered.find((item) => item.meta.name === 'main')
  assert.ok(entry, '未注册主面板')
  const runtime = createRuntime(entry.component, { visible: true })
  return { runtime, calls }
}

const textOf = (tree) => (typeof tree === 'string' ? tree : (tree?.children ?? []).map(textOf).join(''))
const nodesOf = (tree) => {
  const out = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node === null || typeof node !== 'object') return
    out.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(tree)
  return out
}
const classOf = (tree) => nodesOf(tree).find((node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('cb-card'))?.props.className ?? ''
const toneOf = (tree) => nodesOf(tree).find((node) => node.props?.style && node.props.style['--cb-status'])?.props.style['--cb-status'] ?? ''
const stateDotOf = (tree) => nodesOf(tree)
  .find((node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('cb-dot--state')) ?? null
const stateToneOf = (tree) => stateDotOf(tree)?.props.style?.['--cb-status'] ?? ''
const runButtonOf = (tree) => nodesOf(tree).find((node) => node.type === 'button' && textOf(node) === '运行') ?? null

const createdRuntimes = []
after(() => {
  for (const runtime of createdRuntimes) runtime.unmount()
})

test('Given 启用未运行、停用成功、运行中并存 When 打开看板 Then 启用态与运行结果各用一个点', async () => {
  const { runtime } = createHarness()
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  const cards = runtime.captured.filter((item) => item.type?.name === 'JobCard')
  assert.equal(cards.length, 3, '应渲染三张任务卡')
  const cardOf = (name) => cards.find((item) => item.props.job?.name === name)

  const onCard = cardOf('启用未运行')
  const offCard = cardOf('停用但上次成功')
  const runningCard = cardOf('正在执行')
  assert.ok(onCard && offCard && runningCard, '缺少任务卡')
  assert.equal(toneOf(onCard.element), 'var(--cb-status-ok)', '启用任务的卡片色为正常色')
  assert.match(textOf(onCard.element), /未运行/, '启用任务状态文案为未运行')
  assert.equal(stateToneOf(onCard.element), 'var(--cb-status-mute)', '从未运行的状态点不得显示为成功')

  assert.equal(toneOf(offCard.element), 'var(--cb-status-mute)', '停用任务的卡片色为中性色')
  assert.match(textOf(offCard.element), /成功/, '停用任务保留上次运行结果文案')
  assert.equal(stateToneOf(offCard.element), 'var(--cb-status-ok)', '上次成功的状态点必须仍是成功色')

  assert.equal(stateToneOf(runningCard.element), 'var(--cb-status-run)', '运行中沿用绿色令牌')
  assert.match(CLIENT_SRC, /--cb-status-run:var\(--cb-status-ok\)/, '运行中令牌必须指向绿色,不引入第四种色相')
  assert.match(stateDotOf(runningCard.element)?.props.className ?? '', /cb-dot--pulse/, '运行中的绿点必须脉冲')
  assert.doesNotMatch(stateDotOf(onCard.element)?.props.className ?? '', /cb-dot--pulse/, '非运行中不得脉冲')

  assert.doesNotMatch(runButtonOf(onCard.element)?.props.className ?? '', /cb-button--primary/, '行内运行按钮应降为次级,不抢页面唯一主操作')
})
