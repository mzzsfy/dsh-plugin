// store 行为测试:桶键生成、三粒度落桶、写入重试与失败聚合、清理窗口、游标链。
// 域句柄以内存假件注入,断言外部可观察行为(表内容与游标值),不断言内部实现。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MINUTE_RETENTION_DAYS,
  HOUR_RETENTION_DAYS,
  MINUTE_RETENTION_MAX_DAYS,
  UsageStore,
  __resetSharedStoreForTests,
  clampMinuteRetentionDays,
  dayKey,
  hourKey,
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

// 内存假域:表与 global 方法面同构;failUpdate 返回错误时 update 抛出该错误
function fakeDomain({ failUpdate = () => null } = {}) {
  const rows = new Map()
  const stats = { puts: 0, globalSets: 0 }
  let globalValue = { backfilledSessions: [], liveFirstSeq: {} }
  const table = {
    get: (key) => rows.get(key),
    keys: () => rows.keys(),
    entries: () => rows.entries(),
    get size() {
      return rows.size
    },
    async put(key, value) {
      stats.puts += 1
      rows.set(key, value)
    },
    async delete(key) {
      return rows.delete(key)
    },
    async update(key, fn) {
      const failure = failUpdate(key)
      if (failure) throw failure
      const current = rows.get(key)
      if (current === undefined) {
        // 与宿主 storage-domain 缺键报错同形,匹配 /no record .* to update/
        throw new Error(`domain 'usage_stats' table 'buckets' has no record '${key}' to update`)
      }
      rows.set(key, fn(current))
    },
  }
  return {
    rows,
    stats,
    table: () => table,
    global: {
      get: () => globalValue,
      set: async (value) => {
        stats.globalSets += 1
        globalValue = value
      },
    },
  }
}

const facilityOf = (domain) => ({ open: async () => domain })

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

test('token 样本同刻落三粒度三行,行内无 g 字段', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain))
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  const keys = ['D|2026-08-02', 'H|2026-08-02T14', 'M|2026-08-02T14:30'].map(
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
  const store = new UsageStore(facilityOf(domain))
  await store.record({ time: local(2026, 8, 2, 14, 37), turn: true })
  const seen = domain.rows.get('D|2026-08-02|default|(turns)')
  assert.ok(seen)
  assert.equal(seen.turns, 1)
  assert.equal(seen.inputTokens, 0)
})

test('request 样本只计请求数,无归因落 (unknown)', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain))
  await store.record({ time: local(2026, 8, 2, 14, 37), request: true, model: 'deepseek-chat' })
  await store.record({ time: local(2026, 8, 2, 14, 38), request: true })
  const labelled = domain.rows.get('D|2026-08-02|default|deepseek-chat')
  assert.ok(labelled)
  assert.equal(labelled.requests, 1)
  assert.equal(labelled.inputTokens, 0)
  const unknown = domain.rows.get('D|2026-08-02|default|(unknown)')
  assert.ok(unknown)
  assert.equal(unknown.requests, 1)
})

test('missing-record 首写竞态:put 种子后重试写入真值', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain))
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  assert.equal(domain.stats.puts, 3)
  const seen = domain.rows.get('D|2026-08-02|deepseek|deepseek/deepseek-chat')
  assert.equal(seen.inputTokens, 10)
})

test('allSettled 聚合:单粒度失败上抛且其余粒度不丢', async () => {
  const domain = fakeDomain({
    failUpdate: (key) => (key.startsWith('H|') ? new Error('simulated hour failure') : null),
  })
  const store = new UsageStore(facilityOf(domain))
  await assert.rejects(
    store.record(tokenSample(local(2026, 8, 2, 14, 37))),
    (err) => err.name === 'AggregateError' && err.errors.length === 1,
  )
  assert.ok(domain.rows.has('D|2026-08-02|deepseek|deepseek/deepseek-chat'))
  assert.ok(domain.rows.has('M|2026-08-02T14:30|deepseek|deepseek/deepseek-chat'))
  assert.equal(domain.rows.has('H|2026-08-02T14|deepseek|deepseek/deepseek-chat'), false)
})

