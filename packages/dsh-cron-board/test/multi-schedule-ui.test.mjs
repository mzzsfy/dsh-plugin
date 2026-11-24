// 多 cron 编辑面测试:计划行列表的增删、存量多行计划的回填、保存载荷的多行形态。
// client.js 单文件自包含,经 __ModuleLoader__ 捕获模块,配最小 hooks 运行时驱动真实面板
// (同位复用槽位,与 job-card-status / automation-group 测试同构)。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')
const API = '/api/cron-board/'
const NOW = 1_800_000_000_000

let active = null

const ReactStub = {
  createElement: (type, props, ...children) => {
    // 与 React 对齐:children 同时进 props(Modal/Section/Field 靠 props.children 渲染子节点)
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
    const element = {
      type,
      props: { ...(props ?? {}), ...(flat.length > 0 ? { children: flat.length === 1 ? flat[0] : flat } : {}) },
      children: flat,
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

// 存量计划刻意用「后缀带空格」的书写:构建器规范化后文本不同,基线仍取服务端原文(不产生脏字段)
const MULTI_SCHEDULE = '0 9 * * * T+8\n30 8 * * 1-5T+0'
const JOBS = [
  {
    id: 'job-multi', name: '多计划任务', kind: 'shell', command: 'echo hi', schedule: MULTI_SCHEDULE,
    summary: '每天 09:00(UTC+8) · 工作日 08:30(UTC+0)', enabled: true, nextRunAt: NOW + 3600 * 1000,
    lastStatus: null, createdAt: NOW, updatedAt: NOW,
  },
]

// fetch 桩:记录写请求体;preview 按计划行返回逐条 items(与真实路由同构)
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
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ method, target, body })
    const respond = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'POST' && target === API + 'cron/preview') {
      // 与真实路由同构:预览对重复表达式去重(items 数可能少于计划行数)
      const lines = [...new Set(String(body.schedule ?? '').split('\n').filter((line) => line.trim() !== ''))]
      return respond({
        summary: lines.join(' · '),
        nextAt: [NOW + 3600 * 1000],
        // 摘要与表达式原文明显不同,便于断言界面读的是 items 而不是回退表达式
        items: lines.map((line, index) => ({ schedule: line, summary: '第' + (index + 1) + '条摘要', nextAt: [NOW + 3600 * 1000] })),
      })
    }
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
const buttonOf = (tree, label) => nodesOf(tree).find((node) => node.type === 'button' && textOf(node).trim() === label) ?? null
// 按钮可能挂在任意已渲染组件(JobsTab/JobCard/JobForm)树上,按最近一次渲染结果全局查找
const findButton = (runtime, label) => {
  for (const item of runtime.captured) {
    const found = buttonOf(item.element, label)
    if (found) return found
  }
  return null
}
const planRowsOf = (tree) => nodesOf(tree).filter((node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('cb-sched-row'))

const createdRuntimes = []
after(() => {
  for (const runtime of createdRuntimes) runtime.unmount()
})

// 轮询等待条件成立(最多 2s):防抖类异步断言只按时间睡眠会在慢机器上假红
async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('等待条件超时')
}

async function openEditor(runtime, openButtonText) {
  const button = findButton(runtime, openButtonText)
  assert.ok(button, '找不到入口按钮:' + openButtonText)
  button.props.onClick()
  await runtime.flush()
  const form = runtime.find((item) => item.type?.name === 'JobForm')
  assert.ok(form, '编辑器未打开')
  return form
}

test('Given 存量多行计划 When 打开编辑器 Then 计划行逐条展开且贴出摘要', async () => {
  const { runtime, calls } = createHarness()
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()

  const form = await openEditor(runtime, '编辑')
  // 预览经 300ms 防抖后发出:轮询等待而不是固定睡眠(高负载下固定睡眠会假红)
  await waitFor(() => calls.some((call) => call.target === API + 'cron/preview'))
  await runtime.flush()
  const formAfterPreview = runtime.find((item) => item.type?.name === 'JobForm')
  const rows = planRowsOf(formAfterPreview.element)
  assert.equal(rows.length, 2, '两条计划各占一行')
  // 行摘要来自 preview 逐条 items(存量后缀带空格也按规范化表达式匹配到对应行)
  assert.match(textOf(rows[0]), /第1条摘要/)
  assert.match(textOf(rows[1]), /第2条摘要/)
  // 预览请求整份计划一次发出(不按行拆多次)
  const previewCalls = calls.filter((call) => call.target === API + 'cron/preview')
  assert.equal(previewCalls.length, 1)
  assert.equal(previewCalls[0].body.schedule.split('\n').length, 2)

  // When 不做任何修改直接保存 Then 只提交乐观锁基线,不重提计划(避免重写表达式与推进 nextRunAt)
  buttonOf(formAfterPreview.element, '保存').props.onClick()
  await runtime.flush()
  const patched = calls.filter((call) => call.method === 'PATCH' && call.target === API + 'jobs/job-multi').pop()
  assert.ok(patched, '应提交编辑请求')
  assert.deepEqual(patched.body, { updatedAt: NOW })
})

