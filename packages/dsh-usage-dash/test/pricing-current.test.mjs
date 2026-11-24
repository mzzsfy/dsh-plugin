import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, CLIENT_SOURCE } from './client-eval.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...(node.children ?? []).flatMap(nodes)]
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : (node?.children ?? []).map(text).join('')
const rule = (amount = 1, currency = '¥') => ({ model: '*/*', unit: 'perMillion', currency, price: { input: amount, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] })
const price = (revision, amount = revision) => ({ revision, rules: [rule(amount)] })
const usage = { uncachedInputTokens: 1000 * 1000, inputTokens: 1000 * 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, routes: [{ model: 'p/m' }] }

// 执行真实loader和槽组件,Hook仅模拟状态/依赖/清理,网络为可控边界。
function fixture({ observed = [], timeZone, time = new Date(2026, 10, 24, 9, 0).getTime() } = {}) {
  let current, factory, now = time
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
    const value = path.endsWith('/status') ? { running: false } : { models: observed, daily: [], total: 0, requests: 0, from: '2026-10-01', to: '2026-10-28' }
    return { json: async () => ({ ok: true, value }) }
  }
  const Clock = class extends Date { static now() { return now } }
  new Function('window', 'document', 'fetch', 'localStorage', 'MutationObserver', 'setTimeout', 'clearTimeout', 'Date', CLIENT_SOURCE)(window, document, fetch, null, class { observe() {} disconnect() {} takeRecords() { return [] } }, schedule, id => timers.delete(id), Clock)
  const mod = factory(name => name === 'react' ? hooks : { createPortal: null })
  mod.apply({
    effect: fn => fn(),
    locale: { register() {} },
    // 宿主 client ctx 的反射取服务:本夹具没有 sessions 服务,面板按无子代理数据面降级
    get: () => undefined,
    slots: { inject: (_name, fn) => fn(), register: (entry, component) => slots.set(entry.name, component) },
    configForms: { get: () => ({ getSnapshot: () => ({ value: undefined }), subscribe: () => () => {}, mutate: async () => true }) },
  })
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
  const editor = (tab = '编辑') => {
    const p = panel()
    const section = nodes(p.tree).find(n => n.type?.name === 'PricingSection')
    const holder = mount(section.type, section.props)
    const editorEl = nodes(holder.tree).find(n => n.type?.name === 'PricingEditor')
    const owner = mount(editorEl.type, { ...editorEl.props, open: true, observed, timeZone })
    if (tab) pricingTabs(owner).find(button => text(button) === tab)?.props.onClick()
    render(owner)
    return owner
  }
  const stats = () => mount(slots.get('conversation.composer.dock'), { useProjection: () => usage })
  const chip = () => mount(slots.get('conversation.chat.assistant-actions'), { messageId: 'm1', useChat: select => select({ nodes: [{ kind: 'turn-tail', data: { closing: { finalNode: { messageId: 'm1' } }, tokenUsage: usage } }] }) })
  const resolve = (item, value) => item.resolve({ json: async () => ({ ok: true, value }) })
  const resolveError = (item, message) => item.resolve({ json: async () => ({ ok: false, error: { code: 'unavailable', message } }) })
  const save = owner => {
    const button = nodes(owner.tree).find(n => n.type === 'button' && text(n) === '保存')
    assert.ok(button, '已载入编辑器保存按钮'); return button.props.onClick()
  }
  return { panel, editor, stats, chip, settle, unmount, requests, gets, saves, resolve, resolveError, save, mount, nodes, text, timers,
    get lateState() { return lateState }, advance: ms => { now += ms }, cleanup: () => mounted.filter(o => o.alive).forEach(unmount) }
}

const withFixture = async (t, fn, options) => { const f = fixture(options); t.after(f.cleanup); await fn(f) }

