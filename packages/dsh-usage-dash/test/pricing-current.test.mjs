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
  const editor = (tab = '规则视图') => {
    const p = panel()
    const section = nodes(p.tree).find(n => n.type?.name === 'PricingSection')
    const holder = mount(section.type, section.props)
    const editorEl = nodes(holder.tree).find(n => n.type?.name === 'PricingEditor')
    const owner = mount(editorEl.type, { ...editorEl.props, open: true, observed, timeZone })
    if (tab) pricingTabs(owner).find(button => text(button) === tab)?.props.onClick()
    render(owner)
    return owner
  }
  const openCreate = (owner) => {
    const button = byText(owner, '新增规则')
    assert.ok(button, '规则视图应提供新增规则入口')
    button.props.onClick(); render(owner)
    return owner
  }
  const openEdit = (owner, model) => {
    const rendered = mountView({ mount }, byComponent(owner, 'PricingRules'))
    const row = nodes(rendered.tree).find(node => node.type === 'article' && nodes(node).some(child =>
      child.props.className === 'ud-pricing-rule-model' && text(child) === model))
    assert.ok(row, `规则行应存在: ${model}; got ${nodes(rendered.tree).filter(n => n.props?.className === 'ud-pricing-rule-model').map(n => text(n)).join(',')}`)
    const button = nodes(row).find(node => node.type === 'button' && node.props['aria-label']?.startsWith('编辑规则 #'))
    assert.ok(button, `规则行应提供编辑规则入口: ${model}`)
    button.props.onClick(); render(owner)
    return owner
  }
  const stats = () => mount(slots.get('conversation.composer.dock'), { useProjection: () => usage })
  const chip = () => mount(slots.get('conversation.chat.assistant-actions'), { messageId: 'm1', useChat: select => select({ nodes: [{ kind: 'turn-tail', data: { closing: { finalNode: { messageId: 'm1' } }, tokenUsage: usage } }] }) })
  const resolve = (item, value) => item.resolve({ json: async () => ({ ok: true, value }) })
  const resolveError = (item, message) => item.resolve({ json: async () => ({ ok: false, error: { code: 'unavailable', message } }) })
  const save = owner => {
    const button = byText(owner, '保存')
    assert.ok(button, '已载入编辑器保存按钮'); return button.props.onClick()
  }
  return { panel, editor, openCreate, openEdit, stats, chip, settle, unmount, requests, gets, saves, resolve, resolveError, save, mount, nodes, text, timers,
    get lateState() { return lateState }, advance: ms => { now += ms }, cleanup: () => mounted.filter(o => o.alive).forEach(unmount) }
}

const withFixture = async (t, fn, options) => { const f = fixture(options); t.after(f.cleanup); await fn(f) }