test('Given 新建任务 When 添加时间再删除 Then 计划行增删对应到保存载荷', async () => {
  const { runtime, calls } = createHarness()
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()

  const form = await openEditor(runtime, '新建任务')
  assert.equal(planRowsOf(form.element).length, 1, '新建默认一条计划')

  // When 添加一条计划行
  const add = buttonOf(form.element, '+ 添加时间')
  assert.ok(add, '缺少添加时间入口')
  add.props.onClick()
  await runtime.flush()
  const afterAdd = runtime.find((item) => item.type?.name === 'JobForm')
  assert.equal(planRowsOf(afterAdd.element).length, 2, '添加后两条计划行')

  // When 删除第一行(单条时不可删)
  const remove = planRowsOf(afterAdd.element)[0].children.find((node) => node.type === 'button' && textOf(node) === '删除')
  assert.ok(remove, '第二条计划行应带删除按钮')
  // 行内删除按钮阻止冒泡(避免同时切换选中行),桩事件只需 stopPropagation
  remove.props.onClick({ stopPropagation() {} })
  await runtime.flush()
  const afterRemove = runtime.find((item) => item.type?.name === 'JobForm')
  assert.equal(planRowsOf(afterRemove.element).length, 1, '删除后回到一条')
  assert.equal(
    planRowsOf(afterRemove.element)[0].children.some((node) => node.type === 'button' && textOf(node) === '删除'),
    false,
    '最后一条计划不可删除',
  )

  // When 再加一条并保存
  buttonOf(afterRemove.element, '+ 添加时间').props.onClick()
  await runtime.flush()
  const ready = runtime.find((item) => item.type?.name === 'JobForm')
  buttonOf(ready.element, '保存').props.onClick()
  await runtime.flush()
  // Then 新建载荷的 schedule 是多行计划,且新行默认时刻与已有行不同(重复行不增加触发点)
  const created = calls.filter((call) => call.method === 'POST' && call.target === API + 'jobs').pop()
  assert.ok(created, '应提交新建请求')
  const lines = String(created.body.schedule).split('\n')
  assert.equal(lines.length, 2)
  assert.notEqual(lines[0], lines[1], '默认新增的计划行不应与已有行同刻')
  for (const line of lines) assert.equal(line.trim().split(/\s+/).length, 5, '每行必须是 5 段 cron: ' + line)
})

test('Given 两行同表达式 When 预览去重 Then 每行仍按表达式匹配到摘要(不按行号)', async () => {
  const { runtime, calls } = createHarness()
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()

  const form = await openEditor(runtime, '新建任务')
  // Given 默认一行 09:00,再添加一行后把选中行(新行)改回 09:00,构造重复表达式
  buttonOf(form.element, '+ 添加时间').props.onClick()
  await runtime.flush()
  // 构建器是子组件,整点输入框在它自己的渲染树里
  const hourInput = runtime.captured
    .map((item) => nodesOf(item.element).find((node) => node.type === 'input' && node.props.className === 'cb-time'))
    .find(Boolean)
  assert.ok(hourInput, '缺少整点输入框')
  hourInput.props.onChange({ target: { value: '9' } })
  await runtime.flush()

  // When 预览按落库口径去重(两行同表达式只回一条 item)
  await new Promise((resolve) => setTimeout(resolve, 500))
  await runtime.flush()
  const previewCalls = calls.filter((item) => item.target === API + 'cron/preview')
  const lastPreview = previewCalls[previewCalls.length - 1]
  const requested = String(lastPreview.body.schedule).split('\n')
  assert.equal(requested.length, 2)
  assert.equal(new Set(requested).size, 1, '两行已是同一表达式:' + JSON.stringify(requested))
  const formAfter = runtime.find((item) => item.type?.name === 'JobForm')
  const rows = planRowsOf(formAfter.element)
  // Then 两行都显示同一摘要,而不是第二行回退成表达式(行为由表达式匹配保证,与 items 下标无关)
  assert.equal(rows.length, 2)
  for (const row of rows) assert.match(textOf(row), /第1条摘要/)
})
