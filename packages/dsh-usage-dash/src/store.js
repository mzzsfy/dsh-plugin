// 用量统计存储:usage_stats 域,单表 buckets,行键 <粒度>|<桶串>|<provider>|<model>。
// 写入走 update 的原子读改写,缺键时 put 种子后重试一次;同一样本三粒度三行
// 全部尝试后聚合上抛,单粒度失败不造成其余粒度缺失。游标读写全部串行在
// 同一条 promise 链上,防 global 整值覆写的 lost update。进程级单例挂
// globalThis,防 HMR 热重载后重复开域。

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const GRANULARITY_DAILY = 'D'
export const GRANULARITY_HOURLY = 'H'
export const GRANULARITY_MINUTE = 'M'

export const PROVIDER_DEFAULT = 'default'
export const MODEL_TURNS = '(turns)'
export const MODEL_UNKNOWN = '(unknown)'

export const DEFAULT_MINUTE_RETENTION_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000
const PAD_WIDTH = 2
const DOMAIN_NAME = 'usage_stats'
const TABLE_BUCKETS = 'buckets'
const MISSING_RECORD_PATTERN = /no record .* to update/
const MINUTE_KEY_PREFIX = `${GRANULARITY_MINUTE}|`

// 桶串统一本地时区推导,同粒度内字典序即时间序
const pad = (value) => String(value).padStart(PAD_WIDTH, '0')

export function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function hourKey(ts) {
  return `${dayKey(ts)}T${pad(new Date(ts).getHours())}`
}

export function minuteKey(ts) {
  return `${hourKey(ts)}:${pad(new Date(ts).getMinutes())}`
}

// 同一样本依次落三粒度
export const GRANULARITIES = [
  [GRANULARITY_DAILY, dayKey],
  [GRANULARITY_HOURLY, hourKey],
  [GRANULARITY_MINUTE, minuteKey],
]

export function providerOf(modelRef) {
  const slash = modelRef.indexOf('/')
  return slash > 0 ? modelRef.slice(0, slash) : PROVIDER_DEFAULT
}

export const usageRowSchema = z.object({
  bucket: z.string(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
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
    requests: 0,
    turns: 0,
    lastSeen: nowMs,
  }
}

function isMissingRecord(err) {
  return err instanceof Error && MISSING_RECORD_PATTERN.test(err.message)
}

export class UsageStore {
  constructor(facility, options = {}) {
    this.now = options.now ?? Date.now
    this.retentionDays = options.retentionDays ?? (() => DEFAULT_MINUTE_RETENTION_DAYS)
    this.table = null
    this.domain = null
    this.openError = undefined
    this.lastPruneDay = ''
    this.markChain = Promise.resolve()
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

  async record(sample) {
    await this.ready
    const table = this.requireTable()
    await this.pruneOncePerDay()
    const nowMs = this.now()
    const outcomes = await Promise.allSettled(
      GRANULARITIES.map(([g, bucketOf]) => this.recordRow(table, g, bucketOf(sample.time), sample, nowMs)),
    )
    const failures = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []))
    if (failures.length > 0) throw new AggregateError(failures, 'usage store record failed')
  }

  async pruneOncePerDay() {
    const today = dayKey(this.now())
    if (today === this.lastPruneDay) return
    this.lastPruneDay = today
    try {
      await this.pruneMinutes()
    } catch {
      // 清理失败不阻断写入,次日首写再试
    }
  }

  // days = 0 表示禁用分钟桶:全量清理而非按窗口保留
  async pruneMinutes(days = this.retentionDays()) {
    await this.ready
    const table = this.requireTable()
    const retention = Number.isFinite(days) && days >= 0 ? days : DEFAULT_MINUTE_RETENTION_DAYS
    const cutoff = retention === 0 ? null : minuteKey(this.now() - retention * DAY_MS)
    for (const [key, existing] of table.entries()) {
      if (!key.startsWith(MINUTE_KEY_PREFIX)) continue
      if (cutoff === null || existing.bucket < cutoff) await table.delete(key)
    }
  }

  async recordRow(table, g, bucket, sample, nowMs) {
    const model = sample.turn ? MODEL_TURNS : sample.model ? sample.model : MODEL_UNKNOWN
    const provider = sample.turn ? PROVIDER_DEFAULT : providerOf(model)
    const key = rowKey(g, bucket, provider, model)
    const apply = (current) => {
      const base = current ?? emptyRow(bucket, provider, model, nowMs)
      if (sample.turn) return { ...base, turns: base.turns + 1, lastSeen: nowMs }
      if (sample.request) return { ...base, requests: base.requests + 1, lastSeen: nowMs }
      return {
        ...base,
        inputTokens: base.inputTokens + sample.inputTokens,
        outputTokens: base.outputTokens + sample.outputTokens,
        cacheReadTokens: base.cacheReadTokens + sample.cacheReadTokens,
        cacheWriteTokens: base.cacheWriteTokens + sample.cacheWriteTokens,
        lastSeen: nowMs,
      }
    }
    try {
      await table.update(key, apply)
    } catch (err) {
      if (!isMissingRecord(err)) throw err
      await table.put(key, emptyRow(bucket, provider, model, nowMs))
      await table.update(key, apply)
    }
  }

  async rangeRows(g, from, to) {
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
      const table = this.requireTable()
      for (const key of [...table.keys()]) await table.delete(key)
      const liveFirstSeq = {}
      if (boundaries) for (const [id, seq] of boundaries) liveFirstSeq[id] = seq
      await this.writeGlobal([], liveFirstSeq)
    })
  }

  // global 只有整值覆写:全部游标写挂同一链,读改写不再交错
  enqueueGlobalWrite(write) {
    const pending = this.markChain.then(async () => {
      await this.ready
      await write()
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