const observedPricingModels = [
  { model: 'p/m', tokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { model: 'q/other', tokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
]

const pricingTabs = owner => nodes(owner.tree).filter(node => node.props.role === 'tab')
const byText = (owner, value) => {
  const form = byComponent(owner, 'PricingRuleForm')
  return nodes(form ? expand(form) : owner.tree).find(node => node.type === 'button' && text(node) === value)
}

test('Given 面板已观察到模型 When 打开定价 Then 模型视图页签默认选中且可用方向键切换', t => withFixture(t, async f => {
  const editor = f.editor(null)
  f.resolve(f.gets[0], price(1)); await f.settle()
  const tabs = pricingTabs(editor)
  assert.deepEqual(tabs.map(text), ['模型视图', '规则视图'])
  assert.deepEqual(tabs.map(tab => tab.props.tabIndex), [0, -1])
  tabs[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  await f.settle()
  assert.deepEqual(pricingTabs(editor).map(tab => tab.props['aria-selected']), [false, true])
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
const formTree = editor => expand(byComponent(editor, 'PricingRuleForm'))
const ruleFields = editor => ({ tree: expand(byComponent({ tree: formTree(editor) }, 'PricingRuleFields')) })
// 单规则表单内价格分多层:默认层无条件恒生效,时段层按条件覆盖;层片是组件元素,需展开才能取到四桶与条件
const layerNodes = editor => nodes(ruleFields(editor).tree).filter(node => node.type?.name === 'PricingLayerBlock')
const layerRule = node => node.props.rule
const isDefaultLayerRule = rule => !(rule.conditions ?? []).length
const defaultLayerNode = editor => layerNodes(editor).find(node => isDefaultLayerRule(layerRule(node))) ?? null
const timedLayerNodes = editor => layerNodes(editor).filter(node => !isDefaultLayerRule(layerRule(node)))
const editingLayer = (editor, index) => {
  const layer = layerNodes(editor)[index]
  assert.ok(layer, `应有价格层: ${index}; got ${layerNodes(editor).length}`)
  return layer
}
const conditionFields = (editor, index = 0) => {
  const layer = timedLayerNodes(editor)[index]
  assert.ok(layer, `应有时段层: ${index}; got ${timedLayerNodes(editor).length}`)
  return { tree: expand(byComponent({ tree: expand(layer) }, 'PricingConditions')) }
}
const priceGrid = (editor, layer) => {
  const node = layer ?? defaultLayerNode(editor) ?? layerNodes(editor)[0]
  assert.ok(node, '应有可编辑的价格层')
  return { tree: expand(byComponent({ tree: expand(node) }, 'PricingPriceGrid')) }
}
const removeLayerButton = (editor, index) => {
  const layer = editingLayer(editor, index)
  const button = nodes(expand(layer)).find(node => node.type === 'button' && node.props['aria-label'] === '删除这一层')
  assert.ok(button, `价格层应提供删除入口: ${index}`)
  return button
}
const inputByLabel = (owner, label) => {
  const field = nodes(owner.tree).find(node => node.type?.name === 'PricingSuggestInput'
    ? node.props.label === label
    : node.type === 'label' && node.children.some(child => text(child) === label))
  if (field?.type?.name === 'PricingSuggestInput') {
    return { props: {
      value: field.props.value,
      onChange: (event) => field.props.onChange(typeof event === 'string' ? event : event.target.value),
      readOnly: field.props.readOnly, placeholder: field.props.placeholder,
      'aria-invalid': Boolean(field.props.invalid),
    } }
  }
  const input = nodes(field).find(node => node.type === 'input')
  assert.ok(input, `应显示输入字段：${label}`)
  return input
}
const providerPattern = editor => inputByLabel(ruleFields(editor), '平台模式')
const modelPattern = editor => inputByLabel(ruleFields(editor), '型号模式')
const priceInput = (editor, label = '输入') => inputByLabel(priceGrid(editor), label)
const extraFields = editor => {
  const component = byComponent(ruleFields(editor), 'PricingExtraModels')
  return component ? { tree: expand(component) } : { tree: [] }
}
const extraModelInput = (editor, index) => {
  const input = nodes(extraFields(editor).tree).find(node => node.type?.name === 'PricingSuggestInput'
    && node.props.inputProps?.['data-ud-extra-model'] === index)
  assert.ok(input, `应显示额外型号输入：${index}`)
  return { props: {
    value: input.props.value,
    onChange: (event) => input.props.onChange(typeof event === 'string' ? event : event.target.value),
    readOnly: input.props.readOnly,
  } }
}
const changeInput = (input, value) => {
  assert.equal(Boolean(input.props.readOnly || input.props.disabled), false, '输入字段应可编辑')
  input.props.onChange({ target: { value } })
}
const enterPattern = async (f, editor, provider, model) => {
  changeInput(providerPattern(editor), provider); await f.settle()
  changeInput(modelPattern(editor), model); await f.settle()
}

test('Given 有具体型号规则但无观察行 When 渲染定价折叠区 Then 用规则型号填充模型视图', t => withFixture(t, async f => {
  const panel = f.panel()
  f.resolve(f.gets[0], { revision: 1, rules: [{ ...rule(5), model: 'p/m' }] }); await f.settle()
  const section = byComponent(panel, 'PricingSection')
  const fold = f.mount(section.type, section.props)
  assert.deepEqual(byComponent(fold, 'PricingEditor').props.observed, [{ model: 'p/m' }])
}, { observed: [] }))

test('Given 模型视图有定价行 When 渲染 Then 色块沿用规则视图标记色', t => withFixture(t, async f => {
  const editor = f.editor('模型视图')
  f.resolve(f.gets[0], { revision: 1, rules: [{ ...rule(5), model: 'p/m' }] }); await f.settle()
  const view = mountView(f, byComponent(editor, 'PricingModels')).tree
  const swatch = nodes(view).find(node => node.props.className === 'ud-model-swatch')
  assert.equal(swatch.props.style.background, 'var(--dsw-alias-state-business-primary)')
}, { observed: [{ model: 'p/m' }] }))

test('Given 已有观察行且规则另有具体型号 When 渲染定价折叠区 Then 合并配置型号', t => withFixture(t, async f => {
  const panel = f.panel()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(5), { ...rule(6), model: 'Alpha/sonnet-4.5' }] }); await f.settle()
  const section = byComponent(panel, 'PricingSection')
  const fold = f.mount(section.type, section.props)
  assert.deepEqual(
    byComponent(fold, 'PricingEditor').props.observed.map((row) => row.model),
    ['p/m', 'q/other', 'Alpha/sonnet-4.5'],
  )
}, { observed: observedPricingModels }))

test('Given 聚合返回观察行 When 渲染定价折叠区 Then 将完整观察行透传', t => withFixture(t, async f => {
  const panel = f.panel()
  f.resolve(f.gets[0], price(1)); await f.settle()
  const section = byComponent(panel, 'PricingSection')
  const fold = f.mount(section.type, section.props)
  assert.deepEqual(byComponent(fold, 'PricingEditor').props.observed, observedPricingModels)
}, { observed: observedPricingModels }))

test('Given 已观察组合有分时费率 When 改快照与试探未知型号 Then 使用该时点且列表不加入试探模型', t => withFixture(t, async f => {
  const editor = f.editor('模型视图')
  const conditional = { ...rule(5), model: 'p/m', conditions: [{ kind: 'dailyWindow', from: '09:00', to: '10:00' }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(1), conditional] }); await f.settle()
  const view = () => mountView(f, byComponent(editor, 'PricingModels')).tree
  assert.match(text(view()), /#2 · 输入 ¥5/)
  nodes(view()).find(node => node.type === 'button' && node.props['aria-controls']?.endsWith('-clock')).props.onClick(); await f.settle()
  const clock = nodes(view()).find(node => node.props.type === 'datetime-local')
  clock.props.onChange({ target: { value: '2026-11-24T20:00' } }); await f.settle()
  assert.doesNotMatch(text(view()), /#2 · 输入/)
  assert.match(text(view()), /#1 · 输入 ¥1/)
  const search = nodes(view()).find(node => node.props.type === 'search')
  search.props.onChange({ target: { value: 'unknown/model' } }); await f.settle()
  const result = view()
  const probe = nodes(result).find(node => node.type === 'button' && node.props['data-ud-price-model'] === 'unknown/model')
  assert.match(text(result), /未观察到的型号/)
  assert.match(text(probe), /全局默认价/)
  assert.match(text(probe), /#1 · 输入 ¥1/)
  assert.deepEqual(nodes(result).filter(node => node.type === 'option').map(node => node.props.value), [])
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
  const editor = f.editor('规则视图')
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
  f.openEdit(b, '*/*'); await f.settle()
  changeInput(priceInput(b), '7'); await f.settle()
  f.openEdit(a, '*/*'); await f.settle()
  changeInput(priceInput(a), '2'); await f.settle()
  const pending = f.save(a); f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(priceInput(b).props.value, '7')
}))

// C2:保存在飞期间同一编辑器继续编辑,服务器返回不能覆盖新输入或冒充已保存
test('C2 Given save in flight When same editor edits Then server reply does not overwrite draft', t => withFixture(t, async f => {
  const editor = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  f.openEdit(editor, '*/*'); await f.settle()
  changeInput(priceInput(editor), '2'); await f.settle()
  const pending = f.save(editor)
  assert.equal(f.saves[0].body.rules[0].price.input, 2)
  changeInput(priceInput(editor), '7'); await f.settle()
  f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.doesNotMatch(text(editor.tree), /已保存/)
  if (!byComponent(editor, 'PricingRuleForm')) f.openEdit(editor, '*/*')
  assert.equal(priceInput(editor).props.value, '7', '回包不得覆盖在飞改价')
}))

test('C2b Given save in flight When add a rule Then server reply does not remove it', t => withFixture(t, async f => {
  const editor = f.editor()
  f.gets.forEach(item => f.resolve(item, price(1))); await f.settle()
  const pending = f.save(editor)
  f.openCreate(editor); await f.settle()
  assert.equal(byComponent(editor, 'PricingRuleForm')?.props.creating, true, '在飞新增应打开单规则表单')
  f.resolve(f.saves[0], price(2)); await pending; await f.settle()
  assert.equal(byComponent(editor, 'PricingRuleForm')?.props.creating, true, '保存回包不得抹掉在飞新增的规则')
  assert.equal(modelPattern(editor).props.value, '')
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
  const editor = f.editor('规则视图')
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
  const rules = nodes(editor.tree).find(node => node.type?.name === 'PricingRules')
  const control = nodes(rules?.props.footer).find(node => node.props.labelKey === 'pricing.disable')
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
  nodes(view()).find(node => node.type === 'button' && node.props['aria-controls']?.endsWith('-clock')).props.onClick(); await f.settle()
  const clock = () => nodes(view()).find(node => node.props.type === 'datetime-local')
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
  f.openEdit(editor, 'p/m'); await f.settle()
  changeInput(providerPattern(editor), 'p/x'); await f.settle()
  assert.deepEqual([providerPattern(editor).props.value, modelPattern(editor).props.value], ['p/x', 'm'])
  assert.equal(providerPattern(editor).props['aria-invalid'], true)
  await f.save(editor); await f.settle()
  assert.equal(f.saves.length, 0)
  changeInput(modelPattern(editor), 'x/m'); await f.settle()
  assert.deepEqual([providerPattern(editor).props.value, modelPattern(editor).props.value], ['p', 'x/m'])
  assert.equal(providerPattern(editor).props['aria-invalid'], false)
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.ok(posted.some(item => item.model === 'p/x/m'))
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

// 新语义:平台/型号属于整组(一个模型 = 一条规则),改名作用于该模型的所有价格层,
// 不再存在「只改同型号其中一条规则」的入口。
test('Given 同型号两层价格 When 修改型号并保存 Then 该组所有层同步改名且各层数据保持', t => withFixture(t, async f => {
  const editor = f.editor()
  const original = { ...rule(3), model: 'p/m' }
  const conditional = { ...rule(5), model: 'p/m', conditions: [{ kind: 'weekdays', days: [1] }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), original, conditional] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  assert.deepEqual(layerNodes(editor).map(node => node.props.rule.price.input), [3, 5], '编辑态收拢该模型的全部层')
  changeInput(modelPattern(editor), 'other'); await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.map(item => item.model), ['*/*', 'p/other', 'p/other'], '型号作用于整组,各层一起改名')
  assert.deepEqual(posted.filter(item => item.model === 'p/other').map(item => [item.price.input, item.conditions.length]), [[3, 0], [5, 1]])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

// 新语义:同范围的两层由「+ 添加时段价」在既有默认价上扩展,而非再建一条同型号规则
// (新建同型号规则会得到第二条默认价,保存时按重复默认价拦截,见下一条用例)。
test('Given 已有精确型号默认价 When 添加时段价 Then 默认层与时段层并存为两层', t => withFixture(t, async f => {
  const editor = f.editor()
  const exact = { ...rule(3), model: 'p/m' }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), exact] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  byText(ruleFields(editor), '+ 添加时段价').props.onClick(); await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  const layers = posted.filter(item => item.model === 'p/m')
  assert.deepEqual(layers.map(item => item.conditions.length).sort(), [0, 1], '默认层与时段层并存为两层')
  assert.equal(layers.find(item => item.conditions.length).price.input, 3, '新时段层价格照抄默认层')
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

// 新语义:把时段层的条件全部删掉后该层即成为默认价,与同型号已有默认价冲突,保存被拦截。
test('Given 已有默认价 When 新增同型号并删掉时段层条件 Then 保存判重复', t => withFixture(t, async f => {
  const editor = f.editor()
  const exact = { ...rule(3), model: 'p/m' }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), exact] }); await f.settle()
  f.openCreate(editor); await f.settle()
  await enterPattern(f, editor, 'p', 'm')
  const remove = nodes(conditionFields(editor).tree).find(node => node.type === 'button' && node.props['aria-label'] === '删除条件')
  assert.ok(remove, '时段层需能删掉默认时段条件')
  remove.props.onClick(); await f.settle()
  await f.save(editor); await f.settle()
  assert.equal(f.saves.length, 0, '删掉条件后该层成为默认价,与已有默认价重复应拦截')
}))

// 新语义:删除单层走层头的「删除这一层」,「删除计费规则」删的是整个模型组。
test('Given 同型号两条时段价 When 删除其中一层 Then 另一层保留自身数据', t => withFixture(t, async f => {
  const editor = f.editor()
  const earlier = { ...rule(2), model: 'p/m', conditions: [{ kind: 'weekdays', days: [1] }] }
  const later = { ...rule(3), model: 'p/m', conditions: [{ kind: 'weekdays', days: [2] }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), earlier, later] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  // 只有时段层的存量会补一条默认价层,默认层在首位且不可删
  assert.deepEqual(layerNodes(editor).map(node => node.props.rule.price.input), [2, 2, 3])
  removeLayerButton(editor, 1).props.onClick(); await f.settle()
  assert.deepEqual(layerNodes(editor).map(node => node.props.rule.price.input), [2, 3], '只删掉被点的这一层')
  assert.equal(priceInput(editor).props.value, 2)
  const activeDay = nodes(conditionFields(editor).tree).find(node => node.type === 'button' && node.props['aria-pressed'] === true)
  assert.equal(text(activeDay), '二')
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  const layers = posted.filter(item => item.model === 'p/m').map(item => [item.price.input, item.conditions])
  assert.equal(layers.length, 2, '默认价层与剩余时段层各一条')
  assert.ok(layers.some(([input, conditions]) => input === 2 && conditions.length === 0), '默认价保留')
  assert.ok(layers.some(([input, conditions]) => input === 3 && conditions[0].days[0] === 2), '另一层数据不变')
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

test('Given 月中号段 When 修改数字字段并保存 Then 请求仍使用现有 monthDays 协议和数字端点', t => withFixture(t, async f => {
  const editor = f.editor()
  const monthly = { ...rule(3), model: 'p/m', conditions: [{ kind: 'monthDays', from: 1, to: 31 }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), monthly] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  assert.equal(inputByLabel(conditionFields(editor), '从').props.placeholder, '1')
  assert.equal(inputByLabel(conditionFields(editor), '至').props.placeholder, '31')
  changeInput(inputByLabel(conditionFields(editor), '从'), '26')
  await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.find(item => item.model === 'p/m').conditions, [{ kind: 'monthDays', from: 26, to: 31 }])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

test('Given 日期段条件 When 渲染 Then 日期输入显示日期格式占位', t => withFixture(t, async f => {
  const editor = f.editor()
  const dated = { ...rule(3), model: 'p/m', conditions: [{ kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), dated] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  assert.equal(inputByLabel(conditionFields(editor), '从').props.placeholder, 'YYYY-MM-DD')
  assert.equal(inputByLabel(conditionFields(editor), '至').props.placeholder, 'YYYY-MM-DD')
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
  f.openEdit(editor, '*/*'); await f.settle()
  assert.equal(priceInput(editor, '输入').props.placeholder, '0')
  for (const label of ['输入', '输出', '缓存读', '缓存写']) {
    changeInput(priceInput(editor, label), '0'); await f.settle()
  }
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted, [{ model: '*/*', currency: '¥', price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] }])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

test('Given 畸形存量规则导致定价不可用 When 确认重置 Then 提交空表并恢复编辑', t => withFixture(t, async f => {
  const editor = f.editor('规则视图')
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
  // 恢复后规则页应回到正常空表视图:只剩可编辑的全局默认价
  assert.match(text(mountView(f, byComponent(editor, 'PricingRules')).tree), /全局默认价/)
}))

test('Given 定价请求失败且无缓存 When 显示不可用 Then 不提供清空出口', t => withFixture(t, async f => {
  const editor = f.editor('规则视图')
  f.gets[0].reject(new Error('injected network')); await f.settle()
  assert.match(text(editor.tree), /定价规则不可用/)
  assert.ok(byText(editor, '重新加载定价'))
  assert.equal(nodes(editor.tree).some(node => node.props.labelKey === 'pricing.reset'), false)
}))

test('Given 先请求失败后回包畸形 When 重新加载 Then 才出现清空出口', t => withFixture(t, async f => {
  const editor = f.editor('规则视图')
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
  const editor = f.editor('规则视图')
  f.resolve(f.gets[0], { revision: 1, rules: [{ model: 'legacy/m' }] }); await f.settle()
  nodes(editor.tree).find(node => node.props.labelKey === 'pricing.reset').props.onConfirm(); await f.settle()
  f.resolveError(f.saves[0], 'usage stats: pricing unavailable'); await f.settle()
  assert.match(text(editor.tree), /pricing unavailable/)
  assert.match(text(editor.tree), /定价规则不可用/)
}))

const EDITOR_RULE = {
  model: 'a/b',
  unit: 'perMillion',
  currency: '¥',
  price: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
  conditions: [{ kind: 'weekdays', days: [1] }],
}
test('P13 Given 无 */* 规则 When 编辑器加载 Then 列表末尾显示合成全局默认价且不可删除', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [EDITOR_RULE] }); await f.settle()
  const list = mountView(f, byComponent(editor, 'PricingRules'))
  const rows = nodes(list.tree).filter(node => node.type === 'article')
  assert.match(text(rows.at(-1)), /\*\/\*全局默认价/)
  f.openEdit(editor, '*/*'); await f.settle()
  assert.deepEqual([providerPattern(editor), modelPattern(editor)].map(input => [input.props.value, input.props.readOnly]), [['*', true], ['*', true]])
  assert.deepEqual(['输入', '输出', '缓存读', '缓存写'].map(label => priceInput(editor, label).props.value), ['', '', '', ''])
  const layers = layerNodes(editor)
  assert.equal(layers.length, 1, '合成全局默认价只有默认层')
  assert.match(text(expand(layers[0])), /默认价/)
  assert.equal(nodes(expand(layers[0])).some(node => node.type?.name === 'PricingConditions'), false)
  assert.equal(nodes(expand(layers[0])).some(node => node.props?.['aria-label'] === '删除这一层'), false, '默认层不渲染层删除入口')
  const form = { tree: formTree(editor) }
  assert.ok(byText(form, '保存'), '应在实际编辑表单内检查删除入口')
  assert.equal(byComponent(form, 'DeleteArmedButton'), undefined, '全局默认价表单不应渲染删除控件')
  assert.equal(byText(form, '删除计费规则'), undefined)
}))

test('P14 Given 空表合成 */* 规则未填价 When 保存 Then 发送空表且保存后仍可见', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [] }); await f.settle()
  const pending = f.save(editor)
  assert.deepEqual(f.saves[0].body.rules, [])
  f.resolve(f.saves[0], { revision: 2, rules: [] }); await pending; await f.settle()
  assert.match(text(mountView(f, byComponent(editor, 'PricingRules')).tree), /全局默认价/, '保存后合成规则应继续可见')
}))

test('Given 定价表单 When 渲染 Then 平台与型号输入显示带 * 的示例', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), { ...rule(2), model: 'p/m' }] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  assert.equal(providerPattern(editor).props.placeholder, 'gpt-*')
  assert.equal(modelPattern(editor).props.placeholder, 'gpt-*-sol（最多一个 *）')
}))

test('Given 已观察多个平台 When 聚焦平台输入 Then 显示平台建议且可选择', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), { ...rule(2), model: 'p/m' }] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  changeInput(providerPattern(editor), ''); await f.settle()
  const field = nodes(ruleFields(editor).tree).find(node => node.type?.name === 'PricingSuggestInput' && node.props.label === '平台模式')
  const view = f.mount(field.type, { ...field.props })
  const input = nodes(view.tree).find(node => node.type === 'input')
  input.props.onFocus(); await f.settle()
  const options = nodes(view.tree).filter(node => node.type === 'button' && node.props.role === 'option').map(text)
  assert.deepEqual(options, ['p', 'q'])
  nodes(view.tree).find(node => node.type === 'button' && node.props.role === 'option' && text(node) === 'q').props.onClick()
  await f.settle()
  assert.equal(providerPattern(editor).props.value, 'q')
}, { observed: observedPricingModels }))

