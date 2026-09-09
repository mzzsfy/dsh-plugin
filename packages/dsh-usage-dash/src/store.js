// 用量统计存储:usage_stats 域,单表 buckets,行键 <粒度>|<桶串>|<provider>|<model>。
// single 布局每次持久化写都全量重发布 unit 文档,故写入侧做合并(write-behind):
// record 同步累加进内存 pending,按周期 flush 批量落盘,同桶多样本折叠为一次
// update;flush 失败的行留在 pending 下轮重试,错误经 onFlushError 上抛。
// 游标读写与 flush 全部串行在同一条 promise 链上,防 lost update。进程级单例
// 挂 globalThis,防 HMR 热重载后重复开域。

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import { PROVIDER_UNSET, splitRequestSegments } from './pricing.js'

export const GRANULARITY_DAILY = 'D'
export const GRANULARITY_HOURLY = 'H'
export const GRANULARITY_MINUTE = 'M'

export const MODEL_TURNS = '(turns)'
export const MODEL_UNKNOWN = '(unknown)'

export const DEFAULT_MINUTE_RETENTION_DAYS = 7

// 分钟桶对齐粒度(分钟);小时/天桶不受影响
export const MINUTE_BUCKET_SPAN_MINUTES = 10

// 保留上限:小时桶固定 15 天,分钟桶可配置但最大 7 天(与分钟视图选择上限一致)
export const HOUR_RETENTION_DAYS = 15
export const MINUTE_RETENTION_MAX_DAYS = 7

// 写合并周期:pending 样本最长延迟该时长落盘;统计可由会话重扫重建,容忍窗口内丢失
export const FLUSH_INTERVAL_MS = 2000

const DAY_MS = 24 * 60 * 60 * 1000
const PAD_WIDTH = 2
const DOMAIN_NAME = 'usage_stats'
const TABLE_BUCKETS = 'buckets'
const MISSING_RECORD_PATTERN = /no record .* to update/
const MINUTE_KEY_PREFIX = `${GRANULARITY_MINUTE}|`
const HOUR_KEY_PREFIX = `${GRANULARITY_HOURLY}|`

// 保留值归一:非法回落默认,超出上限截到上限;0(禁用)合法保留
export function clampMinuteRetentionDays(days) {
  const raw = Number.isFinite(days) && days >= 0 ? days : DEFAULT_MINUTE_RETENTION_DAYS
  return Math.min(raw, MINUTE_RETENTION_MAX_DAYS)
}

// 桶串统一本地时区推导,同粒度内字典序即时间序
const pad = (value) => String(value).padStart(PAD_WIDTH, '0')

export function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function hourKey(ts) {
  return `${dayKey(ts)}T${pad(new Date(ts).getHours())}`
}

// 分钟桶起点对齐 10 分钟:向下取整到桶边界,不跨时
export function minuteKey(ts) {
  const d = new Date(ts)
  const aligned = d.getMinutes() - (d.getMinutes() % MINUTE_BUCKET_SPAN_MINUTES)
  return `${hourKey(ts)}:${pad(aligned)}`
}

// 同一样本依次落三粒度
export const GRANULARITIES = [
  [GRANULARITY_DAILY, dayKey],
  [GRANULARITY_HOURLY, hourKey],
  [GRANULARITY_MINUTE, minuteKey],
]

// vendor 段推导与定价匹配同源:首个 / 前段,无 / 或首位斜杠归 default
export function providerOf(modelRef) {
  return splitRequestSegments(modelRef)[0]
}

export const usageRowSchema = z.object({
  bucket: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  // 模型时长累计(毫秒):optional 兼容存量记录(域 open 逐记录 parse)
  durationMs: z.number().optional(),
  requests: z.number(),
  turns: z.number(),
  lastSeen: z.number(),
})

export const usageStatsDomain = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    [TABLE_BUCKETS]: domainTable(usageRowSchema),
  },
  global: {
    schema: z.object({
      backfilledSessions: z.array(z.string()),
      liveFirstSeq: z.record(z.string(), z.number()).optional(),
    }),
    initial: { backfilledSessions: [], liveFirstSeq: {} },
  },
})

