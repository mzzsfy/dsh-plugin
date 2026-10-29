import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
const text = node => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')
const OTHER = core.OTHER_MODEL
const slot = {
  day: '2026-10-28', total: 16000, byModel: { 'p/a': 1000, 'p/b': 9000, [OTHER]: 6000 },
  otherByModel: { 'p/c': 2000, 'p/d': 4000 }, cost: 12,
  byCostModel: { 'p/a': 2, 'p/b': 9, [OTHER]: 1 }, otherCostByModel: { 'p/c': 0.75, 'p/d': 0.25 },
  cacheHit: 3000, cacheMiss: 1000, speed: 12, ttft: 300,
}

function fixture({ money = false, costDisplay = true, currency = '¥', lang = 'zh', data = [slot] } = {}) {
  let factory, cursor = 0
  const states = [], refs = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(x => x != null && x !== false) }),
    memo: fn => fn, useId: () => 'trend-test',
    useState(seed) {
      const i = cursor++
      if (!(i in states)) states[i] = typeof seed === 'function' ? seed() : seed
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
    },
    useRef(seed) { const i = cursor++; return refs[i] ??= { current: seed } },
    useEffect() {}, useLayoutEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
  }
  const window = { __ModuleLoader__: { load: entry => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace("inject: ['slots', 'locale'],", "__test: { TrendChart }, inject: ['slots', 'locale'],")
  new Function('window', 'localStorage', source)(window, { getItem: () => JSON.stringify({ costDisplay }), setItem() {} })
  const { TrendChart } = factory(name => name === 'react' ? React : {}).__test
  let tree
  const props = {
    title: 'trend', notes: [], slots: data, tipSlots: data, modelOrder: ['p/a', 'p/b', OTHER],
    colorFor: () => 'currentColor', labelFor: key => key, labelMinPitch: 60,
    legendModels: [], money, costCurrency: currency, t: core.createTranslator(lang === 'en' ? core.MESSAGES_EN : core.MESSAGES_ZH),
  }
  const render = () => {
    cursor = 0
    props.slots = props.money ? core.costSlotsOf(props.tipSlots) : props.tipSlots
    tree = TrendChart(props)
    return tree
  }
  const tip = () => nodes(tree).find(n => n.type?.name === 'ChartTip')
  const rows = () => nodes(tip()).filter(n => n.props.className?.includes('ud-tip-row')).map(text)
  const hover = (index = 0) => {
    nodes(tree).filter(n => n.props.className === 'ud-bar-hit')[index].props.onMouseEnter({ clientX: 20, clientY: 20 })
    render()
  }
  const select = (key, ctrl = false) => {
    nodes(tree).find(n => n.type?.name === 'Legend').props.onItem(key, ctrl)
    render()
  }
  render()
  return { hover, select, rows, tip: () => text(tip()), update: changes => { Object.assign(props, changes); render() } }
}

test('Given 金额视图 When 悬浮 Then 总计和各模型展示估算费用，其他明细按费用排序', () => {
  const f = fixture({ money: true }); f.hover()
  assert.deepEqual(f.rows().slice(0, 5), ['估算费用: ≈ ¥12.00', 'p/a: ≈ ¥2.00', 'p/b: ≈ ¥9.00', '其他: ≈ ¥1.00', 'p/c: ≈ ¥0.75'])
  assert.ok(f.rows().includes('p/d: ≈ ¥0.25'))
  assert.doesNotMatch(f.tip(), /16,000|9,000|6,000/)
})

test('Given Token 视图 When 单选模型 Then 总计、费用、均价仅包含可见模型', () => {
  const f = fixture(); f.hover(); f.select('p/a')
  assert.deepEqual(f.rows(), ['所选用量: 1,000 tok', 'p/a: 1,000 tok', '≈ ¥2.00', '均价: ¥2,000.000/M'])
})

test('Given 金额视图 When Ctrl 多选包含其他 Then 合计不重复计其他子项', () => {
  const f = fixture({ money: true }); f.hover(); f.select('p/a'); f.select(OTHER, true)
  assert.equal(f.rows()[0], '所选估算费用: ≈ ¥3.00')
  assert.doesNotMatch(f.tip(), /p\/b:/)
  assert.ok(f.rows().includes('均价: ¥428.571/M'))
})

for (const [key, label, value] of [['speed', '平均生成速度', '12 tok/s'], ['rate', '缓存命中率', '75.0%'], ['ttft', '首 token 延迟', '0.3秒']]) {
  test(`Given 仅选 ${key} 曲线 When 悬浮 Then 只有时段整体指标且不显示模型合计或费用`, () => {
    const f = fixture({ money: true }); f.hover(); f.select(key)
    assert.match(f.tip(), /时段整体指标/)
    assert.deepEqual(f.rows(), [`${label}: ${value}`])
  })
}

test('Given 有其他付费槽和零费用模型 When 在金额视图选择零费用模型 Then 保留零费用读数', () => {
  const data = [{ ...slot, byCostModel: { ...slot.byCostModel, 'p/a': 0 }, cost: 10 }]
  const f = fixture({ money: true, data }); f.hover(); f.select('p/a')
  assert.deepEqual(f.rows(), ['所选估算费用: ≈ ¥0.00', 'p/a: ≈ ¥0.00'])
})

test('Given 当前槽中选中模型没有用量 When 悬浮 Then 不展示隐藏模型总计或空提示', () => {
  const f = fixture({ data: [{ ...slot, byModel: { ...slot.byModel, 'p/a': 0 } }] }); f.hover(); f.select('p/a')
  assert.equal(f.tip(), '')
})

test('Given 辅助费用偏好关闭 When 切换金额视图 Then 主金额读数仍展示并响应货币变化', () => {
  const f = fixture({ costDisplay: false }); f.hover(); f.select('p/a')
  assert.deepEqual(f.rows(), ['所选用量: 1,000 tok', 'p/a: 1,000 tok'])
  f.update({ money: true, costCurrency: '$' })
  assert.deepEqual(f.rows(), ['所选估算费用: ≈ $2.00', 'p/a: ≈ $2.00', '均价: $2,000.000/M'])
})

test('Given 悬浮时间桶 When 切换到不含该桶的窗口 Then 清除提示而不复用数组下标', () => {
  const f = fixture(); f.hover()
  f.update({ tipSlots: [{ ...slot, day: '2026-10-27' }] })
  assert.equal(f.tip(), '')
})

test('Given 悬浮时间桶 When 窗口前插时间桶 Then 提示仍绑定原时间桶', () => {
  const f = fixture(); f.hover()
  f.update({ tipSlots: [{ ...slot, day: '2026-10-27' }, slot] })
  assert.match(f.tip(), /^2026-10-28/)
})

test('Given 英文金额视图 When 单选模型 Then 使用英文费用标签及当前货币', () => {
  const f = fixture({ money: true, lang: 'en', currency: '$' }); f.hover(); f.select('p/a')
  assert.equal(f.rows()[0], 'Selected estimated cost: ≈ $2.00')
})

for (const [key, label, value] of [['speed', '平均生成速度', '0 tok/s'], ['ttft', '首 token 延迟', '0秒']]) {
  test(`Given 只有 timing 的时间桶 When 仅选 ${key} Then 零值指标仍显示提示`, () => {
    const timing = { ...slot, total: 0, byModel: {}, cost: 0, byCostModel: {}, cacheHit: 0, cacheMiss: 0, speed: 0, ttft: 0 }
    const f = fixture({ data: [timing] }); f.select(key); f.hover()
    assert.deepEqual(f.rows(), [`${label}: ${value}`])
  })
}

for (const key of ['speed', 'ttft', 'rate']) {
  test(`Given 所选 ${key} 在当前桶没有数据 When 悬浮 Then 不显示空指标提示`, () => {
    const emptyMetrics = { ...slot, day: '2026-10-27', speed: undefined, ttft: undefined, cacheHit: 0, cacheMiss: 0 }
    const f = fixture({ data: [emptyMetrics, slot] }); f.select(key); f.hover()
    assert.equal(f.tip(), '')
  })
}

test('Given 单选旧模型 When 新窗口不含该模型 Then 恢复默认可见模型且能继续单选', () => {
  const f = fixture(); f.select('p/a'); f.hover()
  f.update({ tipSlots: [{ ...slot, total: 100, byModel: { 'p/z': 100 }, cost: 1, byCostModel: { 'p/z': 1 } }], modelOrder: ['p/z'] })
  assert.ok(f.rows().includes('p/z: 100 tok'))
  assert.equal(f.rows()[0], '总用量: 100 tok')
  f.select('p/z')
  assert.ok(f.rows().includes('p/z: 100 tok'))
})

test('Given 单选速度 When 新窗口没有速度 Then 恢复可用模型', () => {
  const f = fixture(); f.select('speed'); f.hover()
  f.update({ tipSlots: [{ ...slot, speed: undefined }] })
  assert.ok(f.rows().includes('p/a: 1,000 tok'))
  assert.doesNotMatch(f.tip(), /平均生成速度:/)
})

test('Given 小时桶悬浮 When 切到分钟桶 Then 旧提示清除且新提示显示分钟桶数据', () => {
  const f = fixture({ data: [{ ...slot, day: '2026-10-28T12' }] }); f.hover()
  f.update({ tipSlots: [{ ...slot, day: '2026-10-28T12:10' }] })
  assert.equal(f.tip(), '')
  f.hover()
  assert.match(f.tip(), /^2026-10-28T12:10/)
})

test('Given 单选模型在新窗口全部失效 When 返回原窗口 Then 保持默认显示而不复活旧单选', () => {
  const f = fixture(); f.select('p/a'); f.hover()
  f.update({ tipSlots: [{ ...slot, total: 100, byModel: { 'p/z': 100 }, cost: 1, byCostModel: { 'p/z': 1 } }], modelOrder: ['p/z'] })
  f.update({ tipSlots: [slot], modelOrder: ['p/a', 'p/b', OTHER] })
  assert.equal(f.rows()[0], '总用量: 16,000 tok')
  assert.ok(f.rows().includes('p/b: 9,000 tok'))
})

test('Given 多选中部分模型在新窗口失效 When 返回原窗口 Then 只保留未失效的选择', () => {
  const f = fixture(); f.select('p/a'); f.select('p/b', true); f.hover()
  f.update({ tipSlots: [{ ...slot, total: 1000, byModel: { 'p/a': 1000 }, cost: 2, byCostModel: { 'p/a': 2 } }], modelOrder: ['p/a'] })
  f.update({ tipSlots: [slot], modelOrder: ['p/a', 'p/b', OTHER] })
  assert.equal(f.rows()[0], '所选用量: 1,000 tok')
  assert.doesNotMatch(f.tip(), /p\/b:/)
})

test('Given 未配置费用 When 悬浮 Token 视图 Then 只展示用量及有效曲线', () => {
  const { cost, byCostModel, otherCostByModel, ...unpriced } = slot
  const f = fixture({ data: [unpriced] }); f.select('p/a'); f.hover()
  assert.deepEqual(f.rows(), ['所选用量: 1,000 tok', 'p/a: 1,000 tok'])
})
