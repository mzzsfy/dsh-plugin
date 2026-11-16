import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const usage = { uncachedInputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 0, outputTokens: 500 }
const on = { cachePrecision: true, tokenDetail: true, costDisplay: true, recentSpeed: true }
const rules = [{ model: 'p/m', currency: '¥', price: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 }, conditions: [] }]
const modelUsage = { hours: [{ time: new Date(2026, 2, 15, 10, 0).getTime(), model: 'p/m', ...usage }] }
// 宿主 AssistantMessageNode 最小形态:timing 与 usage 是最近输出速度的唯一输入
const stepNode = (outputTokens, decodeMs) => ({
  kind: 'assistant',
  time: decodeMs,
  timing: { stepStartTime: 0, firstTokenTime: 0, completedTime: decodeMs },
  usage: { outputTokens },
})

// 面板组件在整源求值区之外(组件区),以字符串 type 作为可识别桩锁开合与数据透传,
// 面板内容由 cost-breakdown 纯函数测试覆盖
const COST_POPOVER = 'cost-popover'
const COST_BODY = 'cost-body'

function render(options = {}) {
  const { prefs = on, lang = 'zh', pricing = rules, target = {}, speedTarget = null, nodes = [], capture = {}, recentSpeed = undefined, useSessions = undefined, sessionId = 'sess-1' } = options
  const value = Object.hasOwn(options, 'value') ? options.value : usage
  const source = CLIENT_BODY.match(/const StatsLineAppended = React\.memo\(([\s\S]*?)\n    \}\)/)?.[1] + '\n}'
  const React = { Fragment: 'fragment', useId: () => ':test:' }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) })
  const useState = (init) => [typeof init === 'function' ? init() : init, () => {}]
  const noop = () => {}
  const names = Object.keys(core)
  // 悬浮包装件在整源求值区之外(组件区),测试只关心文本与结构,用保留类名与子节点的桩
  const HintText = (props) => h('span', { className: props.className }, props.children)
  const component = new Function(...names, 'React', 'h', 'useState', 'useEffect', 'useLayoutEffect', 'useRef', 'statsLineState', 'defaultT', 'usePricing', 'useUsageDialogTarget', 'useSpeedDialogTarget', 'useSpeedCapsulePatch', 'createPortal', 'HintText', 'useChat', 'useMemo', 'useCallback', 'CostPopover', 'CostBreakdownBody', `return (${source})`)(...Object.values(core), React, h, useState, noop, noop, () => ({ current: null }), { get: () => prefs }, core.createTranslator(core.MESSAGES_ZH), () => ({ rules: pricing }), () => target, () => speedTarget, (ref, text) => { capture.text = text }, (content, container) => ({ type: 'portal', props: { container }, children: [content].flat(Infinity) }), HintText, (selector) => selector({ legacy: { nodes } }), (fn) => fn(), (fn) => fn, COST_POPOVER, COST_BODY)
  return component({
    useProjection: (key) => (key === 'usageDashModelUsage' ? modelUsage : key === 'usageDashRecentSpeed' ? recentSpeed : value),
    useChat: (selector) => selector({ legacy: { nodes } }),
    useSessions,
    sessionId,
    t: core.createTranslator(lang === 'en' ? core.MESSAGES_EN : core.MESSAGES_ZH),
  })
}

