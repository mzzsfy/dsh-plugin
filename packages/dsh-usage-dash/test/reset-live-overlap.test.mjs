// 端到端:实时采集与「重建」(resetAndRescan)共存时读数不重计也不丢,重启后仍成立。
// reset 的重放上界必须取本 boot 实时起点:取当前尾部会把 [实时起点, 尾部) 既从
// 日志重放一遍、又由 store 的实时累积器回填一次 → 双计并随落盘固化。
// 用真 store(内存假域)+ 真 collector(宿主形状假持久化)驱动整条链路。

import test from 'node:test'
import assert from 'node:assert/strict'

import { UsageCollector } from '../src/collector.js'
import { UsageStore, dayKey } from '../src/store.js'

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const ev = (type, seq, time, data = {}) => ({ type, seq, time, data })
const tick = () => new Promise((resolve) => setImmediate(resolve))

// 内存假域:与宿主 storage-domain 的桶表/游标面同构,足够 store 全链路
function fakeDomain() {
  const rows = new Map()
  const sessionRows = new Map()
  let globalValue = { backfilledSessions: [], liveFirstSeq: {} }
  const makeTable = (map, name) => ({
    get: (key) => map.get(key),
    keys: () => map.keys(),
    entries: () => map.entries(),
    get size() {
      return map.size
    },
    async put(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      return map.delete(key)
    },
    async update(key, fn) {
      // 与宿主 storage-domain 缺键报错同形,匹配 /no record .* to update/
      if (!map.has(key)) throw new Error(`domain 'usage_stats' table '${name}' has no record '${key}' to update`)
      map.set(key, fn(map.get(key)))
    },
  })
  const buckets = makeTable(rows, 'buckets')
  const sessions = makeTable(sessionRows, 'sessions')
  return {
    rows,
    sessionRows,
    table: (name) => (name === 'sessions' ? sessions : buckets),
    global: {
      get: () => globalValue,
      set: async (value) => {
        globalValue = value
      },
    },
    seedCursor(cursor) {
      globalValue = cursor
    },
    cursor: () => globalValue,
  }
}

const facilityOf = (domain, backup = fakeDomain()) => ({
  open: async (definition) => (definition?.name === 'usage_stats_backup' ? backup : domain),
})

// 宿主 handle 代形状:list 返回带 header/revision 的 snapshot,open/read 读全量事件
function fakeHostPersistence(definitions) {
  const byId = new Map(definitions.map((def) => [def.id, def]))
  return {
    async list() {
      return definitions.map((def) => ({ header: { id: def.id }, revision: {} }))
    },
    async open(id) {
      const def = byId.get(id)
      if (!def) throw new Error(`session "${id}" not found`)
      return {
        header: { id: def.id },
        inheritedEventCount: 0,
        async read(offset, length) {
          // 分页读:offset 递增到末尾后返回空页,读取器据此收尾
          const all = def.events ?? []
          const start = typeof offset === 'number' && offset > 0 ? offset : 0
          return { eventState: 'detached', events: all.slice(start, typeof length === 'number' ? start + length : undefined) }
        },
        async close() {},
      }
    },
  }
}

function fakeSessions(handles) {
  const byId = new Map(handles.map((handle) => [handle.id, handle]))
  return { list: () => handles, get: (id) => byId.get(id) }
}

function fakeCtx(sessions, persistence) {
  const listeners = new Map()
  return {
    sessions,
    sessionPersistence: persistence,
    on(event, listener) {
      listeners.set(event, listener)
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args)
    },
  }
}

const dayMs = 24 * 60 * 60 * 1000
const NOW = local(2026, 8, 2, 12, 0)
const T = local(2026, 8, 2, 10, 0)
// 实时起点之前的日志段(已被上一次回扫/上一 boot 折进表):100
const HISTORY_INPUT = 100
// 本 boot 实时采样的三段:20 + 20 + 10
const LIVE_INPUT = [20, 20, 10]

const messageEvent = (seq, turn, input, time) => ev('assistant/message', seq, time, {
  turn,
  step: 0,
  usage: { inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  message: {},
})

// 磁盘日志:[0,3) 属重放段,[3,6) 同时被本 boot 实时采样(累积器持同一份增量)
const logEvents = [
  messageEvent(0, 1, HISTORY_INPUT, T),
  ev('turn/end', 1, T + 1000),
  ev('turn/end', 2, T + 2000),
  messageEvent(3, 2, LIVE_INPUT[0], T + 3000),
  messageEvent(4, 3, LIVE_INPUT[1], T + 4000),
  messageEvent(5, 4, LIVE_INPUT[2], T + 5000),
]

const expectedInput = () => HISTORY_INPUT + LIVE_INPUT.reduce((sum, value) => sum + value, 0)

const sumInput = (rows) => rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)
const readDayInput = async (store) => sumInput(await store.rangeRows('D', dayKey(T - dayMs), dayKey(T + dayMs)))

// Given 表里已有实时起点之前的历史、游标记着本 boot 实时起点为 3
async function bootWithHistory() {
  const domain = fakeDomain()
  domain.seedCursor({ backfilledSessions: ['s1'], liveFirstSeq: { s1: 3 } })
  const store = new UsageStore(facilityOf(domain), { now: () => NOW })
  await store.readyPromise()
  await store.record({ time: T, inputTokens: HISTORY_INPUT, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  await store.flushNow()
  const collector = new UsageCollector(fakeCtx(fakeSessions([{ id: 's1', seq: 6 }]), fakeHostPersistence([{ id: 's1', events: logEvents }])), store)
  collector.start()
  return { domain, store, collector }
}

// When 本 boot 实时采到 [3,6) 的三段
async function emitLive(collector) {
  for (const [index, input] of LIVE_INPUT.entries()) {
    const seq = 3 + index
    collector.ctx.emit('session/event', { id: 's1' }, messageEvent(seq, 2 + index, input, T + (3 + index) * 1000))
  }
  await tick()
  await tick()
}

test('resetAndRescan 以本 boot 实时起点为重放上界:实时区间只计一次(100+50 不变成 200)', async () => {
  const { store, collector } = await bootWithHistory()
  await emitLive(collector)
  const before = await readDayInput(store)
  assert.equal(before, expectedInput(), '前提:实时样本与历史各计一次')

  await collector.resetAndRescan()

  const after = await readDayInput(store)
  assert.equal(after, expectedInput(), '重建后实时区间不得被日志重放再计一次')
  // 游标保留本 boot 实时起点,后续扫描仍从起点之后归实时路径
  assert.deepEqual(store.readCursor?.().liveFirstSeq ?? {}, { s1: 3 })
})

test('重建结果跨重启保持:新 store 读同一域仍是 100+50,游标已记录会话不再重放', async () => {
  const { domain, store, collector } = await bootWithHistory()
  await emitLive(collector)
  await collector.resetAndRescan()
  // 优雅退出前落盘:崩溃丢失窗口 = flush 周期(README 写入模型)
  await store.flushNow()

  // 重启:同一存储域上新建 store 与采集器,模拟宿主重载插件
  const restarted = new UsageStore(facilityOf(domain), { now: () => NOW })
  await restarted.readyPromise()
  assert.equal(await readDayInput(restarted), expectedInput(), '落盘的实时读数不得被重建放大')

  const collector2 = new UsageCollector(
    fakeCtx(fakeSessions([{ id: 's1', seq: 6 }]), fakeHostPersistence([{ id: 's1', events: logEvents }])),
    restarted,
  )
  collector2.start()
  await collector2.rescan()
  assert.equal(await readDayInput(restarted), expectedInput(), '重启回扫不得把已重建的会话再折一遍')
})
