// 底部信息栏增强纯函数层测试:官方 StatsLine 口径(dsh-client-ui-chat 同构)+ usp 双开关状态
// Given/When/Then 场景内嵌于用例描述
// client.js 为经典 script bundle(禁 import/export),整文件 IIFE 书挡;经 client-eval 剥壳后整源求值,按顶层声明名收集
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  STATS_LINE_STORAGE_KEY,
  MESSAGES_EN,
  MESSAGES_ZH,
  billedInputTokens,
  roundedPercentUnits,
  displayPercentUnits,
  formatCacheHitPercent,
  cacheHitPercent,
  cacheHitPercentPrecise,
  formatTokensCompact,
  formatDuration,
  formatTokensPerSecond,
  assistantStepReading,
  deriveStats,
  buildStatsGroups,
  buildCostItem,
  createStatsLineState,
  createTranslator,
} = core

const USAGE = { uncachedInputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 0, outputTokens: 500 }
const STATS = { turns: 2, steps: 3, llmMs: 1500, toolMs: 2000, ttftMs: 200, ttftSteps: 1, decodeMs: 800, decodeTokens: 50 }
const PREFS_OFF = { cachePrecision: false, tokenDetail: false, costDisplay: false }
const PREFS_COST_ON = { cachePrecision: false, tokenDetail: false, costDisplay: true }
const zhT = createTranslator(MESSAGES_ZH)
const enT = createTranslator(MESSAGES_EN)

// 费用组装配输入:精确规则在前、全通配规则兜底,通配仅全天时段(00:00~23:59 双闭)生效
const COST_RULES = [
  { model: 'p/m', currency: '¥', price: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] },
  {
    model: '*/*', currency: '', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    conditions: [{ kind: 'dailyWindow', from: '00:00', to: '23:59' }],
  },
]
const COST_USAGE = { uncachedInputTokens: 500000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
const COST_NOW = new Date(2026, 2, 15, 10, 0)

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
  }
}

test('stats 词典 zh 关键值逐字节对齐官方,en 族逐字节取官方 chat', () => {
  assert.equal(STATS_LINE_STORAGE_KEY, 'dsh-usage-dash:stats-line')
  assert.equal(MESSAGES_ZH['stats.counts'], '{turns} 轮 · {steps} 步')
  assert.equal(MESSAGES_ZH['stats.llm'], 'LLM {duration}')
  assert.equal(MESSAGES_ZH['stats.toolCall'], '工具调用 {duration}')
  assert.equal(MESSAGES_ZH['stats.ttftAverage'], '首 token 平均 {duration}')
  assert.equal(MESSAGES_ZH['stats.tokensPerSecond'], '{throughput} tok/s')
  assert.equal(MESSAGES_ZH['stats.cacheHit'], '缓存命中 {percent}%')
  assert.equal(MESSAGES_ZH['stats.tokens'], '输入 {input} tok · 输出 {output} tok')
  assert.equal(MESSAGES_ZH['stats.tokensDetail'], '总 {total} tok · 输入 {input} tok · 命中缓存 {hit} tok · 未命中缓存 {miss} tok · 输出 {output} tok')
  assert.equal(MESSAGES_ZH.cachePrecision, '精确缓存命中率')
  assert.equal(MESSAGES_ZH.cachePrecisionDesc, '在会话底部信息栏以两位小数显示缓存命中率。')
  assert.equal(MESSAGES_ZH.tokenDetail, '会话 Token 明细')
  assert.equal(MESSAGES_ZH.tokenDetailDesc, '在会话底部信息栏显示总 Token、命中/未命中缓存与输出明细。')
  assert.equal(MESSAGES_ZH['stats.cost'], '费用 ≈ {cost}')
  assert.equal(MESSAGES_ZH.costDisplay, '费用显示')
  assert.equal(MESSAGES_EN['stats.cost'], 'Cost ≈ {cost}')
  assert.equal(MESSAGES_EN.costDisplay, 'Cost display')
  assert.equal(MESSAGES_ZH['duration.compactSeconds'], '{seconds}秒')
  assert.equal(MESSAGES_ZH['duration.compactMinutes'], '{minutes}分{seconds}秒')
  assert.equal(MESSAGES_ZH['number.thousand'], '{value}K')
  assert.equal(MESSAGES_ZH['number.million'], '{value}M')
  assert.equal(MESSAGES_EN['stats.counts'], '{turns} turns · {steps} steps')
  assert.equal(MESSAGES_EN['stats.llm'], 'LLM {duration}')
  assert.equal(MESSAGES_EN['stats.toolCall'], 'Tool call {duration}')
  assert.equal(MESSAGES_EN['stats.ttftAverage'], 'TTFT avg {duration}')
  assert.equal(MESSAGES_EN['stats.tokensPerSecond'], '{throughput} tok/s')
  assert.equal(MESSAGES_EN['stats.cacheHit'], 'Cache hit {percent}%')
  assert.equal(MESSAGES_EN['stats.tokens'], 'Input {input} tok · Output {output} tok')
  assert.equal(MESSAGES_EN['stats.tokensDetail'], 'Total {total} tok · Input {input} tok · Cache hit {hit} tok · Cache miss {miss} tok · Output {output} tok')
  assert.equal(MESSAGES_EN['duration.compactSeconds'], '{seconds}s')
  assert.equal(MESSAGES_EN['duration.compactMinutes'], '{minutes}m{seconds}s')
  assert.equal(MESSAGES_EN['number.thousand'], '{value}K')
  assert.equal(MESSAGES_EN['number.million'], '{value}M')
})

