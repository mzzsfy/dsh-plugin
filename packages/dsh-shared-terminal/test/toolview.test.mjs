// toolview 渲染守卫:全量执行 client.js 工厂(React/primitives/locale 桩),
// 实际调用注册出的 tool.call.toolview 组件断言官方行结构——源码断言抓不住的
// 渲染期未定义引用与结构退化(JSON 平铺)在此暴露。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

// ── 桩 ────────────────────────────────────────────────────────────────
function reactStub(expanded = false) {
  const createElement = (type, props, ...children) => {
    if (typeof type === 'function') return type({ ...(props ?? {}), children })
    return { type, props: props ?? {}, children }
  }
  return {
    createElement,
    useState: (init) => [expanded || (typeof init === 'function' ? init() : init), () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    memo: (fn) => fn,
  }
}

const primitivesStub = {
  TextShimmer: ({ active, children }) => ({ type: 'TextShimmer', props: { active: active === true }, children }),
  StateDot: ({ state }) => ({ type: 'StateDot', props: { state } }),
  IconCodeOutlineRegular: () => ({ type: 'IconCode', props: {} }),
  IconChevronDownOutlineRegular: () => ({ type: 'IconChevronDown', props: {} }),
  IconChevronUpOutlineRegular: () => ({ type: 'IconChevronUp', props: {} }),
}

// ── 装载 ──────────────────────────────────────────────────────────────
function loadClient(expanded = false) {
  const React = reactStub(expanded)
  const registrations = []
  const dictionaries = new Map()
  const slots = {
    inject: (_name, factory) => factory(),
    register: (meta, component) => registrations.push({ meta, component }),
  }
  const locale = { register: (ns, dict) => dictionaries.set(ns, dict) }
  const injectedStyles = []
  const document = {
    documentElement: { lang: 'zh-CN' },
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {}, textContent: '' }),
    head: { appendChild: (node) => injectedStyles.push(node) },
  }
  let loaded
  const window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  new Function('window', 'document', 'navigator', source)(window, document, {}, undefined)
  assert.notEqual(loaded, undefined, 'client.js 未调用 __ModuleLoader__.load')
  loaded.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error('module not available: ' + name)
  }).apply({
    effect: (fn) => fn(),
    slots,
    locale,
  })
  const view = registrations.find((item) => item.meta.name === 'tool.call.toolview' && item.meta.key === 'terminal')
  assert.notEqual(view, undefined, '缺少 key=terminal 的 toolview 注册')
  const t = (key) => {
    const dict = dictionaries.get(view.meta.locale)
    const value = dict?.zh?.[key]
    // 哨兵回退:缺键渲染 '@@key' 而非键名本身,阻断"回退即通过"
    return value === undefined ? '@@' + key : value
  }
  return { component: view.component, t, dictionaries, injectedStyles }
}

// ── 渲染与树断言 ──────────────────────────────────────────────────────
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { node.forEach((child) => flatten(child, out)); return out }
  if (typeof node === 'object' && 'type' in node) {
    out.push(node)
    flatten(node.children, out)
    flatten(node.props?.children, out)
  } else if (typeof node !== 'object') out.push(node)
  return out
}

function textOf(tree) {
  return flatten(tree).filter((node) => typeof node === 'string').join('')
}

function findAll(tree, predicate) {
  return flatten(tree).filter((node) => typeof node === 'object' && 'type' in node && predicate(node))
}

function findAttr(tree, attr, value) {
  return findAll(tree, (node) => node.props?.[attr] === value)[0]
}

// ── 数据组装 ──────────────────────────────────────────────────────────
function settledProps(args, result, extra = {}) {
  return {
    phase: 'result',
    callId: 'c1',
    sessionId: 's1',
    block: {
      kind: 'tool',
      call: { argsRaw: JSON.stringify(args) },
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: extra.isError ?? false,
    },
    ...extra,
  }
}

// ── 场景 ──────────────────────────────────────────────────────────────
test('S1 运行中:官方行结构,进行中态无 JSON 平铺', () => {
  const { component, t } = loadClient()
  const tree = component({
    phase: 'executing',
    callId: 'c1',
    sessionId: 's1',
    block: { argsRaw: JSON.stringify({ action: 'read', terminal_id: 'tid-1', lines: 5 }) },
    t,
  })
  assert.notEqual(findAttr(tree, 'data-tool', 'terminal'), undefined, '缺少 data-tool=terminal 根')
  assert.notEqual(findAttr(tree, 'data-state', 'running'), undefined, '缺少 running 状态')
  const text = textOf(tree)
  assert.ok(text.includes('读取屏幕'), '摘要应含动作文案')
  assert.ok(!text.includes('"action"') && !text.includes('terminal_id'), '运行中不得平铺 JSON 字段')
  const shimmer = findAll(tree, (node) => node.type === 'TextShimmer' && node.props.active === true)
  assert.ok(shimmer.length > 0, '运行中应激活 TextShimmer')
})

