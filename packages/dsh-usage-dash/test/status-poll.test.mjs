// 重建后对账回归(F23 状态轮):真实执行 client loader 与面板组件,仅替换 React Hook 运行时、
// 网络与定时器边界。断言只看网络请求与定时器排程,不触碰面板内部状态字段。
import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SOURCE } from './client-eval.mjs'

// 下列用例以浏览器 +8 为基线;CI runner 是 UTC,显式固定本文件进程时区,
// 避免系统时区把「宿主时区校正」用例的前提悄悄改成同时区。
process.env.TZ = 'Asia/Shanghai'

const flush = () => new Promise((resolve) => setImmediate(resolve))
const statusRequests = (f) => f.requests.filter((item) => item.path.endsWith('/status'))
const rangeRequests = (f) => f.requests.filter((item) => item.path.endsWith('/range'))
const daySpan = (body) => (Date.parse(body.to) - Date.parse(body.from)) / 86400000
// 汇总取默认 30 天窗口;热力图取更长的 91 天窗口,以区间跨度区分两者
const summaryRequests = (f) => rangeRequests(f).filter((item) => item.body && daySpan(item.body) <= 30)
const timersOf = (f, ms) => [...f.timers.entries()].filter(([, timer]) => timer.ms === ms)
const pointRequests = (f, endpoint) => f.requests.filter((item) => item.path.endsWith(`/${endpoint}`))

function findButton(node, label) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  const children = Array.isArray(node.children) ? node.children : []
  if (node.type === 'button' && children.includes(label)) return node
  for (const child of children) {
    const found = findButton(child, label)
    if (found) return found
  }
  return null
}

function fixedDateClass(iso) {
  const RealDate = Date
  const fixed = new RealDate(iso).getTime()
  return class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed)
      else super(...args)
    }
    static now() { return fixed }
  }
}

function fixture({ statuses = [], now, pointOk = false, deferRange = false, deferPoint = false } = {}) {
  let current, factory
  const slots = new Map(), mounted = [], requests = [], timers = new Map(), listeners = new Map()
  const rangeDeferred = []
  const pointDeferred = []
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
  const document = {
    querySelector: () => ({}),
    querySelectorAll: () => [],
    documentElement: {},
    body: {},
    visibilityState: 'visible',
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type) { listeners.delete(type) },
  }
  const fetch = async (path, options = {}) => {
    const body = options.body && JSON.parse(options.body)
    requests.push({ path, body })
    if (path.endsWith('/status')) {
      const value = statuses.length > 0 ? statuses.shift() : { running: false, backup: null }
      return { json: async () => ({ ok: true, value }) }
    }
    // 点时端点可返回空成功值,供点缓存/时区校正用例;默认保持失败无数据
    if (deferPoint && (path.endsWith('/hours') || path.endsWith('/minutes'))) {
      const deferred = Promise.withResolvers()
      pointDeferred.push({ ...deferred, body })
      return deferred.promise
    }
    if (pointOk && (path.endsWith('/hours') || path.endsWith('/minutes'))) {
      return {
        json: async () => ({
          ok: true,
          value: {
            from: body.from, to: body.to, daily: [], models: [], tokens: 0,
            requests: 0, sessions: 0, turns: 0, cacheHit: 0, cacheMiss: 0,
          },
        }),
      }
    }
    if (deferRange && path.endsWith('/range')) {
      const deferred = Promise.withResolvers()
      rangeDeferred.push({ ...deferred, body })
      return deferred.promise
    }
    // 汇总/热力图失败:面板保持无数据也不影响状态轮询链
    return { json: async () => ({ ok: false, message: 'fixture-skip' }) }
  }
  const schedule = (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id }
  const clear = (id) => { timers.delete(id) }
  new Function(
    'window', 'document', 'fetch', 'localStorage', 'MutationObserver', 'setTimeout', 'clearTimeout', 'Date',
    CLIENT_SOURCE,
  )(window, document, fetch, null, class { observe() {} disconnect() {} takeRecords() { return [] } }, schedule, clear, now ? fixedDateClass(now) : Date)

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
  const visibility = (state = 'visible') => {
    document.visibilityState = state
    listeners.get('visibilitychange')?.()
  }
  return { requests, timers, settle, panel, fire, visibility, rangeDeferred, pointDeferred }
}

