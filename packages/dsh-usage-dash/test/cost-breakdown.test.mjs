import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const {
  subagentDescendantIds,
  subagentHoursOf,
  modelCostBreakdownOf,
  selfCostBreakdownOf,
  subagentCostBreakdownOf,
  costTotalsOf,
  costPanelModelOf,
  costPanelViewOf,
  buildSessionCostItem,
  createTranslator,
  MESSAGES_ZH,
  MESSAGES_EN,
} = core

const zhT = createTranslator(MESSAGES_ZH)
const enT = createTranslator(MESSAGES_EN)

const rule = (model, value, conditions = []) => ({ model, unit: 'perMillion', currency: '¥', price: value, conditions })
const price = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite })
const rules = [rule('a/b', price(1, 2, 0.5, 0))]
const at = (hour = 9) => new Date(2026, 10, 12, hour).getTime()
const bucket = (overrides = {}) => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
})
const prefs = { costDisplay: true }

// —— 子代理身份:只认 origin=subagent,fork/孤儿/环都要有定义 ——
test('Given 子代理多级树 When 枚举后代 Then 只含 origin=subagent 的后代,fork 与孤儿不计', () => {
  const byId = {
    A: { id: 'A', displayTitle: 'Root' },
    B: { id: 'B', origin: 'subagent', parentId: 'A' },
    C: { id: 'C', origin: 'subagent', parentId: 'B' },
    D: { id: 'D', parentId: 'A' },
    E: { id: 'E', origin: 'subagent', parentId: 'Z' },
  }
  assert.deepEqual(subagentDescendantIds(byId, 'A'), ['B', 'C'])
})

test('Given 父子关系成环 When 枚举后代 Then 终止且不把根当后代', () => {
  const byId = {
    X: { id: 'X', origin: 'subagent', parentId: 'Y' },
    Y: { id: 'Y', origin: 'subagent', parentId: 'X' },
  }
  assert.deepEqual(subagentDescendantIds(byId, 'X'), ['Y'])
})

test('Given 无 byId 或根缺席 When 枚举后代 Then 返回空表', () => {
  assert.deepEqual(subagentDescendantIds(null, 'A'), [])
  assert.deepEqual(subagentDescendantIds({ A: { id: 'A' } }, 'missing'), [])
})

// —— 子代理小时数据:列在 projectionsBySession(列表行 summary 没有),合并后计数缺失 ——
test('Given 子代理小时在投影仓 When 收集 Then 合并所有小时桶,无数据的子代理单独计数', () => {
  const h1 = [{ time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 100 }) }]
  const h2 = [{ time: at(10), model: 'c/d', ...bucket({ outputTokens: 200 }) }]
  const byId = {
    A: { id: 'A' },
    B: { id: 'B', origin: 'subagent', parentId: 'A', projectionValues: { usageDashModelUsage: { hours: h1 } } },
    C: { id: 'C', origin: 'subagent', parentId: 'A' },
    D: { id: 'D', origin: 'subagent', parentId: 'A' },
  }
  const projections = { C: { values: { usageDashModelUsage: { hours: h2 } } } }
  const collected = subagentHoursOf(byId, 'A', projections)
  assert.equal(collected.hours.length, 2)
  assert.equal(collected.missing, 1)
  // 行 summary 上没有该键时(插件投影 summary:false)取不到,只能靠投影仓
  assert.equal(subagentHoursOf(byId, 'A').missing, 2)
})

// —— 按模型聚合:每模型一行,只算一次 ——
test('Given 同模型多小时 When 聚合计价 Then 四桶相加为一行且按最新用量时刻命中单价', () => {
  const timed = [
    rule('a/b', price(1, 0, 0, 0), [{ kind: 'dailyWindow', from: '09:00', to: '09:59' }]),
    rule('a/b', price(2, 0, 0, 0), [{ kind: 'dailyWindow', from: '10:00', to: '10:59' }]),
  ]
  const breakdown = modelCostBreakdownOf([
    { time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1000 }) },
    { time: at(10), model: 'a/b', ...bucket({ uncachedInputTokens: 1000 }) },
  ], timed)
  // 2000 × ¥2(最新时刻 10:00 的价)/ 1e6 = 0.004,不是逐桶 0.001+0.002
  assert.deepEqual(breakdown.rows.map((row) => [row.model, row.cost]), [['a/b', 0.004]])
  assert.equal(breakdown.total, 0.004)
})