test('Given 平台建议列表 When 方向键回车或 Esc Then 可键盘选择与关闭', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), { ...rule(2), model: 'p/m' }] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  changeInput(providerPattern(editor), ''); await f.settle()
  const field = nodes(ruleFields(editor).tree).find(node => node.type?.name === 'PricingSuggestInput' && node.props.label === '平台模式')
  const view = f.mount(field.type, { ...field.props })
  const input = nodes(view.tree).find(node => node.type === 'input')
  const key = (name) => ({ key: name, preventDefault() {}, stopPropagation() {} })
  input.props.onFocus(); input.props.onKeyDown(key('ArrowDown')); await f.settle()
  nodes(view.tree).find(node => node.type === 'input').props.onKeyDown(key('Enter')); await f.settle()
  assert.equal(providerPattern(editor).props.value, 'p')
  nodes(view.tree).find(node => node.type === 'input').props.onFocus(); await f.settle()
  nodes(view.tree).find(node => node.type === 'input').props.onKeyDown(key('Escape')); await f.settle()
  assert.equal(nodes(view.tree).some(node => node.props?.role === 'listbox'), false)
}, { observed: observedPricingModels }))

test('Given 平台为 p When 聚焦型号输入 Then 只推荐该平台的型号', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), { ...rule(2), model: 'p/m' }] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  const field = nodes(ruleFields(editor).tree).find(node => node.type?.name === 'PricingSuggestInput' && node.props.label === '型号模式')
  const view = f.mount(field.type, { ...field.props })
  const input = nodes(view.tree).find(node => node.type === 'input')
  input.props.onFocus(); await f.settle()
  const options = nodes(view.tree).filter(node => node.type === 'button' && node.props.role === 'option').map(text)
  assert.deepEqual(options, ['m'])
}, { observed: observedPricingModels }))