const observedPricingModels = [
  { model: 'p/m', tokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { model: 'q/other', tokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
]

const pricingTabs = owner => nodes(owner.tree).filter(node => node.props.role === 'tab')
const byText = (owner, value) => nodes(owner.tree).find(node => node.type === 'button' && text(node) === value)

test('Given 面板已观察到模型 When 打开定价 Then 模型页签默认选中且可用方向键切换', t => withFixture(t, async f => {
  const editor = f.editor(null)
  f.resolve(f.gets[0], price(1)); await f.settle()
  const tabs = pricingTabs(editor)
  assert.deepEqual(tabs.map(text), ['模型', '规则', '编辑'])
  assert.deepEqual(tabs.map(tab => tab.props.tabIndex), [0, -1, -1])
  tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  await f.settle()
  assert.deepEqual(pricingTabs(editor).map(tab => tab.props['aria-selected']), [false, true, false])
}, { observed: observedPricingModels }))

test('Given 具有附加规则的空兜底草稿 When 保存 Then 提示先填写兜底且不提交', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [EDITOR_RULE] }); await f.settle()
  await f.save(editor); await f.settle()
  assert.equal(f.saves.length, 0)
  assert.match(text(editor.tree), /全局默认价/)
}))

const byComponent = (owner, name) => nodes(owner.tree).find(node => node.type?.name === name)
const expand = (component) => {
  assert.ok(component, '预期视图已渲染')
  return component.type({ ...component.props, children: component.children })
}
const mountView = (fixture, component) => {
  assert.ok(component, '预期视图已渲染')
  return fixture.mount(component.type, { ...component.props, children: component.children })
}

test('Given 聚合返回观察行 When 渲染定价折叠区 Then 将完整观察行透传', t => withFixture(t, async f => {
  const panel = f.panel()
  f.resolve(f.gets[0], price(1)); await f.settle()
  const section = byComponent(panel, 'PricingSection')
  const fold = f.mount(section.type, section.props)
  assert.deepEqual(byComponent(fold, 'PricingEditor').props.observed, observedPricingModels)
}, { observed: observedPricingModels }))

