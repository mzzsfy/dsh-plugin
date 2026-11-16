// C3 回归:删除确认态(armed)必须有生命周期。armed 此前只由 onDelete 清除,跨操作无限期
// 保留,下一次点击任意「删除」即直接删账号。这里行为级锁定:超时自动复位、其它交互
// (刷新/编辑/换账号/被外部移除)复位,复位后的首次点击只重新武装、不删除。
// client.js 单文件自包含无法 import:经 __ModuleLoader__ 捕获模块,配最小 hooks 运行时
// (按路径复用槽位、setState 触发重渲染、effect 按依赖重跑)与假定时器后挂载真实组件树。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 与 parity/a11y 用例同法:抽 LOGIC 标记段求值,断言值绑定真实源码常量
const logic = (() => {
  const begin = CLIENT_SRC.indexOf('/* LOGIC-BEGIN */')
  const end = CLIENT_SRC.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = CLIENT_SRC.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  return new Function(section + '; return { DELETE_ARM_TIMEOUT_MS, deleteArmAction, scheduleDeleteArmReset };')()
})()

const DELETE_ARM_TIMEOUT_MS = logic.DELETE_ARM_TIMEOUT_MS

test('C3 策略:同账号二次按下才构成确认,未武装/换账号只重新武装', () => {
  assert.equal(logic.deleteArmAction(null, 'acct-a'), 'arm')
  assert.equal(logic.deleteArmAction('acct-a', 'acct-a'), 'confirm')
  assert.equal(logic.deleteArmAction('acct-a', 'acct-b'), 'arm')
  assert.equal(logic.deleteArmAction('acct-b', 'acct-a'), 'arm')
  // 空 id 不得与「未武装」互相命中
  assert.equal(logic.deleteArmAction(null, null), 'arm')
})

test('C3 定时器:按超时常量回调复位,清理函数释放定时器', () => {
  const timers = []
  const cleared = []
  const options = {
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: (id) => { cleared.push(id) },
  }
  assert.ok(Number.isFinite(DELETE_ARM_TIMEOUT_MS) && DELETE_ARM_TIMEOUT_MS > 0, '超时必须是正数')
  assert.ok(DELETE_ARM_TIMEOUT_MS <= 10 * 1000, '确认态窗口须短,超时过久等于无生命周期')
  let resets = 0
  const dispose = logic.scheduleDeleteArmReset(() => { resets += 1 }, options)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, DELETE_ARM_TIMEOUT_MS, '超时必须取自同一常量')
  timers[0].fn()
  assert.equal(resets, 1)
  dispose()
  assert.deepEqual(cleared, [1], '清理必须释放该定时器')
})

// ---------- 最小 hooks 运行时:挂真实组件树 ----------

let activeRuntime = null

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState: (init) => activeRuntime.useState(init),
  useEffect: (effect, deps) => activeRuntime.useEffect(effect, deps),
  useRef: (value) => activeRuntime.useRef(value),
}