// 复制把源规则落成独立草稿行(型号只留平台段)。新实现的复制不直接打开表单,
// 副本需从规则列表进入编辑;副本数据(价格+条件)与型号码清空语义不变。
test('Given 规则带价格和条件 When 点复制模型 Then 表单直接打开副本且型号置空价格条件保留', t => withFixture(t, async f => {
  const editor = f.editor()
  const source = { ...rule(2), model: 'p/m', conditions: [{ kind: 'weekdays', days: [1] }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), source] }); await f.settle()
  const rows = mountView(f, byComponent(editor, 'PricingRules'))
  const copy = nodes(rows.tree).find(node => node.type === 'button' && node.props['aria-label'] === '复制模型 p/m')
  assert.ok(copy, '规则行应提供复制入口')
  copy.props.onClick(); await f.settle()
  assert.deepEqual([providerPattern(editor).props.value, modelPattern(editor).props.value], ['p', ''])
  assert.equal(priceInput(editor).props.value, 2)
  const activeDay = nodes(conditionFields(editor).tree).find(node => node.type === 'button' && node.props['aria-pressed'] === true)
  assert.equal(text(activeDay), '一')
  changeInput(modelPattern(editor), 'other'); await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  const copied = posted.find(item => item.model === 'p/other')
  assert.deepEqual(copied.price, { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(copied.conditions, [{ kind: 'weekdays', days: [1] }])
  assert.equal(posted.find(item => item.model === 'p/m').price.input, 2)
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}, { observed: observedPricingModels }))

