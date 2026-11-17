// 宿主自动化任务只读聚合:开关关闭不请求;开启后按宿主目录渲染只读卡;点击跳宿主页面。
// client.js 单文件自包含,经 __ModuleLoader__ 捕获模块,配最小 hooks 运行时驱动真实面板。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')
const API = '/api/cron-board/'

// ---- 最小 hooks 运行时(同位复用槽位,与 f11 测试同构) ----
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
    get renderCount() {
      return renderCount
    },
  }
  active = runtime
  return runtime
}

// ---- 宿主桩 ----
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

const TASKS = [
  { id: 'automation-1', kind: 'rrule', title: '每日部署检查', prompt: '检查部署状态', status: 'active', scheduledAt: '2099-01-02T01:00:00.000Z', rrule: 'DTSTART;TZID=Asia/Shanghai:20990102T090000\nRRULE:FREQ=DAILY;COUNT=1', target: { kind: 'new_once', sessionId: 'reserved-1', create: {} }, involvedSessionIds: [] },
  { id: 'automation-2', kind: 'rrule', title: '周报汇总', prompt: '汇总周报', status: 'active', scheduledAt: '2099-01-05T02:30:00.000Z', rrule: 'DTSTART;TZID=Asia/Shanghai:20990105T103000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=10;BYMINUTE=30', target: { kind: 'new', create: {} }, involvedSessionIds: [] },
  { id: 'automation-3', kind: 'rrule', title: '工作日日报', prompt: '汇总日报', status: 'paused', scheduledAt: '2099-01-03T01:00:00.000Z', rrule: 'DTSTART;TZID=Asia/Shanghai:20990103T090000\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0', target: { kind: 'session', sessionId: 'session-1' }, involvedSessionIds: [] },
]
const OLD_TASKS = [
  { id: 'automation-old', kind: 'daily', title: '旧宿主日报', prompt: '兼容旧目录', status: 'inactive', scheduledAt: '2099-01-06T00:00:00.000Z', time: '08:00:00.000', timeZone: 'Asia/Shanghai', sessionId: 'session-old' },
]
const EDGE_TASKS = [
  { id: 'automation-edge-1', kind: 'rrule', title: '多时段任务', prompt: '', status: 'active', scheduledAt: '2099-01-02T01:00:00.000Z', rrule: 'DTSTART;TZID=Asia/Shanghai:20990102T090000\nRRULE:FREQ=DAILY;BYHOUR=9,18;BYMINUTE=0', target: { kind: 'new', create: {} }, involvedSessionIds: [] },
  { id: 'automation-edge-2', kind: 'rrule', title: '带序号星期任务', prompt: '', status: 'active', scheduledAt: '2099-01-02T01:00:00.000Z', rrule: 'DTSTART;TZID=Asia/Shanghai:20990102T090000\nRRULE:FREQ=WEEKLY;BYDAY=+1MO;BYHOUR=9;BYMINUTE=0', target: { kind: 'new', create: {} }, involvedSessionIds: [] },
]
const TZ_TASKS = [
  { id: 'automation-tz', kind: 'rrule', title: 'UTC 任务', prompt: '', status: 'active', scheduledAt: '2099-01-02T01:00:00.000Z', rrule: 'DTSTART;TZID=UTC:20990102T010000\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=1;BYMINUTE=0', target: { kind: 'new', create: {} }, involvedSessionIds: [] },
]
function createHarness({ showAutomation = false, tasks = TASKS, remote = true, layoutAvailable = true } = {}) {
  const calls = []
  let pref = showAutomation
  const catalogCalls = []
  const layoutCalls = []
  const bus = {
    subscribe: (fn, options) => {
      const initial = options?.onReset ?? fn
      queueMicrotask(() => initial())
      return () => {}
    },
    publish: () => {},
  }
  const tools = {
    setupCommonTools: () => bus,
    createSnapshotRefresh: (fn) => ({ refresh: () => { void fn() }, dispose() {} }),
    toast: { show() {} },
    subscribeChanges: () => () => {},
  }
  const remoteStub = remote ? {
    $on: () => () => {},
    catalog: async () => {
      catalogCalls.push(true)
      return { ok: true, value: tasks }
    },
  } : null
  const layoutStub = layoutAvailable ? { selectPanel: (id) => { layoutCalls.push(id) } } : null
  const fetchStub = async (url, options = {}) => {
    const target = String(url)
    const method = (options.method ?? 'GET').toUpperCase()
    const body = options.body === undefined ? undefined : JSON.parse(options.body)
    calls.push({ method, target, body })
    const respond = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'GET' && target === API + 'jobs') return respond({ items: [] })
    if (method === 'GET' && target === API + 'envs') return respond({ items: [] })
    if (method === 'GET' && target === API + 'status') return respond({ scheduler: { active: 0, queued: 0 }, serverTzOffset: 8, ui: { sidebarTab: false, showAutomationTasks: pref } })
    if (method === 'POST' && target === API + 'ui-settings') {
      if (typeof body.showAutomationTasks === 'boolean') pref = body.showAutomationTasks
      return respond({ ok: true, ui: { sidebarTab: false, showAutomationTasks: pref } })
    }
    return respond({})
  }
  const registered = []
  const holder = {}
  const windowStub = {
    __ModuleLoader__: { load: (definition) => { holder.definition = definition } },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
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
    layout: layoutStub,
    get: (name) => name === 'layout' ? layoutStub : undefined,
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
    inject: (names, fn) => {
      if (Array.isArray(names) && names.includes('remote.schedule') && remoteStub) return fn({ remote: { schedule: remoteStub } })
      return () => {}
    },
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, component) => { registered.push({ meta, component }); return () => {} },
    },
  })
  const entry = registered.find((item) => item.meta.name === 'main')
  assert.ok(entry, '未注册主面板')
  const runtime = createRuntime(entry.component, { visible: true })
  return { runtime, calls, catalogCalls, layoutCalls, documentElement: documentStub.documentElement }
}

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
const textOf = (tree) => (typeof tree === 'string' ? tree : (tree?.children ?? []).map(textOf).join(''))
const classesOf = (tree) => nodesOf(tree).filter((node) => typeof node.props?.className === 'string')
const hasGroup = (tree) => classesOf(tree).some((node) => node.props.className.split(' ').includes('cb-group'))
const automationCards = (runtime) => runtime.captured.filter((item) => item.type?.name === 'AutomationTaskCard')
const switchOf = (tree) => nodesOf(tree).find((node) => node.type === 'input' && node.props?.['aria-label'] === '显示自动化任务')

