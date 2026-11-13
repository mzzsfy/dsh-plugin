// 汇总卡「会话数量」:数值取会话索引去重计数(stats.sessions),不再用回合数代理;
// 旧响应缺字段时回落 0。整源求值取 StatCards,React 以最小桩件驱动。
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const nodes = (node) => (!node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)])
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))

function renderCards(stats) {
  let factory
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) }),
    memo: (fn) => fn,
    useId: () => 'cards-test',
    useState: (seed) => [typeof seed === 'function' ? seed() : seed, () => {}],
    useRef: () => ({ current: null }),
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace("inject: ['slots', 'locale', 'configForms'],", "__test: { StatCards }, inject: ['slots', 'locale', 'configForms'],")
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  const { StatCards } = factory((name) => (name === 'react' ? React : {})).__test
  return StatCards({ stats, t: core.createTranslator(core.MESSAGES_ZH) })
}

const cardByLabel = (tree, label) => nodes(tree).find((node) => node.props?.label === label)

const BASE_STATS = {
  tokens: 16000,
  sessions: 7,
  turns: 130,
  requests: 42,
  cacheHit: 1000,
  cacheMiss: 3000,
  activeDays: 3,
  topModel: 'p/m',
}

test('Given 有会话索引计数 When 渲染汇总卡 Then 会话数量展示真实会话数而非回合数', () => {
  const cards = renderCards(BASE_STATS)
  const sessions = cardByLabel(cards, core.MESSAGES_ZH.sessions)
  assert.ok(sessions, '存在会话数量卡片')
  assert.match(text(sessions), /7/)
  assert.doesNotMatch(text(sessions), /130/)
})

test('Given 旧响应缺 sessions 字段 When 渲染 Then 回落 0 且不报错', () => {
  const { sessions: _omit, ...legacy } = BASE_STATS
  const card = cardByLabel(renderCards(legacy), core.MESSAGES_ZH.sessions)
  assert.match(text(card), /0/)
})

test('Given 卡片渲染 When 统计卡片集合 Then 仍为 6 张且会话卡带口径提示', () => {
  const cards = renderCards(BASE_STATS)
  const labels = nodes(cards).filter((node) => node.type?.name === 'Card')
  assert.equal(labels.length, 6)
  const sessions = cardByLabel(cards, core.MESSAGES_ZH.sessions)
  assert.equal(sessions.props.hint, core.MESSAGES_ZH.sessionsHint)
})

test('Given 中英文文案 When 读取会话卡提示 Then 两侧均已定义且说明排除子 agent', () => {
  assert.equal(typeof core.MESSAGES_ZH.sessionsHint, 'string')
  assert.equal(typeof core.MESSAGES_EN.sessionsHint, 'string')
  assert.match(core.MESSAGES_ZH.sessionsHint, /子 agent|子会话/)
  assert.match(core.MESSAGES_EN.sessionsHint, /subagent/i)
})
