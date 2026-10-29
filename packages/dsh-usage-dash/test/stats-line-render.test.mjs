import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const usage = { uncachedInputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 0, outputTokens: 500 }
const on = { cachePrecision: true, tokenDetail: true, costDisplay: true }
const rules = [{ model: '*/*', currency: '¥', price: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 }, conditions: [] }]

function render(options = {}) {
  const { prefs = on, lang = 'zh', pricing = rules, target = {} } = options
  const value = Object.hasOwn(options, 'value') ? options.value : usage
  const source = CLIENT_BODY.match(/const StatsLineAppended = React\.memo\(([\s\S]*?)\n    \}\)/)?.[1] + '\n}'
  let stateIndex = 0
  const React = { Fragment: 'fragment', useId: () => ':test:' }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) })
  const useState = (init) => [stateIndex++ === 1 ? pricing : typeof init === 'function' ? init() : init, () => {}]
  const noop = () => {}
  const names = Object.keys(core)
  const component = new Function(...names, 'React', 'h', 'useState', 'useEffect', 'useLayoutEffect', 'useRef', 'statsLineState', 'defaultT', 'usePricing', 'useUsageDialogTarget', 'createPortal', `return (${source})`)(...Object.values(core), React, h, useState, noop, noop, () => ({ current: null }), { get: () => prefs }, core.createTranslator(core.MESSAGES_ZH), () => ({ rules: pricing }), () => target, (content, container) => ({ type: 'portal', props: { container }, children: [content].flat(Infinity) }))
  return component({ useProjection: () => value, t: core.createTranslator(lang === 'en' ? core.MESSAGES_EN : core.MESSAGES_ZH) })
}
const nodes = (tree) => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []
const text = (tree) => typeof tree === 'string' ? tree : tree?.children.map(text).join('') ?? ''
const inlineText = (tree) => tree?.type === 'portal' ? '' : typeof tree === 'string' ? tree : tree?.children.map(inlineText).join('') ?? ''

test('Given 旧三开偏好 When 渲染 Then 底栏只有费用，补充项追加到官方弹窗', () => {
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