const createdRuntimes = []
after(() => {
  for (const runtime of createdRuntimes) runtime.unmount()
})

test('Given showAutomationTasks=false When 打开看板 Then 不渲染分组且不请求宿主目录', async () => {
  const { runtime, catalogCalls } = createHarness({ showAutomation: false })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  const jobsTab = runtime.find((item) => item.props.jobs !== undefined)
  assert.ok(jobsTab, '看板未渲染')
  assert.equal(hasGroup(jobsTab.element), false, '默认关闭时不得出现自动化任务分组')
  assert.equal(catalogCalls.length, 0, '默认关闭时不得请求宿主目录')
  assert.equal(switchOf(jobsTab.element)?.props.disabled, false, '服务在场时开关应可用')
})

test('Given showAutomationTasks=true When 看板挂载 Then 标记隐藏宿主侧栏重复入口', async () => {
  const { runtime, documentElement } = createHarness({ showAutomation: true })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  assert.equal(documentElement.hasAttribute('data-cb-hide-host-automation-nav'), true,
    '开启聚合后应隐藏宿主侧栏重复入口')
})

test('Given showAutomationTasks=true 且宿主有三个任务 When 打开看板 Then 渲染只读分组且无编辑/删除/启停', async () => {
  const { runtime, catalogCalls, layoutCalls } = createHarness({ showAutomation: true })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  assert.equal(catalogCalls.length, 1, '开启时应读取一次宿主目录')
  const jobsTab = runtime.find((item) => item.props.jobs !== undefined)
  const cards = automationCards(runtime)
  assert.equal(cards.length, 3, '应渲染三张宿主任务卡')
  assert.match(textOf(cards[0].element), /每日部署检查/)
  assert.match(textOf(cards[1].element), /周报汇总/)
  assert.match(textOf(cards[2].element), /工作日日报/)
  assert.match(textOf(cards[0].element), /一次性/)
  assert.doesNotMatch(textOf(cards[0].element), /自定义规则/)
  assert.match(textOf(cards[1].element), /每周 周一、周三、周五 10:30/)
  assert.match(textOf(cards[2].element), /每天 09:00/)
  for (const card of cards) {
    const labels = nodesOf(card.element).filter((node) => node.type === 'button').map(textOf)
    assert.deepEqual(labels, [], '只读卡片不得带编辑/删除/运行按钮')
  }
  cards[0].props.onOpen()
  assert.deepEqual(layoutCalls, ['schedules'], '点击卡片应打开宿主自动化任务页面')
})