test('Given 已观察组合有分时费率 When 改快照与试探未知型号 Then 使用该时点且列表不加入试探模型', t => withFixture(t, async f => {
  const editor = f.editor('模型')
  const conditional = { ...rule(5), model: 'p/m', conditions: [{ kind: 'dailyWindow', from: '09:00', to: '10:00' }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(1), conditional] }); await f.settle()
  const view = () => mountView(f, byComponent(editor, 'PricingModels')).tree
  assert.match(text(view()), /#2 · 输入 ¥5/)
  assert.match(text(view()), /¥6\.00/)
  byText(editor, '此刻').props.onClick(); await f.settle()
  const clock = nodes(editor.tree).find(node => node.props.type === 'datetime-local')
  clock.props.onChange({ target: { value: '2026-11-24T20:00' } }); await f.settle()
  assert.doesNotMatch(text(view()), /#2 · 输入/)
  assert.match(text(view()), /¥2\.00/)
  const search = nodes(view()).find(node => node.props.type === 'search')
  search.props.onChange({ target: { value: 'unknown/model' } }); await f.settle()
  assert.match(text(view()), /未观察到的型号.*unknown\/model.*#1.*全局默认价/)
  assert.deepEqual(nodes(view()).filter(node => node.type === 'option').map(node => node.props.value), [])
  search.props.onChange({ target: { value: 'p/m' } }); await f.settle()
  assert.deepEqual(nodes(view()).filter(node => node.props['data-ud-price-model']).map(node => node.props['data-ud-price-model']), ['p/m'])
  assert.ok(nodes(view()).some(node => node.type?.name === 'PricingTree'))
}, { observed: observedPricingModels }))

test('Given 宽匹配有四个平台及超长型号列表 When 搜索和翻页 Then 首屏限制渲染且其余型号仍可访问', t => withFixture(t, async f => {
  const editor = f.editor(null)
  f.resolve(f.gets[0], price(1)); await f.settle()
  const initial = mountView(f, byComponent(editor, 'PricingModels'))
  nodes(initial.tree).find(node => node.props.type === 'search').props.onChange({ target: { value: 'flash' } })
  await f.settle()
  const view = mountView(f, byComponent(editor, 'PricingModels'))
  const rows = () => nodes(view.tree).filter(node => node.props['data-ud-price-model']).map(node => node.props['data-ud-price-model'])
  assert.equal(rows().length, 60)
  assert.equal(nodes(view.tree).filter(node => node.type === 'option').length, 40)
  assert.ok(!rows().some(model => model.startsWith('p3/')))
  byText(view, '下一页型号').props.onClick(); await f.settle()
  assert.ok(rows().includes('p0/flash-24'))
  assert.equal(rows().length, 45)
}, {
  observed: Array.from({ length: 100 }, (_, index) => ({
    ...observedPricingModels[0], model: `p${Math.floor(index / 25)}/flash-${index % 25}`,
  })),
}))

test('Given 通配规则被精确规则接管 When 打开会计徽章 Then 先展示实际型号和胜者之后可展开树与跳转', t => withFixture(t, async f => {
  const editor = f.editor('规则')
  const exact = { ...rule(5), model: 'p/m' }
  const pScope = { ...rule(3), model: 'p/*' }
  const providerScope = { ...rule(2), model: 'q/*' }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(1), pScope, providerScope, exact] }); await f.settle()
  const view = mountView(f, byComponent(editor, 'PricingRules'))
  const heads = nodes(view.tree).filter(node => String(node.props?.className ?? '').includes('ud-pricing-rule-head'))
  assert.deepEqual(heads.map(node => text(nodes(node).find(child => child.props?.className === 'ud-pricing-rule-no'))), ['#4', '#1', '#2', '#3'])
  const global = nodes(view.tree).find(node => node.type === 'article' && text(node).includes('*/*'))
  // 零值徽章不是可点对象:没有型号可列时直接不渲染
  assert.equal(nodes({ tree: global }).filter(node => String(node.props?.className ?? '').includes('ud-pricing-chip--button')).length, 0)
  byText({ tree: global }, '被接管 2').props.onClick(); await f.settle()
  const detail = mountView(f, byComponent(view, 'PricingRuleModels'))
  assert.match(text(detail.tree), /p\/m由 #4 计费/)
  assert.match(text(detail.tree), /q\/other由 #3 计费/)
  assert.equal(byComponent(detail, 'PricingTree'), undefined)
  byText(detail, '看规则树').props.onClick(); await f.settle()
  assert.ok(byComponent(detail, 'PricingTree'))
  byText(detail, '跳到模型').props.onClick(); await f.settle()
  const models = mountView(f, byComponent(editor, 'PricingModels')).tree
  assert.equal(nodes(models).find(node => node.props.type === 'search').props.value, 'p/m')
  assert.ok(nodes(models).some(node => node.type?.name === 'PricingTree'))
}, { observed: observedPricingModels }))

test('Given 含时间条件的模式和已有同范围型号 When 批量预览、取消并再次确认 Then 只在显式保存时写入新精确型号', t => withFixture(t, async f => {
  const editor = f.editor()
  const source = { ...rule(7), model: 'p/m*', conditions: [{ kind: 'dailyWindow', from: '09:00', to: '10:00' }] }
  const existing = { ...rule(2), model: 'p/existing' }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), source, existing] }); await f.settle()
  const enterTargets = async () => {
    const group = expand(groupOf(editor, 'p/m*'))
    const card = expand(byComponent({ tree: group }, 'PricingExtraRuleCard'))
    byText({ tree: card }, '批量套用').props.onClick(); await f.settle()
    const batch = mountView(f, byComponent(editor, 'PricingBatch'))
    nodes(batch.tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'existing\nm,m' } })
    await f.settle()
    return batch
  }
  const batch = await enterTargets()
  assert.match(text(batch.tree), /新增 1 条规则，跳过 1 条/)
  assert.match(text(batch.tree), /已有同范围规则，跳过/)
  assert.match(text(batch.tree), /计费 1/)
  byText(batch, '取消').props.onClick(); await f.settle()
  assert.equal(groupOf(editor, 'p/m'), undefined)
  const again = await enterTargets()
  nodes(again.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await f.settle()
  assert.equal(f.saves.length, 0)
  assert.ok(groupOf(editor, 'p/m'))
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.find(item => item.model === 'p/m'), { ...source, model: 'p/m' })
  assert.equal(posted.filter(item => item.model === 'p/existing').length, 1)
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}, { observed: observedPricingModels }))

