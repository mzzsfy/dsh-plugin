// 工作区用量列表:默认只列前 N 行,超出折叠提供展开;搜索在全部行上过滤后按同一上限折叠。
// 整源求值取 WorkspaceUsage,React 以最小桩件驱动,状态桩支持交互后重渲染。
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const nodes = (node) => (!node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)])
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))
const classed = (tree, name) => nodes(tree)
  .filter((node) => String(node.props?.className ?? '').split(/\s+/).includes(name))
const searchInput = (tree) => nodes(tree).find((node) => node.type === 'input' && node.props?.type === 'search')

function createHarness(props) {
  const states = new Map()
  let cursor = 0
  const React = {
    createElement: (type, nextProps, ...children) => ({
      type,
      props: nextProps ?? {},
      children: children.flat(Infinity).filter((child) => child != null && child !== false),
    }),
    memo: (fn) => fn,
    useId: () => 'workspace-usage-test',
    useState(seed) {
      const index = cursor++
      if (!states.has(index)) states.set(index, typeof seed === 'function' ? seed() : seed)
      return [states.get(index), (next) => states.set(index, typeof next === 'function' ? next(states.get(index)) : next)]
    },
    useRef: () => ({ current: null }),
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  let factory
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace(
    "inject: ['slots', 'locale', 'configForms'],",
    "__test: { WorkspaceUsage, workspaceUsageFiltered, workspaceUsageViewKey }, inject: ['slots', 'locale', 'configForms'],",
  )
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  const { WorkspaceUsage, workspaceUsageFiltered, workspaceUsageViewKey } = factory((name) => (name === 'react' ? React : {})).__test
  const render = (patch = {}) => {
    cursor = 0
    return WorkspaceUsage({ ...props, ...patch })
  }
  return { render, workspaceUsageFiltered, workspaceUsageViewKey, t: core.createTranslator(core.MESSAGES_ZH) }
}

const countRows = (tree) => classed(tree, 'ud-workspace-usage-row').length
const moreButton = (tree) => classed(tree, 'ud-workspace-usage-more')[0]

const WORKSPACES = Array.from({ length: 12 }, (_, index) => {
  const label = String(index).padStart(2, '0')
  return { id: `ws-${label}`, title: `工作区 ${label}`, path: `/tmp/ws-${label}` }
})
const BY_WORKSPACE = WORKSPACES.map((item, index) => ({
  workspaceId: item.id,
  tokens: (WORKSPACES.length - index) * 100,
  requests: 3,
  turns: 2,
  activeDays: 1,
}))
const PROPS = { byWorkspace: BY_WORKSPACE, workspaces: WORKSPACES, t: core.createTranslator(core.MESSAGES_ZH) }

test('Given 12 个工作区用量行 When 渲染工作区用量 Then 只列前 10 行并给出展开入口', () => {
  const harness = createHarness(PROPS)
  const tree = harness.render()
  assert.equal(countRows(tree), 10)
  assert.ok(searchInput(tree), '超出上限时必须提供搜索框')
  const more = moreButton(tree)
  assert.ok(more, '超出上限时必须提供展开入口')
  assert.equal(text(more), core.MESSAGES_ZH.workspaceUsageShowAll.replace('{n}', String(WORKSPACES.length)))
  assert.equal(more.props['aria-expanded'], false)
})

test('Given 折叠态 When 点击展开 Then 列出全部行且按钮切换为收起', () => {
  const harness = createHarness(PROPS)
  moreButton(harness.render()).props.onClick()
  const tree = harness.render()
  assert.equal(countRows(tree), WORKSPACES.length)
  const more = moreButton(tree)
  assert.equal(more.props['aria-expanded'], true)
  assert.equal(text(more), core.MESSAGES_ZH.workspaceUsageShowLess)
})

test('Given 工作区名称大小写混合 When 搜索 Then 忽略大小写与首尾空格命中', () => {
  const harness = createHarness({
    ...PROPS,
    workspaces: [{ id: 'a', title: 'Alpha Repo' }, { id: 'b', title: 'beta' }],
    byWorkspace: [{ workspaceId: 'a', tokens: 200 }, { workspaceId: 'b', tokens: 100 }],
  })
  const filtered = harness.workspaceUsageFiltered(
    [{ name: 'Alpha Repo' }, { name: 'beta' }],
    '  ALPHA  ',
  )
  assert.deepEqual(filtered.map((row) => row.name), ['Alpha Repo'])
})

test('Given 命中数不超过上限 When 搜索 Then 直接列出全部命中且无展开入口', () => {
  const harness = createHarness(PROPS)
  const tree = harness.render()
  searchInput(tree).props.onChange({ target: { value: '工作区 1' } })
  const searched = harness.render()
  assert.equal(countRows(searched), 2)
  assert.equal(moreButton(searched), undefined)
})

test('Given 展开态 When 输入搜索词 Then 折叠回默认上限', () => {
  const harness = createHarness(PROPS)
  moreButton(harness.render()).props.onClick()
  assert.equal(countRows(harness.render()), WORKSPACES.length)
  searchInput(harness.render()).props.onChange({ target: { value: '工作区' } })
  const searched = harness.render()
  assert.equal(countRows(searched), 10)
  assert.equal(moreButton(searched).props['aria-expanded'], false)
})

test('Given 搜索无命中 When 渲染 Then 给无匹配文案且不显示展开入口', () => {
  const harness = createHarness(PROPS)
  searchInput(harness.render()).props.onChange({ target: { value: '不存在的仓库' } })
  const tree = harness.render()
  assert.equal(countRows(tree), 0)
  assert.equal(classed(tree, 'ud-empty').length, 1)
  assert.match(text(tree), new RegExp(core.MESSAGES_ZH.workspaceUsageNoMatch))
  assert.equal(moreButton(tree), undefined)
})

test('Given 行数不超过上限 When 渲染 Then 不出现搜索框', () => {
  const harness = createHarness({
    byWorkspace: BY_WORKSPACE.slice(0, 3),
    workspaces: WORKSPACES.slice(0, 3),
    t: core.createTranslator(core.MESSAGES_ZH),
  })
  const tree = harness.render()
  assert.equal(countRows(tree), 3)
  assert.equal(searchInput(tree), undefined)
  assert.equal(moreButton(tree), undefined)
})

test('Given 中英文案 When 读取工作区用量搜索键 Then 两侧均已定义', () => {
  for (const key of ['workspaceUsageSearch', 'workspaceUsageNoMatch', 'workspaceUsageShowAll', 'workspaceUsageShowLess']) {
    assert.equal(typeof core.MESSAGES_ZH[key], 'string')
    assert.equal(typeof core.MESSAGES_EN[key], 'string')
  }
})

test('Given 已输入搜索词 When 数据降到上限以内 Then 搜索框与过滤同时失效,不漏行', () => {
  const harness = createHarness(PROPS)
  searchInput(harness.render()).props.onChange({ target: { value: '工作区 0' } })
  const shrunk = harness.render({
    byWorkspace: BY_WORKSPACE.slice(0, 7),
    workspaces: WORKSPACES.slice(0, 7),
  })
  assert.equal(searchInput(shrunk), undefined)
  assert.equal(countRows(shrunk), 7)
})

test('Given 无工作区用量 When 渲染 Then 空态按范围口径而非无匹配', () => {
  const harness = createHarness({ byWorkspace: [], workspaces: [], t: core.createTranslator(core.MESSAGES_ZH) })
  const tree = harness.render()
  assert.equal(countRows(tree), 0)
  assert.ok(text(tree).includes(core.MESSAGES_ZH.workspaceUsageEmpty))
  assert.ok(!text(tree).includes(core.MESSAGES_ZH.workspaceUsageNoMatch))
  assert.equal(searchInput(tree), undefined)
})

test('Given 12 行中命中 11 行 When 搜索 Then 可见行取前 10 且展开入口按命中数计数', () => {
  const otherRepo = { id: 'ws-other', title: '其他仓库' }
  const harness = createHarness({
    byWorkspace: [...BY_WORKSPACE.slice(0, 11), { workspaceId: otherRepo.id, tokens: 50 }],
    workspaces: [...WORKSPACES.slice(0, 11), otherRepo],
    t: core.createTranslator(core.MESSAGES_ZH),
  })
  searchInput(harness.render()).props.onChange({ target: { value: '工作区' } })
  const tree = harness.render()
  assert.equal(countRows(tree), 10)
  assert.ok(classed(tree, 'ud-workspace-usage-name').every((node) => text(node).includes('工作区')))
  assert.equal(text(moreButton(tree)), core.MESSAGES_ZH.workspaceUsageShowAll.replace('{n}', '11'))
})

test('Given 范围、模型或刷新变化 When 计算视图键 Then 键随之变化且不含 undefined', () => {
  const harness = createHarness(PROPS)
  const request = { from: '2026-11-01', to: '2026-11-28' }
  const base = harness.workspaceUsageViewKey(request, '', 0)
  assert.equal(base, harness.workspaceUsageViewKey({ ...request }, '', 0))
  assert.notEqual(base, harness.workspaceUsageViewKey({ ...request, from: '2026-11-02' }, '', 0))
  assert.notEqual(base, harness.workspaceUsageViewKey({ ...request, to: '2026-11-27' }, '', 0))
  assert.notEqual(base, harness.workspaceUsageViewKey(request, 'newapi/auto-free', 0))
  assert.notEqual(base, harness.workspaceUsageViewKey(request, '', 1))
  assert.doesNotMatch(harness.workspaceUsageViewKey(undefined, undefined, undefined), /undefined/)
})

test('Given 已删除工作区 When 按删除标签搜索 Then 命中该行', () => {
  const harness = createHarness({
    workspaces: [...WORKSPACES.slice(0, 11), { id: 'deadbeef-0000', deleted: true }],
    byWorkspace: [...BY_WORKSPACE.slice(0, 11), { workspaceId: 'deadbeef-0000', tokens: 50 }],
    t: core.createTranslator(core.MESSAGES_ZH),
  })
  searchInput(harness.render()).props.onChange({ target: { value: core.MESSAGES_ZH.workspaceDeleted } })
  const tree = harness.render()
  assert.equal(countRows(tree), 1)
  assert.match(text(tree), /deadbeef/)
})

test('Given 行名缺失 When 过滤 Then 不抛错且不命中', () => {
  const harness = createHarness(PROPS)
  assert.deepEqual(harness.workspaceUsageFiltered([{ name: undefined }, { name: 'alpha' }], 'alpha').map((row) => row.name), ['alpha'])
})