test('Given 多模型多小时 When 聚合计价 Then 每模型一行且按模型名稳定排序', () => {
  const breakdown = modelCostBreakdownOf([
    { time: at(9), model: 'z/z', ...bucket({ outputTokens: 1000 }) },
    { time: at(10), model: 'a/b', ...bucket({ uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 }) },
    { time: at(11), model: 'z/z', ...bucket({ outputTokens: 1000 }) },
  ], rules)
  assert.deepEqual(breakdown.rows.map((row) => row.model), ['a/b'])
  // a/b:(1000×1 + 500×2 + 2000×0.5)/1e6 = 0.003;z/z 聚合 2000 输出 ×2 /1e6 = 0.004(无 z/z 规则→未定价)
  assert.deepEqual(breakdown.rows.map((row) => row.cost), [0.003])
  assert.deepEqual(breakdown.unpricedModels, ['z/z'])
  assert.equal(breakdown.total, 0.003)
})

test('Given 空用量桶 When 聚合 Then 跳过不产生空行', () => {
  const breakdown = modelCostBreakdownOf([{ time: at(9), model: 'a/b', ...bucket() }], rules)
  assert.deepEqual(breakdown.rows, [])
  assert.deepEqual(breakdown.unpricedModels, [])
  assert.equal(breakdown.total, 0)
})

test('Given 投影有小时桶 When 生成当期档 Then 走按模型聚合而非单路由', () => {
  const breakdown = selfCostBreakdownOf({ routes: [{ provider: 'a', model: 'b' }] }, {
    hours: [{ time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1000 }) }],
  }, rules, new Date(at(9)))
  assert.equal(breakdown.fallback, false)
  assert.deepEqual(breakdown.rows.map((row) => row.model), ['a/b'])
  assert.equal(breakdown.total, 0.001)
})

test('Given 投影缺席 When 生成当期档 Then 单路由兜底并标记', () => {
  const breakdown = selfCostBreakdownOf({ routes: [{ provider: 'a', model: 'b' }], ...bucket({ outputTokens: 1000 }) }, null, rules, new Date(at(9)))
  assert.equal(breakdown.fallback, true)
  assert.equal(breakdown.total, 0.002)
  assert.equal(breakdown.unpricedModels.length, 0)
})

test('Given 单路由且当前模型无价 When 生成当期档 Then 标记 unpricedSession', () => {
  const breakdown = selfCostBreakdownOf({ routes: [{ provider: 'x', model: 'y' }], ...bucket({ outputTokens: 1000 }) }, null, rules, new Date(at(9)))
  assert.equal(breakdown.unpricedSession, true)
  assert.deepEqual(breakdown.rows, [])
})

test('Given 多个子代理 When 生成子代理档 Then 合并小时桶按模型聚合且缺失计数', () => {
  const byId = {
    A: { id: 'A' },
    B: { id: 'B', origin: 'subagent', parentId: 'A', projectionValues: { usageDashModelUsage: { hours: [{ time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1000 }) }] } } },
    C: { id: 'C', origin: 'subagent', parentId: 'A', projectionValues: { usageDashModelUsage: { hours: [{ time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1000 }) }] } } },
    D: { id: 'D', origin: 'subagent', parentId: 'A' },
  }
  const breakdown = subagentCostBreakdownOf(byId, 'A', {}, rules)
  // 两个子代理同为 a/b:1000+1000 = 2000 → ¥0.002,一行
  assert.deepEqual(breakdown.rows.map((row) => [row.model, row.cost]), [['a/b', 0.002]])
  assert.equal(breakdown.missing, 1)
})

test('Given 两档明细 When 合成合计 Then 含子代理为当期与子代理之和', () => {
  const totals = costTotalsOf({ total: 0.003 }, { total: 0.004 })
  assert.deepEqual(totals, { self: 0.003, subagents: 0.004, combined: 0.007 })
  assert.deepEqual(costTotalsOf(null, null), { self: 0, subagents: 0, combined: 0 })
})

