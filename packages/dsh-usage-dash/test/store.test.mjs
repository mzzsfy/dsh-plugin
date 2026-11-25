// store 行为测试:桶键生成、三粒度落桶、写入重试与失败聚合、清理窗口、游标链。
// 域句柄以内存假件注入,断言外部可观察行为(表内容与游标值),不断言内部实现。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MINUTE_RETENTION_DAYS,
  HOUR_RETENTION_DAYS,
  MINUTE_BUCKET_SPAN_MINUTES,
  MINUTE_RETENTION_MAX_DAYS,
  UsageStore,
  __resetSharedStoreForTests,
  clampMinuteRetentionDays,
  dayKey,
  hourKey,
  minuteBucketStart,
  minuteKey,
  sharedStore,
} from '../src/store.js'

const DAY_MS = 24 * 60 * 60 * 1000

// 本地时区构造时间戳,测试不依赖运行环境时区
const local = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime()

function rowOf(bucket, provider, model) {
  return {
    bucket,
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
    turns: 0,
    lastSeen: 0,
  }
}

// 内存假域:表与 global 方法面同构;failUpdate/failPut/failGlobal 返回错误时对应写入抛出,
// onDelete 供在清表事务内部注入「事务期间到达的实时写入」
function fakeDomain({ failUpdate = () => null, failPut = () => null, failGlobal = () => null, onDelete = () => {} } = {}) {
  const rows = new Map()
  const sessionRows = new Map()
  const stats = { puts: 0, sessionPuts: 0, globalSets: 0 }
  let globalValue = { backfilledSessions: [], liveFirstSeq: {} }
  const makeTable = (store, name, countPut) => ({
    get: (key) => store.get(key),
    keys: () => store.keys(),
    entries: () => store.entries(),
    get size() {
      return store.size
    },
    async put(key, value) {
      const failure = failPut(name, key)
      if (failure) throw failure
      countPut()
      store.set(key, value)
    },
    async delete(key) {
      await onDelete(name, key)
      return store.delete(key)
    },
    async update(key, fn) {
      const failure = failUpdate(key)
      if (failure) throw failure
      const current = store.get(key)
      if (current === undefined) {
        // 与宿主 storage-domain 缺键报错同形,匹配 /no record .* to update/
        throw new Error(`domain 'usage_stats' table '${name}' has no record '${key}' to update`)
      }
      store.set(key, fn(current))
    },
  })
  const bucketsTable = makeTable(rows, 'buckets', () => { stats.puts += 1 })
  const sessionsTable = makeTable(sessionRows, 'sessions', () => { stats.sessionPuts += 1 })
  return {
    rows,
    sessionRows,
    stats,
    table: (name) => (name === 'sessions' ? sessionsTable : bucketsTable),
    global: {
      get: () => globalValue,
      set: async (value) => {
        const failure = failGlobal()
        if (failure) throw failure
        stats.globalSets += 1
        globalValue = value
      },
    },
  }
}

// F14 契约:record 按档保留资格过滤。夹具时钟固定在样本日次日,样本全部
// 落在留存期内;超期丢弃语义由专项用例验证
const FIXED_NOW = local(2026, 8, 3, 0, 0)
const facilityOf = (domain, backupDomain) => ({
  open: async (definition) => (definition?.name === 'usage_stats_backup' ? (backupDomain ?? domain) : domain),
})
const makeStore = (domain, options = {}) => new UsageStore(facilityOf(domain), { now: () => FIXED_NOW, ...options })

const tokenSample = (time, extra = {}) => ({
  time,
  model: 'deepseek/deepseek-chat',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  ...extra,
})

test('分钟保留天数默认常量与上限和计划一致', () => {
  assert.equal(DEFAULT_MINUTE_RETENTION_DAYS, 7)
  assert.equal(MINUTE_RETENTION_MAX_DAYS, 7)
  assert.equal(HOUR_RETENTION_DAYS, 15)
})

test('分钟保留值归一:非法回落默认,超上限截断,0 保留', () => {
  assert.equal(clampMinuteRetentionDays(1), 1)
  assert.equal(clampMinuteRetentionDays(0), 0)
  assert.equal(clampMinuteRetentionDays(30), 7)
  assert.equal(clampMinuteRetentionDays(-1), 7)
  assert.equal(clampMinuteRetentionDays('x'), 7)
})

test('桶键生成含补零,分钟桶对齐 10 分钟', () => {
  const ts = local(2026, 1, 5, 3, 7)
  assert.equal(dayKey(ts), '2026-01-05')
  assert.equal(hourKey(ts), '2026-01-05T03')
  assert.equal(minuteKey(ts), '2026-01-05T03:00')
  const late = local(2026, 12, 31, 23, 59)
  assert.equal(hourKey(late), '2026-12-31T23')
  assert.equal(minuteKey(late), '2026-12-31T23:50')
  const aligned = local(2026, 1, 5, 3, 20)
  assert.equal(minuteKey(aligned), '2026-01-05T03:20')
})

test('跨日跨时跨分边界:毫秒推进即换桶', () => {
  const before = local(2026, 8, 2, 23, 59, 59, 999)
  const after = before + 1
  assert.equal(dayKey(before), '2026-08-02')
  assert.equal(dayKey(after), '2026-08-03')
  assert.equal(hourKey(before), '2026-08-02T23')
  assert.equal(hourKey(after), '2026-08-03T00')
  assert.equal(minuteKey(before), '2026-08-02T23:50')
  assert.equal(minuteKey(after), '2026-08-03T00:00')
})

test('A4 桶键显式时区:同一时刻按不同宿主日历落不同桶', () => {
  // Given 宿主 UTC 与 +8 两个日历口径 When 取同一时刻的桶键 Then 日/时/分整体按日历平移
  const ts = Date.parse('2026-03-15T18:30:00Z')
  assert.equal(dayKey(ts, 'UTC'), '2026-03-15')
  assert.equal(hourKey(ts, 'UTC'), '2026-03-15T18')
  assert.equal(minuteKey(ts, 'UTC'), '2026-03-15T18:30')
  assert.equal(dayKey(ts, 'Asia/Shanghai'), '2026-03-16')
  assert.equal(hourKey(ts, 'Asia/Shanghai'), '2026-03-16T02')
  assert.equal(minuteKey(ts, 'Asia/Shanghai'), '2026-03-16T02:30')
})

