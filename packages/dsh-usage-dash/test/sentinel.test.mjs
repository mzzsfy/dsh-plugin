// 异常哨兵单测:纯函数覆盖基线分位、四类规则判定与证据数值;
// 挂载层用假 store / 假 pricing / 假 ctx 驱动,不启动宿主,定时器由测试手动触发。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SENTINEL_CONFIG,
  MIN_BASELINE_DAYS,
  SENTINEL_KINDS,
  SENTINEL_LEVELS,
  buildBaseline,
  detectAnomalies,
  installSentinel,
  normalizeSentinelConfig,
} from '../src/sentinel.js'
import { dayKey, hourKey, minuteKey } from '../src/store.js'

const MS_PER_MINUTE = 60 * 1000
const MS_PER_DAY = 24 * 60 * 60 * 1000
const TOKENS = 1000 * 1000
const NOW = Date.UTC(2026, 8, 7, 12, 0, 0) // 2026-09-07 周一

const dayCost = (day, cost, tokens = TOKENS) => ({
  day,
  weekday: new Date(`${day}T00:00:00Z`).getUTCDay(),
  cost,
  tokens,
})

// 一周每天一条:周一 10 ... 周日 70,每个星期几只有一个样本
const ONE_WEEK = [
  '2026-09-07',
  '2026-09-08',
  '2026-09-09',
  '2026-09-10',
  '2026-09-11',
  '2026-09-12',
  '2026-09-13',
].map((day, index) => dayCost(day, (index + 1) * 10))

const BASE_CONFIG = {
  enabled: true,
  burnMultiplier: 3,
  cacheDropPoints: 20,
  quietBurnMinutes: 20,
}

const emptyRecent = { windowMinutes: 30, cost: 0, hitRate: null }

test('常量:四类规则与三档级别为文档定值', () => {
  assert.deepEqual(SENTINEL_KINDS, ['burn-spike', 'cache-drop', 'model-drift', 'quiet-burn'])
  assert.deepEqual(SENTINEL_LEVELS, ['info', 'warn', 'danger'])
  assert.equal(MIN_BASELINE_DAYS, 7)
  // 开关由 features 投影,默认配置只剩三个阈值
  assert.deepEqual(DEFAULT_SENTINEL_CONFIG, { burnMultiplier: 3, cacheDropPoints: 20, quietBurnMinutes: 20 })
})

test('配置归一:非法值回落默认,归一结果不携带开关', () => {
  const normalized = normalizeSentinelConfig({
    enabled: 'yes',
    burnMultiplier: 0,
    cacheDropPoints: Number.NaN,
    quietBurnMinutes: -1,
  })
  assert.deepEqual(normalized, { burnMultiplier: 3, cacheDropPoints: 20, quietBurnMinutes: 20 })
  // 存储里的 enabled 不再被读回,单一开关只来自 features
  assert.equal('enabled' in normalizeSentinelConfig({ enabled: true }), false)
  assert.equal(normalizeSentinelConfig({ burnMultiplier: 5.5 }).burnMultiplier, 5.5)
})

test('Given 6 天样本 When 建基线 Then 标记不足且不产分位', () => {
  // Given 不足 MIN_BASELINE_DAYS 的样本
  const baseline = buildBaseline(ONE_WEEK.slice(0, MIN_BASELINE_DAYS - 1))
  // When 建基线
  // Then 明确不足、无分位、无 p95
  assert.deepEqual(baseline, { days: 6, byWeekday: {}, p95: 0, insufficient: true })
})