function createRuntime(rootType) {
  const instances = new Map()
  const mountOrder = []
  let activeInstance = null
  let scheduled = false
  let unmounted = false
  let failure = null
  let renderCount = 0
  let tree = null
  let pendingEffects = []
  // 正常路径渲染次数为个位数;超出即视为 setState 自激
  const MAX_RENDERS = 400

  function instanceFor(path) {
    let instance = instances.get(path)
    if (!instance) {
      instance = { path, index: 0, slots: [], effectSlots: [] }
      instances.set(path, instance)
      mountOrder.push(instance)
    }
    return instance
  }

  function slotFor() {
    const instance = activeInstance
    const index = instance.index
    instance.index += 1
    if (!instance.slots[index]) {
      instance.slots[index] = {
        value: undefined, hasValue: false, setter: null,
        hasRef: false, ref: null,
        deps: undefined, hasEffect: false, cleanup: null, pending: false, effect: null,
      }
    }
    return instance.slots[index]
  }

  function renderElement(element, path) {
    if (element === null || element === undefined || element === false || element === true) return null
    if (Array.isArray(element)) return element.map((child, index) => renderElement(child, path + ',' + index))
    if (typeof element !== 'object') return element
    if (typeof element.type === 'function') return renderComponent(path, element.type, element.props || {})
    return { ...element, children: (element.children || []).map((child, index) => renderElement(child, path + ',' + index)) }
  }

  function renderComponent(path, type, props) {
    const instance = instanceFor(path)
    instance.index = 0
    const previous = activeInstance
    activeInstance = instance
    let output
    try {
      output = type(props)
    } finally {
      activeInstance = previous
    }
    return renderElement(output, path + '>')
  }

  function runPendingEffects() {
    const effects = pendingEffects
    pendingEffects = []
    for (const slot of effects) {
      if (!slot.pending) continue
      slot.pending = false
      if (typeof slot.cleanup === 'function') {
        const cleanup = slot.cleanup
        slot.cleanup = null
        cleanup()
      }
      const cleanup = slot.effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  function render() {
    if (unmounted || failure) return
    if (renderCount >= MAX_RENDERS) {
      failure = new Error('重渲染次数超过 ' + MAX_RENDERS + ',疑似 setState 自激循环')
      unmounted = true
      return
    }
    renderCount += 1
    tree = renderComponent('root', rootType, {})
    runPendingEffects()
  }

  function schedule() {
    if (scheduled || unmounted || failure) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (unmounted || failure) return
      try {
        render()
      } catch (error) {
        failure = error
        unmounted = true
      }
    })
  }

  const runtime = {
    get tree() { return tree },
    get failure() { return failure },
    get renderCount() { return renderCount },
    useState(init) {
      const slot = slotFor()
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
      const instance = activeInstance
      const slot = slotFor()
      const unchanged = slot.hasEffect
        && deps !== undefined
        && slot.deps !== undefined
        && deps.length === slot.deps.length
        && deps.every((dep, index) => Object.is(dep, slot.deps[index]))
      slot.deps = deps
      if (unchanged) return
      slot.hasEffect = true
      slot.pending = true
      slot.effect = effect
      if (!instance.effectSlots.includes(slot)) instance.effectSlots.push(slot)
      pendingEffects.push(slot)
    },
    useRef(value) {
      const slot = slotFor()
      if (!slot.hasRef) {
        slot.ref = { current: value }
        slot.hasRef = true
      }
      return slot.ref
    },
    mount() {
      activeRuntime = runtime
      activeInstance = null
      try {
        render()
      } catch (error) {
        failure = error
        unmounted = true
      }
    },
    async flush() {
      for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve))
      if (failure) throw failure
    },
    unmount() {
      if (unmounted) return
      unmounted = true
      for (let i = mountOrder.length - 1; i >= 0; i -= 1) {
        for (const slot of mountOrder[i].effectSlots) {
          if (typeof slot.cleanup !== 'function') continue
          const cleanup = slot.cleanup
          slot.cleanup = null
          cleanup()
        }
      }
    },
  }
  return runtime
}

function createClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    setTimeout(fn, ms) {
      seq += 1
      timers.set(seq, { at: now + Math.max(0, Number(ms) || 0), fn })
      return seq
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    pending() {
      return timers.size
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (due === null || timer.at < due.timer.at) due = { id, timer }
        }
        if (due === null) break
        timers.delete(due.id)
        now = due.timer.at
        due.timer.fn()
      }
      now = target
    },
  }
}

function accountOf(id) {
  return {
    id,
    name: '账号' + id,
    type: 'deepseek',
    last: { ok: false, error: '未查询', queriedAt: 1700000000000 },
  }
}