test('非 missing 错误不触发种子重试', async () => {
  const key = 'D|2026-08-02|deepseek|deepseek/deepseek-chat'
  const domain = fakeDomain({
    failUpdate: (candidate) => (candidate === key ? new Error('backend write failed') : null),
  })
  const store = new UsageStore(facilityOf(domain))
  await assert.rejects(
    store.record(tokenSample(local(2026, 8, 2, 14, 37))),
    (err) => err.name === 'AggregateError' && /backend write failed/.test(err.errors[0].message),
  )
  assert.equal(domain.rows.has(key), false)
})

test('rangeRows 按粒度前缀与桶串闭区间扫描', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain))
  const table = domain.table()
  await table.put('D|2026-07-31|a|m', rowOf('2026-07-31', 'a', 'm'))
  await table.put('D|2026-08-01|a|m', rowOf('2026-08-01', 'a', 'm'))
  await table.put('D|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  await table.put('H|2026-08-01T10|a|m', rowOf('2026-08-01T10', 'a', 'm'))
  await table.put('M|2026-08-01T10:30|a|m', rowOf('2026-08-01T10:30', 'a', 'm'))
  const days = await store.rangeRows('D', '2026-08-01', '2026-08-02')
  assert.deepEqual(days.map((seen) => seen.bucket).sort(), ['2026-08-01', '2026-08-02'])
  const hours = await store.rangeRows('H', '2026-08-01T00', '2026-08-01T23')
  assert.deepEqual(hours.map((seen) => seen.bucket), ['2026-08-01T10'])
  const minutes = await store.rangeRows('M', '2026-08-01T10:30', '2026-08-01T10:30')
  assert.deepEqual(minutes.map((seen) => seen.bucket), ['2026-08-01T10:30'])
})

test('pruneMinutes 按保留窗口清理分钟桶且不碰其他粒度', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain), { now: () => local(2026, 8, 10, 12, 0) })
  const table = domain.table()
  await table.put('M|2026-08-08T11:00|a|m', rowOf('2026-08-08T11:00', 'a', 'm'))
  await table.put('M|2026-08-08T12:00|a|m', rowOf('2026-08-08T12:00', 'a', 'm'))
  await table.put('M|2026-08-09T00:00|a|m', rowOf('2026-08-09T00:00', 'a', 'm'))
  await table.put('D|2026-08-01|a|m', rowOf('2026-08-01', 'a', 'm'))
  await table.put('H|2026-08-01T00|a|m', rowOf('2026-08-01T00', 'a', 'm'))
  await store.pruneMinutes(DEFAULT_MINUTE_RETENTION_DAYS)
  assert.equal(domain.rows.has('M|2026-08-08T11:00|a|m'), false)
  assert.equal(domain.rows.has('M|2026-08-08T12:00|a|m'), true)
  assert.equal(domain.rows.has('M|2026-08-09T00:00|a|m'), true)
  assert.equal(domain.rows.has('D|2026-08-01|a|m'), true)
  assert.equal(domain.rows.has('H|2026-08-01T00|a|m'), true)
})

test('保留窗口为 0 时分钟桶全部清理', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain), { now: () => local(2026, 8, 10, 12, 0) })
  const table = domain.table()
  await table.put('M|2026-08-10T11:00|a|m', rowOf('2026-08-10T11:00', 'a', 'm'))
  await table.put('D|2026-08-10|a|m', rowOf('2026-08-10', 'a', 'm'))
  await store.pruneMinutes(0)
  assert.equal(domain.rows.has('M|2026-08-10T11:00|a|m'), false)
  assert.equal(domain.rows.has('D|2026-08-10|a|m'), true)
})

test('分钟保留超上限时 clamp 到 7 天窗口', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain), { now: () => local(2026, 8, 10, 12, 0) })
  const table = domain.table()
  // clamp 后窗口起点 = 08-03T12:00,7 天前的桶一律清理,即使注入 30 天
  await table.put('M|2026-08-01T00:00|a|m', rowOf('2026-08-01T00:00', 'a', 'm'))
  await table.put('M|2026-08-03T12:00|a|m', rowOf('2026-08-03T12:00', 'a', 'm'))
  await store.pruneMinutes(30)
  assert.equal(domain.rows.has('M|2026-08-01T00:00|a|m'), false)
  assert.equal(domain.rows.has('M|2026-08-03T12:00|a|m'), true)
})

