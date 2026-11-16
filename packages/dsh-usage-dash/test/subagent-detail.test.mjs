import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const { subagentDetailOf, subagentUsageViewOf, createTranslator, MESSAGES_ZH, MESSAGES_EN } = core

const zhT = createTranslator(MESSAGES_ZH)
const enT = createTranslator(MESSAGES_EN)
const rule = (model, price) => ({ model, unit: 'perMillion', currency: '¥', price, conditions: [] })
const rules = [rule('p/m', { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 })]
const time = new Date(2026, 10, 12, 9).getTime()

const byId = {
  A: { id: 'A', displayTitle: 'Root' },
  B: {
    id: 'B', origin: 'subagent', parentId: 'A', displayTitle: '调研',
    projectionValues: {
      usageDashModelUsage: {
        hours: [
          { time, model: 'p/m', uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 },
          { time, model: 'p/m', uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 },
        ],
      },
    },
  },
  C: {
    id: 'C', origin: 'subagent', parentId: 'A', displayTitle: '实现',
    projectionValues: { tokenUsage: { uncachedInputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  },
  D: { id: 'D', origin: 'subagent', parentId: 'A', displayTitle: '空' },
  E: { id: 'E', parentId: 'A', displayTitle: '普通 fork' },
}

test('Given 子代理多模型小时与摘要 When 生成明细 Then 每代理一行且费用只加已定价行', () => {
  const detail = subagentDetailOf(byId, 'A', {}, rules)
  assert.equal(detail.rows.length, 3)
  const [research, implement, empty] = detail.rows
  // B: 两小时桶合并 2000 输入 + 1000 输出 + 4000 缓存读 = 2000×1 + 1000×2 + 4000×0.5 = 6000 → ¥0.0060
  assert.equal(research.model, 'p/m')
  assert.equal(research.tokens, 7000)
  assert.equal(research.cost, 0.006)
  // C: 只有摘要,能出总量但不能计价
  assert.equal(implement.model, null)
  assert.equal(implement.tokens, 400)
  assert.equal(implement.cost, null)
  assert.equal(implement.summaryOnly, true)
  // D: 两样都没有
  assert.equal(empty.missing, true)
  assert.equal(empty.tokens, null)
  assert.equal(detail.totalTokens, 7400)
  assert.equal(detail.total, 0.006)
  assert.equal(detail.missing, 1)
  assert.equal(detail.unpriced, 0)
  // fork 不计入
  assert.deepEqual(detail.rows.map((row) => row.key), ['B', 'C', 'D'])
})

test('Given 子代理模型无价 When 生成明细 Then 计入未定价且不进合计', () => {
  const detail = subagentDetailOf(byId, 'A', {}, [])
  assert.equal(detail.total, 0)
  assert.equal(detail.unpriced, 1)
  assert.equal(detail.rows[0].unpricedModels, 1)
})

test('Given 投影仓带小时 When 生成明细 Then 优先用投影仓数据', () => {
  const projections = {
    B: {
      values: {
        usageDashModelUsage: {
          hours: [{ time, model: 'p/m', uncachedInputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }],
        },
      },
    },
  }
  const detail = subagentDetailOf(byId, 'A', projections, rules)
  assert.equal(detail.rows[0].tokens, 500)
  assert.equal(detail.rows[0].cost, 0.0005)
})

test('Given 明细 When 生成视图 Then 表格列、合计与脚注完整', () => {
  const view = subagentUsageViewOf(subagentDetailOf(byId, 'A', {}, rules), zhT, '¥')
  assert.equal(view.title, '子代理明细')
  assert.equal(view.subtitle, '当前会话 · 3 个子代理')
  assert.deepEqual(view.rows[0], {
    key: 'B', title: '调研', model: 'p/m',
    input: '2,000', output: '1,000', cacheRead: '4,000', cacheWrite: '0',
    total: '7,000', amount: '¥0.0060', note: null,
  })
  assert.equal(view.rows[1].model, '—')
  assert.equal(view.rows[1].note, '仅摘要')
  assert.equal(view.rows[2].note, '未取到用量')
  assert.equal(view.totals.tokens, '7,400')
  assert.equal(view.totals.amount, '≈ ¥0.0060')
  assert.deepEqual(view.footnotes, ['1 个子代理未取到用量'])
})

test('Given 无子代理 When 生成视图 Then 空态且合计为零占位', () => {
  const view = subagentUsageViewOf(subagentDetailOf({ A: { id: 'A' } }, 'A', {}, rules), zhT, '¥')
  assert.equal(view.rows.length, 0)
  assert.equal(view.empty, '暂无子代理')
  assert.equal(view.totals.amount, '—')
})

test('Given 英文 When 生成视图 Then 文案全英文', () => {
  const view = subagentUsageViewOf(subagentDetailOf(byId, 'A', {}, rules), enT, '¥')
  assert.equal(view.title, 'Subagent detail')
  assert.equal(view.rows[1].note, 'Summary only')
  // 会话标题是用户数据,不参与语言断言
  assert.doesNotMatch([view.title, view.subtitle, view.rows[1].note, ...view.footnotes].join('|'), /[\u4e00-\u9fff]/)
})
