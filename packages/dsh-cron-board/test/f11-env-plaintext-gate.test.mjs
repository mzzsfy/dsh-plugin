// F11 回归守护(可失败行为测试):cron 环境变量编辑的「明文门控」提交契约。
// 原始缺陷(F11):列表 API 返回打码值,编辑表单把打码值装进 value 并可立即保存,
// 一次快速保存(PATCH 带 value)就把真值覆盖成掩码。
// 修复后契约:明文加载完成前不可保存;加载失败禁保存;值未被用户修改时 PATCH 不携带
// value;迟到的明文回填不得覆盖用户草稿。
// client.js 单文件自包含无法 import:经 __ModuleLoader__ 捕获模块,配最小 hooks 运行时
// (按渲染路径复用槽位、setState 触发重渲染、effect 按依赖重跑)后挂载真实组件,
// 从面板 → 环境变量 Tab → 编辑表单逐层驱动,断言只落在可观察输出(input.disabled /
// 按钮 disabled / 实际发出的 HTTP 载荷)。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')
const API = '/api/cron-board/'

// ---- 最小 hooks 运行时(同位复用槽位) ----
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
    /** 卸载:逆序执行全部 effect 清理(面板的本地时钟 interval 在此释放) */
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
  return {
    documentElement: {},
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

const ENV_ROW = { id: 'env-1', name: 'TOKEN', value: 'sec***', remarks: '', multi: false, enabled: true }
const PLAINTEXT = 'secret-truth'

function createHarness({ envRow = ENV_ROW, plaintext = 'value' } = {}) {
  const calls = []
  // 总线桩:真总线首连即回调 onReset(全量对账),订阅方据此完成首拉
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
  const plaintextControl = { resolve: null, reject: null }
  if (plaintext === 'deferred') {
    plaintextControl.promise = new Promise((resolve, reject) => {
      plaintextControl.resolve = (value) => resolve({ ok: true, status: 200, json: async () => ({ value }) })
      plaintextControl.reject = (error) => reject(error)
    })
  }
  const fetchStub = async (url, options = {}) => {
    const target = String(url)
    const method = (options.method ?? 'GET').toUpperCase()
    const body = options.body === undefined ? undefined : JSON.parse(options.body)
    calls.push({ method, target, body })
    const respond = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'GET' && target === API + 'envs') return respond({ items: envRow ? [envRow] : [] })
    if (method === 'GET' && target === API + 'jobs') return respond({ items: [] })
    if (method === 'GET' && target === API + 'status') return respond({ scheduler: { active: 0, queued: 0 }, serverTzOffset: 8, ui: { sidebarTab: false } })
    if (method === 'GET' && target === API + 'envs/' + envRow.id) {
      if (plaintext === 'fail') throw new Error('读取失败')
      if (plaintext === 'deferred') return plaintextControl.promise
      return respond({ value: PLAINTEXT })
    }
    if (method === 'PATCH' && target === API + 'envs/' + envRow.id) return respond({ ok: true })
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
    // createRoot 面板不用(整面板由宿主渲染,本测试直接跑组件函数)
    if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    if (name === '@mzzsfy/dsh-common-tools/client') return tools
    throw new Error('模块表缺依赖:' + name)
  }
  new Function('window', 'document', 'navigator', 'fetch', `${CLIENT_SRC}\n;return null`)(windowStub, createDocumentStub(), {}, fetchStub)
  assert.ok(holder.definition, 'client.js 未自注册')
  const plugin = holder.definition.factory(requireStub)
  plugin.apply({
    get: () => undefined,
    // cordis 语义:effect 工厂即时执行,产物是停用时的注销器
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
    inject: (names, fn) => fn({ effect: (factory) => factory() }),
    slots: {
      inject: (name, factory) => factory(),
      register: (meta, component) => { registered.push({ meta, component }); return () => {} },
    },
  })
  return { calls, registered, plaintextControl }
}