// 新语义:额外型号共用默认层,复制出的是「同价无条件规则」(时段层只属于原型号)。
test('Given 新增规则填多个型号 When 保存 Then 按型号复制成多条同价默认规则', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  f.openCreate(editor); await f.settle()
  await enterPattern(f, editor, 'p', 'm')
  removeLayerButton(editor, 1).props.onClick(); await f.settle()
  byText(extraFields(editor), '+ 添加型号').props.onClick(); await f.settle()
  byText(extraFields(editor), '+ 添加型号').props.onClick(); await f.settle()
  changeInput(extraModelInput(editor, 0), 'q/other'); await f.settle()
  changeInput(extraModelInput(editor, 1), 'r/third'); await f.settle()
  changeInput(priceInput(editor), '5'); await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.filter(item => ['p/m', 'q/other', 'r/third'].includes(item.model))
    .map(item => [item.model, item.price.input, item.conditions]), [
    ['p/m', 5, []],
    ['q/other', 5, []],
    ['r/third', 5, []],
  ])
  assert.ok(posted.every(item => item.extraModels === undefined), '额外型号不应进入定价协议')
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}, { observed: observedPricingModels }))

test('Given 新增规则额外型号带通配符 When 保存 Then 提示精确型号并阻止提交', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  f.openCreate(editor); await f.settle()
  await enterPattern(f, editor, 'p', 'm')
  byText(extraFields(editor), '+ 添加型号').props.onClick(); await f.settle()
  changeInput(extraModelInput(editor, 0), 'p/*'); await f.settle()
  await f.save(editor); await f.settle()
  assert.equal(f.saves.length, 0)
  assert.match(text(formTree(editor)), /精确/)
}, { observed: observedPricingModels }))