// 重建回退备份域:与主域同构表,global 多记 takenAt(快照时刻)。
// 独立域而非主域内备份表——reset 清主域数据,同域备份会陪葬
export const usageBackupDomain = defineDomain({
  name: `${DOMAIN_NAME}_backup`,
  version: 1,
  tables: {
    [TABLE_BUCKETS]: domainTable(usageRowSchema),
  },
  global: {
    schema: z.object({
      backfilledSessions: z.array(z.string()),
      liveFirstSeq: z.record(z.string(), z.number()).optional(),
      takenAt: z.number().optional(),
    }),
    initial: { backfilledSessions: [], liveFirstSeq: {}, takenAt: undefined },
  },
})

export function rowKey(g, bucket, provider, model) {
  return `${g}|${bucket}|${provider}|${model}`
}

function emptyRow(bucket, provider, model, nowMs) {
  return {
    bucket,
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    requests: 0,
    turns: 0,
    lastSeen: nowMs,
  }
}

// 样本折叠为计数增量:turn/request 只计次,token 样本累加四类桶
function deltaOf(sample, nowMs) {
  const delta = emptyRow('', '', '', nowMs)
  delete delta.bucket
  delete delta.provider
  delete delta.model
  if (sample.turn) delta.turns = 1
  else if (sample.request) delta.requests = 1
  else {
    delta.inputTokens = sample.inputTokens
    delta.outputTokens = sample.outputTokens
    delta.cacheReadTokens = sample.cacheReadTokens
    delta.cacheWriteTokens = sample.cacheWriteTokens
    delta.durationMs = sample.durationMs ?? 0
  }
  return delta
}

// 增量累加:行与 pending 条目同构,恒等字段取 base,计数逐项相加,时刻取较新
function addDelta(base, delta) {
  return {
    ...base,
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
    // base 侧 ?? 0 容存量旧格式行(缺字段);delta 侧经 deltaOf 恒为数值
    durationMs: (base.durationMs ?? 0) + delta.durationMs,
    requests: base.requests + delta.requests,
    turns: base.turns + delta.turns,
    lastSeen: Math.max(base.lastSeen, delta.lastSeen),
  }
}

function isMissingRecord(err) {
  return err instanceof Error && MISSING_RECORD_PATTERN.test(err.message)
}

export class UsageStore {
  constructor(facility, options = {}) {
    this.now = options.now ?? Date.now
    this.retentionDays = options.retentionDays ?? (() => DEFAULT_MINUTE_RETENTION_DAYS)
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS
    // flush 行级失败上抛缝:采集器注入后接入扫描异常日志
    this.onFlushError = options.onFlushError
    this.table = null
    this.domain = null
    this.backupDomain = undefined
    this.backupTable = undefined
    this.openError = undefined
    this.lastPruneDay = ''
    this.markChain = Promise.resolve()
    this.pending = new Map()
    this.flushTimer = undefined
    // ready 永远 resolve:打开失败转降级,操作按调用失败,逃逸拒绝会拖垮宿主
    this.ready = this.initialize(facility).catch((err) => {
      this.openError = err
    })
  }

  async initialize(facility) {
    const domain = await facility.open(usageStatsDomain)
    this.domain = domain
    this.table = domain.table(TABLE_BUCKETS)
    // 游标空而已有行:无法区分半写坏态,丢弃行交由回扫重建
    const cursor = this.readCursor()
    if ((cursor?.backfilledSessions?.length ?? 0) === 0 && !this.table.keys().next().done) {
      for (const key of [...this.table.keys()]) await this.table.delete(key)
    }
    // 备份域打开失败仅禁用回退能力,不拖垮主采集(openError 只覆盖主域)
    this.backupDomain = await facility.open(usageBackupDomain).catch(() => undefined)
    this.backupTable = this.backupDomain?.table(TABLE_BUCKETS)
  }

  get degradation() {
    return this.openError
  }

  async readyPromise() {
    await this.ready
  }

  readCursor() {
    return this.domain?.global?.get()
  }

  degradedError() {
    const detail = this.openError instanceof Error ? this.openError.message : String(this.openError)
    return new Error(`usage store degraded (domain unavailable: ${detail})`)
  }

  requireTable() {
    if (this.openError !== undefined) throw this.degradedError()
    return this.table
  }

  requireCursor() {
    if (this.openError !== undefined) throw this.degradedError()
    return this.readCursor() ?? {}
  }