test('P0 Given 使用统计设置页, When 渲染, Then 显示与增强和定价规则默认折叠且最近开关独立成组', t => withFixture(t, async f => {
  const p = f.panel()
  assert.equal(f.nodes(p.tree).filter(n => n.type?.name === 'StatsLineOptions').length, 1)
  assert.equal(f.nodes(p.tree).filter(n => n.type?.name === 'PricingSection').length, 1)

  const optionsEl = f.nodes(p.tree).find(n => n.type?.name === 'StatsLineOptions')
  const options = f.mount(optionsEl.type)
  const settingsFoldEl = f.nodes(options.tree).find(n => n.type?.name === 'SectionFold')
  assert.equal(settingsFoldEl.props.open, false)
  const settingsFold = f.mount(settingsFoldEl.type, { ...settingsFoldEl.props, children: settingsFoldEl.children })
  assert.equal(settingsFold.tree.children[0].props['aria-expanded'], false)
  assert.equal(settingsFold.tree.children[1].props.hidden, true)
  assert.match(f.text(options.tree), /显示补全/)
  assert.match(f.text(options.tree), /最近请求/)
  assert.ok(f.nodes(options.tree).some(n => n.props?.className === 'ud-pref-group ud-pref-group--recent'))
  settingsFoldEl.props.onToggle()
  await f.settle()
  const settingsFoldOpen = f.nodes(options.tree).find(n => n.type?.name === 'SectionFold')
  assert.equal(settingsFoldOpen.props.open, true)

  const pricingEl = f.nodes(p.tree).find(n => n.type?.name === 'PricingSection')
  const pricing = f.mount(pricingEl.type, pricingEl.props)
  const pricingFoldEl = f.nodes(pricing.tree).find(n => n.type?.name === 'SectionFold')
  assert.equal(pricingFoldEl.props.open, false)
  const pricingFold = f.mount(pricingFoldEl.type, { ...pricingFoldEl.props, children: pricingFoldEl.children })
  assert.equal(pricingFold.tree.children[0].props['aria-expanded'], false)
  assert.equal(pricingFold.tree.children[1].props.hidden, true)
  pricingFoldEl.props.onToggle()
  await f.settle()
  const pricingFoldOpen = f.nodes(pricing.tree).find(n => n.type?.name === 'SectionFold')
  assert.equal(pricingFoldOpen.props.open, true)
}))

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
  const pending = f.save(editor); f.unmount(editor)
  const timersAfterUnmount = [...f.timers.keys()]
  f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(f.lateState, 0)
  assert.deepEqual([...f.timers.keys()], timersAfterUnmount)
  assert.equal(timersAfterUnmount.length, 0)
  assert.match(text(stats.tree), /¥2\.00/)
}))

test('P11 Given another editor has a draft, When save publishes, Then draft stays unchanged', t => withFixture(t, async f => {
  const a = f.editor(), b = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  const group = () => nodes(b.tree).find(n => n.type?.name === 'PricingModelGroup')
  renameGroup(group(), 'draft/model'); await f.settle()
  const pending = f.save(a); f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(group().props.group.model, 'draft/model')
}))

// C2:保存在飞期间同一编辑器继续编辑,服务器返回不能覆盖新输入或冒充已保存
test('C2 Given save in flight When same editor edits Then server reply does not overwrite draft', t => withFixture(t, async f => {
  const editor = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  const group = () => nodes(editor.tree).find(n => n.type?.name === 'PricingModelGroup')
  const pending = f.save(editor)
  renameGroup(group(), 'draft/model'); await f.settle()
  f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(group().props.group.model, 'draft/model')
  assert.doesNotMatch(f.text(editor.tree), /已保存/)
}))