// 新语义:额外型号挂在默认层,只复制默认层;时段层仍只属于被编辑的型号。
test('Given 新增规则带全天时段层且填额外型号 When 保存 Then 额外型号只复制默认价', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  f.openCreate(editor); await f.settle()
  await enterPattern(f, editor, 'p', 'm')
  byText(extraFields(editor), '+ 添加型号').props.onClick(); await f.settle()
  changeInput(extraModelInput(editor, 0), 'q/other'); await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.filter(item => ['p/m', 'q/other'].includes(item.model))
    .map(item => [item.model, item.conditions]), [
    ['p/m', []],
    ['q/other', []],
    ['p/m', [{ kind: 'dailyWindow', from: '00:00', to: '23:59' }]],
  ])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}, { observed: observedPricingModels }))

test('Given 多型号保存中输入新额外型号 When 服务端回包 Then 当前编辑落成独立草稿且不重复', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  f.openCreate(editor); await f.settle()
  await enterPattern(f, editor, 'p', 'm')
  byText(extraFields(editor), '+ 添加型号').props.onClick(); await f.settle()
  changeInput(extraModelInput(editor, 0), 'q/other'); await f.settle()
  const pending = f.save(editor)
  changeInput(extraModelInput(editor, 0), 'q/other2'); await f.settle()
  const saved = f.saves[0].body.rules
  f.resolve(f.saves[0], { revision: 2, rules: saved }); await pending; await f.settle()
  const list = mountView(f, byComponent(editor, 'PricingRules')).tree
  const models = nodes(list).filter(node => node.props?.className === 'ud-pricing-rule-model').map(text)
  // 列表按模型折叠:同模型的默认层与时段层只占一行,在飞输入的 q/other2 另起一行
  assert.deepEqual(models.sort(), ['*/*', 'p/m', 'q/other2'])
  assert.equal(models.filter(model => model === 'q/other2').length, 1)
  const second = f.save(editor)
  const posted = f.saves[1].body.rules
  assert.deepEqual(posted.map(item => item.model).sort(), ['*/*', 'p/m', 'p/m', 'q/other2'])
  assert.ok(posted.every(item => item.extraModels === undefined))
  f.resolve(f.saves[1], { revision: 3, rules: posted }); await second
}, { observed: observedPricingModels }))