// —— 面板模型与视图 ——
const panelModel = (overrides = {}) => costPanelModelOf({
  usage: { routes: [{ provider: 'a', model: 'b' }] },
  modelUsage: { hours: [{ time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 }) }] },
  rules,
  subagentHours: [],
  subagentMissing: 0,
  now: new Date(at(9)),
  ...overrides,
})

test('Given 小时投影 When 生成面板模型 Then 两档按模型聚合且合计同源', () => {
  const model = panelModel({
    subagentHours: [
      { time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1000 }) },
      { time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1000 }) },
    ],
  })
  assert.equal(model.self.total, 0.003)
  // 子代理 2000 × ¥1 /1e6 = 0.002,同一模型只一行
  assert.equal(model.subs.total, 0.002)
  assert.deepEqual(model.subs.rows.map((row) => row.model), ['a/b'])
  assert.equal(model.totals.combined, 0.005)
})

test('Given 面板模型 When 生成视图 Then 两档金额、模型行与脚注可读', () => {
  const view = costPanelViewOf(panelModel(), zhT, { subagentsAvailable: true })
  assert.equal(view.title, '费用估算明细')
  assert.deepEqual(view.totals.map((row) => [row.label, row.value]), [['当期会话', '≈ ¥0.0030'], ['含子代理', '≈ ¥0.0030']])
  // 不再有「计算公式」区块:每行表达式已给出算法
  assert.equal('formula' in view, false)
  const row = view.sections[0].rows[0]
  assert.equal(row.key, 'a/b')
  assert.equal(row.model, 'a/b')
  assert.equal(row.amount, '¥0.0030')
  assert.equal(row.expression, '1,000×¥1.00 + 500×¥2.00 + 2,000×¥0.50 + 0×¥0.00')
  // 面板公式按缩写显示,悬浮项带完整 token、单价、金额与命中规则
  assert.deepEqual(row.terms.map((term) => term.short), ['1.00K×¥1.00', '500×¥2.00', '2.00K×¥0.50', '0×¥0.00'])
  assert.equal(row.terms[0].label, '未缓存输入')
  assert.equal(row.terms[0].detail, '1,000 × ¥1.00/M = ¥0.0010')
  assert.equal(row.terms[0].rule, 'a/b')
  assert.equal(view.sections[1].empty, '暂无子代理用量')
  assert.deepEqual(view.footnotes, ['估算值,不构成账单;每模型按最新用量时刻匹配单价'])
})

test('Given 未定价模型与缺失子代理 When 生成视图 Then 脚注按模型计数且空态不矛盾', () => {
  const model = panelModel({
    usage: { routes: [{ provider: 'x', model: 'y' }] },
    modelUsage: { hours: [{ time: at(9), model: 'x/y', ...bucket({ outputTokens: 10 }) }] },
    subagentMissing: 2,
  })
  const view = costPanelViewOf(model, zhT, { subagentsAvailable: true })
  assert.match(view.footnotes.join(','), /1 个模型未定价/)
  assert.match(view.footnotes.join(','), /2 个子代理未取到用量/)
  assert.equal(view.sections[1].empty, null)
})

test('Given 单路由兜底且无价 When 生成视图 Then 当前模型未定价且不报模型计数', () => {
  const view = costPanelViewOf(panelModel({ modelUsage: null, usage: { routes: [{ provider: 'x', model: 'y' }], ...bucket({ outputTokens: 1000 }) } }), zhT, { subagentsAvailable: true })
  assert.equal(view.totals[0].value, '—')
  assert.equal(view.sections[0].note, '投影缺席,按当前模型整体估算')
  assert.deepEqual(view.footnotes, ['估算值,不构成账单;每模型按最新用量时刻匹配单价', '当前模型未定价,按占位符显示'])
})

test('Given 宿主无会话列表 When 生成视图 Then 只列当期档并说明子代理不可统计', () => {
  const view = costPanelViewOf(panelModel(), zhT, { subagentsAvailable: false })
  assert.deepEqual(view.totals.map((row) => row.key), ['self'])
  assert.equal(view.sections[1].empty, '宿主未提供会话列表,无法统计子代理')
})