test('C2b Given save in flight When add a model group Then server reply does not remove it', t => withFixture(t, async f => {
  const editor = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  const groups = () => nodes(editor.tree).filter(n => n.type?.name === 'PricingModelGroup')
  const before = groups().length
  const pending = f.save(editor)
  const add = nodes(editor.tree).find(n => n.type === 'button' && text(n) === '添加模型')
  assert.ok(add, '编辑器应提供添加模型按钮')
  add.props.onClick(); await f.settle()
  assert.equal(groups().length, before + 1)
  f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(groups().length, before + 1, '保存回包不得抹掉在飞新增的模型组')
  assert.doesNotMatch(f.text(editor.tree), /已保存/)
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

test('Given 首次加载得到畸形定价 When 展开规则 Then 显示不可用', t => withFixture(t, async f => {
  const editor = f.editor('规则')
  f.resolve(f.gets[0], { revision: 1, rules: [{ model: 'legacy/m' }] }); await f.settle()
  assert.match(text(editor.tree), /定价规则不可用/)
  const retry = byText(editor, '重新加载定价')
  assert.ok(retry)
  retry.props.onClick(); await f.settle()
  f.resolve(f.gets[1], price(2)); await f.settle()
  assert.doesNotMatch(text(editor.tree), /定价规则不可用/)
}))

test('Given 定价已配置 When 用户确认停用 Then 显式保存空规则表', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  const control = nodes(editor.tree).find(node => node.props.labelKey === 'pricing.disable')
  assert.ok(control)
  control.props.onConfirm(); await f.settle()
  assert.equal(f.saves.length, 0)
  const pending = f.save(editor)
  assert.deepEqual(f.saves[0].body.rules, [])
  f.resolve(f.saves[0], { revision: 2, rules: [] }); await pending
}))

test('Given 浏览器开着定价 When 跨过宿主墙钟分钟边界 Then 此刻费率推进且选定快照清理定时器', t => withFixture(t, async f => {
  const editor = f.editor(null)
  const conditional = { ...rule(5), model: 'p/m', conditions: [{ kind: 'dailyWindow', from: '09:00', to: '09:00' }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(1), conditional] }); await f.settle()
  const view = () => mountView(f, byComponent(editor, 'PricingModels')).tree
  assert.match(text(view()), /#2 · 输入 ¥5/)
  byText(editor, '此刻').props.onClick(); await f.settle()
  const clock = () => nodes(editor.tree).find(node => node.props.type === 'datetime-local')
  assert.equal(clock().props.value, '2026-11-24T09:00')
  const next = [...f.timers.values()].find(timer => timer.ms === 1000)
  assert.ok(next, '精确调度到下一分钟')
  f.advance(1000); next.fn(); await f.settle()
  assert.match(text(view()), /#1 · 输入 ¥1/)
  clock().props.onChange({ target: { value: '2026-11-24T09:00' } }); await f.settle()
  assert.match(text(view()), /#2 · 输入 ¥5/)
  assert.equal(f.timers.size, 0)
}, { observed: observedPricingModels, timeZone: 'Asia/Shanghai', time: Date.parse('2026-11-24T01:00:59Z') }))

test('Given 普通规则 When 将平台填成含斜杠的内容 Then 输入保留且无法保存，型号内斜杠仍可保存', t => withFixture(t, async f => {
  const editor = f.editor()
  const exact = { ...rule(3), model: 'p/m' }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), exact] }); await f.settle()
  const fields = () => nodes(expand(groupOf(editor, 'p/m'))).filter(node => node.type === 'input')
  fields()[0].props.onChange({ target: { value: 'p/x' } }); await f.settle()
  assert.deepEqual(fields().map(node => node.props.value), ['p/x', 'm'])
  assert.equal(fields()[0].props['aria-invalid'], true)
  await f.save(editor); assert.equal(f.saves.length, 0)
  fields()[1].props.onChange({ target: { value: 'x/m' } }); await f.settle()
  const corrected = nodes(expand(groupOf(editor, 'p/x/m'))).filter(node => node.type === 'input')
  assert.deepEqual(corrected.map(node => node.props.value), ['p', 'x/m'])
  assert.equal(corrected[0].props['aria-invalid'], false)
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.ok(posted.some(item => item.model === 'p/x/m'))
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

test('Given 规则已有型号 When 新组中途输入相同范围与全局模式 Then 组保持独立且可继续修正', t => withFixture(t, async f => {
  const editor = f.editor()
  const exact = { ...rule(3), model: 'p/m' }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), exact] }); await f.settle()
  byText(editor, '添加模型').props.onClick(); await f.settle()
  const added = groupOf(editor, '')
  const newGroup = () => editorGroups(editor).find(group => group.props.key === added.props.key)
  renameGroup(newGroup(), 'p/m'); await f.settle()
  assert.equal(editorGroups(editor).filter(group => group.props.group.model === 'p/m').length, 2)
  await f.save(editor); assert.equal(f.saves.length, 0)
  renameGroup(newGroup(), '*/*'); await f.settle()
  const field = nodes(expand(newGroup())).find(node => node.type === 'input')
  assert.equal(field.props.readOnly, false)
  renameGroup(newGroup(), 'p/mo'); await f.settle()
  assert.ok(groupOf(editor, 'p/m'))
  assert.ok(groupOf(editor, 'p/mo'))
}))

