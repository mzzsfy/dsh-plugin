// 底部信息栏 append 条目纯函数层测试:官方 pill 数据后追加增强项 + usp 双开关状态
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
  cacheHitPercentPrecise,
  formatTokensCompact,
  formatDuration,
  formatTokensPerSecond,
  buildCostItem,
  createStatsLineState,
  createTranslator,
} = core

const USAGE = { uncachedInputTokens: 1000, cacheReadTokens: 4000, cacheWriteTokens: 0, outputTokens: 500 }
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

test('stats 词典关键值逐字节,en 族逐字节', () => {
  assert.equal(STATS_LINE_STORAGE_KEY, 'dsh-usage-dash:stats-line')
  assert.equal(MESSAGES_ZH['stats.tokens'], '输入 {input} tok · 输出 {output} tok')
  assert.equal(MESSAGES_ZH.cachePrecision, '精确缓存命中率')
  assert.equal(MESSAGES_ZH.cachePrecisionDesc, '将官方用量胶囊及弹窗中的命中率显示为两位小数。')
  assert.equal(MESSAGES_ZH.tokenDetail, '会话 Token 明细')
  assert.equal(MESSAGES_ZH.tokenDetailDesc, '在官方 Token 用量弹窗末尾追加含缓存输入合计；存在缓存写入时追加未命中合计。')
  assert.equal(MESSAGES_ZH['stats.cost'], '费用 ≈ {cost}')
  assert.equal(MESSAGES_ZH.costDisplay, '费用显示')
  assert.equal(MESSAGES_EN['stats.cost'], 'Cost ≈ {cost}')
  assert.equal(MESSAGES_EN.costDisplay, 'Cost display')
  assert.equal(MESSAGES_ZH['duration.compactSeconds'], '{seconds}秒')
  assert.equal(MESSAGES_ZH['duration.compactMinutes'], '{minutes}分{seconds}秒')
  assert.equal(MESSAGES_ZH['number.thousand'], '{value}K')
  assert.equal(MESSAGES_ZH['number.million'], '{value}M')
  assert.equal(MESSAGES_EN['duration.compactSeconds'], '{seconds}s')
  assert.equal(MESSAGES_EN['duration.compactMinutes'], '{minutes}m{seconds}s')
  assert.equal(MESSAGES_EN['number.thousand'], '{value}K')
  assert.equal(MESSAGES_EN['number.million'], '{value}M')
})

test('billedInputTokens 为三个互斥 prompt 桶之和', () => {
  assert.equal(billedInputTokens(USAGE), 5000)
  assert.equal(billedInputTokens({ uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 300, outputTokens: 0 }), 600)
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

test('buildCostItem 开关关恒为 null', () => {
  assert.equal(buildCostItem(COST_USAGE, COST_RULES, PREFS_OFF, zhT, COST_NOW), null)
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

test('dock 注册 append 契约:order 排官方 pill(activity 0/usage 1)之后,条目只消费 useProjection', () => {
  assert.ok(CLIENT_BODY.includes("id: 'stats', order: 2, priority: STATS_SLOT_PRIORITY"))
  assert.ok(CLIENT_BODY.includes('StatsLineAppended({ useProjection, t = defaultT })'))
  assert.ok(!CLIENT_BODY.includes("useProjection('sessionStats')"))
  assert.ok(!CLIENT_BODY.includes('deriveStats'))
})

test('dock append 条目布局契约:官方 pill 满宽不受挤压,空间不足时增强条目先让位', () => {
  // 失效方式:回退为整行 width:100% 或去掉让位收缩/截断,官方胶囊被压缩或被溢出文本遮挡(独立环境实测 147→96px)
  const rule = CLIENT_BODY.match(/\.ud-statsline-root\{[^}]*\}/)?.[0]
  assert.ok(rule, '存在 .ud-statsline-root 规则')
  assert.ok(!/(^|[^-a-z])width:100%/.test(rule), '不再整行占满,dock 内为并列条目')
  assert.ok(!rule.includes('--dsh-composer-side-clearance'), '不再沿用整行侧边距')
  assert.ok(rule.includes('flex:0 999 auto'), '高收缩因子锁定,空间不足时先收缩自身,挤压亏损不由官方 pill 承担')
  assert.ok(rule.includes('padding:0;'), '费用收缩到零时不留下固定内边距挤压官方胶囊')
  assert.ok(rule.includes('margin-left:calc(0px - var(--ud-dock-gap,0px))') && rule.includes('text-indent:var(--ud-dock-gap,0px)'), '抵消新增 flex gap，文字缩进提供可收缩间距')
  assert.ok(rule.includes('min-width:0'), '允许收缩到零')
  assert.ok(rule.includes('overflow:hidden') && rule.includes('white-space:nowrap') && rule.includes('text-overflow:ellipsis'), '收缩残态截断三件套在位,溢出不遮挡官方 pill')
})