test('分钟桶按本地墙钟对齐:非整十分钟偏移时区(+5:45)不落到非桶分钟', () => {
  // Given 尼泊尔偏移 -345(UTC+5:45)下的 UTC 整十分钟刻度
  const utcTen = Date.UTC(2026, 2, 15, 6, 0)
  const wallOf = (ts) => new Date(ts + 345 * 60 * 1000)
  // When 取桶起点
  const start = minuteBucketStart(utcTen, -345)
  // Then 落到本地墙钟 11:40(而非 UTC 对齐得到的 11:45),同刻同桶且不跨时
  const wall = wallOf(start)
  assert.equal(wall.getUTCHours(), 11)
  assert.equal(wall.getUTCMinutes(), 40)
  assert.equal(wall.getUTCMinutes() % MINUTE_BUCKET_SPAN_MINUTES, 0)
  // 同刻同桶:墙钟 11:45 落 11:40 桶,11:50 起落下一桶
  assert.equal(start, utcTen - 5 * 60 * 1000)
  assert.equal(wallOf(minuteBucketStart(utcTen + 14 * 60 * 1000, -345)).getUTCMinutes(), 50)
  // 跨日:本地 00:05 归次日 00:00 桶
  const afterMidnight = Date.UTC(2026, 2, 15, 18, 20)
  const midnight = wallOf(minuteBucketStart(afterMidnight, -345))
  assert.equal(midnight.getUTCDate(), 16)
  assert.equal(midnight.getUTCHours(), 0)
  assert.equal(midnight.getUTCMinutes(), 0)
})

test('token 样本同刻落三粒度三行,行内无 g 字段', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.flushNow()
  const keys = ['D|(workspace-unknown)|2026-08-02', 'H|(workspace-unknown)|2026-08-02T14', 'M|(workspace-unknown)|2026-08-02T14:30'].map(
    (prefix) => `${prefix}|deepseek|deepseek/deepseek-chat`,
  )
  assert.equal(domain.rows.size, 3)
  for (const key of keys) {
    const seen = domain.rows.get(key)
    assert.ok(seen, `缺少行 ${key}`)
    assert.equal(seen.inputTokens, 10)
    assert.equal(seen.outputTokens, 20)
    assert.equal(seen.cacheReadTokens, 3)
    assert.equal(seen.cacheWriteTokens, 4)
    assert.equal(seen.requests, 0)
    assert.equal(seen.turns, 0)
    assert.equal('g' in seen, false)
  }
})

test('turn 样本落合成行:provider default 与 model (turns)', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.record({ time: local(2026, 8, 2, 14, 37), turn: true })
  await store.flushNow()
  const seen = domain.rows.get('D|(workspace-unknown)|2026-08-02|default|(turns)')
  assert.ok(seen)
  assert.equal(seen.turns, 1)
  assert.equal(seen.inputTokens, 0)
})

test('request 样本只计请求数,无归因落 (unknown)', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.record({ time: local(2026, 8, 2, 14, 37), request: true, model: 'deepseek-chat' })
  await store.record({ time: local(2026, 8, 2, 14, 38), request: true })
  await store.flushNow()
  const labelled = domain.rows.get('D|(workspace-unknown)|2026-08-02|default|deepseek-chat')
  assert.ok(labelled)
  assert.equal(labelled.requests, 1)
  assert.equal(labelled.inputTokens, 0)
  const unknown = domain.rows.get('D|(workspace-unknown)|2026-08-02|default|(unknown)')
  assert.ok(unknown)
  assert.equal(unknown.requests, 1)
})

test('token 样本时长落三粒度累加,request 与 turn 行时长恒 0', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const at = local(2026, 8, 2, 14, 37)
  await store.record(tokenSample(at, { durationMs: 6500 }))
  await store.record(tokenSample(at + 1000, { durationMs: 2500 }))
  await store.record({ time: at, request: true, model: 'deepseek/deepseek-chat' })
  await store.record({ time: at, turn: true })
  await store.flushNow()
  const daily = domain.rows.get('D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat')
  assert.equal(daily.outputTokens, 40)
  assert.equal(daily.durationMs, 9000)
  const hourly = domain.rows.get('H|(workspace-unknown)|2026-08-02T14|deepseek|deepseek/deepseek-chat')
  assert.equal(hourly.durationMs, 9000)
  const minute = domain.rows.get('M|(workspace-unknown)|2026-08-02T14:30|deepseek|deepseek/deepseek-chat')
  assert.equal(minute.durationMs, 9000)
  const requestRow = domain.rows.get('D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat')
  assert.equal(requestRow.requests, 1)
  const turnRow = domain.rows.get('D|(workspace-unknown)|2026-08-02|default|(turns)')
  assert.equal(turnRow.durationMs, 0)
})

test('老行缺 durationMs 字段:增量求和不产 NaN', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const at = local(2026, 8, 2, 14, 37)
  const key = 'D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat'
  await store.record(tokenSample(at))
  await store.flushNow()
  // 模拟存量旧格式行:回写去掉 durationMs 字段
  const stored = domain.rows.get(key)
  delete stored.durationMs
  await store.record(tokenSample(at + 1000, { durationMs: 3000 }))
  await store.flushNow()
  const seen = domain.rows.get(key)
  assert.equal(seen.durationMs, 3000)
  assert.equal(seen.outputTokens, 40)
})

test('decode 配对与首字样本落三粒度累加,timing 样本不重复计 token', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const at = local(2026, 8, 2, 14, 37)
  // chunk 先发 token 样本:只有 token 桶
  await store.record(tokenSample(at, { durationMs: undefined }))
  // message 补发纯 timing 增量:零桶 + decodeTokens + durationMs + ttftMs
  await store.record(tokenSample(at + 1000, {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    decodeTokens: 20, durationMs: 30000, ttftMs: 10000,
  }))
  await store.flushNow()
  const key = 'D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat'
  const daily = domain.rows.get(key)
  assert.equal(daily.outputTokens, 20)
  assert.equal(daily.decodeTokens, 20)
  assert.equal(daily.durationMs, 30000)
  assert.equal(daily.ttftMs, 10000)
  assert.equal(daily.ttftSteps, 1)
  const minute = domain.rows.get('M|(workspace-unknown)|2026-08-02T14:30|deepseek|deepseek/deepseek-chat')
  assert.equal(minute.decodeTokens, 20)
  assert.equal(minute.ttftMs, 10000)
})

test('timing 缺失样本:decodeTokens 与 ttft 字段按零累计', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const at = local(2026, 8, 2, 14, 37)
  await store.record(tokenSample(at))
  await store.flushNow()
  const seen = domain.rows.get('D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat')
  assert.equal(seen.decodeTokens, 0)
  assert.equal(seen.durationMs, 0)
  assert.equal(seen.ttftMs, 0)
  assert.equal(seen.ttftSteps, 0)
})