test('Given 批量加入的型号已改名 When 再批量添加原型号 Then 两个草稿保有独立分组', t => withFixture(t, async f => {
  const editor = f.editor()
  const source = { ...rule(3), model: 'p/*' }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), source] }); await f.settle()
  const add = async () => {
    const group = expand(groupOf(editor, 'p/*'))
    byText({ tree: group }, '批量套用').props.onClick(); await f.settle()
    const batch = mountView(f, byComponent(editor, 'PricingBatch'))
    nodes(batch.tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'm' } }); await f.settle()
    nodes(batch.tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await f.settle()
  }
  await add()
  renameGroup(groupOf(editor, 'p/m'), 'p/n'); await f.settle()
  await add()
  assert.equal(groupOf(editor, 'p/m').props.group.slots.length, 1)
  assert.equal(groupOf(editor, 'p/n').props.group.slots.length, 1)
  assert.equal(f.saves.length, 0)
}))

test('Given 组内两条附加规则 When 移除第一条 Then 第二条保留自身删除确认身份', t => withFixture(t, async f => {
  const editor = f.editor()
  const earlier = { ...rule(2), model: 'p/m', conditions: [{ kind: 'weekdays', days: [1] }] }
  const later = { ...rule(3), model: 'p/m', conditions: [{ kind: 'weekdays', days: [2] }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), earlier, later] }); await f.settle()
  const cards = () => nodes(expand(groupOf(editor, 'p/m'))).filter(node => node.type?.name === 'PricingExtraRuleCard')
  const [first, second] = cards()
  const remove = byComponent({ tree: expand(first) }, 'DeleteArmedButton')
  remove.props.onConfirm(); await f.settle()
  assert.equal(cards().length, 1)
  assert.equal(cards()[0].props.rule.price.input, 3)
  assert.equal(cards()[0].props.key, second.props.key)
  assert.notEqual(cards()[0].props.key, first.props.key)
}))

test('Given 月中号段 When 修改数字字段并保存 Then 请求仍使用现有 monthDays 协议和数字端点', t => withFixture(t, async f => {
  const editor = f.editor()
  const monthly = { ...rule(3), model: 'p/m', conditions: [{ kind: 'monthDays', from: 1, to: 31 }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), monthly] }); await f.settle()
  const card = () => expand(byComponent({ tree: expand(groupOf(editor, 'p/m')) }, 'PricingExtraRuleCard'))
  nodes(card()).find(node => node.type === 'input' && node.props.max === 31 && node.props.value === 1)
    .props.onChange({ target: { value: '26' } })
  await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.find(item => item.model === 'p/m').conditions, [{ kind: 'monthDays', from: 26, to: 31 }])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

test('Given 存量规则缺省条件字段 When 保存 Then 继续视为无条件规则', t => withFixture(t, async f => {
  const editor = f.editor()
  const legacy = { ...rule(), conditions: null }
  f.resolve(f.gets[0], { revision: 1, rules: [legacy] }); await f.settle()
  const pending = f.save(editor)
  assert.equal(f.saves.length, 1)
  assert.deepEqual(f.saves[0].body.rules[0].conditions, [])
  f.resolve(f.saves[0], price(2)); await pending
}))

test('Given 空安装 When 显式填写四个零价 Then 保存真实零价而非剔除它', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [] }); await f.settle()
  for (const label of ['输入', '输出', '缓存读', '缓存写']) {
    const grid = expand(byComponent({ tree: expand(groupOf(editor, '*/*')) }, 'PricingPriceGrid'))
    const field = nodes(grid).find(node => node.type === 'label' && text(node).startsWith(label))
    assert.ok(field, label)
    nodes(field).find(node => node.type === 'input').props.onChange({ target: { value: '0' } })
    await f.settle()
  }
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted, [{ model: '*/*', currency: '¥', price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] }])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

