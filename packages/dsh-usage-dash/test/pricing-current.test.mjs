import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SOURCE } from './client-eval.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...(node.children ?? []).flatMap(nodes)]
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : (node?.children ?? []).map(text).join('')
const rule = (amount = 1, currency = '¥') => ({ model: '*/*', unit: 'perMillion', currency, price: { input: amount, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] })
const price = (revision, amount = revision) => ({ revision, rules: [rule(amount)] })
const usage = { uncachedInputTokens: 1000 * 1000, inputTokens: 1000 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, routes: [{ model: 'p/m' }] }

// 执行真实loader和槽组件,Hook仅模拟状态/依赖/清理,网络为可控边界。
function fixture() {
  let current, factory, now = Date.now()
  const slots = new Map(), mounted = [], requests = [], gets = [], saves = [], timers = new Map()
  let lateState = 0
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    memo: fn => fn, Fragment: 'fragment', useId: () => 'fixture',
    useState(seed) {
      const owner = current, i = owner.cursor++
      if (!(i in owner.states)) owner.states[i] = typeof seed === 'function' ? seed() : seed
      return [owner.states[i], value => {
        if (!owner.alive) { lateState++; return }
        owner.states[i] = typeof value === 'function' ? value(owner.states[i]) : value
        owner.dirty = true
      }]
    },
    useRef(seed) { const i = current.cursor++; return current.refs[i] ??= { current: seed } },
    useMemo(fn, deps) {
      const i = current.cursor++, old = current.memos[i]
      if (!old || !depsEqual(old.deps, deps)) current.memos[i] = { value: fn(), deps }
      return current.memos[i].value
    },
    useEffect(fn, deps) {
      const owner = current, i = owner.cursor++, old = owner.effects[i]
      if (!old || !depsEqual(old.deps, deps)) owner.pending.push(() => {
        old?.cleanup?.(); owner.effects[i] = { deps, cleanup: fn() }
      })
    },
  }
  hooks.useCallback = (fn, deps) => hooks.useMemo(() => fn, deps)
  hooks.useLayoutEffect = hooks.useEffect
  const window = { __ModuleLoader__: { load: entry => { factory = entry.factory } }, addEventListener() {}, removeEventListener() {} }
  const document = { querySelector: () => ({}), querySelectorAll: () => [], documentElement: {}, body: {} }
  const schedule = (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id }
  const fetch = async (path, options = {}) => {
    requests.push({ path, ...options })
    const deferred = Promise.withResolvers()
    if (path.endsWith('/pricing')) {
      const list = options.method === 'POST' ? saves : gets
      list.push({ ...deferred, body: options.body && JSON.parse(options.body) })
      return deferred.promise
    }
    const value = path.endsWith('/status') ? { running: false } : { models: [], daily: [], total: 0, requests: 0, from: '2026-10-01', to: '2026-10-28' }
    return { json: async () => ({ ok: true, value }) }
  }
  const Clock = class extends Date { static now() { return now } }
  new Function('window', 'document', 'fetch', 'localStorage', 'MutationObserver', 'setTimeout', 'clearTimeout', 'Date', CLIENT_SOURCE)(window, document, fetch, null, class { observe() {} disconnect() {} takeRecords() { return [] } }, schedule, id => timers.delete(id), Clock)
  const mod = factory(name => name === 'react' ? hooks : { createPortal: null })
  mod.apply({ effect: fn => fn(), locale: { register() {} }, slots: { inject: (_name, fn) => fn(), register: (entry, component) => slots.set(entry.name, component) } })
  const render = owner => {
    current = owner; owner.cursor = 0; owner.dirty = false
    owner.tree = owner.component(owner.props); current = null
    owner.pending.splice(0).forEach(fn => fn())
    return owner.tree
  }
  const mount = (component, props = {}) => {
    const owner = { component, props, states: [], refs: [], memos: [], effects: [], pending: [], cursor: 0, alive: true, dirty: true }
    mounted.push(owner); render(owner); return owner
  }
  const unmount = owner => { owner.alive = false; owner.effects.forEach(effect => effect?.cleanup?.()) }
  const settle = async () => {
    for (let i = 0; i < 12; i++) { await flush(); mounted.filter(owner => owner.alive && owner.dirty).forEach(render) }
  }
  const panel = () => mount(slots.get('settings.section'))
  const editor = () => { const p = panel(); return mount(nodes(p.tree).find(n => n.type?.name === 'PricingEditor').type) }
  const stats = () => mount(slots.get('conversation.composer.dock'), { useProjection: () => usage })
  const chip = () => mount(slots.get('conversation.chat.assistant-actions'), { messageId: 'm1', useChat: select => select({ nodes: [{ kind: 'turn-tail', data: { closing: { finalNode: { messageId: 'm1' } }, tokenUsage: usage } }] }) })
  const resolve = (item, value) => item.resolve({ json: async () => ({ ok: true, value }) })
  const save = owner => {
    const button = nodes(owner.tree).find(n => n.type === 'button' && text(n) === '保存')
    assert.ok(button, '已载入编辑器保存按钮'); return button.props.onClick()
  }
  return { panel, editor, stats, chip, settle, unmount, requests, gets, saves, resolve, save, mount, nodes, text, timers,
    get lateState() { return lateState }, advance: ms => { now += ms }, cleanup: () => mounted.filter(o => o.alive).forEach(unmount) }
}