const nodesOf = (tree) => {  const out = []
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

// 值输入 = 唯一带 disabled 属性的文本输入(名称/备注输入不受门控)
const valueInputOf = (tree) => nodesOf(tree).find((node) => node.type === 'input' && node.props && node.props.type !== 'checkbox' && 'disabled' in node.props)
const saveButtonOf = (tree) => nodesOf(tree).find((node) => node.type === 'button' && textOf(node) === '保存')
const patchCalls = (calls) => calls.filter((call) => call.method === 'PATCH')

// 全部挂载过的运行时:任一用例中途失败也必须卸载(面板本地时钟 interval 不释放会挂住进程)
const createdRuntimes = []
after(() => {
  for (const runtime of createdRuntimes) runtime.unmount()
})

/** 挂载面板 → 环境变量 Tab → 打开编辑表单。 */
async function openEnvForm(options) {
  const harness = createHarness(options)
  const entry = harness.registered.find((item) => item.meta.name === 'main')
  assert.ok(entry, '未注册主面板')
  const runtime = createRuntime(entry.component, { visible: true })
  createdRuntimes.push(runtime)
  runtime.render()
  await runtime.flush()

  const pills = runtime.find((item) => Array.isArray(item.props.options) && item.props.options.some((option) => option.value === 'envs'))
  assert.ok(pills, '未找到 Tab 切换组件')
  pills.props.onChange('envs')
  await runtime.flush()

  const envsTab = runtime.find((item) => Array.isArray(item.props.envs))
  assert.ok(envsTab, '环境变量 Tab 未渲染')
  const editButton = nodesOf(envsTab.element).find((node) => node.type === 'button' && textOf(node) === '编辑')
  assert.ok(editButton, '环境变量行缺少编辑按钮')
  editButton.props.onClick()
  await runtime.flush()

  // 表单每次重渲染都是新元素对象:测试一律经 getter 取最新形态
  const currentForm = () => {
    const found = runtime.find((item) => item.props.row !== undefined && typeof item.props.onDone === 'function')
    assert.ok(found, '编辑表单未渲染')
    return found
  }
  currentForm()
  return { ...harness, runtime, currentForm }
}

test('F11-a 明文在途:值输入与保存按钮均禁用(掩码不可提交)', async (t) => {
  const { runtime, currentForm, plaintextControl } = await openEnvForm({ plaintext: 'deferred' })
  t.after(() => runtime.unmount())
  const form = currentForm()
  const input = valueInputOf(form.element)
  const save = saveButtonOf(form.element)
  assert.ok(input && save, '表单缺值输入或保存按钮')
  assert.equal(input.props.disabled, true, '明文未就绪时值输入须禁用')
  assert.equal(save.props.disabled, true, '明文未就绪时保存须禁用')

  // 明文到达后解除门控并回填真值
  plaintextControl.resolve(PLAINTEXT)
  await runtime.flush()
  const readyInput = valueInputOf(currentForm().element)
  assert.equal(readyInput.props.disabled, false, '明文到达后应可编辑')
  assert.equal(readyInput.props.value, PLAINTEXT, '明文到达后回填真值')
})

test('F11-b 明文读取失败:保存永久禁用且给出可读错误', async (t) => {
  const { runtime, currentForm } = await openEnvForm({ plaintext: 'fail' })
  t.after(() => runtime.unmount())
  const form = currentForm()
  const save = saveButtonOf(form.element)
  assert.equal(save.props.disabled, true, '读取失败后不得允许保存')
  assert.equal(valueInputOf(form.element).props.disabled, true, '读取失败后值输入保持禁用')
  assert.match(textOf(form.element), /读取变量明文失败/, '失败须显式告知')
})

test('F11-c 值未修改:保存不携带 value(服务端保留原值),其余字段照常提交', async (t) => {
  const { calls, runtime, currentForm } = await openEnvForm({ plaintext: 'value' })
  t.after(() => runtime.unmount())
  const input = valueInputOf(currentForm().element)
  assert.equal(input.props.value, PLAINTEXT, '明文已回填')
  const save = saveButtonOf(currentForm().element)
  assert.equal(save.props.disabled, false, '明文就绪且未修改时可保存')
  save.props.onClick()
  await runtime.flush()
  const patches = patchCalls(calls)
  assert.equal(patches.length, 1, '应发出一条 PATCH')
  assert.equal('value' in patches[0].body, false, '未修改的值不得随 PATCH 提交')
  assert.equal('values' in patches[0].body, false, '未修改的多值不得随 PATCH 提交')
  assert.equal(patches[0].body.name, ENV_ROW.name, '改名等其它字段照常提交')
})

test('F11-d 迟到明文不覆盖用户草稿:草稿值原样提交', async (t) => {
  const { calls, runtime, currentForm, plaintextControl } = await openEnvForm({ plaintext: 'deferred' })
  t.after(() => runtime.unmount())
  const input = valueInputOf(currentForm().element)
  input.props.onChange({ target: { value: 'user-draft' } })
  await runtime.flush()
  plaintextControl.resolve(PLAINTEXT)
  await runtime.flush()
  const after = valueInputOf(currentForm().element)
  assert.equal(after.props.value, 'user-draft', '用户已输入的草稿不得被迟到回填覆盖')

  const save = saveButtonOf(currentForm().element)
  save.props.onClick()
  await runtime.flush()
  const patches = patchCalls(calls)
  assert.equal(patches.length, 1, '应发出一条 PATCH')
  assert.equal(patches[0].body.value, 'user-draft', '提交的是用户草稿而非迟到明文')
})