test('老行缺 decode/ttft 字段:增量求和不产 NaN', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const at = local(2026, 8, 2, 14, 37)
  const key = 'D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat'
  await store.record(tokenSample(at))
  await store.flushNow()
  // 模拟存量旧格式行:回写去掉新增字段
  const stored = domain.rows.get(key)
  delete stored.decodeTokens
  delete stored.ttftMs
  delete stored.ttftSteps
  await store.record(tokenSample(at + 1000, { decodeTokens: 20, durationMs: 3000, ttftMs: 500 }))
  await store.flushNow()
  const seen = domain.rows.get(key)
  assert.equal(seen.decodeTokens, 20)
  assert.equal(seen.durationMs, 3000)
  assert.equal(seen.ttftMs, 500)
  assert.equal(seen.ttftSteps, 1)
})

test('missing-record 首写竞态:put 种子后重试写入真值', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.flushNow()
  assert.equal(domain.stats.puts, 3)
  const seen = domain.rows.get('D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat')
  assert.equal(seen.inputTokens, 10)
})

test('flush 中单粒度失败:错误经 onFlushError 上抛,失败行留 pending 重试,成功粒度落盘', async () => {
  const failedKeys = new Set()
  const domain = fakeDomain({
    failUpdate: (key) => {
      if (!key.startsWith('H|(workspace-unknown)|') || failedKeys.has(key)) return null
      failedKeys.add(key)
      return new Error('simulated hour failure')
    },
  })
  const store = makeStore(domain)
  const errors = []
  store.onFlushError = (err) => errors.push(err)
  await store.readyPromise()
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.flushNow()
  assert.ok(domain.rows.has('D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat'))
  assert.ok(domain.rows.has('M|(workspace-unknown)|2026-08-02T14:30|deepseek|deepseek/deepseek-chat'))
  assert.equal(domain.rows.has('H|(workspace-unknown)|2026-08-02T14|deepseek|deepseek/deepseek-chat'), false)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].name, 'AggregateError')
  assert.equal(errors[0].errors.length, 1)
  await store.flushNow()
  assert.ok(domain.rows.has('H|(workspace-unknown)|2026-08-02T14|deepseek|deepseek/deepseek-chat'))
})

test('非 missing 错误不触发种子重试', async () => {
  const key = 'D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat'
  const domain = fakeDomain({
    failUpdate: (candidate) => (candidate === key ? new Error('backend write failed') : null),
  })
  const store = makeStore(domain)
  const errors = []
  store.onFlushError = (err) => errors.push(err)
  await store.readyPromise()
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.flushNow()
  assert.equal(domain.rows.has(key), false)
  assert.equal(errors.length, 1)
  assert.match(errors[0].errors[0].message, /backend write failed/)
  assert.equal(domain.stats.puts, 2)
})

test('rangeRows 按粒度前缀与桶串闭区间扫描', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const table = domain.table()
  await table.put('D|(workspace-unknown)|2026-07-31|a|m', rowOf('2026-07-31', 'a', 'm'))
  await table.put('D|(workspace-unknown)|2026-08-01|a|m', rowOf('2026-08-01', 'a', 'm'))
  await table.put('D|(workspace-unknown)|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  await table.put('H|(workspace-unknown)|2026-08-01T10|a|m', rowOf('2026-08-01T10', 'a', 'm'))
  await table.put('M|(workspace-unknown)|2026-08-01T10:30|a|m', rowOf('2026-08-01T10:30', 'a', 'm'))
  const days = await store.rangeRows('D', '2026-08-01', '2026-08-02')
  assert.deepEqual(days.map((seen) => seen.bucket).sort(), ['2026-08-01', '2026-08-02'])
  const hours = await store.rangeRows('H', '2026-08-01T00', '2026-08-01T23')
  assert.deepEqual(hours.map((seen) => seen.bucket), ['2026-08-01T10'])
  const minutes = await store.rangeRows('M', '2026-08-01T10:30', '2026-08-01T10:30')
  assert.deepEqual(minutes.map((seen) => seen.bucket), ['2026-08-01T10:30'])
})

test('pruneMinutes 按保留窗口清理分钟桶且不碰其他粒度', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain, { now: () => local(2026, 8, 10, 12, 0) })
  const table = domain.table()
  await table.put('M|(workspace-unknown)|2026-08-01T11:00|a|m', rowOf('2026-08-01T11:00', 'a', 'm'))
  await table.put('M|(workspace-unknown)|2026-08-08T12:00|a|m', rowOf('2026-08-08T12:00', 'a', 'm'))
  await table.put('M|(workspace-unknown)|2026-08-09T00:00|a|m', rowOf('2026-08-09T00:00', 'a', 'm'))
  await table.put('D|(workspace-unknown)|2026-08-01|a|m', rowOf('2026-08-01', 'a', 'm'))
  await table.put('H|(workspace-unknown)|2026-08-01T00|a|m', rowOf('2026-08-01T00', 'a', 'm'))
  await store.pruneMinutes(DEFAULT_MINUTE_RETENTION_DAYS)
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-01T11:00|a|m'), false)
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-08T12:00|a|m'), true)
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-09T00:00|a|m'), true)
  assert.equal(domain.rows.has('D|(workspace-unknown)|2026-08-01|a|m'), true)
  assert.equal(domain.rows.has('H|(workspace-unknown)|2026-08-01T00|a|m'), true)
})

test('保留窗口为 0 时分钟桶全部清理', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain, { now: () => local(2026, 8, 10, 12, 0) })
  const table = domain.table()
  await table.put('M|(workspace-unknown)|2026-08-10T11:00|a|m', rowOf('2026-08-10T11:00', 'a', 'm'))
  await table.put('D|(workspace-unknown)|2026-08-10|a|m', rowOf('2026-08-10', 'a', 'm'))
  await store.pruneMinutes(0)
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-10T11:00|a|m'), false)
  assert.equal(domain.rows.has('D|(workspace-unknown)|2026-08-10|a|m'), true)
})

test('分钟保留超上限时 clamp 到 7 天窗口', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain, { now: () => local(2026, 8, 10, 12, 0) })
  const table = domain.table()
  // clamp 后窗口起点 = 08-03T12:00,7 天前的桶一律清理,即使注入 30 天
  await table.put('M|(workspace-unknown)|2026-08-01T00:00|a|m', rowOf('2026-08-01T00:00', 'a', 'm'))
  await table.put('M|(workspace-unknown)|2026-08-03T12:00|a|m', rowOf('2026-08-03T12:00', 'a', 'm'))
  await store.pruneMinutes(30)
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-01T00:00|a|m'), false)
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-03T12:00|a|m'), true)
})

