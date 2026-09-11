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
  turnCostAmountOf,
  turnCostTitleText,
  turnModelOf,
  turnTokenUsageOfMessage,
  turnUsageSourceOfMessage,
  usageSourceBuckets,
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

test('反查:closing.usage 采样回退为聚合形态,可选桶带上', () => {
  const sampled = { inputTokens: 100, outputTokens: 20, totalTokens: 130, cacheReadTokens: 10 }
  const node = { kind: 'turn-tail', data: { closing: { finalNode: { seq: 1, messageId: 'm-1' }, usage: sampled } } }
  assert.deepEqual(turnTokenUsageOfMessage([node], 'm-1'), { uncachedInputTokens: 100, outputTokens: 20, totalTokens: 130, cacheReadTokens: 10 })
  const bare = { kind: 'turn-tail', data: { closing: { finalNode: { seq: 2, messageId: 'm-2' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } } }
  assert.deepEqual(turnTokenUsageOfMessage([bare], 'm-2'), { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 })
})

test('反查:非数组与空列表返回 null', () => {
  assert.equal(turnTokenUsageOfMessage(null, 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage(undefined, 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage([], 'm-1'), null)
})

test('反查:chat 节点表 Map 形态与数组等价', () => {
  const tokenUsage = { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 }
  const nodes = new Map([
    ['k1', tailNode('m-0', { uncachedInputTokens: 9, outputTokens: 9, totalTokens: 18 })],
    ['k2', tailNode('m-1', tokenUsage)],
  ])
  assert.equal(turnTokenUsageOfMessage(nodes, 'm-1'), tokenUsage)
  assert.equal(turnTokenUsageOfMessage(new Map(), 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage({ size: 0 }, 'm-1'), null)
})

test('反查:单节点形状残缺跳过不抛,后续命中不受阻', () => {
  const hostile = { get kind() { throw new Error('boom') } }
  const tokenUsage = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }
  assert.equal(turnTokenUsageOfMessage([hostile, tailNode('m-1', tokenUsage)], 'm-1'), tokenUsage)
  assert.equal(turnTokenUsageOfMessage([{ kind: 'turn-tail', get data() { throw new Error('boom') } }], 'm-1'), null)
  assert.equal(turnTokenUsageOfMessage([null, 'x', 42], 'm-1'), null)
})

test('反查:同一容器重复调用命中索引,结果一致', () => {
  const tokenUsage = { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 }
  const nodes = [tailNode('m-1', tokenUsage)]
  // Given 同一容器连续两次反查(首次建索引,二次命中缓存)
  const first = turnTokenUsageOfMessage(nodes, 'm-1')
  const second = turnTokenUsageOfMessage(nodes, 'm-1')
  // Then 结果一致且均为 tokenUsage 本体
  assert.equal(first, tokenUsage)
  assert.equal(second, tokenUsage)
  // 未命中的 messageId 二次查询仍为 null(索引缓存不放大误命中)
  assert.equal(turnTokenUsageOfMessage(nodes, 'm-2'), null)
})

test('反查源:命中返回仓库内原始引用,采样形态不归一(归一属渲染层)', () => {
  const tokenUsage = { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 }
  assert.equal(turnUsageSourceOfMessage([tailNode('m-1', tokenUsage)], 'm-1'), tokenUsage)
  // 视图节点直挂 tokenUsage 次选
  const directNode = { kind: 'turn-tail', data: { closing: { finalNode: { seq: 1, messageId: 'm-2' } }, tokenUsage } }
  assert.equal(turnUsageSourceOfMessage([directNode], 'm-2'), tokenUsage)
  // 采样 usage 原样返回(引用稳定,useSyncExternalStore 快照可比对)
  const sampled = { inputTokens: 100, outputTokens: 20, totalTokens: 130, cacheReadTokens: 10 }
  const sampledNode = { kind: 'turn-tail', data: { closing: { finalNode: { seq: 2, messageId: 'm-3' }, usage: sampled } } }
  assert.equal(turnUsageSourceOfMessage([sampledNode], 'm-3'), sampled)
  // 三级全缺返回 null(稳定值)
  assert.equal(turnUsageSourceOfMessage([{ kind: 'turn-tail', data: { closing: { finalNode: { seq: 3, messageId: 'm-4' } } } }], 'm-4'), null)
  assert.equal(turnUsageSourceOfMessage([], 'm-1'), null)
  assert.equal(turnUsageSourceOfMessage(null, 'm-1'), null)
  // 仓库两态
  assert.equal(turnUsageSourceOfMessage(new Map([['k', tailNode('m-1', tokenUsage)]]), 'm-1'), tokenUsage)
})

test('反查源:节点数据更新后同容器引用随之更替', () => {
  // Given 命中节点无用量源 When 位置数据补上 tokenUsage(同一容器对象,仓库可变语义)
  const node = { kind: 'turn-tail', data: { closing: { finalNode: { seq: 1, messageId: 'm-1' } } } }
  const nodes = [node]
  assert.equal(turnUsageSourceOfMessage(nodes, 'm-1'), null)
  const tokenUsage = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }
  node.data.tokenUsage = tokenUsage
  // Then 反查读到新引用 —— selector 快照由恒等(null)变为新引用,驱动重渲染
  assert.equal(turnUsageSourceOfMessage(nodes, 'm-1'), tokenUsage)
})

test('归一:采样形态转聚合桶,聚合形态原样直通', () => {
  assert.deepEqual(
    usageSourceBuckets({ inputTokens: 100, outputTokens: 20, totalTokens: 130, cacheReadTokens: 10 }),
    { uncachedInputTokens: 100, outputTokens: 20, totalTokens: 130, cacheReadTokens: 10 },
  )
  const aggregated = { uncachedInputTokens: 8, outputTokens: 2, totalTokens: 10, routes: [{ provider: 'p', model: 'm' }] }
  assert.equal(usageSourceBuckets(aggregated), aggregated)
  assert.equal(usageSourceBuckets(null), null)
})

test('反查:容器换引用(快照更替)后新节点可见', () => {
  const oldUsage = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }
  const oldNodes = [tailNode('m-1', oldUsage)]
  assert.equal(turnTokenUsageOfMessage(oldNodes, 'm-1'), oldUsage)
  // Given 节点表内容变化以新容器表达(官方 store 快照语义),新增回合节点
  const newUsage = { uncachedInputTokens: 7, outputTokens: 7, totalTokens: 14 }
  const newNodes = [...oldNodes, tailNode('m-2', newUsage)]
  // Then 新容器首查即可见新节点,旧容器结果不受影响
  assert.equal(turnTokenUsageOfMessage(newNodes, 'm-2'), newUsage)
  assert.equal(turnTokenUsageOfMessage(oldNodes, 'm-1'), oldUsage)
})

test('反查:仓库身份恒定而节点集更替时新增回合可见', () => {
  // Given 官方 chat 仓库语义:store 实例身份跨回合恒定,values() 返回的节点集数组随 upsert 换新引用
  const usage1 = { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 }
  const usage2 = { uncachedInputTokens: 7, outputTokens: 7, totalTokens: 14 }
  let snapshot = [tailNode('m-1', usage1)]
  const store = { values: () => snapshot }
  assert.equal(turnUsageSourceOfMessage(store, 'm-1'), usage1)
  // When 第二回合 turn-tail 节点入库(同一 store,节点集数组换引用)
  snapshot = [...snapshot, tailNode('m-2', usage2)]
  // Then 新回合反查命中,不依赖页面刷新重建索引
  assert.equal(turnUsageSourceOfMessage(store, 'm-2'), usage2)
  assert.equal(turnTokenUsageOfMessage(store, 'm-2'), usage2)
  // 旧回合反查不受重建影响
  assert.equal(turnUsageSourceOfMessage(store, 'm-1'), usage1)
})

test('计价模型键:双全拼两段,仅 model 用裸名,双缺回退全通配键', () => {
  assert.equal(turnModelOf({ routes: [{ provider: 'p', model: 'm' }] }), 'p/m')
  assert.equal(turnModelOf({ routes: [{ model: 'm' }] }), 'm')
  assert.equal(turnModelOf({ routes: [{ provider: 'p' }] }), MODEL_UNROUTED)
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
    cacheReadTokens: 1000, cacheWriteTokens: 0, routes: [{ provider: 'p', model: 'm' }],
  }
  const price = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  assert.equal(buildTurnCostChipText(zhT, tokenUsage, price, '¥'), '¥0.01')
})