  // 同步合并进 pending,不等待持久化;崩溃丢失窗口 = flush 周期
  async record(sample) {
    await this.ready
    this.requireTable()
    const nowMs = this.now()
    const model = sample.turn ? MODEL_TURNS : sample.model ? sample.model : MODEL_UNKNOWN
    const provider = sample.turn ? PROVIDER_UNSET : providerOf(model)
    const delta = deltaOf(sample, nowMs)
    for (const [g, bucketOf] of GRANULARITIES) {
      const bucket = bucketOf(sample.time)
      const entry = { ...delta, bucket, provider, model }
      const existing = this.pending.get(rowKey(g, bucket, provider, model))
      this.pending.set(rowKey(g, bucket, provider, model), existing ? addDelta(existing, entry) : entry)
    }
    this.scheduleFlush()
  }

  scheduleFlush() {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushNow()
    }, this.flushIntervalMs)
  }

  // pending 批量落盘:每脏行一次原子读改写,失败的行并回 pending 下轮重试,
  // 错误聚合后经 onFlushError 上抛;与游标写同链串行
  flushNow() {
    const run = this.markChain.then(async () => {
      await this.ready
      if (this.pending.size === 0) return
      try {
        await this.flushBatch()
      } catch (err) {
        this.onFlushError?.(err)
      }
    })
    this.markChain = run.then(() => {}, () => {})
    return run
  }

  async flushBatch() {
    await this.pruneOncePerDay()
    const table = this.requireTable()
    const batch = this.pending
    this.pending = new Map()
    const outcomes = await Promise.allSettled([...batch].map(([key, delta]) => this.applyDelta(table, key, delta)))
    const failures = outcomes.flatMap((outcome, index) => {
      if (outcome.status !== 'rejected') return []
      const key = [...batch.keys()][index]
      const [entryKey, entry] = [key, batch.get(key)]
      const existing = this.pending.get(entryKey)
      this.pending.set(entryKey, existing ? addDelta(existing, entry) : entry)
      return [outcome.reason]
    })
    if (failures.length > 0) throw new AggregateError(failures, 'usage store flush failed')
  }

  async applyDelta(table, key, delta) {
    const apply = (current) => addDelta(current ?? emptyRow(delta.bucket, delta.provider, delta.model, delta.lastSeen), delta)
    try {
      await table.update(key, apply)
    } catch (err) {
      if (!isMissingRecord(err)) throw err
      await table.put(key, emptyRow(delta.bucket, delta.provider, delta.model, delta.lastSeen))
      await table.update(key, apply)
    }
  }

  async pruneOncePerDay() {
    const today = dayKey(this.now())
    if (today === this.lastPruneDay) return
    this.lastPruneDay = today
    try {
      await this.pruneMinutes()
      await this.pruneHours()
    } catch {
      // 清理失败不阻断写入,次日首写再试
    }
  }

  // days = 0 表示禁用分钟桶:全量清理而非按窗口保留
  async pruneMinutes(days = this.retentionDays()) {
    await this.ready
    const table = this.requireTable()
    const retention = clampMinuteRetentionDays(days)
    const cutoff = retention === 0 ? null : minuteKey(this.now() - retention * DAY_MS)
    for (const [key, existing] of table.entries()) {
      if (!key.startsWith(MINUTE_KEY_PREFIX)) continue
      if (cutoff === null || existing.bucket < cutoff) await table.delete(key)
    }
  }

  // 小时桶保留固定 15 天,无配置项
  async pruneHours() {
    await this.ready
    const table = this.requireTable()
    const cutoff = hourKey(this.now() - HOUR_RETENTION_DAYS * DAY_MS)
    for (const [key, existing] of table.entries()) {
      if (!key.startsWith(HOUR_KEY_PREFIX)) continue
      if (existing.bucket < cutoff) await table.delete(key)
    }
  }

  async rangeRows(g, from, to) {
    await this.flushNow()
    await this.ready
    const table = this.requireTable()
    const prefix = `${g}|`
    const matched = []
    for (const [key, existing] of table.entries()) {
      if (!key.startsWith(prefix)) continue
      if (existing.bucket >= from && existing.bucket <= to) matched.push(existing)
    }
    return matched
  }

  async seenSessions() {
    await this.ready
    return new Set(this.readCursor()?.backfilledSessions ?? [])
  }

  async liveSequences() {
    await this.ready
    return new Map(Object.entries(this.readCursor()?.liveFirstSeq ?? {}))
  }

  markSeenSessions(ids) {
    return this.enqueueGlobalWrite(async () => {
      const cursor = this.requireCursor()
      const seen = new Set(cursor.backfilledSessions ?? [])
      for (const id of ids) seen.add(id)
      await this.writeGlobal([...seen], cursor.liveFirstSeq ?? {})
    })
  }

  markLiveSequences(entries) {
    return this.enqueueGlobalWrite(async () => {
      const cursor = this.requireCursor()
      const merged = { ...(cursor.liveFirstSeq ?? {}) }
      let changed = false
      for (const [id, seq] of entries) {
        if (merged[id] === undefined || seq < merged[id]) {
          merged[id] = seq
          changed = true
        }
      }
      if (!changed) return
      await this.writeGlobal(cursor.backfilledSessions ?? [], merged)
    })
  }

  reset(boundaries) {
    return this.enqueueGlobalWrite(async () => {
      await this.flushBatch()
      // 清空前快照到备份域:重建丢数据(规则缺陷/中断/口径变化)可整体回退;
      // 备份不可用视为 reset 失败——回退安全带是重建的前置条件
      await this.snapshotToBackup()
      const table = this.requireTable()
      for (const key of [...table.keys()]) await table.delete(key)
      const liveFirstSeq = {}
      if (boundaries) for (const [id, seq] of boundaries) liveFirstSeq[id] = seq
      await this.writeGlobal([], liveFirstSeq)
    })
  }

  // 当前全量(表行 + 游标 + 时刻)写入备份域,覆盖旧备份:恢复点恒为最近一次清空/恢复前;
  // 备份域不可用时跳过(重建不被卡死,仅失去回退点,backupInfo 透明展示)
  async snapshotToBackup() {
    if (this.backupTable === undefined) return
    const cursor = this.readCursor() ?? {}
    for (const key of [...this.backupTable.keys()]) await this.backupTable.delete(key)
    for (const [key, row] of this.requireTable().entries()) await this.backupTable.put(key, row)
    await this.backupDomain.global.set({
      backfilledSessions: cursor.backfilledSessions ?? [],
      liveFirstSeq: cursor.liveFirstSeq ?? {},
      takenAt: this.now(),
    })
  }

  // 备份写回主域;当前态先入备份(恢复动作自身可回退),故必须先取备份内容
  // 再覆盖备份域;返回快照时刻与回写行数
  async restoreFromBackup() {
    if (this.backupTable === undefined) throw new Error('usage backup domain unavailable')
    return this.enqueueGlobalWrite(async () => {
      await this.flushBatch()
      const savedRows = [...this.backupTable.entries()]
      const saved = this.backupDomain.global.get()
      await this.snapshotToBackup()
      for (const key of [...this.requireTable().keys()]) await this.table.delete(key)
      for (const [key, row] of savedRows) await this.table.put(key, row)
      await this.writeGlobal(saved?.backfilledSessions ?? [], saved?.liveFirstSeq ?? {})
      return { takenAt: saved?.takenAt, rows: savedRows.length }
    })
  }

  // 备份元信息:available=false 表示无回退点(从未重建/备份域不可用)
  backupInfo() {
    if (this.backupTable === undefined) return { available: false }
    const saved = this.backupDomain.global.get()
    return {
      available: typeof saved?.takenAt === 'number',
      takenAt: saved?.takenAt,
      rows: [...this.backupTable.keys()].length,
      sessions: saved?.backfilledSessions?.length ?? 0,
    }
  }

  // global 只有整值覆写:全部游标写挂同一链,读改写不再交错;write 返回值透传
  enqueueGlobalWrite(write) {
    const pending = this.markChain.then(async () => {
      await this.ready
      return write()
    })
    this.markChain = pending.then(() => {}, () => {})
    return pending
  }

  async writeGlobal(backfilledSessions, liveFirstSeq) {
    await this.domain.global.set({ backfilledSessions, liveFirstSeq })
  }
}

const SHARED_STORE_KEY = '__dshUsageDashStore'

export function sharedStore(facility, options = {}) {
  const existing = globalThis[SHARED_STORE_KEY]
  if (existing) return existing
  const store = new UsageStore(facility, options)
  globalThis[SHARED_STORE_KEY] = store
  return store
}

export function __resetSharedStoreForTests() {
  delete globalThis[SHARED_STORE_KEY]
}