const withFixture = async (t, fn) => { const f = fixture(); t.after(f.cleanup); await fn(f) }

test('P1 Given concurrent consumers, When cold mounted, Then only one pricing GET is sent', t => withFixture(t, async f => {
  f.stats(); f.stats(); f.panel(); f.editor()
  assert.equal(f.gets.length, 1)
}))

test('P2/P4 Given mounted consumers, When editor saves, Then cost changes and panel ranges refresh', t => withFixture(t, async f => {
  const stats = f.stats(), chip = f.chip(), editor = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  assert.match(text(stats.tree), /¥1\.00/)
  assert.match(text(chip.tree), /¥1\.00/)
  const before = f.requests.filter(r => r.path.endsWith('/range')).length
  const pending = f.save(editor); f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.match(text(stats.tree), /¥2\.00/)
  assert.match(text(chip.tree), /¥2\.00/)
  assert.equal(f.requests.filter(r => r.path.endsWith('/range')).length, before + 2)
}))

test('P3/P8 Given initial load or same revision TTL refresh, When panel mounts, Then range is not duplicated', t => withFixture(t, async f => {
  f.panel(); f.resolve(f.gets[0], price(1)); await f.settle()
  assert.equal(f.requests.filter(r => r.path.endsWith('/range')).length, 2)
  f.advance(5 * 60 * 1000 + 1); f.panel()
  f.resolve(f.gets.at(-1), price(1)); await f.settle()
  assert.equal(f.requests.filter(r => r.path.endsWith('/range')).length, 4)
}))

test('P6/P9 Given new save while old GET is pending, When old reply arrives, Then price never goes backward', t => withFixture(t, async f => {
  const editor = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  f.advance(5 * 60 * 1000 + 1)
  const stats = f.stats(), old = f.gets.at(-1)
  const pending = f.save(editor); f.resolve(f.saves[0], price(3)); await pending; await f.settle()
  f.resolve(old, price(2)); await f.settle()
  assert.match(text(stats.tree), /¥3\.00/)
  const remount = f.stats(); await f.settle(); assert.match(text(remount.tree), /¥3\.00/)
}))

test('P7 Given TTL refresh GET pending, When another editor saves first, Then panel refreshes for mutation', t => withFixture(t, async f => {
  const editor = f.editor(); f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  f.advance(5 * 60 * 1000 + 1); f.panel()
  const before = f.requests.filter(r => r.path.endsWith('/range')).length
  const pending = f.save(editor); f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(f.requests.filter(r => r.path.endsWith('/range')).length, before + 4)
}))

test('P10 Given editor unmount during save, When reply arrives, Then publish without stale state or timer', t => withFixture(t, async f => {
  const stats = f.stats(), editor = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  const before = f.timers.size, pending = f.save(editor); f.unmount(editor)
  f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(f.lateState, 0)
  assert.equal(f.timers.size, before)
  assert.match(text(stats.tree), /¥2\.00/)
}))

test('P11 Given another editor has a draft, When save publishes, Then draft stays unchanged', t => withFixture(t, async f => {
  const a = f.editor(), b = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  const group = () => nodes(b.tree).find(n => n.type?.name === 'PricingModelGroup')
  group().props.onModelChange('draft/model'); await f.settle()
  const pending = f.save(a); f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(group().props.group.model, 'draft/model')
}))

for (const [tab, endpoint] of [['小时', 'hours'], ['分钟', 'minutes']]) {
  test(`P5 Given ${endpoint} view, When save publishes, Then active points refetch once`, t => withFixture(t, async f => {
    const panel = f.panel(), editor = f.editor()
    f.resolve(f.gets[0], price(1)); await f.settle()
    const button = nodes(panel.tree).find(n => n.type === 'button' && text(n) === tab)
    assert.ok(button, tab + '视图按钮'); button.props.onClick(); await f.settle()
    const count = () => f.requests.filter(r => r.path.endsWith('/' + endpoint)).length
    assert.equal(count(), 1)
    const pending = f.save(editor); f.resolve(f.saves[0], price(2)); await pending; await f.settle()
    assert.equal(count(), 2)
  }))
}

test('P10-GET Given consumers unmount with GET pending, When response arrives, Then no stale state is written', t => withFixture(t, async f => {
  const stats = f.stats(), editor = f.editor()
  f.unmount(stats); f.unmount(editor)
  f.resolve(f.gets[0], price(2)); await f.settle()
  assert.equal(f.lateState, 0)
}))

test('P12 Given failed pricing request, When next consumer mounts, Then failed flight is released and retry works', t => withFixture(t, async f => {
  f.stats(); f.gets[0].reject(new Error('injected network')); await f.settle()
  const stats = f.stats(); assert.equal(f.gets.length, 2)
  f.resolve(f.gets[1], price(2)); await f.settle(); assert.match(text(stats.tree), /¥2\.00/)
}))