test('pruneHours 固定 15 天窗口清理小时桶且不碰其他粒度', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain, { now: () => local(2026, 8, 10, 12, 0) })
  const table = domain.table()
  await table.put('H|(workspace-unknown)|2026-07-25T00:00|a|m', rowOf('2026-07-25T00:00', 'a', 'm'))
  await table.put('H|(workspace-unknown)|2026-07-26T12:00|a|m', rowOf('2026-07-26T12:00', 'a', 'm'))
  await table.put('D|(workspace-unknown)|2026-07-20|a|m', rowOf('2026-07-20', 'a', 'm'))
  await table.put('M|(workspace-unknown)|2026-07-25T00:00|a|m', rowOf('2026-07-25T00:00', 'a', 'm'))
  await store.pruneHours()
  assert.equal(domain.rows.has('H|(workspace-unknown)|2026-07-25T00:00|a|m'), false)
  assert.equal(domain.rows.has('H|(workspace-unknown)|2026-07-26T12:00|a|m'), true)
  assert.equal(domain.rows.has('D|(workspace-unknown)|2026-07-20|a|m'), true)
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-07-25T00:00|a|m'), true)
})

test('每日本地日首次 flush 触发清理,同日后续 flush 不重复触发', async () => {
  let clock = local(2026, 8, 10, 12, 0)
  const domain = fakeDomain()
  const store = makeStore(domain, { now: () => clock, retentionDays: () => 0 })
  const table = domain.table()
  await table.put('M|(workspace-unknown)|2026-08-01T00:00|a|m', rowOf('2026-08-01T00:00', 'a', 'm'))
  await store.record(tokenSample(local(2026, 8, 10, 12, 0)))
  await store.flushNow()
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-01T00:00|a|m'), false)
  await table.put('M|(workspace-unknown)|2026-08-01T00:00|a|m', rowOf('2026-08-01T00:00', 'a', 'm'))
  await store.record(tokenSample(local(2026, 8, 10, 12, 1)))
  await store.flushNow()
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-01T00:00|a|m'), true)
  clock = local(2026, 8, 11, 0, 0)
  await store.record(tokenSample(local(2026, 8, 11, 0, 0)))
  await store.flushNow()
  assert.equal(domain.rows.has('M|(workspace-unknown)|2026-08-01T00:00|a|m'), false)
})

test('并发 markSeenSessions 不丢 id', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await Promise.all([
    store.markSeenSessions(['a']),
    store.markSeenSessions(['b']),
    store.markSeenSessions(['c']),
  ])
  assert.deepEqual([...(await store.seenSessions())].sort(), ['a', 'b', 'c'])
})

test('游标链串行:reset 排在先前 markSeen 之后,行与游标一致重置', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const pending = store.markSeenSessions(['a'])
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.reset(new Map([['live-a', 7]]))
  await pending
  assert.equal(domain.rows.size, 0)
  assert.deepEqual(domain.global.get(), { backfilledSessions: [], liveFirstSeq: { 'live-a': 7 } })
})

test('reset 不带边界时游标清空', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.markLiveSequences([['s', 5]])
  await store.reset()
  assert.deepEqual(domain.global.get(), { backfilledSessions: [], liveFirstSeq: {} })
})

test('markLiveSequences 保留最小 seq 且无变化不写 global', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.markLiveSequences([['s', 5]])
  assert.deepEqual(await store.liveSequences(), new Map([['s', 5]]))
  await store.markLiveSequences([['s', 3], ['t', 9]])
  assert.deepEqual(await store.liveSequences(), new Map([['s', 3], ['t', 9]]))
  const setsAfterChange = domain.stats.globalSets
  await store.markLiveSequences([['s', 4]])
  assert.equal(domain.stats.globalSets, setsAfterChange)
  assert.deepEqual(await store.liveSequences(), new Map([['s', 3], ['t', 9]]))
})

test('游标写单次失败不断链', async () => {
  const domain = fakeDomain()
  const originalSet = domain.global.set
  let failed = false
  domain.global.set = async (value) => {
    if (!failed) {
      failed = true
      throw new Error('simulated set failure')
    }
    return originalSet(value)
  }
  const store = makeStore(domain)
  await assert.rejects(store.markSeenSessions(['a']))
  await store.markSeenSessions(['b'])
  assert.deepEqual([...(await store.seenSessions())].sort(), ['b'])
})

test('启动时游标为空且已有行:只标记待清,回扫读出会话后 clearOrphanRows 才清空', async () => {
  const domain = fakeDomain()
  await domain.table().put('D|(workspace-unknown)|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  await domain.table('sessions').put('H|(workspace-unknown)|2026-08-02T10|s1', { bucket: '2026-08-02T10', workspaceId: '(workspace-unknown)', sessions: ['s1'] })
  const store = makeStore(domain)
  await store.readyPromise()
  assert.equal(domain.rows.size, 1, '启动阶段不得先清历史')
  assert.equal(domain.sessionRows.size, 1)
  assert.equal(store.orphanResetPending, true)
  assert.equal(await store.clearOrphanRows(), true)
  assert.equal(domain.rows.size, 0)
  assert.equal(domain.sessionRows.size, 0)
  assert.equal(store.orphanResetPending, false)
  // 幂等:再次调用不重复处理
  assert.equal(await store.clearOrphanRows(), false)
})

// U3:孤儿清理先 flush 再整表删除,本 boot 实时行也被删;回扫对实时拥区间
// (liveFirstSeq 之后)跳过重放,store 必须自行回填实时增量与会话索引
test('U3 孤儿清理保留本 boot 实时行并回填(含已落盘行,不含上一 boot 孤儿行)', async () => {
  const domain = fakeDomain()
  // 上一 boot 遗留:表有行、游标空 → 孤儿态
  await domain.table().put('M|(workspace-unknown)|2026-08-02T14:30|deepseek|deepseek/deepseek-chat',
    { ...rowOf('2026-08-02T14:30', 'deepseek', 'deepseek/deepseek-chat'), inputTokens: 111, lastSeen: 1 })
  await domain.table('sessions').put('D|(workspace-unknown)|2026-08-02', { bucket: '2026-08-02', workspaceId: '(workspace-unknown)', sessions: ['stale'] })
  const store = makeStore(domain)
  await store.readyPromise()
  assert.equal(store.orphanResetPending, true)
  // 本 boot 实时样本已 flush 落表(孤儿清理发生在本轮回扫首个会话之后)
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)), { live: true })
  await store.recordSession('live-session', local(2026, 8, 2, 14, 37), { live: true })
  await store.flushNow()
  assert.equal(store.orphanResetPending, true)

  assert.equal(await store.clearOrphanRows(), true)
  await store.flushNow()
  // 实时行原样重建:同桶同维度只有本 boot 增量,不含孤儿行的 111
  const minuteRows = await store.rangeRows('M', '2026-08-02T14:30', '2026-08-02T14:30')
  assert.equal(minuteRows.length, 1)
  assert.equal(minuteRows[0].inputTokens, 10, '实时增量不双计也不丢')
  assert.equal(minuteRows[0].outputTokens, 20)
  const dayRows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(dayRows.length, 1)
  assert.equal(dayRows[0].inputTokens, 10)
  // 会话索引同样回填:旧孤儿会话被清,实时会话保留
  const sessions = await store.sessionRangeRows('D', '2026-08-02', '2026-08-02')
  assert.deepEqual(sessions.map((row) => row.sessions), [['live-session']])
})