// 交互态渲染:真实 useState 语义 + 手动重挂载,用于「点击展开」这类开合契约
function mountInteractive(options = {}) {
  const { prefs = on, pricing = rules, sessionId = 'sess-1' } = options
  // 显式传 undefined 表示旧宿主没有该 props,不能被解构默认值吞掉
  const useSessions = Object.hasOwn(options, 'useSessions') ? options.useSessions : () => ({ byId: {} })
  const source = CLIENT_BODY.match(/const StatsLineAppended = React\.memo\(([\s\S]*?)\n    \}\)/)?.[1] + '\n}'
  const React = { Fragment: 'fragment', useId: () => ':test:' }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) })
  const noop = () => {}
  let states = []
  let index = 0
  const useState = (init) => {
    const slot = index++
    if (slot >= states.length) states[slot] = typeof init === 'function' ? init() : init
    const set = (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next }
    return [states[slot], set]
  }
  const HintText = (props) => h('span', { className: props.className, 'data-hint': props.text ?? '' }, props.children)
  const component = new Function(...Object.keys(core), 'React', 'h', 'useState', 'useEffect', 'useLayoutEffect', 'useRef', 'statsLineState', 'defaultT', 'usePricing', 'useUsageDialogTarget', 'useSpeedDialogTarget', 'useSpeedCapsulePatch', 'createPortal', 'HintText', 'useChat', 'useMemo', 'useCallback', 'CostPopover', 'CostBreakdownBody', `return (${source})`)(...Object.values(core), React, h, useState, noop, noop, () => ({ current: null }), { get: () => prefs }, core.createTranslator(core.MESSAGES_ZH), () => ({ rules: pricing }), () => null, () => null, noop, (content, container) => ({ type: 'portal', props: { container }, children: [content].flat(Infinity) }), HintText, () => null, (fn) => fn(), (fn) => fn, COST_POPOVER, COST_BODY)
  const props = {
    useProjection: (key) => (key === 'usageDashModelUsage' ? modelUsage : usage),
    useChat: () => null,
    useSessions,
    sessionId,
    t: core.createTranslator(core.MESSAGES_ZH),
  }
  const mount = () => { index = 0; return component(props) }
  let tree = mount()
  const trigger = () => nodes(tree).find((node) => node.type === 'button' && node.props['aria-haspopup'] === 'dialog')
  return {
    tree: () => tree,
    click() {
      const button = trigger()
      assert.ok(button, '费用条目应是可点击按钮')
      button.props.onClick()
      tree = mount()
      return tree
    },
    trigger,
  }
}
const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []
const text = (tree) => typeof tree === 'string' ? tree : tree?.children.map(text).join('') ?? ''
const inlineText = (tree) => tree?.type === 'portal' ? '' : typeof tree === 'string' ? tree : tree?.children.map(inlineText).join('') ?? ''

test('Given 默认偏好 When 渲染 Then 底栏只有费用，补充项追加到官方弹窗', () => {
  const target = {}
  const tree = render({ target })
  assert.equal(inlineText(tree), '费用 ≈ ¥0.0020')
  assert.equal(nodes(tree).filter((n) => (n.type === 'button' && n.props['aria-haspopup'] !== 'dialog') || n.props.popover).length, 0)
  const portal = nodes(tree).find((n) => n.type === 'portal')
  assert.equal(portal.props.container, target)
  assert.doesNotMatch(text(portal), /命中率/)
  assert.match(text(portal), /输入合计（含缓存）5,000 tok/)
  assert.doesNotMatch(text(portal), /总 |输出|未命中缓存|命中缓存/)
})

test('Given 存在子代理且明细开关开启 When 渲染 Then 官方弹窗追加子代理明细入口', () => {
  const target = {}
  const byId = { A: { id: 'A' }, B: { id: 'B', origin: 'subagent', parentId: 'A', displayTitle: '调研' } }
  const tree = render({ target, sessionId: 'A', useSessions: (selector) => selector({ byId, projectionsBySession: {} }) })
  const portal = nodes(tree).filter((n) => n.type === 'portal').find((p) => text(p).includes('子代理用量'))
  assert.ok(portal, '应追加子代理入口')
  assert.equal(portal.props.container, target)
  assert.match(text(portal), /查看 1 个子代理明细/)
})

test('Given 明细开关关闭 When 有子代理 Then 不追加子代理入口', () => {
  const byId = { A: { id: 'A' }, B: { id: 'B', origin: 'subagent', parentId: 'A' } }
  const tree = render({
    prefs: { ...on, tokenDetail: false },
    target: {},
    sessionId: 'A',
    useSessions: (selector) => selector({ byId, projectionsBySession: {} }),
  })
  assert.equal(nodes(tree).filter((n) => n.type === 'portal').length, 0)
})

test('Given 英文与费用关闭 When 渲染 Then 仅向官方弹窗追加英文补充项', () => {
  const tree = render({ prefs: { ...on, costDisplay: false }, lang: 'en' })
  assert.equal(inlineText(tree), '')
  assert.doesNotMatch(text(tree), /cache-hit/)
  assert.match(text(tree), /Total input \(including cache\)5,000 tok/)
})

test('Given 官方弹窗未打开 When 渲染 Then 没有额外入口或补充节点', () => {
  const tree = render({ target: null })
  assert.equal(text(tree), '费用 ≈ ¥0.0020')
  assert.equal(nodes(tree).filter((n) => n.type === 'portal').length, 0)
})

test('Given 明细开关全关 When 渲染 Then 只显示费用', () => {
  const tree = render({ prefs: { cachePrecision: false, tokenDetail: false, costDisplay: true } })
  assert.equal(text(tree), '费用 ≈ ¥0.0020')
  assert.equal(nodes(tree).filter((n) => n.type === 'portal').length, 0)
})

