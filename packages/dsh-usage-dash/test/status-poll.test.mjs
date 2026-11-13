// 重建后对账回归(F23 状态轮):真实执行 client loader 与面板组件,仅替换 React Hook 运行时、
// 网络与定时器边界。断言只看网络请求与定时器排程,不触碰面板内部状态字段。
import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SOURCE } from './client-eval.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const statusRequests = (f) => f.requests.filter((item) => item.path.endsWith('/status'))
const rangeRequests = (f) => f.requests.filter((item) => item.path.endsWith('/range'))
const daySpan = (body) => (Date.parse(body.to) - Date.parse(body.from)) / 86400000
// 汇总取默认 30 天窗口;热力图取更长的 91 天窗口,以区间跨度区分两者
const summaryRequests = (f) => rangeRequests(f).filter((item) => item.body && daySpan(item.body) <= 30)
const timersOf = (f, ms) => [...f.timers.entries()].filter(([, timer]) => timer.ms === ms)

function fixture() {
  let current, factory
  const slots = new Map(), mounted = [], requests = [], timers = new Map()
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    memo: (fn) => fn,
    Fragment: 'fragment',
    useId: () => 'fixture',
    useState(seed) {
      const owner = current, index = owner.cursor++
      if (!(index in owner.states)) owner.states[index] = typeof seed === 'function' ? seed() : seed
      return [owner.states[index], (value) => {
        if (!owner.alive) return
        owner.states[index] = typeof value === 'function' ? value(owner.states[index]) : value
        owner.dirty = true
      }]
    },
    useRef(seed) { const index = current.cursor++; return current.refs[index] ??= { current: seed } },
    useMemo(fn, deps) {
      const index = current.cursor++, old = current.memos[index]
      if (!old || !depsEqual(old.deps, deps)) current.memos[index] = { value: fn(), deps }
      return current.memos[index].value
    },
    useEffect(fn, deps) {
      const owner = current, index = owner.cursor++, old = owner.effects[index]
      if (!old || !depsEqual(old.deps, deps)) owner.pending.push(() => {
        old?.cleanup?.()
        owner.effects[index] = { deps, cleanup: fn() }
      })
    },
  }
  hooks.useCallback = (fn, deps) => hooks.useMemo(() => fn, deps)
  hooks.useLayoutEffect = hooks.useEffect

  const window = {
    __ModuleLoader__: { load: (entry) => { factory = entry.factory } },
    addEventListener() {},
    removeEventListener() {},
  }
  const document = { querySelector: () => ({}), querySelectorAll: () => [], documentElement: {}, body: {} }
  const fetch = async (path, options = {}) => {
    requests.push({ path, body: options.body && JSON.parse(options.body) })
    if (path.endsWith('/status')) {
      return { json: async () => ({ ok: true, value: { running: false, backup: null } }) }
    }
    // 汇总/热力图失败:面板保持无数据也不影响状态轮询链
    return { json: async () => ({ ok: false, message: 'fixture-skip' }) }
  }
  const schedule = (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id }
  const clear = (id) => { timers.delete(id) }
  new Function(
    'window', 'document', 'fetch', 'localStorage', 'MutationObserver', 'setTimeout', 'clearTimeout', 'Date',
    CLIENT_SOURCE,
  )(window, document, fetch, null, class { observe() {} disconnect() {} takeRecords() { return [] } }, schedule, clear, Date)

  const mod = factory((name) => name === 'react' ? hooks : { createPortal: null })
  mod.apply({
    effect: (fn) => fn(),
    locale: { register() {} },
    slots: {
      inject: (_name, fn) => fn(),
      register: (entry, component) => slots.set(entry.name, component),
    },
    configForms: { get: () => ({ getSnapshot: () => ({ value: undefined }), subscribe: () => () => {}, mutate: async () => true }) },
  })

  const render = (owner) => {
    current = owner
    owner.cursor = 0
    owner.dirty = false
    owner.tree = owner.component(owner.props)
    current = null
    owner.pending.splice(0).forEach((fn) => fn())
    return owner.tree
  }
  const mount = (component, props = {}) => {
    const owner = {
      component, props, states: [], refs: [], memos: [], effects: [], pending: [],
      cursor: 0, alive: true, dirty: true,
    }
    mounted.push(owner)
    render(owner)
    return owner
  }
  const settle = async () => {
    for (let index = 0; index < 12; index += 1) {
      await flush()
      mounted.filter((owner) => owner.alive && owner.dirty).forEach(render)
    }
  }
  const panel = () => mount(slots.get('settings.section'))
  const fire = (id) => {
    const timer = timers.get(id)
    timers.delete(id)
    timer.fn()
  }
  return { requests, timers, settle, panel, fire }
}

test('Given 重建后回到空闲 When 首个空闲 tick 返回 Then 仍续排下一轮慢轮询', async () => {
  // Given 面板挂载且状态接口返回 running=false(此前未运行)
  const f = fixture()
  f.panel()
  await f.settle()
  assert.equal(statusRequests(f).length, 1, '挂载后应发出首次状态请求')

  // When 触发首个空闲 tick Then 不刷新汇总但继续排 5s 慢轮
  const slow = timersOf(f, 5000)
  assert.equal(slow.length, 1, '首个空闲 tick 后必须续排慢轮询(否则轮询链断裂)')
  const rangeBefore = summaryRequests(f).length
  f.fire(slow[0][0])
  await f.settle()

  assert.equal(statusRequests(f).length, 2, '空闲 tick 应继续请求状态')
  assert.equal(summaryRequests(f).length, rangeBefore, '空闲 tick 不应触发汇总刷新')
  assert.equal(timersOf(f, 5000).length, 1, '第二个空闲 tick 后仍须续排慢轮询')
})

test('Given restart 重置基线 When 首个快轮 tick 返回空闲 Then 补一次汇总刷新并恢复慢轮', async () => {
  // Given 面板空闲,statusMachineRef 已暴露 restart
  const f = fixture()
  const mountedPanel = f.panel()
  await f.settle()
  const machine = mountedPanel.refs.map((ref) => ref.current).find((value) => value && typeof value.restart === 'function')
  assert.ok(machine, 'statusMachineRef 未暴露 restart')
  const rangeBefore = summaryRequests(f).length

  // When restart 后首个快轮 tick 返回 running=false(模拟 reset/restore 同步完成)
  machine.restart()
  const fast = timersOf(f, 1000)
  assert.equal(fast.length, 1, 'restart 应排一次 1s 快轮')
  assert.equal(timersOf(f, 5000).length, 0, 'restart 应取消上一轮慢轮')
  f.fire(fast[0][0])
  await f.settle()

  // Then 状态请求发出,刷新被 800ms 去抖挂起,尚未重复拉汇总
  assert.equal(statusRequests(f).length, 2, 'restart 快轮应请求状态')
  const debounce = timersOf(f, 800)
  assert.equal(debounce.length, 1, 'running→idle 必须排一次汇总刷新去抖')
  assert.equal(summaryRequests(f).length, rangeBefore, '去抖到期前不得刷新汇总')

  // When 去抖到期 Then 汇总刷新发生,慢轮恢复
  f.fire(debounce[0][0])
  await f.settle()
  assert.ok(summaryRequests(f).length > rangeBefore, '去抖到期后应拉取汇总')
  assert.equal(timersOf(f, 5000).length, 1, '刷新后应恢复 5s 慢轮')
})