test('U3 回扫写入不进入实时快照:清表后不重复计数', async () => {
  const domain = fakeDomain()
  await domain.table().put('D|(workspace-unknown)|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  const store = makeStore(domain)
  await store.readyPromise()
  // 回扫写入(无 live 标记):历史由回扫自身重建,store 不回填
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.flushNow()
  await store.clearOrphanRows()
  await store.flushNow()
  assert.equal(domain.rows.size, 0)
})

test('U3 重建(reset)后实时行仍在:清表不吞本 boot 实时读数', async () => {
  const domain = fakeDomain()
  const backup = fakeDomain()
  const store = new UsageStore(facilityOf(domain, backup), { now: () => FIXED_NOW })
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)), { live: true })
  await store.reset(new Map([['live-session', 9]]))
  await store.flushNow()
  const dayRows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(dayRows.length, 1)
  assert.equal(dayRows[0].inputTokens, 10)
  const sessions = await store.seenSessions()
  assert.deepEqual([...sessions], [], '游标按重建边界写,实时会话 id 仍待回扫确认')
})

test('U3 备份恢复不回填实时快照(快照已含),避免双计', async () => {
  const domain = fakeDomain()
  const backup = fakeDomain()
  const store = new UsageStore(facilityOf(domain, backup), { now: () => FIXED_NOW })
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)), { live: true })
  await store.reset()
  // 重置后继续实时采集一笔,再回退:回到重置前快照(只有第一笔)
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)), { live: true })
  await store.restoreFromBackup()
  const dayRows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(dayRows.length, 1)
  assert.equal(dayRows[0].inputTokens, 10, '恢复后只剩快照值,实时快照不得再叠加')
})

test('U3 孤儿清理落盘失败:累积器保留,重试仍能回填实时行', async () => {
  let failures = 1
  const domain = fakeDomain({ failUpdate: () => (failures-- > 0 ? new Error('transient') : null) })
  await domain.table().put('D|(workspace-unknown)|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  const store = makeStore(domain)
  await store.readyPromise()
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)), { live: true })
  await assert.rejects(store.clearOrphanRows(), /usage store flush failed/)
  assert.equal(store.orphanResetPending, true, '清理失败不得置完成位')
  assert.equal(await store.clearOrphanRows(), true)
  await store.flushNow()
  const dayRows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(dayRows.length, 1)
  assert.equal(dayRows[0].inputTokens, 10, '重试后实时行仍在且不双计')
})

// 终验阻断 1:writeGlobal 抛错时表已清空,旧实现把快照丢了,第二次成功也回填不出行
test('U3 孤儿清理写游标失败:表已清空但累积器仍可重建,重试后实时行不丢', async () => {
  let failures = 1
  const domain = fakeDomain({ failGlobal: () => (failures-- > 0 ? new Error('cursor write failed') : null) })
  await domain.table().put('D|(workspace-unknown)|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  const store = makeStore(domain)
  await store.readyPromise()
  assert.equal(store.orphanResetPending, true)
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)), { live: true })
  await store.recordSession('live-session', local(2026, 8, 2, 14, 37), { live: true })
  await store.flushNow()
  await assert.rejects(store.clearOrphanRows(), /cursor write failed/)
  assert.equal(store.orphanResetPending, true, '失败不置完成位')
  assert.equal(await store.clearOrphanRows(), true)
  await store.flushNow()
  const dayRows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(dayRows.length, 1)
  assert.equal(dayRows[0].inputTokens, 10, '第二次成功后实时行由累积器重建')
  const sessions = await store.sessionRangeRows('D', '2026-08-02', '2026-08-02')
  assert.deepEqual(sessions.map((row) => row.sessions), [['live-session']])
})

// 终验阻断 2:备份快照写入抛错时主表仍是清空前状态,旧实现已把快照摘走,
// 第二次成功时清表后无法恢复
test('U3 重建备份快照失败:主表与累积器保留,重试清表后实时行不丢', async () => {
  const domain = fakeDomain()
  let failures = 1
  const backup = fakeDomain({ failPut: (name) => (name === 'buckets' && failures-- > 0 ? new Error('backup put failed') : null) })
  const store = new UsageStore(facilityOf(domain, backup), { now: () => FIXED_NOW })
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)), { live: true })
  await store.flushNow()
  await assert.rejects(store.reset(), /backup put failed/)
  assert.equal((await store.rangeRows('D', '2026-08-02', '2026-08-02'))[0].inputTokens, 10, '失败时主表未被清')
  await store.reset()
  await store.flushNow()
  const dayRows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(dayRows.length, 1)
  assert.equal(dayRows[0].inputTokens, 10, '第二次成功后累积器仍能重建实时行')
})

// 终验阻断 3:清表事务启动(摘取快照)之后、flush 捕获 pending 之前到达的实时
// 样本会随 flush 写进表又被 wipe 删除;只回填旧快照会丢它。累积器重建须包含它,
// 且同键覆盖不双计(15 而非 10 或 20)。删除钩子用在事务内 prune 的删除点上,
// 作为「事务已启动」的确定性注入时机
test('U3 清表事务期间新到的实时样本一并重建:同桶合计 15 而非 10', async () => {
  const hooks = { onDelete: () => {} }
  const domain = fakeDomain({ onDelete: (name, key) => hooks.onDelete(name, key) })
  // 超期分钟行只用于让事务内的 prune 触发一次删除
  await domain.table().put('M|(workspace-unknown)|2026-07-01T00:00|a|m', rowOf('2026-07-01T00:00', 'a', 'm'))
  const store = makeStore(domain)
  await store.readyPromise()
  assert.equal(store.orphanResetPending, true)
  // 实时样本先留在 pending:事务内 flush 会把它写进表,随后被 wipe 删除
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)), { live: true })
  let injected = false
  hooks.onDelete = async () => {
    if (injected) return
    injected = true
    await store.record(tokenSample(local(2026, 8, 2, 14, 37), {
      inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }), { live: true })
  }
  assert.equal(await store.clearOrphanRows(), true)
  await store.flushNow()
  const dayRows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(dayRows.length, 1)
  assert.equal(dayRows[0].inputTokens, 15, '清表期间的实时增量必须并入重建集且不双计')
})