test('Given 新增规则额外型号留空 When 保存 Then 忽略空行', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  f.openCreate(editor); await f.settle()
  await enterPattern(f, editor, 'p', 'm')
  byText(extraFields(editor), '+ 添加型号').props.onClick(); await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.map(item => item.model).sort(), ['*/*', 'p/m', 'p/m'], '空额外型号不落规则,原型号两层保留')
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}, { observed: observedPricingModels }))

// 与上一条复制用例同:副本先落成草稿行,再从列表进入编辑;新实现不会替用户自动打开表单。
test('Given 复制全局兜底模型 When 表单打开 Then 平台和型号都置空', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  const rows = mountView(f, byComponent(editor, 'PricingRules'))
  const copy = nodes(rows.tree).find(node => node.type === 'button' && node.props['aria-label'] === '复制模型 */*')
  copy.props.onClick(); await f.settle()
  assert.deepEqual([providerPattern(editor).props.value, modelPattern(editor).props.value], ['', ''])
}, { observed: observedPricingModels }))

test('Given 新增规则重复填写同一个额外型号 When 保存 Then 阻止提交并提示重复', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  f.openCreate(editor); await f.settle()
  await enterPattern(f, editor, 'p', 'm')
  byText(extraFields(editor), '+ 添加型号').props.onClick(); await f.settle()
  byText(extraFields(editor), '+ 添加型号').props.onClick(); await f.settle()
  changeInput(extraModelInput(editor, 0), 'q/other'); await f.settle()
  changeInput(extraModelInput(editor, 1), 'q/other'); await f.settle()
  await f.save(editor); await f.settle()
  assert.equal(f.saves.length, 0)
  assert.match(text(formTree(editor)), /型号重复/)
}, { observed: observedPricingModels }))

test('Given 编辑已有规则 When 打开表单 Then 不显示新增页的多型号入口', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), { ...rule(2), model: 'p/m' }] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  assert.equal(byText(ruleFields(editor), '+ 添加型号'), undefined)
}, { observed: observedPricingModels }))

// 新语义:新增规则自带默认层(无条件)与全天时段层;要让新规则成为该型号的默认价,
// 删掉时段层即可,留下无条件默认层与存量条件层并存。
test('P15 Given 某型号只有条件规则 When 载入编辑器 Then 自动补默认价层并可保存', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), EDITOR_RULE] }); await f.settle()
  f.openEdit(editor, 'a/b'); await f.settle()
  assert.equal(layerNodes(editor).length, 2, '只有时段层的模型自动补一条默认价层')
  assert.ok(defaultLayerNode(editor), '默认层必须存在')
  const pending = f.save(editor)
  const rules = f.saves[0].body.rules
  const sameModel = rules.filter(item => item.model === 'a/b')
  assert.equal(sameModel.length, 2)
  assert.ok(sameModel.some(item => (item.conditions ?? []).length === 0), '默认价层无条件发布')
  assert.ok(sameModel.some(item => (item.conditions ?? []).length > 0), '存量时段层保持条件')
  f.resolve(f.saves[0], { revision: 2, rules }); await pending
}))

// 新语义:新增规则默认两槽(默认层空价 + 时段层继承价格、条件全天),两层一起保存。
test('Given 新增规则 When 打开表单 Then 默认层与全天时段层两层一起保存', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], price(1)); await f.settle()
  f.openCreate(editor); await f.settle()
  await enterPattern(f, editor, 'p', 'm')
  const layers = layerNodes(editor)
  assert.equal(layers.length, 2, '新增规则一次插入默认层与时段层')
  assert.match(text(expand(layers[0])), /默认价/)
  assert.match(text(expand(layers[1])), /时段价/)
  assert.equal(layerRule(layers[0]).price.input, 0, '默认层未填写时是占位零价')
  assert.deepEqual(layerRule(layers[0]).price, layerRule(layers[1]).price, '时段层继承默认层价格')
  assert.deepEqual(layerRule(layers[1]).conditions, [{ kind: 'dailyWindow', from: '00:00', to: '23:59' }], '时段层条件默认全天')
  assert.match(text(conditionFields(editor).tree), /每日时段/)
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.filter(item => item.model === 'p/m').map(item => item.conditions),
    [[], [{ kind: 'dailyWindow', from: '00:00', to: '23:59' }]])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

// 新语义:存量缺省条件归一为默认层,追加条件走「+ 添加时段价」(默认层不再渲染条件编辑器)。
test('Given 普通存量规则的条件为 null When 打开表单并添加时段价 Then 能保存该条件', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), { ...EDITOR_RULE, conditions: null }] }); await f.settle()
  f.openEdit(editor, 'a/b'); await f.settle()
  assert.equal(defaultLayerNode(editor) !== null, true, 'null 条件归一为默认层')
  byText(ruleFields(editor), '+ 添加时段价').props.onClick(); await f.settle()
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.filter(item => item.model === 'a/b').map(item => item.conditions),
    [[], [{ kind: 'dailyWindow', from: '00:00', to: '23:59' }]])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

test('Given 同型号已有无条件价 When 删掉时段层条件 Then 正在编辑的表单显示冲突', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), EDITOR_RULE, { ...EDITOR_RULE, conditions: [] }] }); await f.settle()
  f.openEdit(editor, 'a/b'); await f.settle()
  nodes(conditionFields(editor).tree).find(node => node.props['aria-label'] === '删除条件').props.onClick(); await f.settle()
  await f.save(editor); await f.settle()
  assert.equal(f.saves.length, 0)
  assert.match(text(ruleFields(editor).tree), /同一范围只能有一条无条件规则/)
}))