test('billedInputTokens 为三个互斥 prompt 桶之和', () => {
  assert.equal(billedInputTokens(USAGE), 5000)
  assert.equal(billedInputTokens({ uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 300, outputTokens: 0 }), 600)
})

test('roundedPercentUnits 整数位 0.5 进位', () => {
  // 125*100/200 = 62.5 → 63(0.5 进位,非银行家舍入)
  assert.equal(roundedPercentUnits(125, 200, 0), 63)
  assert.equal(roundedPercentUnits(75, 100, 0), 75)
  assert.equal(roundedPercentUnits(999946, 1000000, 0), 100)
})

test('roundedPercentUnits 十分位单位 0.5 进位', () => {
  // 755*1000/1000 = 755 个十分位 → 755('75.5')
  assert.equal(roundedPercentUnits(755, 1000, 1), 755)
  assert.equal(roundedPercentUnits(125, 200, 1), 625)
})

test('displayPercentUnits 按小数位渲染,十分位为 0 时省略小数点', () => {
  assert.equal(displayPercentUnits(75, 0), '75')
  assert.equal(displayPercentUnits(805, 1), '80.5')
  assert.equal(displayPercentUnits(800, 1), '80')
})

test('formatCacheHitPercent 无分母为 null,无 miss 为 100', () => {
  assert.equal(formatCacheHitPercent(100, 0, 0), null)
  assert.equal(formatCacheHitPercent(100, 100, 0), '100')
})

test('formatCacheHitPercent 整数位四舍五入', () => {
  assert.equal(formatCacheHitPercent(75, 100), '75')
  assert.equal(formatCacheHitPercent(125, 200), '63')
  assert.equal(formatCacheHitPercent(52, 100), '52')
})

test('formatCacheHitPercent 溢出 100 时闭式构造 99.x', () => {
  assert.equal(formatCacheHitPercent(999946, 1000000), '99.99')
  assert.equal(formatCacheHitPercent(99995, 100000), '99.995')
})

test('cacheHitPercent 官方整数口径与空数据 null', () => {
  assert.equal(cacheHitPercent(USAGE), '80')
  assert.equal(cacheHitPercent({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 }), null)
})

