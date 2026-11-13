// 悬浮内容模型渲染:标题 + 分区 + 两列标签/数值;子项弱化;空内容安全。
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const nodes = (node) => (!node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)])
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))
const classesOf = (node) => nodes(node).map((item) => item.props?.className).filter(Boolean)

function renderTip(props) {
  let factory
  const React = {
    createElement: (type, p, ...children) => ({ type, props: p ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false) }),
    memo: (fn) => fn,
    useId: () => 'tip-test',
    useState: (seed) => [typeof seed === 'function' ? seed() : seed, () => {}],
    useRef: () => ({ current: null }),
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
  }
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace("inject: ['slots', 'locale', 'configForms'],", "__test: { TipBody }, inject: ['slots', 'locale', 'configForms'],")
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  const { TipBody } = factory((name) => (name === 'react' ? React : {})).__test
  return TipBody(props)
}

test('标题与两列行:标签与数值分列渲染,数值文本完整', () => {
  const tree = renderTip({
    title: '2026-11-10',
    sections: [{ key: 'main', rows: [
      { key: 'tokens', label: 'Tokens 用量', value: '16,000' },
      { key: 'requests', label: '请求数量', value: '42' },
    ] }],
  })
  assert.match(text(tree), /2026-11-10/)
  assert.match(text(tree), /Tokens 用量/)
  assert.match(text(tree), /16,000/)
  const labels = nodes(tree).filter((node) => node.props?.className === 'ud-tip-label')
  const values = nodes(tree).filter((node) => node.props?.className === 'ud-tip-value')
  assert.equal(labels.length, 2)
  assert.equal(values.length, 2)
})

test('分区标题与子项:组标题渲染,子项带弱化类', () => {
  const tree = renderTip({
    sections: [
      { key: 'models', label: '模型', rows: [{ key: 'a', label: 'p/a', value: '1,000', swatch: '#abc' }] },
      { key: 'metrics', rows: [{ key: 'rate', label: '缓存命中率', value: '75.00%', sub: true }] },
    ],
  })
  const classes = classesOf(tree)
  assert.ok(classes.includes('ud-tip-section-title'))
  assert.equal(classes.filter((name) => name === 'ud-tip-section').length, 2)
  assert.ok(classes.some((name) => name.split(' ').includes('ud-tip-item--sub')))
})

test('无标题时只渲染分区;空 sections 不产生内容行', () => {
  const tree = renderTip({ sections: [{ key: 'only', rows: [{ key: 'a', label: 'L', value: 'V' }] }] })
  assert.equal(classesOf(tree).includes('ud-tip-title'), false)
  assert.equal(text(renderTip({ sections: [] })), '')
})

test('子项带色块时渲染 swatch 且沿用图例色块类', () => {
  const tree = renderTip({ sections: [{ key: 'm', rows: [{ key: 'a', label: 'p/a', value: '1', swatch: 'var(--ud-chart-1)' }] }] })
  const swatch = nodes(tree).find((node) => node.props?.className === 'ud-legend-swatch')
  assert.ok(swatch)
  assert.equal(swatch.props.style.background, 'var(--ud-chart-1)')
})