test('Given 空用量或全关 When 渲染 Then 不留下空条目', () => {
  for (const value of [undefined, { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }]) assert.equal(text(render({ value })), '')
  assert.equal(text(render({ prefs: { cachePrecision: false, tokenDetail: false, costDisplay: false } })), '')
})

test('Given 只有输出且费用未加载 When 渲染 Then 官方已有输出，不追加零值明细', () => {
  assert.equal(text(render({ value: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 }, pricing: null })), '')
})

test('Given 有缓存写入 When 渲染 Then 追加合计未命中量且两开关独立', () => {
  const value = { ...usage, cacheWriteTokens: 2000 }
  const detailOnly = render({ value, prefs: { cachePrecision: false, tokenDetail: true, costDisplay: false } })
  assert.match(text(detailOnly), /输入合计（含缓存）7,000 tok/)
  assert.match(text(detailOnly), /未命中合计（含缓存写入）3,000 tok/)
  assert.doesNotMatch(text(detailOnly), /命中率/)
  const precisionOnly = render({ value, prefs: { cachePrecision: true, tokenDetail: false, costDisplay: false } })
  assert.equal(text(precisionOnly), '')
})

test('Given 窗口内有可解码步骤 When 打开用时与速度弹窗 Then 追加最近输出速度行', () => {
  const tree = render({ speedTarget: {}, target: null, nodes: [stepNode(500, 2000), stepNode(300, 1000)] })
  const portals = nodes(tree).filter((n) => n.type === 'portal')
  assert.equal(portals.length, 1)
  // 800 tok / 3s,一位小数以上取整
  assert.match(text(portals[0]), /最近输出速度267 tok\/s/)
  assert.equal(portals[0].children.filter((n) => n.type === 'dt').length, 1)
  assert.equal(portals[0].children.filter((n) => n.type === 'dd').length, 1)
})

test('Given 只有最近输出速度开关开着 When 渲染 Then 弹窗出现该行且底栏不占位', () => {
  const tree = render({ speedTarget: {}, prefs: { cachePrecision: false, tokenDetail: false, costDisplay: false, recentSpeed: true }, nodes: [stepNode(500, 2000)] })
  assert.equal(inlineText(tree), '')
  assert.equal(nodes(tree).filter((n) => n.type === 'portal').length, 1)
  assert.match(text(tree), /最近输出速度250 tok\/s/)
})

test('Given 开关关闭、窗口无可用步骤或弹窗未打开 When 渲染 Then 不追加该行', () => {
  assert.doesNotMatch(text(render({ speedTarget: {}, prefs: { ...on, recentSpeed: false }, nodes: [stepNode(500, 2000)] })), /最近输出速度/)
  const empty = render({ speedTarget: {}, prefs: { cachePrecision: false, tokenDetail: false, costDisplay: false }, nodes: [] })
  assert.equal(nodes(empty).filter((n) => n.type === 'portal').length, 0)
  const closed = render({ speedTarget: null, nodes: [stepNode(500, 2000)] })
  assert.doesNotMatch(text(closed), /最近输出速度/)
})

test('Given 英文环境 When 渲染最近输出速度 Then 文案随语言切换', () => {
  const tree = render({ speedTarget: {}, lang: 'en', nodes: [stepNode(500, 2000)] })
  assert.match(text(tree), /Recent output speed250 tok\/s/)
})

test('Given 替换默认速度开关 When 渲染 Then 胶囊补丁只接管开启且有读数的场景并带最近前缀', () => {
  const onCapture = {}
  render({ capture: onCapture, prefs: { ...on, replaceSpeed: true }, speedTarget: {}, nodes: [stepNode(500, 2000)] })
  assert.equal(onCapture.text, '最近250 tok/s')
  const enCapture = {}
  render({ capture: enCapture, prefs: { ...on, replaceSpeed: true }, speedTarget: {}, nodes: [stepNode(500, 2000)], lang: 'en' })
  assert.equal(enCapture.text, 'Recent 250 tok/s')
  const offCapture = {}
  render({ capture: offCapture, prefs: { ...on, replaceSpeed: false }, speedTarget: {}, nodes: [stepNode(500, 2000)] })
  assert.equal(offCapture.text, null)
  const statsOffCapture = {}
  render({ capture: statsOffCapture, prefs: { cachePrecision: false, tokenDetail: false, costDisplay: false, recentSpeed: false, replaceSpeed: true }, nodes: [stepNode(500, 2000)] })
  assert.equal(statsOffCapture.text, null)
  const emptyCapture = {}
  render({ capture: emptyCapture, prefs: { ...on, replaceSpeed: true }, speedTarget: {}, nodes: [] })
  assert.equal(emptyCapture.text, null)
})