test('S2 read 成功:行数摘要与截断徽章,展开屏幕文本', () => {
  const { component, t } = loadClient()
  const props = settledProps(
    { action: 'read', terminal_id: 'tid-1', lines: 3 },
    { ok: true, terminal_id: 'tid-1', text: 'line1\nline2\nline3', lines: 3, truncated: true, state: 'running', sequence: 4 },
  )
  const collapsed = component({ ...props, t })
  assert.ok(textOf(collapsed).includes('读取屏幕'), '摘要缺动作文案')
  assert.ok(textOf(collapsed).includes('3 行'), '摘要缺行数')
  assert.ok(findAll(collapsed, (node) => node.type === 'span' && node.props?.className === 'stv-badge' && textOf(node) === '已截断').length > 0, '缺截断徽章')
  assert.equal(findAll(collapsed, (node) => node.props?.className === 'stv-ioSection').length, 0, '折叠态不应渲染屏幕体')
  const expanded = loadClient(true)
  const openTree = expanded.component({ ...props, t })
  const screen = findAll(openTree, (node) => node.props?.className === 'stv-ioText').map(textOf).join('\n')
  assert.ok(screen.includes('line1') && screen.includes('line3'), '展开应含屏幕文本')
  assert.ok(!textOf(openTree).includes('@@'), '展开不得出现缺键哨兵')
  const row = findAttr(openTree, 'data-state', 'done')
  assert.equal(row?.props?.role, 'button', '可展开行应 role=button')
  assert.equal(row?.props?.['aria-expanded'], true, '展开态 aria-expanded=true')
  assert.equal(typeof row?.props?.onKeyDown, 'function', '缺键盘切换处理')
  assert.ok(findAll(openTree, (node) => node.type === 'IconChevronUp').length > 0, '展开态应为 Up 箭头')
})

test('S2b read 全空白屏幕:展开显示兜底提示', () => {
  const { component, t } = loadClient(true)
  const tree = component({ ...settledProps(
    { action: 'read', terminal_id: 'tid-1', lines: 24 },
    { ok: true, terminal_id: 'tid-1', text: '\n\n\n', lines: 24, truncated: false },
  ), t })
  const screen = findAll(tree, (node) => node.props?.className === 'stv-ioText').map(textOf).join('\n')
  assert.ok(screen.includes('屏幕底部为空白行'), '空白屏幕应显示兜底提示')
})

test('S3 list 成功:数量摘要,展开每终端状态行', () => {
  const { component, t } = loadClient(true)
  const props = settledProps(
    { action: 'list' },
    { ok: true, terminals: [
      { id: 'aaaa-bbbb', title: 'bash.exe', state: 'running', attached: true },
      { id: 'cccc-dddd', title: 'cmd.exe', state: 'running', attached: false },
    ] },
  )
  const tree = component({ ...props, t })
  assert.ok(textOf(tree).includes('2 个终端'), '摘要缺数量')
  const rows = findAll(tree, (node) => node.props?.className === 'stv-termRow')
  assert.equal(rows.length, 2, '展开应每终端一行')
  const text = textOf(tree)
  assert.ok(text.includes('bash.exe') && text.includes('已连接'), '缺运行中终端详情')
  assert.ok(text.includes('未连接'), '缺未绑定徽章')
})

test('S4 write 成功:提交徽章,展开输入文本', () => {
  const { component, t } = loadClient(true)
  const tree = component({ ...settledProps(
    { action: 'write', terminal_id: 'tid-1', text: "date '+%H:%M'", submit: true },
    { ok: true, terminal_id: 'tid-1', accepted: true },
  ), t })
  assert.ok(textOf(tree).includes('写入终端'), '缺动作文案')
  assert.ok(textOf(tree).includes('已提交'), '缺提交徽章')
  const input = findAll(tree, (node) => node.props?.className === 'stv-ioText').map(textOf).join('\n')
  assert.ok(input.includes("date '+%H:%M'"), '展开缺输入文本')
})

test('S4b wait found:needle 摘要与已出现徽章,展开屏幕文本', () => {
  const { component, t } = loadClient(true)
  const tree = component({ ...settledProps(
    { action: 'wait', terminal_id: 'tid-1', text: 'Build successful' },
    { ok: true, terminal_id: 'tid-1', kind: 'found', text: 'Build successful\n$', lines: 2, truncated: false, state: 'running', sequence: 9, elapsed_ms: 12 },
  ), t })
  assert.ok(textOf(tree).includes('等待屏幕文本'), '缺动作文案')
  assert.ok(textOf(tree).includes('Build successful'), '摘要缺 needle')
  assert.ok(findAll(tree, (node) => node.type === 'span' && node.props?.className === 'stv-badge' && textOf(node) === '已出现').length > 0, '缺 found 徽章')
  const screen = findAll(tree, (node) => node.props?.className === 'stv-ioText').map(textOf).join('\n')
  assert.ok(screen.includes('Build successful'), '展开缺屏幕文本')
  assert.ok(!textOf(tree).includes('@@'), '不得出现缺键哨兵')
})

