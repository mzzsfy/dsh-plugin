// 输入区常驻读数只在配置过成本口径时出现:定价与预算都没有时整行不渲染,
// 否则用户会看到一行既无金额也无剩余的空噪音。整源求值取 HudDockLine,
// useState 桩直接注入快照,免去真实订阅。
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const t = core.createTranslator(core.MESSAGES_ZH)
const INJECT_HOOK = "      inject: ['slots', 'locale', 'configForms'],"
const textOf = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))

function renderDock(snapshot, features = { dock: true, guard: true }) {
  let factory
  // 组件先读开关再读快照,stub 按调用序发值,不能一律返回快照
  const values = [features, snapshot]
  let call = 0
  const React = {
    createElement: (type, props, ...children) => ({
      type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false),
    }),
    memo: (fn) => fn,
    useState: () => [values[call++] ?? null, () => {}],
    useRef: () => ({ current: null }),
    useEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
  }
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace(INJECT_HOOK, `      __test: { HudDockLine, applyFeatures },\n${INJECT_HOOK}`)
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  const { HudDockLine, applyFeatures } = factory((name) => (name === 'react' ? React : {})).__test
  applyFeatures(features)
  return HudDockLine({ t })
}

const summaryWith = (currency) => ({ currency, today: { cost: 0, tokens: 0, requests: 0 }, cycle: { cost: 0, tokens: 0, requests: 0 }, ratePerHour: 0, spark: [] })
const budgetWith = (limit, enabled = true, spent = 0) => ({
  status: {
    enabled,
    action: 'none',
    currency: limit > 0 ? '¥' : null,
    budgets: limit > 0 ? [{ scope: 'daily', limit, spent, remaining: Math.max(0, limit - spent), ratio: spent / limit, state: 'ok', action: 'none' }] : [],
    eta: null,
  },
})

test('既无定价也无预算时乘积为 null,整行不渲染', () => {
  assert.equal(renderDock({ summary: summaryWith(null), budget: budgetWith(0) }), null)
})

test('快照未就绪时同样不渲染,避免先占位再消失', () => {
  assert.equal(renderDock(null), null)
  assert.equal(renderDock({ summary: null, budget: null }), null)
})

test('只有预算时给出纯数字的已用/限额', () => {
  const node = renderDock({ summary: summaryWith(null), budget: budgetWith(50) })
  assert.match(textOf(node), /今日 0 \/ 50/)
})

test('只有定价时只报今日花费,速率进 tooltip 不占主文本', () => {
  const node = renderDock({ summary: summaryWith('¥'), budget: budgetWith(0) })
  const label = textOf(node)
  assert.match(label, /今日 ≈¥0/)
  assert.doesNotMatch(label, /\/h/)
  assert.doesNotMatch(label, /·/)
})

