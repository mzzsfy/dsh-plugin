// 跨组件悬浮联动:图例/模型行悬停驱动趋势柱段高亮,共用面板级 hoverModel。
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const nodes = (node) => (!node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)])
const classesOf = (node) => nodes(node)
  .map((item) => item.props?.className)
  .filter((name) => typeof name === 'string')
  .flatMap((name) => name.split(' '))

function load(extra) {
  let factory
  let cursor = 0
  const states = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) }),
    memo: (fn) => fn,
    useId: () => ':hover-test:',
    useState(seed) {
      const i = cursor++
      if (!(i in states)) states[i] = typeof seed === 'function' ? seed() : seed
      return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
    },
    useRef: () => ({ current: null }),
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
  }
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace(
    "inject: ['slots', 'locale', 'configForms'],",
    `__test: { ${extra.join(', ')} }, inject: ['slots', 'locale', 'configForms'],`,
  )
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  return factory((name) => (name === 'react' ? React : {})).__test
}

function render(component, props) {
  return component({ t: core.createTranslator(core.MESSAGES_ZH), ...props })
}

test('图例项悬停回调联动模型,离开清空,激活项带高亮类', () => {
  const { Legend } = load(['Legend'])
  const calls = []
  const models = [{ model: 'p/a', tokens: 10 }, { model: 'p/b', tokens: 20 }]
  const base = { models, colorFor: () => 'currentColor', isVisible: () => true, onHoverModel: (model) => calls.push(model) }
  const tree = render(Legend, { ...base, activeModel: 'p/a' })
  // 命中率图例项不带模型联动回调,按回调存在性筛模型项
  const items = nodes(tree).filter((node) => String(node.props?.className).startsWith('ud-legend-item') && node.props.onMouseEnter)
  assert.equal(items.length, 2)
  assert.match(String(items[0].props.className), /ud-legend-item--on/)
  assert.doesNotMatch(String(items[1].props.className), /ud-legend-item--on/)
  items[0].props.onMouseEnter()
  items[0].props.onMouseLeave()
  assert.deepEqual(calls, ['p/a', null])
})

test('趋势柱段:激活模型之外的柱段降透明,同模型保持原样', () => {
  const { TrendChart } = load(['TrendChart'])
  const slot = { day: '2026-11-10', total: 30, byModel: { 'p/a': 10, 'p/b': 20 }, cost: 1, cacheHit: 1, cacheMiss: 1 }
  const tree = render(TrendChart, {
    title: 'trend', notes: [], slots: [slot], tipSlots: [slot],
    modelOrder: ['p/a', 'p/b'], colorFor: () => 'currentColor', labelFor: (key) => key,
    slotLabelFor: (key) => key, labelMinPitch: 60, legendModels: [{ model: 'p/a', tokens: 10 }, { model: 'p/b', tokens: 20 }],
    activeModel: 'p/a',
  })
  const bars = nodes(tree).filter((node) => String(node.props?.className).split(' ').includes('ud-bar'))
  assert.equal(bars.length, 2)
  const dim = bars.filter((node) => String(node.props.className).includes('ud-bar--dim'))
  assert.equal(dim.length, 1)
  assert.equal(dim[0].props.fill, 'currentColor')
  assert.ok(bars.some((node) => !String(node.props.className).includes('--dim')))
})

test('模型行悬停回调联动模型,未知节点不误触发', () => {
  const { ModelUsage } = load(['ModelUsage'])
  const calls = []
  const models = [{ model: 'p/a', tokens: 10, cost: 1 }, { model: 'p/b', tokens: 20, cost: 2 }]
  const tree = render(ModelUsage, {
    models, colorFor: () => 'currentColor', onHoverModel: (model) => calls.push(model),
  })
  const row = nodes(tree).find((node) => String(node.props?.className).split(' ').includes('ud-model-row'))
  row.props.onMouseEnter()
  row.props.onMouseLeave()
  assert.deepEqual(calls, ['p/a', null])
})

test('无联动回调时图例与模型行仍可渲染,不抛错', () => {
  const { Legend, ModelUsage } = load(['Legend', 'ModelUsage'])
  const models = [{ model: 'p/a', tokens: 10 }]
  const legend = render(Legend, { models, colorFor: () => 'currentColor', isVisible: () => true })
  assert.ok(classesOf(legend).includes('ud-legend'))
  const usage = render(ModelUsage, { models, colorFor: () => 'currentColor' })
  assert.ok(nodes(usage).length > 0)
})