// 新语义:删掉时段层唯一条件后该层就是默认层(渲染为默认价、不再有条件编辑器)。
test('Given 普通规则仅有一个条件 When 删除该条件 Then 该层成为第二个默认价并被拦下', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), EDITOR_RULE] }); await f.settle()
  f.openEdit(editor, 'a/b'); await f.settle()
  assert.equal(layerNodes(editor).length, 2, '载入时已为只有时段层的模型补默认价')
  const remove = nodes(conditionFields(editor).tree).find(node => node.type === 'button' && node.props['aria-label'] === '删除条件')
  assert.ok(remove, '单个条件应可删除')
  remove.props.onClick(); await f.settle()
  assert.equal(layerNodes(editor).length, 2, '删掉条件后该层仍留在表单里')
  assert.equal(timedLayerNodes(editor).length, 0, '无条件的层不再算时段层')
  assert.match(text(ruleFields(editor).tree), /默认价/)
  f.save(editor); await f.settle()
  assert.equal(f.saves.length, 0, '两个无条件层同范围,保存被拦')
  assert.match(text(ruleFields(editor).tree), /同一范围只能有一条无条件规则/)
}))

test('Given 默认层旁再添一层并删掉其条件 When 渲染 Then 该层仍可见且可单独删除', t => withFixture(t, async f => {
  const editor = f.editor()
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), { ...rule(3), model: 'p/m' }] }); await f.settle()
  f.openEdit(editor, 'p/m'); await f.settle()
  byText(ruleFields(editor), '+ 添加时段价').props.onClick(); await f.settle()
  assert.equal(layerNodes(editor).length, 2)
  const removeCondition = nodes(conditionFields(editor, 0).tree)
    .find(node => node.type === 'button' && node.props['aria-label'] === '删除条件')
  assert.ok(removeCondition, '新增层应带可删除的默认条件')
  removeCondition.props.onClick(); await f.settle()
  assert.equal(layerNodes(editor).length, 2, '删掉条件后该层仍留在表单里')
  assert.equal(timedLayerNodes(editor).length, 0, '该层已无条件下,但仍占第二层位,可补条件或删除')
  removeLayerButton(editor, 1).props.onClick(); await f.settle()
  assert.equal(layerNodes(editor).length, 1)
}))

test('Given 型号只有时段层 When 删除时段层 Then 保留自动补的默认价', t => withFixture(t, async f => {
  const editor = f.editor()
  const only = { ...rule(2), model: 'a/b', conditions: [{ kind: 'weekdays', days: [1] }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), only] }); await f.settle()
  f.openEdit(editor, 'a/b'); await f.settle()
  assert.equal(layerNodes(editor).length, 2, '载入时已为 a/b 补默认价')
  removeLayerButton(editor, 1).props.onClick(); await f.settle()
  assert.equal(layerNodes(editor).length, 1, '删掉时段层后只剩默认价')
  assert.ok(defaultLayerNode(editor), '默认价不可删')
  const pending = f.save(editor)
  const posted = f.saves[0].body.rules
  assert.deepEqual(posted.filter(item => item.model === 'a/b').map(item => item.conditions), [[]])
  f.resolve(f.saves[0], { revision: 2, rules: posted }); await pending
}))

test('Given 同型号有默认层与时段层 When 查看并展开规则行 Then 折叠价取该时点生效层且逐层列出', t => withFixture(t, async f => {
  const editor = f.editor()
  const base = { ...rule(3), model: 'p/m' }
  const timed = { ...rule(5), model: 'p/m', conditions: [{ kind: 'dailyWindow', from: '09:00', to: '18:00' }] }
  f.resolve(f.gets[0], { revision: 1, rules: [rule(), base, timed] }); await f.settle()
  const owner = mountView(f, byComponent(editor, 'PricingRules'))
  const modelNames = () => nodes(owner.tree).filter(node => node.props?.className === 'ud-pricing-rule-model').map(text)
  assert.deepEqual(modelNames().sort(), ['*/*', 'p/m'], '同一模型的多层折叠成一行')
  const row = () => nodes(owner.tree).find(node => node.type === 'article'
    && nodes(node).some(child => child.props?.className === 'ud-pricing-rule-model' && text(child) === 'p/m'))
  // 夹具时点 09:00 落在 09:00–18:00 内,折叠价应是时段层而不是默认层
  assert.match(text(row()), /¥5 \/ ¥0/, '折叠态给出该时点生效的价格')
  assert.match(text(row()), /2 个价格层/)
  const toggle = nodes(row()).find(node => node.type === 'button' && node.props.className?.includes('ud-pricing-rule-head'))
  toggle.props.onClick(); await f.settle()
  const details = nodes(row()).find(node => node.type?.name === 'PricingRuleDetails')
  assert.ok(details, '展开后应渲染各层明细')
  assert.equal(details.props.activeRule?.price.input, 5, '生效层指向时段层')
  assert.deepEqual(details.props.layers.map(layer => [layer.price.input, (layer.conditions ?? []).length]),
    [[3, 0], [5, 1]], '展开后逐层列出默认价与时段价')
  const detailText = text(expand(details))
  assert.match(detailText, /默认价/)
  assert.match(detailText, /时段价/)
  assert.match(detailText, /此刻生效/)
  assert.match(detailText, /每日时段 09:00–18:00/)
}))