function loadPanel({ accounts }) {
  const clock = createClock()
  const calls = []
  const modules = []
  const windowListeners = new Map()
  const state = { accounts, revision: 1 }
  const windowStub = {
    __ModuleLoader__: { load: (module) => modules.push(module) },
    addEventListener(type, fn) {
      const set = windowListeners.get(type) || new Set()
      set.add(fn)
      windowListeners.set(type, set)
    },
    removeEventListener(type, fn) {
      const set = windowListeners.get(type)
      if (set) set.delete(fn)
    },
    dispatchEvent() {},
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    if (name === '@mzzsfy/dsh-common-tools/client') {
      return {
        toast: { show: () => {} },
        // ReadingRow 的悬浮层:本用例只关心账号操作,渲染为空节点
        Tooltip: () => null,
        setupCommonTools: () => ({ subscribe: () => () => {} }),
        createSnapshotRefresh: (task) => ({ refresh: task, dispose() {} }),
      }
    }
    throw new Error('模块表缺依赖:' + name)
  }
  const respond = (path, method, options) => {
    const body = options && options.body ? JSON.parse(options.body) : null
    if (path === '/api/usage-panel/accounts') {
      if (method === 'POST') {
        return { ok: true, accounts: body.accounts, revision: (body.revision || 0) + 1 }
      }
      return { accounts: state.accounts, revision: state.revision }
    }
    if (path === '/api/usage-panel/revision') return { revision: state.revision }
    if (path === '/api/usage-panel/history') return { sequences: {} }
    if (path === '/api/usage-panel/settings') return { pollArmed: true }
    if (path === '/api/usage-panel/query') {
      return { account: state.accounts.find((item) => item.id === body.id) || null }
    }
    if (path === '/api/usage-panel/notify-config') {
      return {
        notify: {
          enabled: false, quotaThresholdPct: 80, balanceThreshold: null,
          resetNotice: true, toast: true, webhookConfigured: false, imTargets: [],
        },
        imAvailable: false,
      }
    }
    return {}
  }
  const fetchStub = (path, options = {}) => {
    const method = options.method || 'GET'
    calls.push({ path, method, body: options.body })
    return Promise.resolve({ ok: true, status: 200, json: async () => respond(path, method, options) })
  }
  // setTimeout/clearTimeout 作为参数注入 factory 作用域,组件内定时器落假时钟
  const evaluate = new Function('window', 'fetch', 'setTimeout', 'clearTimeout', CLIENT_SRC + '\n;return null')
  evaluate(windowStub, fetchStub, clock.setTimeout, clock.clearTimeout)
  assert.equal(modules.length, 1, 'client.js 未调用 __ModuleLoader__.load')
  const plugin = modules[0].factory(requireStub)
  let registered = null
  plugin.apply({
    effect: () => {},
    get: () => undefined,
    slots: {
      inject: (_name, callback) => callback(),
      register: (_options, component) => { registered = component },
    },
  })
  assert.equal(typeof registered, 'function', '面板组件未注册到 settings.section')
  return {
    clock,
    calls,
    state,
    rootType: registered,
    emit(type) {
      for (const fn of windowListeners.get(type) || []) fn({ type })
    },
  }
}

function textOf(element) {
  if (element === null || element === undefined) return ''
  if (typeof element === 'string') return element
  if (typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(textOf).join('')
  return (element.children || []).map(textOf).join('')
}

function buttonsOf(tree, out = []) {
  if (tree === null || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const child of tree) buttonsOf(child, out)
    return out
  }
  if (tree.type === 'button') out.push(tree)
  for (const child of tree.children || []) buttonsOf(child, out)
  return out
}

function buttonByText(runtime, label) {
  assert.ok(runtime.tree !== null, '组件树未渲染')
  return buttonsOf(runtime.tree).find((button) => textOf(button) === label) || null
}

function assertButton(runtime, label, present = true) {
  const button = buttonByText(runtime, label)
  assert.equal(button !== null, present, (present ? '缺少按钮:' : '不应存在按钮:') + label)
}

async function press(runtime, label) {
  const button = buttonByText(runtime, label)
  assert.ok(button !== null, '找不到按钮:' + label)
  button.props.onClick()
  await runtime.flush()
}

function saves(calls) {
  return calls.filter((call) => call.path === '/api/usage-panel/accounts' && call.method === 'POST')
}

async function mountPanel(fixture) {
  const runtime = createRuntime(fixture.rootType)
  runtime.mount()
  await runtime.flush()
  return runtime
}

test('C3-a 超时自动复位:复位后的首次点击只重新武装,第二次才删除', async () => {
  const fixture = loadPanel({ accounts: [accountOf('acct-a')] })
  const runtime = await mountPanel(fixture)
  try {
    assertButton(runtime, '删除')
    await press(runtime, '删除')
    assertButton(runtime, '确认删除')
    assert.equal(fixture.clock.pending(), 1, '武装即挂一个超时定时器')

    fixture.clock.advance(DELETE_ARM_TIMEOUT_MS)
    await runtime.flush()
    assertButton(runtime, '删除')
    assert.equal(saves(fixture.calls).length, 0, '超时复位不是删除')

    await press(runtime, '删除')
    assertButton(runtime, '确认删除')
    assert.equal(saves(fixture.calls).length, 0, '超时后的首次点击不得直接删除')

    await press(runtime, '确认删除')
    assert.equal(saves(fixture.calls).length, 1, '紧接着的第二次点击才构成确认')
    assert.deepEqual(JSON.parse(saves(fixture.calls)[0].body).accounts, [], '确认删除的是被武装账号')
    assert.equal(fixture.clock.pending(), 0, '确认后必须释放定时器')
  } finally {
    runtime.unmount()
  }
})