test('S4c wait 终态徽章随 kind,运行中 shimmer', () => {
  const { component, t } = loadClient(true)
  const timeoutTree = component({ ...settledProps(
    { action: 'wait', terminal_id: 'tid-1', text: 'never', timeout_ms: 150 },
    { ok: true, terminal_id: 'tid-1', kind: 'timeout', text: '$', lines: 1, truncated: false, state: 'running', sequence: 9, timeout_ms: 150 },
  ), t })
  assert.ok(findAll(timeoutTree, (node) => node.props?.className === 'stv-badge' && textOf(node) === '超时').length > 0, '缺超时徽章')
  const exitedTree = component({ ...settledProps(
    { action: 'wait', terminal_id: 'tid-1', text: 'never' },
    { ok: true, terminal_id: 'tid-1', kind: 'exited', text: 'process exited', lines: 1, truncated: false, state: 'exited', sequence: 10 },
  ), t })
  assert.ok(findAll(exitedTree, (node) => node.props?.className === 'stv-badge' && textOf(node) === '已退出').length > 0, '缺退出徽章')
  const runningTree = component({
    phase: 'executing',
    callId: 'c1',
    sessionId: 's1',
    block: { argsRaw: JSON.stringify({ action: 'wait', terminal_id: 'tid-1', text: 'Build successful' }) },
    t,
  })
  assert.ok(textOf(runningTree).includes('等待屏幕文本'), '运行中缺动作文案')
  assert.ok(findAll(runningTree, (node) => node.type === 'TextShimmer' && node.props.active === true).length > 0, '运行中应激活 shimmer')
})

test('S5 open/close 成功:id 短码,open 带打开按钮', () => {
  const { component, t } = loadClient(true)
  const openProps = settledProps(
    { action: 'open', cols: 80, rows: 24 },
    { ok: true, terminal_id: 'abcdef12-3456-7890' },
    { sessionId: 's1' },
  )
  const openTree = component({ ...openProps, openTerminal: async () => true, t })
  assert.ok(textOf(openTree).includes('打开终端'), '缺动作文案')
  assert.ok(textOf(openTree).includes('abcdef12'), '缺终端 id 短码')
  assert.ok(findAll(openTree, (node) => node.type === 'button' && node.props?.className === 'stv-openBtn').length > 0, 'open 应带打开按钮')
  const closeTree = component({ ...settledProps({ action: 'close', terminal_id: 'abcdef12-3456' }, { ok: true, terminal_id: 'abcdef12-3456' }), t })
  assert.ok(textOf(closeTree).includes('关闭终端') && textOf(closeTree).includes('abcdef12'), 'close 摘要不完整')
})

test('S6 错误:错误态摘要含 code,展开 label 与原文', () => {
  const { component, t } = loadClient(true)
  const tree = component({ ...settledProps(
    { action: 'write', terminal_id: 'tid-1', text: 'x' },
    { ok: false, error: { code: 'NOT_ATTACHED', message: 'terminal 侧边栏面板未打开(切页会断开输入附着),打开面板后重试' } },
  ), t })
  assert.notEqual(findAttr(tree, 'data-state', 'error'), undefined, '缺 error 状态')
  assert.ok(textOf(tree).includes('NOT_ATTACHED'), '摘要缺错误码')
  const labels = findAll(tree, (node) => node.props?.className === 'stv-ioLabel').map(textOf)
  assert.deepEqual(labels, ['结果'], '错误展开 section label 应为结果')
  const tree2 = component({ ...settledProps(
    { action: 'read', terminal_id: 'tid-1' },
    'TERMINAL_ERROR',
    { isError: true },
  ), t })
  assert.notEqual(findAttr(tree2, 'data-state', 'error'), undefined, 'isError 块应错误态')
})

test('S7 解析失败:generic 回退行,摘要首行可展开原文', () => {  const { component, t } = loadClient(true)
  const tree = component({
    phase: 'result',
    callId: 'c1',
    sessionId: 's1',
    block: { kind: 'tool', call: { argsRaw: '{broken' }, content: [{ type: 'text', text: 'plain output line\nsecond' }] },
    t,
  })
  assert.notEqual(findAttr(tree, 'data-state', 'done'), undefined, '回退应中性 done 态')
  assert.ok(textOf(tree).includes('plain output line'), '摘要缺原文首行')
  const labels = findAll(tree, (node) => node.props?.className === 'stv-ioLabel').map(textOf)
  assert.deepEqual(labels, ['结果'], '回退展开 label 应为结果')
  const screen = findAll(tree, (node) => node.props?.className === 'stv-ioText').map(textOf).join('\n')
  assert.ok(screen.includes('second'), '展开应含原文')
})

test('S8 样式注入守卫:style 带 data-plugin 且注册面单次', () => {
  const { injectedStyles } = loadClient()
  assert.equal(injectedStyles.length, 1, '样式节点应恰好一个')
  const sourceCount = (source.match(/createElement\('style'\)/g) ?? []).length
  const markedCount = (source.match(/setAttribute\('data-plugin'/g) ?? []).length
  assert.equal(sourceCount, markedCount, '每个样式注入点都应带 data-plugin 标记')
})

test('S9 双语字典键集对称', () => {
  const { dictionaries } = loadClient()
  const dict = dictionaries.get('dsh-shared-terminal')
  assert.ok(dict, 'locale 字典未注册')
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort(), 'zh/en 键集不对称')
})