test('Given 7 天样本 When 建基线 Then 按星期几分位并给出总 p95', () => {
  // Given 一周七条样本
  const baseline = buildBaseline(ONE_WEEK)
  // When 建基线
  // Then 天数足够、7 个星期几齐全、周一 p50/p95 为该日唯一值
  assert.equal(baseline.days, 7)
  assert.equal(baseline.insufficient, false)
  assert.deepEqual(Object.keys(baseline.byWeekday).map(Number).sort(), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(baseline.byWeekday[1], { p50: 10, p95: 10 })
  assert.deepEqual(baseline.byWeekday[0], { p50: 70, p95: 70 })
  // 7 个样本的 p95 按线性插值落在 60 与 70 之间
  assert.ok(Math.abs(baseline.p95 - 67) < 1e-9)
})

test('Given 同一天重复条目 When 建基线 Then 天数按自然日去重且费用累加', () => {
  const baseline = buildBaseline([
    dayCost('2026-09-07', 10),
    dayCost('2026-09-07', 20),
    ...ONE_WEEK.slice(1),
  ])
  assert.equal(baseline.days, 7)
  assert.equal(baseline.byWeekday[1].p95, 30)
})

test('Given 非法条目 When 建基线 Then 忽略且不影响天数', () => {
  const baseline = buildBaseline([
    null,
    { day: 'bad', weekday: 9, cost: 1 },
    { day: '2026-09-07', weekday: 1, cost: Number.NaN },
    ...ONE_WEEK,
  ])
  assert.equal(baseline.days, 7)
})

test('Given 燃烧超阈值 When 检测 Then 产 burn-spike 并带可复核证据', () => {
  // Given 周一 p95=10(日口径),阈值倍数 3,最近 30 分钟费用 1 元 → 日化 48 元
  const baseline = buildBaseline(ONE_WEEK)
  const events = detectAnomalies({
    config: BASE_CONFIG,
    baseline,
    recent: { windowMinutes: 30, cost: 1, hitRate: null },
    history: { hitRate: null },
    modelShare: { current: null, baseline: null },
    idleMinutes: null,
    weekday: 1,
    now: NOW,
  })
  // When 检测
  // Then 唯一事件是 burn-spike,证据同时给窗口值与日化值
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(event.kind, 'burn-spike')
  assert.equal(event.level, 'warn')
  assert.equal(event.at, NOW)
  assert.equal(typeof event.id, 'string')
  assert.deepEqual(event.evidence, {
    recentCost: 1,
    projectedDaily: 48,
    p95: 10,
    multiplier: 4.8,
    windowMinutes: 30,
  })
  assert.ok(!event.title.includes('可能'))
  assert.ok(!event.suggestion.includes('可能'))
})

test('Given 日化燃烧恰好等于阈值 When 检测 Then 不产事件(严格大于)', () => {
  // 30 分钟 0.625 元日化为 30 元,恰为 p95 的 3 倍
  const events = detectAnomalies({
    config: BASE_CONFIG,
    baseline: buildBaseline(ONE_WEEK),
    recent: { windowMinutes: 30, cost: 0.625, hitRate: null },
    history: { hitRate: null },
    modelShare: { current: null, baseline: null },
    idleMinutes: null,
    weekday: 1,
    now: NOW,
  })
  assert.deepEqual(events, [])
})

test('Given 基线不足 When 检测 Then 四类规则一律不产事件', () => {
  const events = detectAnomalies({
    config: BASE_CONFIG,
    baseline: buildBaseline(ONE_WEEK.slice(0, 6)),
    recent: { windowMinutes: 30, cost: 999, hitRate: 0, quietCost: 999, quietWindowMinutes: 60 },
    history: { hitRate: 90 },
    modelShare: {
      current: { model: 'vendor/new', share: 0.9 },
      baseline: { model: 'vendor/old', share: 0.8, models: ['vendor/old'] },
    },
    idleMinutes: 999,
    weekday: 1,
    now: NOW,
  })
  assert.deepEqual(events, [])
})

test('Given 开关关闭 When 挂载 Then 状态报 disabled 且不产事件', async () => {
  const { handle } = install({
    store: makeStore({ daily: dailyRows() }),
    config: { ...BASE_CONFIG, enabled: false },
  })
  await handle.refresh()
  const status = handle.status()
  assert.equal(status.reason, 'disabled')
  assert.equal(status.config.enabled, false)
  assert.deepEqual(status.events, [])
})

test('Given 缓存命中率下降超过阈值 When 检测 Then 产 cache-drop', () => {
  const baseline = buildBaseline(ONE_WEEK)
  const events = detectAnomalies({
    config: BASE_CONFIG,
    baseline,
    recent: { windowMinutes: 30, cost: 0, hitRate: 55 },
    history: { hitRate: 80 },
    modelShare: { current: null, baseline: null },
    idleMinutes: null,
    weekday: 1,
    now: NOW,
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'cache-drop')
  assert.equal(events[0].level, 'warn')
  assert.deepEqual(events[0].evidence, {
    recentHitRate: 55,
    baselineHitRate: 80,
    dropPoints: 25,
    thresholdPoints: 20,
    windowMinutes: 60,
  })
})

test('Given 缓存命中率恰好下降 20 个百分点 When 检测 Then 不产事件(严格低于)', () => {
  const events = detectAnomalies({
    config: BASE_CONFIG,
    baseline: buildBaseline(ONE_WEEK),
    recent: { windowMinutes: 30, cost: 0, hitRate: 60 },
    history: { hitRate: 80 },
    modelShare: { current: null, baseline: null },
    idleMinutes: null,
    weekday: 1,
    now: NOW,
  })
  assert.deepEqual(events, [])
})

test('Given 最近 24h 主用模型是基线未见过的新模型 When 检测 Then 产 model-drift', () => {
  const events = detectAnomalies({
    config: BASE_CONFIG,
    baseline: buildBaseline(ONE_WEEK),
    recent: emptyRecent,
    history: { hitRate: null },
    modelShare: {
      current: { model: 'vendor/new', share: 0.8 },
      baseline: { model: 'vendor/old', share: 0.7, models: ['vendor/old', 'vendor/aux'] },
    },
    idleMinutes: null,
    weekday: 1,
    now: NOW,
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'model-drift')
  assert.equal(events[0].level, 'info')
  assert.deepEqual(events[0].evidence, {
    currentModel: 'vendor/new',
    currentShare: 0.8,
    baselineModel: 'vendor/old',
    baselineShare: 0.7,
    windowHours: 24,
  })
})

test('Given 主用模型与基线相同或已在基线出现 When 检测 Then 不产 model-drift', () => {
  const baseline = buildBaseline(ONE_WEEK)
  const same = detectAnomalies({
    config: BASE_CONFIG,
    baseline,
    recent: emptyRecent,
    history: { hitRate: null },
    modelShare: {
      current: { model: 'vendor/old', share: 0.8 },
      baseline: { model: 'vendor/old', share: 0.7, models: ['vendor/old'] },
    },
    idleMinutes: null,
    weekday: 1,
    now: NOW,
  })
  const known = detectAnomalies({
    config: BASE_CONFIG,
    baseline,
    recent: emptyRecent,
    history: { hitRate: null },
    modelShare: {
      current: { model: 'vendor/aux', share: 0.8 },
      baseline: { model: 'vendor/old', share: 0.5, models: ['vendor/old', 'vendor/aux'] },
    },
    idleMinutes: null,
    weekday: 1,
    now: NOW,
  })
  assert.deepEqual(same, [])
  assert.deepEqual(known, [])
})

test('Given 无用户输入超过阈值且窗口有费用 When 检测 Then 产 quiet-burn 并标注口径', () => {
  const events = detectAnomalies({
    config: BASE_CONFIG,
    baseline: buildBaseline(ONE_WEEK),
    recent: { windowMinutes: 30, cost: 0, hitRate: null, quietCost: 0.5, quietWindowMinutes: 60 },
    history: { hitRate: null },
    modelShare: { current: null, baseline: null },
    idleMinutes: 20,
    idleBasis: 'last-input',
    weekday: 1,
    now: NOW,
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'quiet-burn')
  assert.equal(events[0].level, 'warn')
  assert.deepEqual(events[0].evidence, {
    idleMinutes: 20,
    cost: 0.5,
    windowMinutes: 60,
    thresholdMinutes: 20,
    basis: 'last-input',
  })
})

test('Given 静默时长不足或窗口无费用 When 检测 Then 不产 quiet-burn', () => {
  const baseline = buildBaseline(ONE_WEEK)
  const notIdle = detectAnomalies({
    config: BASE_CONFIG,
    baseline,
    recent: { windowMinutes: 30, cost: 0, hitRate: null, quietCost: 1, quietWindowMinutes: 60 },
    history: { hitRate: null },
    modelShare: { current: null, baseline: null },
    idleMinutes: 19.9,
    weekday: 1,
    now: NOW,
  })
  const noCost = detectAnomalies({
    config: BASE_CONFIG,
    baseline,
    recent: { windowMinutes: 30, cost: 0, hitRate: null, quietCost: 0, quietWindowMinutes: 60 },
    history: { hitRate: null },
    modelShare: { current: null, baseline: null },
    idleMinutes: 30,
    weekday: 1,
    now: NOW,
  })
  assert.deepEqual(notIdle, [])
  assert.deepEqual(noCost, [])
})

test('Given 四类条件同时满足 When 检测 Then 按固定顺序返回四类事件且 ID 唯一', () => {
  const events = detectAnomalies({
    config: BASE_CONFIG,
    baseline: buildBaseline(ONE_WEEK),
    recent: { windowMinutes: 30, cost: 31, hitRate: 55, quietCost: 31, quietWindowMinutes: 60 },
    history: { hitRate: 80 },
    modelShare: {
      current: { model: 'vendor/new', share: 0.8 },
      baseline: { model: 'vendor/old', share: 0.7, models: ['vendor/old'] },
    },
    idleMinutes: 25,
    weekday: 1,
    now: NOW,
  })
  assert.deepEqual(events.map((event) => event.kind), ['burn-spike', 'cache-drop', 'model-drift', 'quiet-burn'])
  assert.equal(new Set(events.map((event) => event.id)).size, 4)
})

// —— 挂载层:假 store / 假 pricing / 假 ctx,手动触发检测 ——

const rule = {
  model: '*/*',
  unit: 'perMillion',
  currency: '¥',
  price: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
  conditions: [],
}

const makeRow = (bucket, overrides = {}) => ({
  bucket,
  provider: 'vendor',
  model: 'vendor/model-a',
  inputTokens: TOKENS,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 0,
  decodeTokens: 0,
  ttftMs: 0,
  ttftSteps: 0,
  requests: 1,
  turns: 0,
  lastSeen: NOW,
  ...overrides,
})

const dailyRows = (count = 8) => Array.from({ length: count }, (_, index) =>
  makeRow(dayKey(NOW - index * MS_PER_DAY, 'UTC')))

const makeStore = ({ daily = [], minute = [], hour = [] } = {}) => {
  const calls = []
  const byGranularity = { D: daily, H: hour, M: minute }
  return {
    calls,
    async rangeRows(granularity, from, to) {
      calls.push({ granularity, from, to })
      return (byGranularity[granularity] ?? []).filter((row) => row.bucket >= from && row.bucket <= to)
    },
  }
}

const makeCtx = (services = {}) => {
  const listeners = new Map()
  const effects = []
  return {
    listeners,
    effects,
    effect(setup, label) {
      const dispose = setup()
      effects.push({ label, dispose })
      return dispose
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    get(service) {
      return services[service]
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args)
    },
    logger: { warn() {} },
    fiber: { entry: { options: { id: 'dsh-usage-dash' } } },
  }
}

const makeTimer = () => {
  let callback = null
  let delay = 0
  let cleared = false
  return {
    get callback() { return callback },
    get delay() { return delay },
    get cleared() { return cleared },
    setInterval(fn, ms) {
      callback = fn
      delay = ms
      return Symbol('timer')
    },
    clearInterval() {
      cleared = true
    },
  }
}

// 开关已迁到 features,测试默认给开启形态;验证关闭的用例显式传 enabled:false
const install = ({ store, ctx = makeCtx(), now = () => NOW, config = BASE_CONFIG, pricingRules = [rule], retentionDays = () => 7 } = {}) => {
  const timer = makeTimer()
  const handle = installSentinel(ctx, {
    store,
    pricing: { active: true, rules: () => pricingRules, revision: () => 1 },
    now,
    timeZone: 'UTC',
    retentionDays,
    ...(config === null ? {} : { config }),
    intervalMs: 60 * 1000,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  })
  return { handle, ctx, timer }
}

test('Given 8 天基线且最近 30 分钟燃烧超阈值 When 挂载检测 Then 产事件并可忽略', async () => {
  // Given 每天 ¥1 的 8 天基线 + 最近 20 分钟 ¥4
  const store = makeStore({
    daily: dailyRows(),
    minute: [5, 10, 15, 20].map((minutes) => makeRow(minuteKey(NOW - minutes * MS_PER_MINUTE, 'UTC'))),
    hour: [],
  })
  const { handle, timer } = install({ store })

  // When 首轮检测
  const status = await handle.refresh().then(() => handle.status())

  // Then 基线足够、产 burn-spike、定时器 60 秒
  assert.equal(timer.delay, 60 * 1000)
  assert.equal(status.reason, null)
  assert.equal(status.baseline.days, 8)
  assert.equal(status.events.length, 1)
  const [event] = status.events
  assert.equal(event.kind, 'burn-spike')
  assert.equal(event.evidence.recentCost, 4)
  // 30 分钟 4 元日化为 192 元,对 p95=1 的日基线为 192 倍
  assert.equal(event.evidence.projectedDaily, 192)
  assert.equal(event.evidence.p95, 1)
  assert.equal(event.evidence.multiplier, 192)

  // 忽略后事件不再出现;同一 kind 冷却期内重复检测不补发
  assert.deepEqual(handle.ack([event.id]), { acked: 1 })
  assert.deepEqual(handle.status().events, [])
  await handle.refresh()
  assert.deepEqual(handle.status().events, [])
  handle.dispose()
  assert.equal(timer.cleared, true)
})

test('Given 同一 kind 首次触发后继续超阈值 When 一分钟后再检测 Then 30 分钟内不重复', async () => {
  let nowMs = NOW
  const store = makeStore({
    daily: dailyRows(),
    minute: [5, 10, 15, 20].map((minutes) => makeRow(minuteKey(NOW - minutes * MS_PER_MINUTE, 'UTC'))),
  })
  const { handle } = install({ store, now: () => nowMs })
  await handle.refresh()
  assert.equal(handle.status().events.length, 1)

  nowMs = NOW + MS_PER_MINUTE
  await handle.refresh()
  assert.equal(handle.status().events.length, 1)

  // 31 分钟后冷却结束,换一批新分钟行再次触发
  nowMs = NOW + 31 * MS_PER_MINUTE
  store.rangeRows = async (granularity, from, to) => {
    if (granularity === 'M') {
      return [5, 10, 15, 20].map((minutes) => makeRow(minuteKey(nowMs - minutes * MS_PER_MINUTE, 'UTC')))
    }
    if (granularity === 'D') return dailyRows()
    return []
  }
  await handle.refresh()
  assert.equal(handle.status().events.length, 2)
  handle.dispose()
})

test('Given 无定价规则 When 挂载检测 Then status 标注原因且无伪事件', async () => {
  const store = makeStore({ daily: dailyRows(), minute: [makeRow(minuteKey(NOW - 5 * MS_PER_MINUTE, 'UTC'))] })
  const { handle } = install({ store, pricingRules: [] })
  await handle.refresh()
  const status = handle.status()
  assert.equal(status.reason, 'no-pricing')
  assert.equal(status.baseline, null)
  assert.deepEqual(status.events, [])
  handle.dispose()
})

test('Given 基线不足 When 挂载检测 Then status 标注不足且无事件', async () => {
  const store = makeStore({
    daily: dailyRows(3),
    minute: [5, 10, 15].map((minutes) => makeRow(minuteKey(NOW - minutes * MS_PER_MINUTE, 'UTC'))),
  })
  const { handle } = install({ store })
  await handle.refresh()
  const status = handle.status()
  assert.equal(status.reason, 'baseline-insufficient')
  assert.equal(status.baseline.insufficient, true)
  assert.equal(status.baseline.days, 3)
  assert.deepEqual(status.events, [])
  handle.dispose()
})

test('Given 开关关闭 When 挂载检测 Then status 标注 disabled 且无事件', async () => {
  const store = makeStore({ daily: dailyRows() })
  const { handle } = install({ store, config: { ...BASE_CONFIG, enabled: false } })
  await handle.refresh()
  const status = handle.status()
  assert.equal(status.reason, 'disabled')
  assert.deepEqual(status.events, [])
  handle.dispose()
})

test('Given 无用户输入事件且最近 30 分钟无请求 When 检测 Then 用请求窗口近似并标注口径', async () => {
  // Given 45 分钟前有费用、最近 30 分钟无请求;插件从未观测到用户消息
  const store = makeStore({
    daily: dailyRows(),
    minute: [makeRow(minuteKey(NOW - 45 * MS_PER_MINUTE, 'UTC'), { requests: 0 })],
  })
  const { handle } = install({ store })
  await handle.refresh()
  const status = handle.status()
  const quiet = status.events.find((event) => event.kind === 'quiet-burn')
  assert.ok(quiet)
  assert.equal(quiet.evidence.basis, 'request-window-approx')
  assert.equal(quiet.evidence.idleMinutes, 30)
  handle.dispose()
})

test('Given 观测到用户消息 When 检测 Then 按真实空闲时长抑制 quiet-burn', async () => {
  // Given 45 分钟前有费用,但 5 分钟前刚有用户消息
  const store = makeStore({
    daily: dailyRows(),
    minute: [makeRow(minuteKey(NOW - 45 * MS_PER_MINUTE, 'UTC'), { requests: 0 })],
  })
  const ctx = makeCtx()
  const { handle } = install({ store, ctx })
  ctx.emit('session/event', { header: { id: 's1' } }, { type: 'user/message', time: NOW - 5 * MS_PER_MINUTE })
  await handle.refresh()
  const quiet = handle.status().events.find((event) => event.kind === 'quiet-burn')
  assert.equal(quiet, undefined)
  handle.dispose()
  assert.equal(ctx.listeners.size, 0)
})

test('Given 投影配置 When 挂载 Then status 回显归一后的阈值与开关', async () => {
  const { handle } = install({
    store: makeStore({ daily: dailyRows() }),
    config: { enabled: true, burnMultiplier: 5, cacheDropPoints: 30, quietBurnMinutes: 15 },
  })
  await handle.refresh()
  assert.deepEqual(handle.status().config, {
    enabled: true,
    burnMultiplier: 5,
    cacheDropPoints: 30,
    quietBurnMinutes: 15,
  })
  handle.dispose()
})

test('Given 事件表超过上限 When 多轮检测 Then 最多保留 50 条', async () => {
  let nowMs = NOW
  // 基线模型 old 且有缓存命中,小时桶出现新模型;分钟桶制造燃烧与零命中
  const baseDaily = Array.from({ length: 8 }, (_, index) =>
    makeRow(dayKey(NOW - index * MS_PER_DAY, 'UTC'), {
      model: 'vendor/old',
      inputTokens: 0,
      cacheReadTokens: TOKENS,
    }))
  const store = makeStore({ daily: baseDaily })
  const { handle } = install({ store, now: () => nowMs })
  for (let round = 0; round < 14; round += 1) {
    nowMs = NOW + round * 31 * MS_PER_MINUTE
    store.rangeRows = async (granularity) => {
      if (granularity === 'D') return baseDaily
      if (granularity === 'M') {
        return [5, 10, 15, 20].map((minutes) => makeRow(minuteKey(nowMs - minutes * MS_PER_MINUTE, 'UTC'), {
          requests: 0,
        }))
      }
      if (granularity === 'H') {
        return [makeRow(hourKey(nowMs - MS_PER_MINUTE, 'UTC'), { model: 'vendor/new' })]
      }
      return []
    }
    await handle.refresh()
    assert.equal(handle.status().events.length, Math.min((round + 1) * 4, 50))
  }
  assert.equal(handle.status().events.length, 50)
  handle.dispose()
})

test('Given 检测在飞 When 改配置再 refresh Then 补跑一次并按新配置重算', async () => {
  const ctx = makeCtx()
  let config = { ...BASE_CONFIG, burnMultiplier: 1 }
  const slowStore = {
    async rangeRows() {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return dailyRows()
    },
  }
  const handle = installSentinel(ctx, {
    store: slowStore,
    pricing: { active: true, rules: () => [rule], revision: () => 1 },
    now: () => NOW,
    timeZone: 'UTC',
    retentionDays: () => 7,
    config: () => config,
    intervalMs: 60 * 1000,
    setInterval: () => 0,
    clearInterval: () => {},
  })
  // 安装即启动一次检测;改一个要过 await 才落地的字段,补跑必须按新配置重算
  config = { ...BASE_CONFIG, burnMultiplier: 2 }
  await handle.refresh()
  assert.equal(handle.status().config.burnMultiplier, 2, '补跑要按新配置重算')
  handle.dispose()
})

test('Given 检测在飞 When 多个等待者 Then 都拿到同一轮补跑后的快照', async () => {
  const ctx = makeCtx()
  let config = { ...BASE_CONFIG, burnMultiplier: 1 }
  // 每轮检测的时间戳必须不同,否则无法区分「同一轮」与「上一轮」
  let rounds = 0
  const slowStore = {
    async rangeRows() {
      rounds += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return dailyRows()
    },
  }
  const handle = installSentinel(ctx, {
    store: slowStore,
    pricing: { active: true, rules: () => [rule], revision: () => 1 },
    now: () => NOW + rounds * 60 * 1000,
    timeZone: 'UTC',
    retentionDays: () => 7,
    config: () => config,
    intervalMs: 60 * 1000,
    setInterval: () => 0,
    clearInterval: () => {},
  })
  config = { ...BASE_CONFIG, burnMultiplier: 2 }
  const snaps = await Promise.all([
    handle.refresh(), handle.refresh(), handle.refresh(), handle.refresh(), handle.refresh(),
  ])
  // 只有第一个等待者等补跑时,其余会拿着上一轮的时间戳与事件返回
  assert.equal(new Set(snaps.map((snap) => snap.updatedAt)).size, 1, '五个等待者应是同一轮快照')
  assert.ok(snaps[0].updatedAt > NOW, '这一轮必须是补跑那轮,不是安装时那次')
  for (const snap of snaps) assert.equal(snap.config.burnMultiplier, 2)
  handle.dispose()
})

test('Given 多个调用同时在飞 When 逐个 refresh Then 只补跑一次', async () => {
  const ctx = makeCtx()
  let calls = 0
  const slowStore = {
    async rangeRows() {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return dailyRows()
    },
  }
  const handle = installSentinel(ctx, {
    store: slowStore,
    pricing: { active: true, rules: () => [rule], revision: () => 1 },
    now: () => NOW,
    timeZone: 'UTC',
    retentionDays: () => 7,
    config: () => BASE_CONFIG,
    intervalMs: 60 * 1000,
    setInterval: () => 0,
    clearInterval: () => {},
  })
  // 先让安装时那次检测落地,再量单轮与并发的查询增量
  await new Promise((resolve) => setTimeout(resolve, 40))
  const beforeSingle = calls
  await handle.refresh()
  const single = calls - beforeSingle
  const before = calls
  await Promise.all([handle.refresh(), handle.refresh(), handle.refresh()])
  const burst = calls - before
  assert.ok(single > 0)
  // 并发三次:第一发起检测,其余命中在飞并排队补跑一次 → 恰好两轮
  assert.ok(burst > single, `并发 refresh 必须补跑:单轮 ${single} 次查询,突发 ${burst} 次`)
  assert.ok(burst <= single * 2, `并发 refresh 只应补跑一次:单轮 ${single} 次查询,突发 ${burst} 次`)
  handle.dispose()
})