test('C3-b 其它交互复位:武装后点刷新,下一次删除点击只重新武装', async () => {
  const fixture = loadPanel({ accounts: [accountOf('acct-a')] })
  const runtime = await mountPanel(fixture)
  try {
    await press(runtime, '删除')
    assertButton(runtime, '确认删除')
    await press(runtime, '刷新')
    assertButton(runtime, '删除')
    assert.equal(fixture.clock.pending(), 0, '刷新复位后定时器必须清掉')
    assert.equal(saves(fixture.calls).length, 0)

    await press(runtime, '删除')
    assertButton(runtime, '确认删除')
    assert.equal(saves(fixture.calls).length, 0, '刷新后的首次点击不得直接删除')
  } finally {
    runtime.unmount()
  }
})

test('C3-c 其它交互复位:点编辑同样解除确认态', async () => {
  const fixture = loadPanel({ accounts: [accountOf('acct-a')] })
  const runtime = await mountPanel(fixture)
  try {
    await press(runtime, '删除')
    assertButton(runtime, '确认删除')
    await press(runtime, '编辑')
    assertButton(runtime, '删除')
    assert.equal(fixture.clock.pending(), 0)
    await press(runtime, '删除')
    assert.equal(saves(fixture.calls).length, 0, '编辑后的首次点击不得直接删除')
  } finally {
    runtime.unmount()
  }
})

test('C3-d 换账号武装:点击另一账号删除只转移确认态,不删除任何账号', async () => {
  const fixture = loadPanel({ accounts: [accountOf('acct-a'), accountOf('acct-b')] })
  const runtime = await mountPanel(fixture)
  try {
    const deletes = () => buttonsOf(runtime.tree).filter((button) => /删除/.test(textOf(button)))
    assert.equal(deletes().length, 2)
    await press(runtime, '删除')
    // 第一个「删除」属于 acct-a 已变成确认态,剩余未武装的那个是 acct-b
    assert.equal(buttonsOf(runtime.tree).filter((button) => textOf(button) === '确认删除').length, 1)
    await press(runtime, '删除')
    assert.equal(saves(fixture.calls).length, 0, '跨账号点击不得删除')
    assert.equal(buttonsOf(runtime.tree).filter((button) => textOf(button) === '确认删除').length, 1, '确认态只能有一个')
    await press(runtime, '确认删除')
    assert.equal(saves(fixture.calls).length, 1)
    assert.deepEqual(JSON.parse(saves(fixture.calls)[0].body).accounts.map((item) => item.id), ['acct-a'])
  } finally {
    runtime.unmount()
  }
})

test('C3-e 被武装账号被外部移除:对账后确认态失效,同 id 重新出现也不得复活', async () => {
  const fixture = loadPanel({ accounts: [accountOf('acct-a'), accountOf('acct-b')] })
  const runtime = await mountPanel(fixture)
  try {
    await press(runtime, '删除')
    assert.equal(buttonsOf(runtime.tree).filter((button) => textOf(button) === '确认删除').length, 1)
    // 另一窗口删掉 acct-a 并广播数据失效:对账拉回新账号表
    fixture.state.accounts = [accountOf('acct-b')]
    fixture.state.revision = 2
    fixture.emit('up-data-changed')
    await runtime.flush()
    assert.equal(buttonsOf(runtime.tree).filter((button) => textOf(button) === '确认删除').length, 0, '账号已不存在,确认态必须失效')
    assertButton(runtime, '删除')
    assert.equal(fixture.clock.pending(), 0)
    // acct-a 被重新加回(同 id):残留确认态若不复位,这里会直接显示「确认删除」
    fixture.state.accounts = [accountOf('acct-a'), accountOf('acct-b')]
    fixture.state.revision = 3
    fixture.emit('up-data-changed')
    await runtime.flush()
    assert.equal(buttonsOf(runtime.tree).filter((button) => textOf(button) === '确认删除').length, 0, '同 id 账号重新出现不得复活确认态')
    await press(runtime, '删除')
    assert.equal(saves(fixture.calls).length, 0, '重新出现后的首次点击不得直接删除')
  } finally {
    runtime.unmount()
  }
})

test('C3-f 卸载清理:武装中卸载不留定时器', async () => {
  const fixture = loadPanel({ accounts: [accountOf('acct-a')] })
  const runtime = await mountPanel(fixture)
  await press(runtime, '删除')
  assert.equal(fixture.clock.pending(), 1)
  runtime.unmount()
  assert.equal(fixture.clock.pending(), 0, 'effect 清理必须释放确认态定时器')
})