test('pruneHours 固定 15 天窗口清理小时桶且不碰其他粒度', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain), { now: () => local(2026, 8, 10, 12, 0) })
  const table = domain.table()
  await table.put('H|2026-07-25T00:00|a|m', rowOf('2026-07-25T00:00', 'a', 'm'))
  await table.put('H|2026-07-26T12:00|a|m', rowOf('2026-07-26T12:00', 'a', 'm'))
  await table.put('D|2026-07-20|a|m', rowOf('2026-07-20', 'a', 'm'))
  await table.put('M|2026-07-25T00:00|a|m', rowOf('2026-07-25T00:00', 'a', 'm'))
  await store.pruneHours()
  assert.equal(domain.rows.has('H|2026-07-25T00:00|a|m'), false)
  assert.equal(domain.rows.has('H|2026-07-26T12:00|a|m'), true)
  assert.equal(domain.rows.has('D|2026-07-20|a|m'), true)
  assert.equal(domain.rows.has('M|2026-07-25T00:00|a|m'), true)
})

test('每日本地日首次写入触发清理,同日后续写入不重复触发', async () => {
  let clock = local(2026, 8, 10, 12, 0)
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain), { now: () => clock, retentionDays: () => 0 })
  const table = domain.table()
  await table.put('M|2026-08-01T00:00|a|m', rowOf('2026-08-01T00:00', 'a', 'm'))
  await store.record(tokenSample(local(2026, 8, 10, 12, 0)))
  assert.equal(domain.rows.has('M|2026-08-01T00:00|a|m'), false)
  await table.put('M|2026-08-01T00:00|a|m', rowOf('2026-08-01T00:00', 'a', 'm'))
  await store.record(tokenSample(local(2026, 8, 10, 12, 1)))
  assert.equal(domain.rows.has('M|2026-08-01T00:00|a|m'), true)
  clock = local(2026, 8, 11, 0, 0)
  await store.record(tokenSample(local(2026, 8, 11, 0, 0)))
  assert.equal(domain.rows.has('M|2026-08-01T00:00|a|m'), false)
})

test('并发 markSeenSessions 不丢 id', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain))
  await Promise.all([
    store.markSeenSessions(['a']),
    store.markSeenSessions(['b']),
    store.markSeenSessions(['c']),
  ])
  assert.deepEqual([...(await store.seenSessions())].sort(), ['a', 'b', 'c'])
})

test('游标链串行:reset 排在先前 markSeen 之后,行与游标一致重置', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain))
  const pending = store.markSeenSessions(['a'])
  await store.record(tokenSample(local(2026, 8, 2, 14, 37)))
  await store.reset(new Map([['live-a', 7]]))
  await pending
  assert.equal(domain.rows.size, 0)
  assert.deepEqual(domain.global.get(), { backfilledSessions: [], liveFirstSeq: { 'live-a': 7 } })
})

test('reset 不带边界时游标清空', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain))
  await store.markLiveSequences([['s', 5]])
  await store.reset()
  assert.deepEqual(domain.global.get(), { backfilledSessions: [], liveFirstSeq: {} })
})

test('markLiveSequences 保留最小 seq 且无变化不写 global', async () => {
  const domain = fakeDomain()
  const store = new UsageStore(facilityOf(domain))
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
  const store = new UsageStore(facilityOf(domain))
  await assert.rejects(store.markSeenSessions(['a']))
  await store.markSeenSessions(['b'])
  assert.deepEqual([...(await store.seenSessions())].sort(), ['b'])
})

test('启动时游标为空且已有行则清空待重建', async () => {
  const domain = fakeDomain()
  await domain.table().put('D|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  const store = new UsageStore(facilityOf(domain))
  await store.readyPromise()
  assert.equal(domain.rows.size, 0)
})

test('启动时游标非空则既有行保留', async () => {
  const domain = fakeDomain()
  await domain.table().put('D|2026-08-02|a|m', rowOf('2026-08-02', 'a', 'm'))
  await domain.global.set({ backfilledSessions: ['old'], liveFirstSeq: {} })
  const store = new UsageStore(facilityOf(domain))
  await store.readyPromise()
  assert.equal(domain.rows.size, 1)
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

test('globalThis 单例复用同实例,重置缝生效', () => {
  __resetSharedStoreForTests()
  const first = sharedStore(facilityOf(fakeDomain()))
  assert.equal(sharedStore(facilityOf(fakeDomain())), first)
  __resetSharedStoreForTests()
  assert.notEqual(sharedStore(facilityOf(fakeDomain())), first)
  __resetSharedStoreForTests()
})
