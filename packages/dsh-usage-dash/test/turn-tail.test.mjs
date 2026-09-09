// 注入点B(S15)纯函数层测试:select 矩阵/模型键回退/单轮行文本/title 口径/文案键/显隐 CSS 镜像
// client.js 为经典 script bundle(禁 import/export),整文件 IIFE 书挡;经 client-eval 剥壳后整源求值,按顶层声明名收集
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  MESSAGES_EN,
  MESSAGES_ZH,
  MODEL_UNROUTED,
  TURN_TAIL_DATA_KEY,
  TURN_TAIL_PRIORITY,
  buildTurnCostLine,
  createTranslator,
  matchPrice,
  selectTurnTokenUsage,
  turnCostTitleText,
  turnModelOf,
} = core

const zhT = createTranslator(MESSAGES_ZH)
const enT = createTranslator(MESSAGES_EN)

// 本地时区固定时钟,与 client.test.mjs 同一刻
const NOW = new Date(2026, 2, 15, 14, 30, 45)

test('chain 常量锁定:数据键与尝试顺序后试于 deliverables', () => {
  assert.equal(TURN_TAIL_DATA_KEY, 'turn-tail')
  assert.equal(TURN_TAIL_PRIORITY, 1)
})

test('select 从 Turn 位置数据返回 tokenUsage 本体', () => {
  const tokenUsage = { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 }
  const owner = { turn: { data: new Map([[TURN_TAIL_DATA_KEY, { tokenUsage }]]) } }
  assert.equal(selectTurnTokenUsage(owner), tokenUsage)
})

test('select 数据键缺席或 tokenUsage 缺失返回 null', () => {
  assert.equal(selectTurnTokenUsage({ turn: { data: new Map([[TURN_TAIL_DATA_KEY, {}]]) } }), null)
  assert.equal(selectTurnTokenUsage({ turn: { data: new Map() } }), null)
})

test('select owner 形状残缺全部 null 不抛', () => {
  assert.equal(selectTurnTokenUsage({ turn: { data: {} } }), null)
  assert.equal(selectTurnTokenUsage({ turn: {} }), null)
  assert.equal(selectTurnTokenUsage({}), null)
  assert.equal(selectTurnTokenUsage(null), null)
  assert.equal(selectTurnTokenUsage(undefined), null)
})

test('计价模型键取 routes 首个,缺失回退全通配键', () => {
  assert.equal(turnModelOf({ routes: [{ provider: 'p', model: 'p/m' }] }), 'p/m')
  assert.equal(turnModelOf({ routes: [] }), MODEL_UNROUTED)
  assert.equal(turnModelOf({}), MODEL_UNROUTED)
  assert.equal(turnModelOf(null), MODEL_UNROUTED)
})

test('routes 缺失模型键命中全通配规则', () => {
  const rules = [
    { model: 'p/m', currency: '¥', price: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }, conditions: [] },
    { model: '*/*', currency: '$', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] },
  ]
  const tokenUsage = { uncachedInputTokens: 1000, outputTokens: 0, totalTokens: 1000 }
  assert.equal(turnModelOf(tokenUsage), MODEL_UNROUTED)
  assert.deepEqual(matchPrice(rules, turnModelOf(tokenUsage), NOW), { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('单轮行四桶全带:摘要含 prompt 三桶费用按价计', () => {
  const tokenUsage = {
    uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 10000,
    cacheReadTokens: 1000, cacheWriteTokens: 0, routes: [{ provider: 'p', model: 'p/m' }],
  }
  const price = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  assert.equal(buildTurnCostLine(zhT, tokenUsage, price, '¥'), '输入 9K tok · 输出 1K tok · 费用 ≈ ¥0.01')
})

test('单轮行可选桶缺失按 0 计入摘要与费用', () => {
  const tokenUsage = { uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 9000 }
  const price = { input: 1, output: 2, cacheRead: 5, cacheWrite: 5 }
  assert.equal(buildTurnCostLine(zhT, tokenUsage, price, '¥'), '输入 8K tok · 输出 1K tok · 费用 ≈ ¥0.01')
})

test('单轮行取不到价费用为占位符', () => {
  const tokenUsage = { uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 9000 }
  assert.equal(buildTurnCostLine(zhT, tokenUsage, null, ''), '输入 8K tok · 输出 1K tok · 费用 ≈ —')
  assert.equal(buildTurnCostLine(enT, tokenUsage, null, ''), 'Input 8K tok · Output 1K tok · Cost ≈ —')
})

test('title 估算口径,可选桶未上报追加标注', () => {
  const full = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
  assert.equal(turnCostTitleText(zhT, full), '单轮用量按当前费率估算')
  const missing = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }
  assert.equal(turnCostTitleText(zhT, missing), '单轮用量按当前费率估算,该提供商未上报此桶')
  assert.equal(turnCostTitleText(enT, missing), 'Per-turn usage estimated at current rates,Not reported by this provider')
})

test('注入点B 文案键 zh/en 值锁定', () => {
  assert.equal(MESSAGES_ZH['stats.turnCost'], '{summary} · 费用 ≈ {cost}')
  assert.equal(MESSAGES_EN['stats.turnCost'], '{summary} · Cost ≈ {cost}')
  assert.equal(MESSAGES_ZH.turnCostTitle, '单轮用量按当前费率估算')
  assert.equal(MESSAGES_EN.turnCostTitle, 'Per-turn usage estimated at current rates')
  assert.equal(MESSAGES_ZH.turnTokensUnreported, '该提供商未上报此桶')
  assert.equal(MESSAGES_EN.turnTokensUnreported, 'Not reported by this provider')
})

test('显隐 CSS 镜像官方动作行:历史悬停显现与焦点恢复', () => {
  assert.ok(CLIENT_SOURCE.includes('.ud-turn-cost{'))
  assert.ok(CLIENT_SOURCE.includes('@media (hover:hover){[data-actions-reveal=hover] .ud-turn-cost{opacity:0'))
  assert.ok(CLIENT_SOURCE.includes('[data-actions-reveal=hover]:hover .ud-turn-cost,[data-actions-reveal=hover]:focus-within .ud-turn-cost{opacity:1}'))
})