test('cacheHitPercentPrecise 恒两位小数且 99.99 封顶', () => {
  assert.equal(cacheHitPercentPrecise({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), null)
  assert.equal(cacheHitPercentPrecise({ uncachedInputTokens: 0, cacheReadTokens: 8000, cacheWriteTokens: 0, outputTokens: 10 }), '100.00')
  assert.equal(cacheHitPercentPrecise(USAGE), '80.00')
  assert.equal(cacheHitPercentPrecise({ uncachedInputTokens: 4, cacheReadTokens: 999996, cacheWriteTokens: 0, outputTokens: 1 }), '99.99')
})

test('formatTokensCompact 官方 K/M 紧凑族', () => {
  assert.equal(formatTokensCompact(517, zhT), '517')
  assert.equal(formatTokensCompact(12200, zhT), '12.2K')
  assert.equal(formatTokensCompact(517000, zhT), '517K')
  assert.equal(formatTokensCompact(1200000, zhT), '1.2M')
  assert.equal(formatTokensCompact(0, zhT), '0')
})

test('formatDuration 60 秒内一位小数,以上折分秒', () => {
  assert.equal(formatDuration(45200, zhT), '45.2秒')
  assert.equal(formatDuration(162000, zhT), '2分42秒')
  assert.equal(formatDuration(0, zhT), '0秒')
})

test('formatTokensPerSecond 钳负值且阈值上下分别取整', () => {
  assert.equal(formatTokensPerSecond(-5), '0')
  assert.equal(formatTokensPerSecond(9.96), '10')
  assert.equal(formatTokensPerSecond(150), '150')
  assert.equal(formatTokensPerSecond(3.24), '3.2')
})

test('assistantStepReading 时间戳齐全时产出 TTFT/decode/输出 token', () => {
  assert.deepEqual(
    assistantStepReading({ timing: { stepStartTime: 1000, firstTokenTime: 1200, completedTime: 2000 }, usage: 50 }),
    { ttftMs: 200, decodeMs: 800, outputTokens: 50 },
  )
})

test('assistantStepReading 负时长钳 0 且非法 usage 为 null', () => {
  // completedTime 早于 firstTokenTime → decode 钳 0
  assert.deepEqual(
    assistantStepReading({ timing: { stepStartTime: 1000, firstTokenTime: 2000, completedTime: 1500 }, usage: 30 }),
    { ttftMs: 1000, decodeMs: 0, outputTokens: 30 },
  )
  assert.equal(assistantStepReading({ timing: { stepStartTime: 0, firstTokenTime: 100, completedTime: 200 }, usage: 'oops' }).outputTokens, null)
  assert.equal(assistantStepReading({ timing: { stepStartTime: 0, firstTokenTime: 100, completedTime: 200 }, usage: -1 }).outputTokens, null)
  assert.equal(assistantStepReading({ timing: { stepStartTime: 0, firstTokenTime: 100, completedTime: 200 }, usage: Number.NaN }).outputTokens, null)
})

test('assistantStepReading 无 timing 时读数双 null', () => {
  assert.deepEqual(assistantStepReading({ usage: 50 }), { ttftMs: null, decodeMs: null, outputTokens: 50 })
})

test('deriveStats 折叠窗口节点:轮次去重/负值钳制/读数按有值步聚合', () => {
  // When:混合 tool-result 与 assistant(含 turn 重复、stepStart null、firstToken null、非法 usage)
  const nodes = [
    { kind: 'user' },
    { kind: 'tool-result', time: 5000, callTime: 3000 },
    { kind: 'tool-result', time: 1000, callTime: 3000 },
    { kind: 'tool-result', time: 9000, callTime: null },
    { kind: 'assistant', turn: 1, timing: { stepStartTime: 1000, firstTokenTime: 1200, completedTime: 2000 }, usage: 50 },
    { kind: 'assistant', turn: 1, timing: { stepStartTime: null, firstTokenTime: 1300, completedTime: 2100 }, usage: 10 },
    { kind: 'assistant', turn: 2, timing: { stepStartTime: 3000, firstTokenTime: null, completedTime: 3500 }, usage: 30 },
    { kind: 'assistant', turn: 3, timing: { stepStartTime: 4000, firstTokenTime: 4100, completedTime: 4600 }, usage: 'oops' },
  ]
  // Then:llm 1000+0+500+600;ttft 分母=有值 2 步;decode 只算时间戳与 usage 双全的步
  assert.deepEqual(deriveStats(nodes), {
    turns: 3,
    steps: 4,
    llmMs: 2100,
    toolMs: 2000,
    ttftMs: 300,
    ttftSteps: 2,
    decodeMs: 1600,
    decodeTokens: 60,
  })
})

test('deriveStats 空节点为零值统计', () => {
  assert.deepEqual(deriveStats([]), { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 })
})

test('buildStatsGroups 双开关全关与官方行逐字节一致', () => {
  assert.deepEqual(buildStatsGroups(STATS, USAGE, PREFS_OFF, zhT), [
    '2 轮 · 3 步',
    'LLM 1.5秒 · 工具调用 2秒',
    '首 token 平均 0.2秒 · 63 tok/s',
    '缓存命中 80%',
    '输入 5K tok · 输出 500 tok',
  ])
})

test('buildStatsGroups 传 en 翻译器输出官方 en 口径逐字节', () => {
  assert.deepEqual(buildStatsGroups(STATS, USAGE, PREFS_OFF, enT), [
    '2 turns · 3 steps',
    'LLM 1.5s · Tool call 2s',
    'TTFT avg 0.2s · 63 tok/s',
    'Cache hit 80%',
    'Input 5K tok · Output 500 tok',
  ])
})

test('buildStatsGroups en 零命中率呈现 Cache hit 0%', () => {
  const zeroHitStats = { turns: 2, steps: 3, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  const zeroHitUsage = { uncachedInputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 1000, outputTokens: 0 }
  assert.deepEqual(buildStatsGroups(zeroHitStats, zeroHitUsage, PREFS_OFF, enT), [
    '2 turns · 3 steps',
    'Cache hit 0%',
    'Input 5K tok · Output 0 tok',
  ])
})

test('buildStatsGroups tokenDetail 开关切换五项明细组', () => {
  const groups = buildStatsGroups(STATS, USAGE, { cachePrecision: false, tokenDetail: true }, zhT)
  assert.deepEqual(groups.slice(0, 4), [
    '2 轮 · 3 步',
    'LLM 1.5秒 · 工具调用 2秒',
    '首 token 平均 0.2秒 · 63 tok/s',
    '缓存命中 80%',
  ])
  assert.equal(groups[4], '总 5.5K tok · 输入 5K tok · 命中缓存 4K tok · 未命中缓存 1K tok · 输出 500 tok')
})

test('buildStatsGroups cachePrecision 开关切精确命中率', () => {
  const groups = buildStatsGroups(STATS, USAGE, { cachePrecision: true, tokenDetail: false }, zhT)
  assert.equal(groups[3], '缓存命中 80.00%')
})

test('buildStatsGroups usage 缺席时命中与 Token 组整体缺席', () => {
  assert.deepEqual(buildStatsGroups(STATS, undefined, PREFS_OFF, zhT), [
    '2 轮 · 3 步',
    'LLM 1.5秒 · 工具调用 2秒',
    '首 token 平均 0.2秒 · 63 tok/s',
  ])
})

test('buildStatsGroups 无步进且用量空为空数组', () => {
  const zeroStats = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  const zeroUsage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  assert.deepEqual(buildStatsGroups(zeroStats, zeroUsage, PREFS_OFF, zhT), [])
})

test('buildStatsGroups 仅输出时命中率组因 null 丢弃', () => {
  const zeroStats = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  const usage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 }
  assert.deepEqual(buildStatsGroups(zeroStats, usage, PREFS_OFF, zhT), ['输入 0 tok · 输出 500 tok'])
})

test('createStatsLineState 默认三开,非法 JSON 回落三开,显式 false 才视为关', () => {
  assert.deepEqual(createStatsLineState(fakeStorage()).get(), { cachePrecision: true, tokenDetail: true, costDisplay: true })
  assert.deepEqual(createStatsLineState(null).get(), { cachePrecision: true, tokenDetail: true, costDisplay: true })
  const broken = fakeStorage({ [STATS_LINE_STORAGE_KEY]: '{broken json' })
  assert.deepEqual(createStatsLineState(broken).get(), { cachePrecision: true, tokenDetail: true, costDisplay: true })
  const junk = fakeStorage({ [STATS_LINE_STORAGE_KEY]: JSON.stringify({ cachePrecision: 'yes', tokenDetail: 1 }) })
  assert.deepEqual(createStatsLineState(junk).get(), { cachePrecision: true, tokenDetail: true, costDisplay: true })
  const partialOff = fakeStorage({ [STATS_LINE_STORAGE_KEY]: JSON.stringify({ cachePrecision: false, tokenDetail: true }) })
  assert.deepEqual(createStatsLineState(partialOff).get(), { cachePrecision: false, tokenDetail: true, costDisplay: true })
})

test('createStatsLineState set 合并生效并持久化且通知订阅者', () => {
  const storage = fakeStorage()
  const state = createStatsLineState(storage)
  const seen = []
  state.subscribe(() => seen.push(state.get()))
  state.set({ cachePrecision: false })
  assert.deepEqual(state.get(), { cachePrecision: false, tokenDetail: true, costDisplay: true })
  assert.deepEqual(JSON.parse(storage.getItem(STATS_LINE_STORAGE_KEY)), { cachePrecision: false, tokenDetail: true, costDisplay: true })
  assert.equal(seen.length, 1)
})

test('createStatsLineState subscribe 退订后不再通知', () => {
  const state = createStatsLineState(fakeStorage())
  let count = 0
  const unsubscribe = state.subscribe(() => { count += 1 })
  state.set({ cachePrecision: false })
  unsubscribe()
  state.set({ tokenDetail: false })
  assert.equal(count, 1)
})

test('createStatsLineState reload 吸收外部写入', () => {
  const storage = fakeStorage()
  const state = createStatsLineState(storage)
  let notified = 0
  state.subscribe(() => { notified += 1 })
  storage.setItem(STATS_LINE_STORAGE_KEY, JSON.stringify({ cachePrecision: true, tokenDetail: true }))
  state.reload()
  assert.deepEqual(state.get(), { cachePrecision: true, tokenDetail: true, costDisplay: true })
  assert.equal(notified, 1)
})

test('createStatsLineState 写入失败仅丢持久化,内存仍生效', () => {
  const state = createStatsLineState({
    getItem: () => null,
    setItem: () => { throw new Error('quota') },
  })
  state.set({ tokenDetail: false })
  assert.deepEqual(state.get(), { cachePrecision: true, tokenDetail: false, costDisplay: true })
})

// —— S14 费用组(buildCostItem) ——

test('buildCostItem 开关关恒为 null,组数组不受 rules 影响', () => {
  assert.equal(buildCostItem(COST_USAGE, COST_RULES, PREFS_OFF, zhT, COST_NOW), null)
  assert.deepEqual(buildStatsGroups(STATS, USAGE, PREFS_OFF, zhT, COST_RULES), [
    '2 轮 · 3 步',
    'LLM 1.5秒 · 工具调用 2秒',
    '首 token 平均 0.2秒 · 63 tok/s',
    '缓存命中 80%',
    '输入 5K tok · 输出 500 tok',
  ])
})

test('buildCostItem routes 缺席按全通配规则匹配,符号取全局口径(首个非空货币)', () => {
  // 无 routes → model '*/*',500000 × 1 / 每百万 = 0.5;命中全通配(货币空),符号取表内首个非空 ¥
  assert.equal(buildCostItem(COST_USAGE, COST_RULES, PREFS_COST_ON, zhT, COST_NOW), '费用 ≈ ¥0.50')
  assert.equal(buildCostItem(COST_USAGE, COST_RULES, PREFS_COST_ON, enT, COST_NOW), 'Cost ≈ ¥0.50')
})

test('buildCostItem routes 首个 model 精确规则优先于通配', () => {
  const routed = { ...COST_USAGE, routes: [{ provider: 'p', model: 'p/m' }] }
  const wildcardFirst = [COST_RULES[1], COST_RULES[0]]
  // 500000 × 2 / 每百万 = 1,精确规则货币 ¥
  assert.equal(buildCostItem(routed, wildcardFirst, PREFS_COST_ON, zhT, COST_NOW), '费用 ≈ ¥1.00')
})

test('buildCostItem 时间条件按传入时刻评估:窗口外均不生效', () => {
  // 双闭下 00:00~00:00 单点仅命中零点整,COST_NOW 10:00 不命中;08:00~09:00 与固定时刻不交
  const singlePoint = [{ ...COST_RULES[1], conditions: [{ kind: 'dailyWindow', from: '00:00', to: '00:00' }] }]
  const daytime = [{ ...COST_RULES[1], conditions: [{ kind: 'dailyWindow', from: '08:00', to: '09:00' }] }]
  assert.equal(buildCostItem(COST_USAGE, singlePoint, PREFS_COST_ON, zhT, COST_NOW), '—')
  assert.equal(buildCostItem(COST_USAGE, daytime, PREFS_COST_ON, zhT, COST_NOW), '—')
})

test('buildCostItem 价格未加载为 null,规则已载无命中为占位符', () => {
  assert.equal(buildCostItem(COST_USAGE, null, PREFS_COST_ON, zhT, COST_NOW), null)
  assert.equal(buildCostItem(COST_USAGE, [], PREFS_COST_ON, zhT, COST_NOW), '—')
  assert.equal(buildCostItem(COST_USAGE, [{ model: 'other/x', currency: '¥', price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, conditions: [] }], PREFS_COST_ON, zhT, COST_NOW), '—')
})

test('buildCostItem usage 缺席为 null', () => {
  assert.equal(buildCostItem(undefined, COST_RULES, PREFS_COST_ON, zhT, COST_NOW), null)
})

test('buildCostItem buildStatsGroups 费用组符号同全局口径', () => {
  // USAGE 无 routes → 通配价 input 1:1000 × 1 / 每百万 = 0.001 → 四位小数微观格式;符号取首个非空 ¥
  assert.deepEqual(buildStatsGroups(STATS, USAGE, PREFS_COST_ON, zhT, COST_RULES), [
    '2 轮 · 3 步',
    'LLM 1.5秒 · 工具调用 2秒',
    '首 token 平均 0.2秒 · 63 tok/s',
    '缓存命中 80%',
    '输入 5K tok · 输出 500 tok',
    '费用 ≈ ¥0.0010',
  ])
})

test('buildStatsGroups 开+无价不追加费用组', () => {
  assert.deepEqual(buildStatsGroups(STATS, USAGE, PREFS_COST_ON, zhT, null), [
    '2 轮 · 3 步',
    'LLM 1.5秒 · 工具调用 2秒',
    '首 token 平均 0.2秒 · 63 tok/s',
    '缓存命中 80%',
    '输入 5K tok · 输出 500 tok',
  ])
})