test('启动游标为空且宿主全面拒读:孤儿标记保持,历史不被清空', async () => {
  const domain = fakeDomain()
  await domain.table().put('D|(workspace-unknown)|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  const store = makeStore(domain)
  await store.readyPromise()
  // 模拟本轮回扫没有任何成功会话:不调用 clearOrphanRows
  assert.equal(store.orphanResetPending, true)
  assert.equal(domain.rows.size, 1)
  // 下一轮启动仍标记待清,数据仍在
  assert.equal(store.orphanResetPending, true)
})

test('启动时游标非空则既有行保留', async () => {
  const domain = fakeDomain()
  await domain.table().put('D|(workspace-unknown)|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  await domain.global.set({ backfilledSessions: ['old'], liveFirstSeq: {} })
  const store = makeStore(domain)
  await store.readyPromise()
  assert.equal(domain.rows.size, 1)
})

test('reset 前自动快照,restore 整体回退到快照态', async () => {
  const domain = fakeDomain()
  const backup = fakeDomain()
  const store = new UsageStore(facilityOf(domain, backup), { now: () => FIXED_NOW })
  await store.record(tokenSample(local(2026, 8, 2, 14, 0)))
  await store.markSeenSessions(['s1', 's2'])
  assert.equal(store.backupInfo().available, false)
  await store.reset()
  assert.equal(domain.rows.size, 0)
  assert.deepEqual([...(await store.seenSessions())], [])
  // 快照在清空前生成:行与游标都可回退
  const info = store.backupInfo()
  assert.equal(info.available, true)
  assert.equal(info.rows, 3)
  assert.equal(info.sessions, 2)
  const restored = await store.restoreFromBackup()
  assert.equal(restored.rows, 3)
  assert.equal(domain.rows.size, 3)
  assert.deepEqual([...(await store.seenSessions())].sort(), ['s1', 's2'])
})

test('restore 前先快照当前态:回退动作自身可再回退', async () => {
  const domain = fakeDomain()
  const backup = fakeDomain()
  const store = new UsageStore(facilityOf(domain, backup), { now: () => FIXED_NOW })
  await store.record(tokenSample(local(2026, 8, 2, 14, 0)))
  await store.reset()
  await store.record(tokenSample(local(2026, 8, 3, 14, 0), { inputTokens: 99 }))
  await store.flushNow()
  // 第一轮回退到重建前(有 8/2 数据)
  await store.restoreFromBackup()
  const dayRows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(dayRows.length, 1)
  // 第二次回退回到"重建后"(8/3 数据),回退链不断
  await store.restoreFromBackup()
  const after = await store.rangeRows('D', '2026-08-03', '2026-08-03')
  assert.equal(after.length, 1)
})

test('备份域不可用:重建照常,backupInfo 标记不可用,restore 报错', async () => {  const domain = fakeDomain()
  const facility = {
    open: async (definition) => {
      if (definition?.name === 'usage_stats_backup') throw new Error('backup domain unavailable')
      return domain
    },
  }
  const store = new UsageStore(facility, { now: () => FIXED_NOW })
  await store.record(tokenSample(local(2026, 8, 2, 14, 0)))
  await store.reset()
  assert.equal(domain.rows.size, 0)
  assert.equal(store.backupInfo().available, false)
  await assert.rejects(store.restoreFromBackup(), /backup domain unavailable/)
})

test('无备份快照时 restore 拒绝:不清空全量与游标', async () => {
  const domain = fakeDomain()
  const backup = fakeDomain()
  const store = new UsageStore(facilityOf(domain, backup), { now: () => FIXED_NOW })
  await store.record(tokenSample(local(2026, 8, 2, 14, 0)))
  await store.markSeenSessions(['s1'])
  await store.flushNow()
  const keysBefore = [...domain.rows.keys()].sort()
  assert.equal(store.backupInfo().available, false)
  // 无快照的回退等于清库:必须在破坏前拒绝
  await assert.rejects(store.restoreFromBackup(), /backup snapshot unavailable/)
  assert.deepEqual([...domain.rows.keys()].sort(), keysBefore)
  assert.deepEqual([...(await store.seenSessions())], ['s1'])
})

test('域打开失败进入降级:ready 可等待,操作按调用失败', async () => {
  const store = new UsageStore({ open: () => Promise.reject(new Error('domain already open')) })
  await store.readyPromise()
  assert.ok(store.degradation)
  await assert.rejects(store.record(tokenSample(local(2026, 8, 2, 14, 37))), /usage store degraded/)
  await assert.rejects(store.markSeenSessions(['a']), /usage store degraded/)
  await assert.rejects(store.rangeRows('D', '2026-08-01', '2026-08-02'), /usage store degraded/)
  assert.deepEqual(await store.seenSessions(), new Set())
  assert.deepEqual(await store.liveSequences(), new Map())
})

test('globalThis 单例按 facility 关联:同 facility 同实例,异 facility 新实例', async () => {
  __resetSharedStoreForTests()
  const facilityA = facilityOf(fakeDomain())
  const a = await sharedStore(facilityA)
  assert.equal(await sharedStore(facilityA), a)
  assert.notEqual(await sharedStore(facilityOf(fakeDomain())), a)
  __resetSharedStoreForTests()
})

test('降级实例不复用:同 facility 再取重建新实例', async () => {
  __resetSharedStoreForTests()
  const facility = { open: () => Promise.reject(new Error("domain 'usage_stats' is already open")) }
  const degraded = await sharedStore(facility)
  await degraded.readyPromise()
  assert.ok(degraded.degradation)
  const fresh = sharedStore(facility)
  assert.notEqual(fresh, degraded)
  __resetSharedStoreForTests()
})

test('非对象 facility(服务缺席桩)不缓存:每次新建', () => {
  __resetSharedStoreForTests()
  assert.notEqual(sharedStore(undefined), sharedStore(undefined))
  __resetSharedStoreForTests()
})

// 同名域占用不证明无主;get 诊断面不可授权关闭活跃 owner。
function facilityWithReserved({ withCode = true } = {}) {
  const reserved = new Map()
  const closes = []
  const open = async (spec) => {
    if (reserved.has(spec.name)) {
      const err = new Error(`domain '${spec.name}' is already open`)
      if (withCode) err.code = 'already-open'
      throw err
    }
    const domain = fakeDomain()
    domain.close = async () => {
      closes.push(spec.name)
      reserved.delete(spec.name)
    }
    reserved.set(spec.name, domain)
    return domain
  }
  return { open, get: (name) => reserved.get(name), closes }
}

for (const withCode of [true, false]) {
  test(`Given occupied domain with code=${withCode}, When another store opens, Then owner stays live and newcomer degrades`, async () => {
    __resetSharedStoreForTests()
    const facility = facilityWithReserved({ withCode })
    const owner = await facility.open({ name: 'usage_stats' })
    await facility.open({ name: 'usage_stats_backup' })
    const store = sharedStore(facility)
    await store.readyPromise()
    assert.ok(store.degradation)
    assert.equal(facility.get('usage_stats'), owner)
    assert.deepEqual(facility.closes, [])
    await owner.global.set({ stillLive: true })
    assert.deepEqual(owner.global.get(), { stillLive: true })
    await assert.rejects(store.record(tokenSample(local(2026, 8, 2, 14, 37))), /usage store degraded/)
    __resetSharedStoreForTests()
  })
}

test('record 带 workspaceId 时按工作区分行,rangeRows 可按工作区筛选', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const time = local(2026, 8, 2, 14, 37)
  await store.record(tokenSample(time), { workspaceId: 'ws-a' })
  await store.record(tokenSample(time, { inputTokens: 9 }), { workspaceId: 'ws-b' })
  await store.flushNow()

  const all = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(all.length, 2)

  const onlyA = await store.rangeRows('D', '2026-08-02', '2026-08-02', 'ws-a')
  assert.equal(onlyA.length, 1)
  assert.equal(onlyA[0].workspaceId, 'ws-a')
  assert.equal(onlyA[0].inputTokens, 10)
})

test('recordSession 带 workspaceId 时会话索引按工作区分行并可筛选', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const time = local(2026, 8, 2, 14, 37)
  await store.recordSession('sid-a', time, { workspaceId: 'ws-a' })
  await store.recordSession('sid-b', time, { workspaceId: 'ws-b' })
  await store.flushNow()

  assert.equal((await store.sessionRangeRows('D', '2026-08-02', '2026-08-02')).length, 2)
  const onlyA = await store.sessionRangeRows('D', '2026-08-02', '2026-08-02', 'ws-a')
  assert.deepEqual(onlyA, [{ bucket: '2026-08-02', workspaceId: 'ws-a', sessions: ['sid-a'] }])
})