test('Given 单价带三位以上小数 When 生成视图 Then 表达式按原值展示保证可手算复核', () => {
  const precise = [rule('a/b', price(0.123, 0.456, 0.0007, 0.0021))]
  const view = costPanelViewOf(panelModel({ rules: precise, usage: null, modelUsage: { hours: [{ time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }) }] } }), zhT, { subagentsAvailable: true })
  const row = view.sections[0].rows[0]
  assert.equal(row.expression, '1,000,000×¥0.123 + 1,000,000×¥0.456 + 1,000,000×¥0.0007 + 1,000,000×¥0.0021')
  assert.equal(row.amount, '¥0.5818')
})

test('Given 亿级 token When 生成视图 Then 公式缩写两位小数且悬浮给完整值', () => {
  const view = costPanelViewOf(panelModel({
    rules: [rule('a/b', price(0.03, 0.03, 0.03, 0))],
    usage: null,
    modelUsage: { hours: [{ time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 113_481_991, outputTokens: 330_455 }) }] },
  }), zhT, { subagentsAvailable: true })
  const row = view.sections[0].rows[0]
  assert.deepEqual(row.terms.map((term) => term.short), ['113.48M×¥0.03', '330.46K×¥0.03', '0×¥0.03', '0×¥0.00'])
  assert.equal(row.terms[0].detail, '113,481,991 × ¥0.03/M = ¥3.4045')
})

test('Given 条件规则命中 When 生成视图 Then 悬浮项带规则与条件摘要', () => {
  const conditional = [{
    model: 'a/b', unit: 'perMillion', currency: '¥', price: price(1, 2, 0.5, 0),
    conditions: [{ kind: 'dailyWindow', from: '00:00', to: '23:59' }],
  }]
  const view = costPanelViewOf(panelModel({ rules: conditional }), zhT, { subagentsAvailable: true })
  assert.equal(view.sections[0].rows[0].terms[0].rule, 'a/b · 00:00–23:59')
})

test('Given 两个模型各自多次用量 When 生成视图 Then 行金额四位小数且合计等于两行之和', () => {
  const model = costPanelModelOf({
    usage: null,
    modelUsage: {
      hours: [
        { time: at(9), model: 'echo-openai/echo-model', ...bucket({ uncachedInputTokens: 3000, outputTokens: 600 }) },
        { time: at(9), model: 'echo-openai/echo-model-think', ...bucket({ uncachedInputTokens: 1500, outputTokens: 300 }) },
      ],
    },
    rules: [
      rule('echo-openai/echo-model', price(2, 8, 0.5, 1)),
      rule('echo-openai/echo-model-think', price(1, 4, 0.25, 0.5)),
    ],
    subagentHours: [],
    subagentMissing: 0,
    now: new Date(at(9)),
  })
  const view = costPanelViewOf(model, zhT, { subagentsAvailable: true })
  assert.deepEqual(view.sections[0].rows.map((row) => [row.model, row.amount]), [
    ['echo-openai/echo-model', '¥0.0108'],
    ['echo-openai/echo-model-think', '¥0.0027'],
  ])
  assert.equal(view.totals[0].value, '≈ ¥0.0135')
})

test('Given 英文 When 生成视图 Then 文案全英文', () => {
  const view = costPanelViewOf(panelModel(), enT, { subagentsAvailable: true })
  assert.equal(view.title, 'Cost estimate breakdown')
  assert.deepEqual(view.totals.map((row) => row.label), ['This session', 'Including subagents'])
  assert.equal('formula' in view, false)
  assert.doesNotMatch(JSON.stringify(view), /[\u4e00-\u9fff]/)
})

// —— 底栏文本:按模型聚合后的合计,未定价按模型数追加 ——
test('Given 小时投影 When 生成底栏条目 Then 按模型聚合金额且未定价数为模型数', () => {
  const item = buildSessionCostItem(
    { routes: [{ provider: 'a', model: 'b' }] },
    { hours: [{ time: at(9), model: 'a/b', ...bucket({ uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 }) }] },
    rules, prefs, zhT, new Date(at(9)),
  )
  assert.equal(item.text, '费用 ≈ ¥0.0030')
  assert.equal(item.unpriced, 0)
})

test('Given 未配置规则 When 生成底栏条目 Then 不渲染', () => {
  assert.equal(buildSessionCostItem({ routes: [{ provider: 'a', model: 'b' }] }, null, [], prefs, zhT), null)
})