test('Given showAutomationTasks=false When 打开工具栏开关 Then 写入偏好并加载分组', async () => {
  const { runtime, calls, catalogCalls } = createHarness({ showAutomation: false })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  const jobsTab = runtime.find((item) => item.props.jobs !== undefined)
  const toggle = switchOf(jobsTab.element)
  assert.ok(toggle, '工具栏缺少自动化任务开关')
  toggle.props.onChange({ target: { checked: true } })
  await runtime.flush()
  const write = calls.find((call) => call.method === 'POST' && call.target === API + 'ui-settings')
  assert.deepEqual(write?.body, { showAutomationTasks: true })
  assert.equal(catalogCalls.length, 1, '开启后应读取宿主目录')
  const current = runtime.find((item) => item.props.jobs !== undefined)
  assert.equal(hasGroup(current.element), true, '开启后应出现自动化任务分组')
})

test('Given 复杂 RRULE When 打开看板 Then 仅官方可表达子集翻译,其余回退自定义规则', async () => {
  const { runtime } = createHarness({ showAutomation: true, tasks: EDGE_TASKS })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  const cards = automationCards(runtime)
  assert.equal(cards.length, 2)
  for (const card of cards) assert.match(textOf(card.element), /自定义规则/)
})

test('Given 任务带独立时区 When 打开看板 Then 下次时间按任务时区展示而非浏览器时区', async () => {
  const { runtime } = createHarness({ showAutomation: true, tasks: TZ_TASKS })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  const card = automationCards(runtime)[0]
  assert.match(textOf(card.element), /下次 2099-01-02 01:00/)
})

test('Given 0.2.1 目录形状 When 打开看板 Then 兼容 inactive/sessionId 且不显示下次运行', async () => {
  const { runtime } = createHarness({ showAutomation: true, tasks: OLD_TASKS })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  const card = automationCards(runtime)[0]
  assert.ok(card, '应渲染旧宿主任务卡')
  const text = textOf(card.element)
  assert.match(text, /每天 08:00/)
  assert.match(text, /已停用/)
  assert.match(text, /固定会话/)
  assert.doesNotMatch(text, /下次/)
})

test('Given 宿主无 remote.schedule When 打开看板 Then 开关禁用且看板其余能力照常', async () => {
  const { runtime } = createHarness({ showAutomation: false, remote: false })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  const jobsTab = runtime.find((item) => item.props.jobs !== undefined)
  assert.equal(switchOf(jobsTab.element)?.props.disabled, true, '无服务时开关应禁用')
  assert.ok(textOf(jobsTab.element).includes('新建任务'), '看板新建任务仍可用')
})

test('Given RRULE 省略 INTERVAL When 展示宿主任务频率 Then 间隔按 1 处理而不是 undefined', async () => {
  const hourly = [{
    id: 'automation-hourly', kind: 'rrule', title: '每小时巡检', prompt: '', status: 'active',
    scheduledAt: '2099-01-02T01:00:00.000Z',
    rrule: 'DTSTART;TZID=Asia/Shanghai:20990102T090000\nRRULE:FREQ=HOURLY',
    target: { kind: 'new', create: {} }, involvedSessionIds: [],
  }]
  const { runtime } = createHarness({ showAutomation: true, tasks: hourly })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()
  const text = textOf(automationCards(runtime)[0].element)
  assert.match(text, /每小时/)
  assert.doesNotMatch(text, /undefined/)
})