test('Given 畸形存量规则导致定价不可用 When 确认重置 Then 提交空表并恢复编辑', t => withFixture(t, async f => {
  const editor = f.editor('规则')
  f.resolve(f.gets[0], { revision: 1, rules: [{ model: 'legacy/m' }] }); await f.settle()
  const reset = nodes(editor.tree).find(node => node.props.labelKey === 'pricing.reset')
  assert.ok(reset, '不可用态需提供清空空表的出口')
  reset.props.onConfirm(); await f.settle()
  assert.equal(f.saves.length, 1)
  assert.deepEqual(f.saves[0].body.rules, [])
  f.resolve(f.saves[0], { revision: 2, rules: [] }); await f.settle()
  // 写回后直接进入可用态,不再二次取价,避免用未解析的回包掩盖恢复失败
  assert.equal(f.gets.length, 1)
  assert.doesNotMatch(text(editor.tree), /定价规则不可用/)
  // 恢复后规则页应回到正常空表视图
  assert.match(text(mountView(f, byComponent(editor, 'PricingRules')).tree), /未配置/)
}))

test('Given 定价请求失败且无缓存 When 显示不可用 Then 不提供清空出口', t => withFixture(t, async f => {
  const editor = f.editor('规则')
  f.gets[0].reject(new Error('injected network')); await f.settle()
  assert.match(text(editor.tree), /定价规则不可用/)
  assert.ok(byText(editor, '重新加载定价'))
  assert.equal(nodes(editor.tree).some(node => node.props.labelKey === 'pricing.reset'), false)
}))

test('Given 先请求失败后回包畸形 When 重新加载 Then 才出现清空出口', t => withFixture(t, async f => {
  const editor = f.editor('规则')
  f.gets[0].reject(new Error('injected network')); await f.settle()
  assert.equal(nodes(editor.tree).some(node => node.props.labelKey === 'pricing.reset'), false)
  nodes(editor.tree).find(node => node.type === 'button' && text(node) === '重新加载定价').props.onClick()
  await f.settle()
  assert.equal(f.gets.length, 2)
  f.resolve(f.gets[1], { revision: 1, rules: [{ model: 'legacy/m' }] }); await f.settle()
  assert.match(text(editor.tree), /定价规则不可用/)
  assert.ok(nodes(editor.tree).some(node => node.props.labelKey === 'pricing.reset'), '畸形回包应给出自救出口')
}))

test('Given 清空请求失败 When 确认重置 Then 提示错误并留在不可用态', t => withFixture(t, async f => {
  const editor = f.editor('规则')
  f.resolve(f.gets[0], { revision: 1, rules: [{ model: 'legacy/m' }] }); await f.settle()
  nodes(editor.tree).find(node => node.props.labelKey === 'pricing.reset').props.onConfirm(); await f.settle()
  f.resolveError(f.saves[0], 'usage stats: pricing unavailable'); await f.settle()
  assert.match(text(editor.tree), /pricing unavailable/)
  assert.match(text(editor.tree), /定价规则不可用/)
}))

// 组卡 memo 判等:依赖草稿规则对象不可变,逐槽比 rule 引用覆盖字段变化
const groupPropsEqual = new Function(`${CLIENT_BODY}\nreturn pricingGroupPropsEqual`)()