function findNode(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

test('Given 重建后回到空闲 When 首个空闲 tick 返回 Then 停链,不再周期请求', async () => {
  // Given 面板挂载且状态接口返回 running=false(此前未运行)
  const f = fixture()
  f.panel()
  await f.settle()
  assert.equal(statusRequests(f).length, 1, '挂载后应发出首次状态请求')

  // Then 空闲不排任何续轮,也不触发汇总刷新
  assert.equal(timersOf(f, 1000).length, 0, '空闲不得排快轮')
  assert.equal(timersOf(f, 5000).length, 0, '空闲不得排慢轮')
  assert.equal(timersOf(f, 800).length, 0, '空闲不得排汇总刷新')
})

test('Given 首屏汇总在飞 When 切到空自定义范围 Then loading 复位且不继承上一轮', async () => {
  const f = fixture({ deferRange: true })
  const panel = f.panel()
  await f.settle()
  const refreshBefore = findNode(panel.tree, (node) => node.type === 'button' && node.props?.['aria-label'] === '刷新')
  assert.equal(refreshBefore.props.disabled, true, '首屏汇总在飞时刷新按钮应忙')

  const custom = findButton(panel.tree, '自定义')
  assert.ok(custom, '天视图应有自定义范围按钮')
  custom.props.onClick()
  await f.settle()

  const refresh = findNode(panel.tree, (node) => node.type === 'button' && node.props?.['aria-label'] === '刷新')
  assert.equal(refresh.props.disabled, false, '空自定义范围必须复位 loading')
  assert.equal(findNode(panel.tree, (node) => node.props?.className === 'ud-loading'), null)
  for (const request of f.rangeDeferred) request.resolve({ json: async () => ({ ok: false, message: 'fixture-skip' }) })
  await f.settle()
})

test('Given 点时请求在飞 When 清空自定义时间 Then point loading 复位', async () => {
  const f = fixture({ deferPoint: true })
  const panel = f.panel()
  await f.settle()
  findButton(panel.tree, '小时').props.onClick()
  await f.settle()
  assert.equal(findNode(panel.tree, (node) => node.type === 'button' && node.props?.['aria-label'] === '刷新').props.disabled, true)

  findButton(panel.tree, '自定义').props.onClick()
  await f.settle()
  const fromInput = findNode(panel.tree, (node) => node.type === 'input' && node.props?.['aria-label'] === '开始')
  const toInput = findNode(panel.tree, (node) => node.type === 'input' && node.props?.['aria-label'] === '结束')
  fromInput.props.onChange({ target: { value: '' } })
  toInput.props.onChange({ target: { value: '' } })
  await f.settle()
  assert.equal(findNode(panel.tree, (node) => node.type === 'button' && node.props?.['aria-label'] === '刷新').props.disabled, false)
  assert.equal(findNode(panel.tree, (node) => node.props?.className === 'ud-loading'), null)
  for (const request of f.pointDeferred) request.resolve({ json: async () => ({ ok: false, message: 'fixture-skip' }) })
  await f.settle()
})

test('Given 回扫运行中 When 连续快轮推进到空闲 Then 快轮停链且收尾只刷新一次', async () => {
  const f = fixture({
    statuses: [
      { running: true, total: 4, done: 0, backup: null },
      { running: true, total: 4, done: 2, backup: null },
      { running: false, total: 4, done: 4, backup: null },
    ],
  })
  f.panel()
  await f.settle()
  // 首 tick running=true → 排 1s 快轮
  assert.equal(timersOf(f, 1000).length, 1, '运行中应续排快轮')
  const rangeBefore = summaryRequests(f).length

  // 第二 tick 仍在跑且 done 推进 → 排刷新去抖 + 下一快轮
  f.fire(timersOf(f, 1000)[0][0])
  await f.settle()
  assert.equal(timersOf(f, 800).length, 1, 'done 推进应排汇总刷新')
  assert.equal(timersOf(f, 1000).length, 1, '运行中继续快轮')

  // 第三 tick 回到空闲 → 收尾刷新,之后不再续轮
  f.fire(timersOf(f, 1000)[0][0])
  await f.settle()
  assert.equal(statusRequests(f).length, 3, '运行期每 tick 一次状态请求')
  assert.equal(timersOf(f, 1000).length, 0, '空闲后快轮必须停链')
  assert.equal(timersOf(f, 800).length, 1, 'running→idle 收尾保留一次汇总刷新')
  assert.equal(summaryRequests(f).length, rangeBefore, '汇总刷新仍由去抖触发,尚未执行')
})

test('Given restart 重置基线 When 首个快轮 tick 返回空闲 Then 补一次汇总刷新且不恢复慢轮', async () => {
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
  f.fire(fast[0][0])
  await f.settle()

  // Then 状态请求发出,刷新被 800ms 去抖挂起,尚未重复拉汇总
  assert.equal(statusRequests(f).length, 2, 'restart 快轮应请求状态')
  const debounce = timersOf(f, 800)
  assert.equal(debounce.length, 1, 'running→idle 必须排一次汇总刷新去抖')
  assert.equal(summaryRequests(f).length, rangeBefore, '去抖到期前不得刷新汇总')

  // When 去抖到期 Then 汇总刷新发生,空闲保持停链
  f.fire(debounce[0][0])
  await f.settle()
  assert.ok(summaryRequests(f).length > rangeBefore, '去抖到期后应拉取汇总')
  assert.equal(timersOf(f, 1000).length, 0, '空闲不得重新排快轮')
  assert.equal(timersOf(f, 5000).length, 0, '空闲不得重新排慢轮')
})

test('Given 面板空闲 When 窗口由隐藏恢复可见 Then 补一次状态检查且仍停链', async () => {
  const f = fixture()
  f.panel()
  await f.settle()
  assert.equal(statusRequests(f).length, 1)

  // 隐藏:无定时器可清,保持静默
  f.visibility('hidden')
  assert.equal(statusRequests(f).length, 1)
  // 恢复可见:补一次状态检查(空闲),不排后续轮询
  f.visibility('visible')
  await f.settle()
  assert.equal(statusRequests(f).length, 2, '重新可见应补一次状态检查')
  assert.equal(timersOf(f, 1000).length, 0, '可见补查后空闲仍停链')
  assert.equal(timersOf(f, 5000).length, 0, '可见补查后不得排慢轮')
})

test('A4 Given 宿主 UTC/浏览器 +8 When status 下发宿主时区 Then 汇总与热力图按宿主日历重取', async () => {
  // Given 固定时刻 2026-03-15T18:30Z:浏览器 +8 已是 3/16,宿主 UTC 仍是 3/15
  const f = fixture({
    statuses: [{ running: false, backup: null, timeZone: 'UTC' }],
    now: '2026-03-15T18:30:00Z',
  })
  // When 挂载后首帧用浏览器时区发范围,status 返回宿主时区触发重算
  f.panel()
  await f.settle()
  const summaries = summaryRequests(f)
  assert.ok(summaries.length >= 2, '时区变化必须触发汇总重取')
  // Then 最后一次汇总请求按宿主 UTC 日历(30 天预设)
  assert.deepEqual(summaries.at(-1).body, { from: '2026-02-14', to: '2026-03-15' })
  // Then 热力图同样按宿主日历(26 周窗口)
  const heat = rangeRequests(f).filter((item) => item.body && daySpan(item.body) > 30)
  assert.ok(heat.length >= 1)
  assert.deepEqual(heat.at(-1).body, { from: '2025-09-15', to: '2026-03-15' })
})

test('R2-U1 Given 点数据已按浏览器时区缓存 When status 校正宿主时区 Then 点缓存失配并按宿主日历重取', async () => {
  // Given 首次 status 仍 running(宿主时区未下发),固定时刻 +8 为 3/16 02:30、UTC 为 3/15 18:30
  const f = fixture({
    statuses: [
      { running: true, total: 4, done: 0, backup: null },
      { running: false, total: 4, done: 4, backup: null, timeZone: 'UTC' },
    ],
    now: '2026-03-15T18:30:00Z',
    pointOk: true,
  })
  const panel = f.panel()
  await f.settle()
  // When 切到小时视图:点请求按浏览器时区写入 pointStats('24h')
  const hourButton = findButton(panel.tree, '小时')
  assert.ok(hourButton, '未找到小时视图入口')
  hourButton.props.onClick()
  await f.settle()
  const first = pointRequests(f, 'hours')
  assert.equal(first.length, 1)
  assert.deepEqual(first[0].body, { from: '2026-03-15T02', to: '2026-03-16T02' }, '首轮按浏览器 +8 日历')
  // When 状态快轮返回 idle + 宿主 UTC,校正时区 Then 同挡位旧缓存必须失配并重取
  const fast = timersOf(f, 1000)
  assert.equal(fast.length, 1, 'running 应排快轮')
  f.fire(fast[0][0])
  await f.settle()
  const afterCorrection = pointRequests(f, 'hours')
  assert.equal(afterCorrection.length, 2, '时区校正后必须重取点数据')
  assert.deepEqual(
    afterCorrection.at(-1).body,
    { from: '2026-03-14T18', to: '2026-03-15T18' },
    '重取范围必须按宿主 UTC 日历',
  )
})

test('R3-U3-1 Given 隐藏页在途 status 返回 running When 响应到达 Then 不续快轮,恢复可见才续', async () => {
  const f = fixture({ statuses: [{ running: true, done: 0 }, { running: true, done: 0 }] })
  f.panel()
  // 隐藏发生在首个 status 在途期间
  f.visibility('hidden')
  await f.settle()
  assert.equal(statusRequests(f).length, 1)
  assert.equal(timersOf(f, 1000).length, 0, '隐藏期间在途 running 响应不得续快轮')

  // 恢复可见补一次状态检查;确认 running 后才允许续快轮
  f.visibility('visible')
  await f.settle()
  assert.equal(statusRequests(f).length, 2, '恢复可见应补一次状态检查')
  assert.equal(timersOf(f, 1000).length, 1, '可见且 running 才续快轮')
})