test('护栏关闭时不显示额度,只报花费', () => {
  // 额度只在护栏启用时才是约束,关闭后显示「已用 / 总额度」会让人以为还在被限制
  const node = renderDock({ summary: summaryWith('¥'), budget: budgetWith(50, false) }, { dock: true, guard: false })
  const label = textOf(node)
  assert.match(label, /今日 ≈¥0/)
  assert.doesNotMatch(label, /\//)
})

test('护栏关闭且无额度时只剩今日花费', () => {
  const node = renderDock({ summary: summaryWith('¥'), budget: budgetWith(0, false) })
  const label = textOf(node)
  assert.match(label, /今日 ≈¥0/)
  assert.doesNotMatch(label, /\//)
})

test('定价与预算齐备时给出已用 / 总额度两个数,不做剩余换算', () => {
  const node = renderDock({ summary: summaryWith('¥'), budget: budgetWith(50) })
  const label = textOf(node)
  assert.match(label, /今日 ¥0 \/ ¥50/)
  assert.doesNotMatch(label, /剩余/)
  assert.doesNotMatch(label, /·/)
})

test('金额去掉尾随零:有小数保留,整数不补 .00', () => {
  const small = renderDock({ summary: summaryWith('¥'), budget: budgetWith(50, true, 0.35) })
  assert.match(textOf(small), /今日 ¥0\.35 \/ ¥50/)
  const half = renderDock({ summary: summaryWith('¥'), budget: budgetWith(12.5, true, 12.5) })
  assert.match(textOf(half), /今日 ¥12\.5 \/ ¥12\.5/)
})

test('开关关闭时整行不渲染', () => {
  assert.equal(renderDock({ summary: summaryWith('¥'), budget: budgetWith(50) }, { dock: false }), null)
})

test('读数注册在输入区工具行,不再挂输入框上方', () => {
  assert.ok(CLIENT_SOURCE.includes("ctx.slots.inject('conversation.input.right'"))
  assert.ok(!CLIENT_SOURCE.includes("ctx.slots.inject('conversation.input.dock'"))
})

test('只配周期限额时标签跟档位走,不把周期数据写成今日', () => {
  const monthly = {
    status: {
      enabled: true, action: 'none', currency: '¥', eta: null,
      budgets: [{ scope: 'monthly', limit: 800, spent: 540, remaining: 260, ratio: 0.675, state: 'ok', action: 'none' }],
    },
  }
  const label = textOf(renderDock({ summary: summaryWith('¥'), budget: monthly }))
  assert.match(label, /本周期 ¥540 \/ ¥800/)
  assert.doesNotMatch(label, /今日/)
})

test('读数不可点击:渲染为 span 且不带 onClick', () => {
  const node = renderDock({ summary: summaryWith('¥'), budget: budgetWith(50) })
  assert.equal(node.props.tag, 'span')
  assert.equal(node.props.onClick, undefined)
})

test('额度行的 tooltip 说口径,不复述正文数字', () => {
  // 按函数边界取整段,固定窗口会截掉尾部
  const start = CLIENT_SOURCE.indexOf('function hudBudgetRow')
  const end = CLIENT_SOURCE.indexOf('function HudSummaryBody')
  assert.ok(start > 0 && end > start)
  const row = CLIENT_SOURCE.slice(start, end)
  assert.match(row, /hudTipLimitScope/)
  // tooltip 的 text 实参不能直接复用正文那串表达式,否则提示零信息量
  assert.doesNotMatch(row, /text: valueText/)
})

test('无币种时剩余值不挂 tooltip', () => {
  const row = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('function hudBudgetRow'), CLIENT_SOURCE.indexOf('function HudSummaryBody'))
  assert.ok(row.includes('currency === null'), '应有 currency === null 分支')
  // 只取到 span 那一行行尾,别把 else 分支的 HintText 也算进来
  const start = row.indexOf('currency === null')
  const branch = row.slice(start, row.indexOf('\n', row.indexOf("h('span'", start)))
  assert.match(branch, /h\('span'/, '无币种分支要用纯 span')
  assert.doesNotMatch(branch, /HintText/, '无币种分支不能挂 HintText')
})

test('HUD 的三个定时器都判页面可见性', () => {
  const hud = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('function hudRefresh'))
  // 读数、折叠行、展开正文各一处:少一处就会在后台空转
  assert.equal([...hud.matchAll(/visibilityState !== 'hidden'/g)].length, 3)
})

test('护栏关闭时 tooltip 不含额度段', () => {
  const node = renderDock({ summary: summaryWith('¥'), budget: budgetWith(50, false) }, { dock: true, guard: false })
  const sections = node?.props?.sections ?? []
  assert.ok(!sections.some((section) => section.key === 'budget'), '关闭护栏后提示里不该出现额度段')
})

test('tooltip 的费用行先给 tokens 再给金额', () => {
  const snapshot = {
    summary: { currency: '¥', today: { cost: 24.28, tokens: 425_000_000 }, cycle: { from: '2026-10-16', to: '2026-11-15', cost: 711.48, tokens: 20_824_000_000 }, ratePerHour: 5.74, tokensPerHour: 586_000_000, spark: [] },
    budget: budgetWith(0),
  }
  const node = renderDock(snapshot)
  const cost = (node?.props?.sections ?? []).find((section) => section.key === 'cost')
  assert.ok(cost, '缺少费用段')
  const today = cost.rows.find((row) => row.key === 'today')
  assert.match(today.value, /^425\.00M · ¥24\.28$/)
  const month = cost.rows.find((row) => row.key === 'month')
  assert.match(month.value, /^20\.82B · ¥711\.48$/)
  // 速率行同样要给用量,只有金额看不出量级
  const rate = cost.rows.find((row) => row.key === 'rate')
  assert.match(rate.value, /^586\.00M\/h · ¥5\.74\/h$/)
})