test('UO1 Given old owner with seen cursor and pending tokens, When new generation opens, Then old owner flushes every bucket once', async () => {
  __resetSharedStoreForTests()
  const facility = facilityWithReserved()
  const old = new UsageStore(facility, { now: () => FIXED_NOW })
  await old.readyPromise()
  await old.markSeenSessions(['s1'])
  await old.record(tokenSample(local(2026, 8, 2, 14, 37)))
  clearTimeout(old.flushTimer)
  const newcomer = sharedStore(facility)
  await newcomer.readyPromise()
  assert.deepEqual(facility.closes, [])
  assert.ok(newcomer.degradation)
  await old.flushNow()
  const rows = await old.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].inputTokens, 10)
  assert.equal(rows[0].outputTokens, 20)
  assert.deepEqual(await old.seenSessions(), new Set(['s1']))
  await old.flushNow()
  assert.equal((await old.rangeRows('D', '2026-08-02', '2026-08-02'))[0].inputTokens, 10)
  __resetSharedStoreForTests()
})

test('UO3 Given occupied backup only, When main opens, Then collection works and backup owner is untouched', async () => {
  __resetSharedStoreForTests()
  const facility = facilityWithReserved()
  const backup = await facility.open({ name: 'usage_stats_backup' })
  const store = sharedStore(facility)
  await store.readyPromise()
  assert.equal(store.degradation, undefined)
  assert.equal(facility.get('usage_stats_backup'), backup)
  assert.deepEqual(facility.closes, [])
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  clearTimeout(store.flushTimer)
  await store.flushNow()
  assert.equal((await store.rangeRows('D', '2026-08-02', '2026-08-02'))[0].inputTokens, 10)
  __resetSharedStoreForTests()
})

test('get 缝在场但孤儿已不存在:维持降级,不逃逸', async () => {
  const store = new UsageStore({
    open: () => Promise.reject(new Error("domain 'usage_stats' is already open")),
    get: () => undefined,
  })
  await store.readyPromise()
  assert.ok(store.degradation)
  await assert.rejects(store.record(tokenSample(local(2026, 8, 2, 14, 37))), /usage store degraded/)
})

// —— 写合并(write-behind):record 同步入 pending,flush 周期落盘 ——

test('record 只入 pending 不产生持久化写,flushNow 后每脏行恰一次 update', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.readyPromise()
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  assert.equal(domain.rows.size, 0)
  await store.flushNow()
  assert.equal(domain.rows.size, 3)
  const seen = domain.rows.get('D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat')
  assert.equal(seen.inputTokens, 10)
})

test('同桶多样本合并:pending 累加,一次 update 落全部计数', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.readyPromise()
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.record(tokenSample(local(2026, 8, 2, 14, 38)))
  await store.record(tokenSample(local(2026, 8, 2, 14, 39)))
  await store.flushNow()
  const seen = domain.rows.get('D|(workspace-unknown)|2026-08-02|deepseek|deepseek/deepseek-chat')
  assert.equal(seen.inputTokens, 30)
  assert.equal(domain.stats.puts, 3)
})

test('flush 周期自动落盘', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain, { flushIntervalMs: 5 })
  await store.readyPromise()
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(domain.rows.size, 3)
})

test('rangeRows 前自动 flush,读己之写', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.readyPromise()
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  const rows = await store.rangeRows('D', '2026-08-02', '2026-08-02')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].inputTokens, 10)
})

test('reset 前 pending 先落盘再清表', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.readyPromise()
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.reset(new Map())
  assert.equal(domain.rows.size, 0)
  assert.equal(domain.stats.puts, 3)
})

test('降级态 record 仍按调用失败', async () => {
  const store = new UsageStore({ open: () => Promise.reject(new Error('domain already open')) })
  await store.readyPromise()
  await assert.rejects(store.record(tokenSample(local(2026, 8, 2, 14, 37))), /usage store degraded/)
})

// ── F14: 入队保留资格过滤 ──────────────────────────────────────────────────
test('F14: 超出档留存期的样本不入 pending 不落盘,回扫同通道受控', async () => {
  const domain = fakeDomain()
  // 时钟"今天" = 样本日次日 + 8 天:8/2 样本对分钟档(7 天)超期、小时档(15 天)与日档在期
  const now = local(2026, 8, 10, 0, 0)
  const store = new UsageStore(facilityOf(domain), { now: () => now })
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.flushNow()
  const prefixes = [...domain.rows.keys()].map((key) => key.split('|').slice(0, 3).join('|'))
  assert.ok(!prefixes.some((p) => p.startsWith('M|(workspace-unknown)|')), `分钟档超期不得落行: ${prefixes.join(',')}`)
  assert.ok(prefixes.some((p) => p.startsWith('D|(workspace-unknown)|')), '日档无留存上限恒写入')
  assert.ok(prefixes.some((p) => p.startsWith('H|(workspace-unknown)|')), '小时档 15 天内在期')
  // 分钟档保留 0(关闭):分钟样本一律不入队
  const offStore = new UsageStore(facilityOf(fakeDomain()), { now: () => local(2026, 8, 2, 14, 38), retentionDays: () => 0 })
  await offStore.record(tokenSample(local(2026, 8, 2, 14, 37)))
  assert.equal(offStore.pending.size, 2, '关闭分钟档后仅日/小时两行入队')
})