test('Given 组卡 memo 判等 When 依赖变化 Then 只在必要时重渲染', () => {
  const rule = { model: 'a/b', price: { input: 1 }, conditions: [] }
  const base = {
    currency: '¥', errors: new Map(), t: () => '', actions: {},
    group: { id: 'g', model: 'a/b', slots: [{ rule, index: 0, id: 's0' }] },
  }
  const withGroup = (group) => ({ ...base, group })
  assert.equal(groupPropsEqual(base, { ...base }), true, '同引用不重渲染')
  assert.equal(groupPropsEqual(base, { ...base, currency: '$' }), false)
  assert.equal(groupPropsEqual(base, { ...base, errors: new Map() }), false)
  assert.equal(groupPropsEqual(base, { ...base, t: () => '' }), false)
  assert.equal(groupPropsEqual(base, { ...base, actions: {} }), false)
  assert.equal(groupPropsEqual(base, withGroup({ ...base.group, slots: [{ rule: { ...rule }, index: 0, id: 's0' }] })), false, '规则新对象即内容变化')
  assert.equal(groupPropsEqual(base, withGroup({ ...base.group, slots: [{ rule, index: 1, id: 's0' }] })), false, '编号位移需重渲染')
  assert.equal(groupPropsEqual(base, withGroup({ ...base.group, slots: [{ rule, index: 0, id: 's0' }, { rule: { ...rule }, index: 1, id: 's1' }] })), false, '增删槽位')
})

const EDITOR_RULE = {
  model: 'a/b',
  unit: 'perMillion',
  currency: '¥',
  price: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
  conditions: [{ kind: 'weekdays', days: [1] }],
}
const editorGroups = editor => nodes(editor.tree)
  .filter(node => node.type?.name === 'PricingModelGroup')
const groupOf = (editor, model) => editorGroups(editor).find(node => node.props.group.model === model)
const renameGroup = (group, model) => group.props.actions.rename(group.props.group.id, model)

test('P13 Given 无 */* 规则 When 编辑器加载 Then 末尾合成锁定且不可删除的全局槽', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [EDITOR_RULE] }); await f.settle()
  const global = groupOf(editor, '*/*')
  assert.ok(global, '缺少合成 */* 组')
  assert.equal(editorGroups(editor).at(-1).props.group.model, '*/*')
  assert.equal(global.props.group.slots.length, 1)
  assert.deepEqual(global.props.group.slots[0].rule.conditions, [])
  const rendered = global.type(global.props)
  const patterns = nodes(rendered).filter(node => node.type === 'input' && node.props.value === '*')
  assert.deepEqual(patterns.map((input) => input.props.readOnly), [true, true])
  assert.deepEqual(global.props.group.slots[0].rule.price, { input: '', output: '', cacheRead: '', cacheWrite: '' })
  assert.equal(nodes(rendered).filter(node => node.type?.name === 'DeleteArmedButton').length, 0)
}))

test('P14 Given 空表合成 */* 槽未填价 When 保存 Then 发送空表且保存后仍可见', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [] }); await f.settle()
  const pending = f.save(editor)
  assert.deepEqual(f.saves[0].body.rules, [])
  f.resolve(f.saves[0], { revision: 2, rules: [] }); await pending; await f.settle()
  assert.ok(groupOf(editor, '*/*'), '保存后合成槽应继续可见')
}))

test('P15 Given 无默认价的模型组 When 点添加默认价 Then 新槽无条件并成为默认槽', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [EDITOR_RULE] }); await f.settle()
  const group = groupOf(editor, 'a/b')
  const rendered = group.type(group.props)
  const add = nodes(rendered).find(node => node.type === 'button' && text(node) === '添加默认价')
  assert.ok(add, '无默认价组应提供添加默认价按钮')
  add.props.onClick(); await f.settle()
  const updated = groupOf(editor, 'a/b')
  const { defaultSlot } = corePartition(updated.props.group)
  assert.ok(defaultSlot)
  assert.deepEqual(defaultSlot.rule.conditions, [])
}))

test('P16 Given 附加规则仅一条条件 When 渲染 Then 删除条件按钮隐藏', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [EDITOR_RULE] }); await f.settle()
  const group = groupOf(editor, 'a/b')
  const rendered = group.type(group.props)
  const card = nodes(rendered).find(node => node.type?.name === 'PricingExtraRuleCard')
  assert.ok(card, '组内应有附加规则卡')
  const cardTree = card.type(card.props)
  assert.equal(nodes(cardTree).filter(node => node.type === 'button'
    && node.props['aria-label'] === '删除条件').length, 0)
}))

// 取编辑器同源分区函数:测试不重新实现判定,实现变更后断言同步失效而非假通过
const corePartition = new Function(`${CLIENT_BODY}\nreturn partitionGroupOf`)()