test('芯片文本可选桶缺失按 0 计入费用', () => {
  const tokenUsage = { uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 9000 }
  const price = { input: 1, output: 2, cacheRead: 5, cacheWrite: 5 }
  assert.equal(buildTurnCostChipText(zhT, tokenUsage, price, '¥'), '¥0.01')
})

test('计费额 0 元为 null,正额保留', () => {
  const tokenUsage = { uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 9000 }
  assert.equal(turnCostAmountOf(tokenUsage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null)
  assert.equal(turnCostAmountOf(tokenUsage, null), null)
  assert.equal(turnCostAmountOf(tokenUsage, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), 0.008)
})

test('芯片文本取不到价为占位符', () => {
  const tokenUsage = { uncachedInputTokens: 8000, outputTokens: 1000, totalTokens: 9000 }
  assert.equal(buildTurnCostChipText(zhT, tokenUsage, null, ''), '—')
  assert.equal(buildTurnCostChipText(enT, tokenUsage, null, ''), '—')
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
  assert.equal(MESSAGES_ZH['turnCostChip'], '{cost}')
  assert.equal(MESSAGES_EN['turnCostChip'], '{cost}')
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

test('芯片样式:显隐随官方动作行父级,不自绘重复规则', () => {
  assert.ok(CLIENT_SOURCE.includes('.ud-turn-cost{'))
  assert.ok(!CLIENT_SOURCE.includes('[data-actions-reveal=hover] .ud-turn-cost'))
})