test('Given 统计开关关闭 When 查看偏好卡契约 Then 替换子开关不渲染且父关一并复位', () => {
  // 偏好卡组件依赖整个组件区上下文,这里锁定条件渲染与复位契约,防止回归
  assert.match(CLIENT_BODY, /prefs\.recentSpeed && h\(StatsLineOptionRow, \{\s*labelKey: 'replaceSpeed'/)
  assert.match(CLIENT_BODY, /recentSpeed: false, replaceSpeed: false/)
})

test('Given 会话投影有读数 When 渲染 Then 优先于窗口节点估算', () => {
  // 投影来自宿主 decode 配对,与官方同一份数据;窗口节点只是缺失时的兜底
  const tree = render({ speedTarget: {}, target: null, nodes: [stepNode(500, 2000)], recentSpeed: { tps: 104, steps: 2 } })
  assert.match(text(tree), /最近输出速度104 tok\/s/)
})

test('Given 投影无可读值 When 渲染 Then 回落窗口节点估算', () => {
  const tree = render({ speedTarget: {}, target: null, nodes: [stepNode(500, 2000)], recentSpeed: { tps: null, steps: 0 } })
  assert.match(text(tree), /最近输出速度250 tok\/s/)
})

test('Given 投影带非数值 When 渲染 Then 视为无值回落估算', () => {
  const tree = render({ speedTarget: {}, target: null, nodes: [stepNode(500, 2000)], recentSpeed: { tps: '104', steps: 2 } })
  assert.match(text(tree), /最近输出速度250 tok\/s/)
})

// —— 费用条目点击展开:trigger 契约与开合状态机 ——
const panelNode = (tree) => nodes(tree).find((node) => node.type === 'cost-popover')
const bodyNode = (tree) => nodes(tree).find((node) => node.type === 'cost-body')

test('Given 费用可显示 When 渲染底栏 Then 费用是 aria-haspopup 按钮且默认收起', () => {
  const tree = render({ target: null })
  const button = nodes(tree).find((node) => node.type === 'button' && node.props['aria-haspopup'] === 'dialog')
  assert.ok(button, '费用条目应以展开按钮呈现')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(inlineText(button), '费用 ≈ ¥0.0020')
  assert.equal(button.props.type, 'button')
  assert.match(button.props['aria-label'], /费用 ≈ ¥0\.0020/)
  assert.equal(panelNode(tree), undefined)
})

test('Given 点击费用 When 展开 Then 面板挂载且按钮 aria-expanded 为真', () => {
  const view = mountInteractive()
  assert.equal(panelNode(view.tree()), undefined)
  const tree = view.click()
  assert.equal(view.trigger().props['aria-expanded'], true)
  const panel = panelNode(tree)
  assert.ok(panel, '点击后应挂载费用面板')
  // 锚点不再冻结成矩形:面板自己按 triggerRef 当前矩形定位,这里只锁触发件与关闭回调
  assert.equal(typeof panel.props.triggerRef, 'object')
  assert.equal(typeof panel.props.onClose, 'function')
})

test('Given 再次点击费用 When 收起 Then 面板卸载且 aria-expanded 复位', () => {
  const view = mountInteractive()
  view.click()
  const tree = view.click()
  assert.equal(view.trigger().props['aria-expanded'], false)
  assert.equal(panelNode(tree), undefined)
})

test('Given 宿主提供 useSessions When 展开 Then 面板携带会话数据面与当期用量', () => {
  const useSessions = () => ({ byId: {} })
  const view = mountInteractive({ useSessions, sessionId: 'sess-42' })
  const tree = view.click()
  assert.ok(panelNode(tree), '点击后应挂载费用面板')
  const body = bodyNode(tree)
  assert.equal(body.props.sessionId, 'sess-42')
  assert.equal(body.props.useSessions, useSessions)
  assert.deepEqual(body.props.usage, usage)
  assert.deepEqual(body.props.modelUsage, modelUsage)
})

test('Given 旧宿主无 useSessions When 展开 Then 面板仍挂载并透传缺失能力', () => {
  const view = mountInteractive({ useSessions: undefined })
  const tree = view.click()
  assert.ok(panelNode(tree))
  assert.equal(bodyNode(tree).props.useSessions, undefined)
})