// ── 会话索引:真实会话按天/小时去重落表,供汇总卡「会话数量」聚合 ─────────────
test('recordSession:同一会话落天/小时两行,重复记录幂等', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const time = local(2026, 8, 2, 14, 37)
  await store.recordSession('sid-a', time)
  await store.recordSession('sid-a', time + 60_000)
  await store.flushNow()
  assert.deepEqual(domain.sessionRows.get('D|(workspace-unknown)|2026-08-02'), { bucket: '2026-08-02', workspaceId: '(workspace-unknown)', sessions: ['sid-a'] })
  assert.deepEqual(domain.sessionRows.get('H|(workspace-unknown)|2026-08-02T14'), { bucket: '2026-08-02T14', workspaceId: '(workspace-unknown)', sessions: ['sid-a'] })
})

test('recordSession:同一 (会话,桶) 只入队一次,不重复写', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  const time = local(2026, 8, 2, 14, 37)
  await store.recordSession('sid-a', time)
  await store.recordSession('sid-a', time + 1)
  assert.equal(store.sessionPending.size, 2, '天/小时各一行 pending')
  await store.flushNow()
  assert.equal(domain.stats.sessionPuts, 2, '两行各一次 put')
  await store.recordSession('sid-a', time + 2)
  assert.equal(store.sessionPending.size, 0, '同桶重复记录被去重')
})

test('recordSession:多小时活动累加到对应小时行,天行合并同会话', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.recordSession('sid-a', local(2026, 8, 2, 14, 1))
  await store.recordSession('sid-a', local(2026, 8, 2, 15, 1))
  await store.recordSession('sid-b', local(2026, 8, 2, 15, 2))
  await store.flushNow()
  assert.deepEqual(domain.sessionRows.get('D|(workspace-unknown)|2026-08-02').sessions, ['sid-a', 'sid-b'])
  assert.deepEqual(domain.sessionRows.get('H|(workspace-unknown)|2026-08-02T14').sessions, ['sid-a'])
  assert.deepEqual(domain.sessionRows.get('H|(workspace-unknown)|2026-08-02T15').sessions, ['sid-a', 'sid-b'])
})

test('recordSession:小时桶超保留期只落天行', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.recordSession('sid-old', local(2026, 7, 1, 10, 0))
  await store.flushNow()
  assert.deepEqual([...domain.sessionRows.keys()], ['D|(workspace-unknown)|2026-07-01'])
})

test('recordSession:空 id 或非法时间不入队', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.recordSession('', local(2026, 8, 2, 14, 0))
  await store.recordSession('sid-a', Number.NaN)
  assert.equal(store.sessionPending.size, 0)
})

test('sessionRangeRows:按粒度前缀与闭区间过滤窗口', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.recordSession('sid-a', local(2026, 8, 2, 14, 0))
  await store.recordSession('sid-b', local(2026, 8, 3, 9, 0))
  await store.flushNow()
  const days = await store.sessionRangeRows('D', '2026-08-02', '2026-08-02')
  assert.deepEqual(days.map((row) => row.bucket), ['2026-08-02'])
  const hours = await store.sessionRangeRows('H', '2026-08-02T00', '2026-08-02T23')
  assert.deepEqual(hours.map((row) => row.bucket), ['2026-08-02T14'])
})

test('会话索引 flush 失败行重排,下轮写入成功', async () => {
  let fail = true
  const domain = fakeDomain({ failUpdate: (key) => (fail && key === 'D|(workspace-unknown)|2026-08-02' ? new Error('boom') : null) })
  const store = makeStore(domain)
  const failures = []
  store.onFlushError = (error) => failures.push(error)
  await store.recordSession('sid-a', local(2026, 8, 2, 14, 0))
  await store.flushNow()
  assert.equal(failures.length, 1)
  assert.equal(domain.sessionRows.has('D|(workspace-unknown)|2026-08-02'), false)
  fail = false
  await store.flushNow()
  assert.deepEqual(domain.sessionRows.get('D|(workspace-unknown)|2026-08-02'), { bucket: '2026-08-02', workspaceId: '(workspace-unknown)', sessions: ['sid-a'] })
})

test('pruneHours 清理过期小时会话行,天行保留', async () => {
  const domain = fakeDomain()
  let now = local(2026, 8, 10, 0, 0)
  const store = new UsageStore(facilityOf(domain), { now: () => now })
  await store.recordSession('sid-a', local(2026, 8, 2, 14, 0))
  await store.flushNow()
  assert.ok(domain.sessionRows.has('H|(workspace-unknown)|2026-08-02T14'))
  now = local(2026, 8, 20, 0, 0)
  await store.pruneHours()
  assert.equal(domain.sessionRows.has('H|(workspace-unknown)|2026-08-02T14'), false)
  assert.ok(domain.sessionRows.has('D|(workspace-unknown)|2026-08-02'))
})

test('reset 清空会话索引与去重内存', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.recordSession('sid-a', local(2026, 8, 2, 14, 0))
  await store.flushNow()
  await store.reset(new Map())
  assert.equal(domain.sessionRows.size, 0)
  await store.recordSession('sid-a', local(2026, 8, 2, 14, 5))
  await store.flushNow()
  assert.deepEqual(domain.sessionRows.get('D|(workspace-unknown)|2026-08-02').sessions, ['sid-a'])
})

test('reset 前快照包含会话索引,restore 一并回退', async () => {
  const domain = fakeDomain()
  const backup = fakeDomain()
  const store = new UsageStore(facilityOf(domain, backup), { now: () => FIXED_NOW })
  await store.recordSession('sid-a', local(2026, 8, 2, 14, 0))
  await store.flushNow()
  await store.reset()
  assert.equal(domain.sessionRows.size, 0)
  await store.restoreFromBackup()
  assert.deepEqual(domain.sessionRows.get('D|(workspace-unknown)|2026-08-02').sessions, ['sid-a'])
})

test('hasSessionRows/hasBucketRows 反映两表现状', async () => {
  const domain = fakeDomain()
  const store = makeStore(domain)
  await store.readyPromise()
  assert.equal(store.hasSessionRows(), false)
  assert.equal(store.hasBucketRows(), false)
  await store.record(tokenSample(local(2026, 8, 2, 14, 0)))
  await store.flushNow()
  assert.equal(store.hasBucketRows(), true)
  assert.equal(store.hasSessionRows(), false)
  await store.recordSession('sid-a', local(2026, 8, 2, 14, 0))
  await store.flushNow()
  assert.equal(store.hasSessionRows(), true)
})
