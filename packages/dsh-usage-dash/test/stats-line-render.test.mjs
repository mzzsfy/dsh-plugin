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

function render(options = {}) {
  const { prefs = on, lang = 'zh', pricing = rules, target = {}, speedTarget = null, nodes = [], capture = {}, recentSpeed = undefined } = options
  const value = Object.hasOwn(options, 'value') ? options.value : usage
  const source = CLIENT_BODY.match(/const StatsLineAppended = React\.memo\(([\s\S]*?)\n    \}\)/)?.[1] + '\n}'
  let stateIndex = 0
  const React = { Fragment: 'fragment', useId: () => ':test:' }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) })
  const useState = (init) => [stateIndex++ === 1 ? pricing : typeof init === 'function' ? init() : init, () => {}]
  const noop = () => {}
  const names = Object.keys(core)
  // 悬浮包装件在整源求值区之外(组件区),测试只关心文本与结构,用保留类名与子节点的桩
  const HintText = (props) => h('span', { className: props.className }, props.children)
  const component = new Function(...names, 'React', 'h', 'useState', 'useEffect', 'useLayoutEffect', 'useRef', 'statsLineState', 'defaultT', 'usePricing', 'useUsageDialogTarget', 'useSpeedDialogTarget', 'useSpeedCapsulePatch', 'createPortal', 'HintText', 'useChat', `return (${source})`)(...Object.values(core), React, h, useState, noop, noop, () => ({ current: null }), { get: () => prefs }, core.createTranslator(core.MESSAGES_ZH), () => ({ rules: pricing }), () => target, () => speedTarget, (ref, text) => { capture.text = text }, (content, container) => ({ type: 'portal', props: { container }, children: [content].flat(Infinity) }), HintText, (selector) => selector({ legacy: { nodes } }))
  return component({
    useProjection: (key) => (key === 'usageDashModelUsage' ? modelUsage : key === 'usageDashRecentSpeed' ? recentSpeed : value),
    useChat: (selector) => selector({ legacy: { nodes } }),
    t: core.createTranslator(lang === 'en' ? core.MESSAGES_EN : core.MESSAGES_ZH),
  })
}
const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []
const text = (tree) => typeof tree === 'string' ? tree : tree?.children.map(text).join('') ?? ''
const inlineText = (tree) => tree?.type === 'portal' ? '' : typeof tree === 'string' ? tree : tree?.children.map(inlineText).join('') ?? ''

test('Given 默认偏好 When 渲染 Then 底栏只有费用，补充项追加到官方弹窗', () => {
  const target = {}
  const tree = render({ target })
  assert.equal(inlineText(tree), '费用 ≈ ¥0.0020')
  assert.equal(nodes(tree).filter((n) => n.type === 'button' || n.props.popover).length, 0)
  const portal = nodes(tree).find((n) => n.type === 'portal')
  assert.equal(portal.props.container, target)
  assert.doesNotMatch(text(portal), /命中率/)
  assert.match(text(portal), /输入合计（含缓存）5,000 tok/)
  assert.doesNotMatch(text(portal), /总 |输出|未命中缓存|命中缓存/)
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

test('Given 替换默认速度开关 When 渲染 Then 胶囊补丁只接管开启且有读数的场景', () => {
  const onCapture = {}
  render({ capture: onCapture, prefs: { ...on, replaceSpeed: true }, speedTarget: {}, nodes: [stepNode(500, 2000)] })
  assert.equal(onCapture.text, '250 tok/s')
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
