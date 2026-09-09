// 注入点B 纯函数层测试:messageId 反查矩阵/模型键回退/芯片文本/title 口径/文案键/注册与 CSS 镜像
// client.js 为经典 script bundle(禁 import/export),整文件 IIFE 书挡;经 client-eval 剥壳后整源求值,按顶层声明名收集
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  MESSAGES_EN,
  MESSAGES_ZH,
  MODEL_UNROUTED,
  buildTurnCostChipText,
  createTranslator,
  matchPrice,
  turnCostTitleText,
  turnModelOf,
  turnTokenUsageOfMessage,
} = core

const zhT = createTranslator(MESSAGES_ZH)
const enT = createTranslator(MESSAGES_EN)

// 本地时区固定时钟,与 client.test.mjs 同一刻
const NOW = new Date(2026, 2, 15, 14, 30, 45)

const tailNode = (messageId, tokenUsage) => ({
  kind: 'turn-tail',
  data: { turn: 1, closing: { finalNode: { seq: 9, messageId } }, tokenUsage },
})

test('反查:matchId 命中返回 tokenUsage 本体', () => {
  const tokenUsage = { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 }
  assert.equal(turnTokenUsageOfMessage([tailNode('m-1', tokenUsage)], 'm-1'), tokenUsage)
})

test('反查:多节点取命中者', () => {
  const tokenUsage = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }
  const nodes = [tailNode('m-0', { uncachedInputTokens: 9, outputTokens: 9, totalTokens: 18 }), tailNode('m-1', tokenUsage)]
  assert.equal(turnTokenUsageOfMessage(nodes, 'm-1'), tokenUsage)
})

test('反查:非命中 kind 与 messageId 不误收', () => {
  const assistant = { kind: 'assistant', messageId: 'm-1', data: { closing: { finalNode: { messageId: 'm-1' } }, tokenUsage: {} } }
  assert.equal(turnTokenUsageOfMessage([assistant], 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage([tailNode('m-0', {})], 'm-1'), null)
})

test('反查:tokenUsage 缺失返回 null', () => {
  assert.equal(turnTokenUsageOfMessage([{ kind: 'turn-tail', data: { closing: { finalNode: { messageId: 'm-1' } } } }], 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage([tailNode('m-1', null)], 'm-1'), null)
})

test('反查:非数组与空列表返回 null', () => {
  assert.equal(turnTokenUsageOfMessage(null, 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage(undefined, 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage([], 'm-1'), null)
})

test('反查:单节点形状残缺跳过不抛,后续命中不受阻', () => {
  const hostile = { get kind() { throw new Error('boom') } }
  const tokenUsage = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }
  assert.equal(turnTokenUsageOfMessage([hostile, tailNode('m-1', tokenUsage)], 'm-1'), tokenUsage)
  assert.equal(turnTokenUsageOfMessage([{ kind: 'turn-tail', get data() { throw new Error('boom') } }], 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage([null, 'x', 42], 'm-1'), null)
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

test('芯片文本四桶全带:prompt 三桶入费用分母按价计', () => {
  const tokenUsage = {
    uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 10000,
    cacheReadTokens: 1000, cacheWriteTokens: 0, routes: [{ provider: 'p', model: 'p/m' }],
  }
  const price = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  assert.equal(buildTurnCostChipText(zhT, tokenUsage, price, '¥'), '费用 ≈ ¥0.01')
})

test('芯片文本可选桶缺失按 0 计入费用', () => {
  const tokenUsage = { uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 9000 }
  const price = { input: 1, output: 2, cacheRead: 5, cacheWrite: 5 }
  assert.equal(buildTurnCostChipText(zhT, tokenUsage, price, '¥'), '费用 ≈ ¥0.01')
})

test('芯片文本取不到价为占位符', () => {
  const tokenUsage = { uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 9000 }
  assert.equal(buildTurnCostChipText(zhT, tokenUsage, null, ''), '费用 ≈ —')
  assert.equal(buildTurnCostChipText(enT, tokenUsage, null, ''), 'Cost ≈ —')
})

test('title 含 token 摘要与估算口径,可选桶未上报追加标注', () => {
  const full = { uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 9000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  assert.equal(turnCostTitleText(zhT, full), '输入 8K tok · 输出 1K tok,单轮用量按当前费率估算')
  const missing = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }
  assert.equal(turnCostTitleText(zhT, missing), '输入 1 tok · 输出 1 tok,单轮用量按当前费率估算,该提供商未上报此桶')
  assert.equal(turnCostTitleText(enT, missing), 'Input 1 tok · Output 1 tok,Per-turn usage estimated at current rates,Not reported by this provider')
})

test('注入点B 文案键 zh/en 值锁定,独立行旧键已删', () => {
  assert.equal(MESSAGES_ZH['stats.cost'], '费用 ≈ {cost}')
  assert.equal(MESSAGES_EN['stats.cost'], 'Cost ≈ {cost}')
  assert.equal(MESSAGES_ZH['stats.turnCost'], undefined)
  assert.equal(MESSAGES_EN['stats.turnCost'], undefined)
  assert.equal(MESSAGES_ZH.turnCostTitle, '单轮用量按当前费率估算')
  assert.equal(MESSAGES_EN.turnCostTitle, 'Per-turn usage estimated at current rates')
  assert.equal(MESSAGES_ZH.turnTokensUnreported, '该提供商未上报此桶')
  assert.equal(MESSAGES_EN.turnTokensUnreported, 'Not reported by this provider')
  assert.equal(MESSAGES_ZH.costDisplayDesc, '在信息栏、趋势悬浮与回合费用芯片中显示按当前费率估算的费用。')
  assert.equal(MESSAGES_EN.costDisplayDesc, 'Show costs estimated at current rates in the stats line, trend tooltips and the turn cost chip.')
})

test('注册指向官方动作行槽,turnTail 旧路径移除', () => {
  assert.ok(CLIENT_SOURCE.includes("ctx.slots.inject('conversation.chat.assistant-actions'"))
  assert.ok(!CLIENT_SOURCE.includes('conversation.chat.turnTail'))
})

test('芯片样式镜像官方动作行显隐:历史悬停显现与焦点恢复', () => {
  assert.ok(CLIENT_SOURCE.includes('.ud-turn-cost{'))
  assert.ok(CLIENT_SOURCE.includes('@media (hover:hover){[data-actions-reveal=hover] .ud-turn-cost{opacity:0'))
  assert.ok(CLIENT_SOURCE.includes('[data-actions-reveal=hover]:hover .ud-turn-cost,[data-actions-reveal=hover]:focus-within .ud-turn-cost{opacity:1}'))
})
