// 用量统计存储:usage_stats 域,单表 buckets,行键 <粒度>|<桶串>|<provider>|<model>。
// single 布局每次持久化写都全量重发布 unit 文档,故写入侧做合并(write-behind):
// record 同步累加进内存 pending,按周期 flush 批量落盘,同桶多样本折叠为一次
// update;flush 失败的行留在 pending 下轮重试,错误经 onFlushError 上抛。
// 游标读写与 flush 全部串行在同一条 promise 链上,防 lost update。store 实例
// 按 facility 弱关联缓存,防 HMR 热重载换 facility 后旧实例泄漏或撞单开守卫;
// 同名域被上一代遗留占用时降级(不关闭占用者),不争单开守卫。

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import { PROVIDER_UNSET, splitRequestSegments } from './pricing.js'

export const GRANULARITY_DAILY = 'D'
export const GRANULARITY_HOURLY = 'H'
export const GRANULARITY_MINUTE = 'M'

export const MODEL_TURNS = '(turns)'
export const MODEL_UNKNOWN = '(unknown)'
// 旧记录没有工作区归属:保留为独立分组,不冒充任一真实工作区
export const WORKSPACE_UNKNOWN = '(workspace-unknown)'

export const DEFAULT_MINUTE_RETENTION_DAYS = 7

// 分钟桶对齐粒度(分钟);小时/天桶不受影响
export const MINUTE_BUCKET_SPAN_MINUTES = 10
const MS_PER_MINUTE = 60 * 1000
const MINUTE_BUCKET_SPAN_MS = MINUTE_BUCKET_SPAN_MINUTES * MS_PER_MINUTE

// 保留上限:小时桶固定 15 天,分钟桶可配置但最大 7 天(与分钟视图选择上限一致)
export const HOUR_RETENTION_DAYS = 15
export const MINUTE_RETENTION_MAX_DAYS = 7

// 写合并周期:pending 样本最长延迟该时长落盘;统计可由会话重扫重建,容忍窗口内丢失
export const FLUSH_INTERVAL_MS = 2000

const DAY_MS = 24 * 60 * 60 * 1000
const PAD_WIDTH = 2
const DOMAIN_NAME = 'usage_stats'
const TABLE_BUCKETS = 'buckets'
const TABLE_SESSIONS = 'sessions'
const MISSING_RECORD_PATTERN = /no record .* to update/
const MINUTE_KEY_PREFIX = `${GRANULARITY_MINUTE}|`
const HOUR_KEY_PREFIX = `${GRANULARITY_HOURLY}|`
const DAILY_KEY_PREFIX = `${GRANULARITY_DAILY}|`

// 保留值归一:非法回落默认,超出上限截到上限;0(禁用)合法保留
export function clampMinuteRetentionDays(days) {
  const raw = Number.isFinite(days) && days >= 0 ? days : DEFAULT_MINUTE_RETENTION_DAYS
  return Math.min(raw, MINUTE_RETENTION_MAX_DAYS)
}

// 桶串统一本地时区推导,同粒度内字典序即时间序。显式 timeZone(IANA)供跨时区
// 口径测试与服务端 status 对拍;缺省沿用宿主本地时区(Date 分量)。
const pad = (value) => String(value).padStart(PAD_WIDTH, '0')

const wallFormatters = new Map()
function wallPartsOf(ts, timeZone) {
  const date = new Date(ts)
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    }
  }
  let formatter = wallFormatters.get(timeZone)
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
    } catch {
      formatter = null
    }
    wallFormatters.set(timeZone, formatter)
  }
  if (formatter === null) return wallPartsOf(ts, undefined)
  const parts = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute }
}

const formatDayParts = (parts) => `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`

export function dayKey(ts, timeZone) {
  return formatDayParts(wallPartsOf(ts, timeZone))
}

export function hourKey(ts, timeZone) {
  const parts = wallPartsOf(ts, timeZone)
  return `${formatDayParts(parts)}T${pad(parts.hour)}`
}

// 分钟桶起点按本地墙钟向下取整到桶边界,不跨时。偏移非整十分钟的时区
// (尼泊尔 +5:45 / 查塔姆 +12:45)里按 UTC 纪元取整会落到 :45 这类非桶分钟,
// 客户端与服务端必须用同一口径:localMs = ts - offset,取整后加回 offset
export function minuteBucketStart(ts, offsetMinutes = new Date(ts).getTimezoneOffset()) {
  const offsetMs = offsetMinutes * MS_PER_MINUTE
  return Math.floor((ts - offsetMs) / MINUTE_BUCKET_SPAN_MS) * MINUTE_BUCKET_SPAN_MS + offsetMs
}

export function minuteKey(ts, timeZone) {
  const parts = wallPartsOf(ts, timeZone)
  const wallMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  const aligned = Math.floor(wallMs / MINUTE_BUCKET_SPAN_MS) * MINUTE_BUCKET_SPAN_MS
  const date = new Date(aligned)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

// 最近若干分钟的完整桶键:按绝对时间逐桶回推,不用「起点键..终点键」的墙钟
// 区间——夏令时回拨时墙钟会倒退,字符串区间可能为空或纳入窗口外的桶
export function recentMinuteBuckets(nowMs, timeZone, windowMinutes) {
  const count = Math.ceil(windowMinutes / MINUTE_BUCKET_SPAN_MINUTES)
  const keys = []
  // 当前桶还在累计,计入会按整窗放大成系统性低估;从上一个桶起取完整桶
  for (let step = 1; step <= count; step += 1) {
    keys.push(minuteKey(nowMs - step * MINUTE_BUCKET_SPAN_MS, timeZone))
  }
  const unique = [...new Set(keys)].sort()
  return { keys: new Set(unique), from: unique[0], to: unique[unique.length - 1] }
}

// 同一样本依次落三粒度
export const GRANULARITIES = [
  [GRANULARITY_DAILY, dayKey],
  [GRANULARITY_HOURLY, hourKey],
  [GRANULARITY_MINUTE, minuteKey],
]

// 会话索引只落天/小时两档(row 存桶内去重会话 id):天档永久,小时档随桶保留期;
// 分钟视图由覆盖小时行近似(边界最多外扩一小时),不为会话数另建分钟行
const SESSION_GRANULARITIES = [
  [GRANULARITY_DAILY, dayKey],
  [GRANULARITY_HOURLY, hourKey],
]

// 会话索引保留资格与对应粒度桶同源
function sessionWithinRetention(g, bucket, nowMs) {
  if (g === GRANULARITY_DAILY) return true
  return bucket >= hourKey(nowMs - HOUR_RETENTION_DAYS * DAY_MS)
}

// 档保留资格(F14):样本桶 ≥ 该档 cutoff 即可写入。日档无上限恒写;
// 小时档固定留存;分钟档走可配置天数(0 = 分钟档关闭,一律不写)
function withinRetention(g, bucket, nowMs, minuteRetentionDays) {
  if (g === GRANULARITY_DAILY) return true
  if (g === GRANULARITY_HOURLY) return bucket >= hourKey(nowMs - HOUR_RETENTION_DAYS * DAY_MS)
  const retention = clampMinuteRetentionDays(minuteRetentionDays)
  if (retention === 0) return false
  return bucket >= minuteKey(nowMs - retention * DAY_MS)
}

// vendor 段推导与定价匹配同源:首个 / 前段,无 / 或首位斜杠归 default
export function providerOf(modelRef) {
  return splitRequestSegments(modelRef)[0]
}

export const usageRowSchema = z.object({
  bucket: z.string(),
  workspaceId: z.string().default(WORKSPACE_UNKNOWN),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  // 模型时长累计(毫秒)与 decode 口径速度分子:optional 兼容存量记录(域 open 逐记录 parse)
  durationMs: z.number().optional(),
  decodeTokens: z.number().optional(),
  // 首 token 延迟累计(毫秒)与样本步数:optional 兼容存量记录
  ttftMs: z.number().optional(),
  ttftSteps: z.number().optional(),
  requests: z.number(),
  turns: z.number(),
  lastSeen: z.number(),
})

// 会话索引行:bucket 为该桶的桶串,sessions 为桶内去重的真实会话 id
export const sessionRowSchema = z.object({
  bucket: z.string(),
  workspaceId: z.string().default(WORKSPACE_UNKNOWN),
  sessions: z.array(z.string()),
})

export const usageStatsDomain = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: {
    [TABLE_BUCKETS]: domainTable(usageRowSchema),
    [TABLE_SESSIONS]: domainTable(sessionRowSchema),
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
    [TABLE_SESSIONS]: domainTable(sessionRowSchema),
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

export function rowKey(g, workspaceId, bucket, provider, model) {
  return `${g}|${workspaceId}|${bucket}|${provider}|${model}`
}

function sessionKey(g, workspaceId, bucket) {
  return `${g}|${workspaceId}|${bucket}`
}

const normalizeWorkspaceId = (value) => typeof value === 'string' && value !== '' ? value : WORKSPACE_UNKNOWN

function emptyRow(bucket, workspaceId, provider, model, nowMs) {
  return {
    bucket,
    workspaceId,
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    decodeTokens: 0,
    ttftMs: 0,
    ttftSteps: 0,
    requests: 0,
    turns: 0,
    lastSeen: nowMs,
  }
}

// 样本折叠为计数增量:turn/request 只计次,token 样本累加四类桶;
// decodeTokens 与 durationMs 同源配对构成速度,timing 缺失按零累计
function deltaOf(sample, nowMs) {
  const delta = emptyRow('', WORKSPACE_UNKNOWN, '', '', nowMs)
  delete delta.bucket
  delete delta.workspaceId
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
    delta.decodeTokens = sample.decodeTokens ?? 0
    delta.ttftMs = sample.ttftMs ?? 0
    delta.ttftSteps = sample.ttftMs !== undefined ? 1 : 0
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
    decodeTokens: (base.decodeTokens ?? 0) + delta.decodeTokens,
    ttftMs: (base.ttftMs ?? 0) + delta.ttftMs,
    ttftSteps: (base.ttftSteps ?? 0) + delta.ttftSteps,
    requests: base.requests + delta.requests,
    turns: base.turns + delta.turns,
    lastSeen: Math.max(base.lastSeen, delta.lastSeen),
  }
}

// 会话 id 集合并集:保持既有顺序,只追加新 id,重复记录幂等
function mergeSessionIds(existing, incoming) {
  const merged = new Set(existing ?? [])
  for (const id of incoming) merged.add(id)
  return [...merged]
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
    this.sessionTable = null
    this.domain = null
    this.backupDomain = undefined
    this.backupTable = undefined
    this.backupSessionTable = undefined
    this.openError = undefined
    // 游标空而已有行:启动时只标记,待本轮回扫成功读完任一会话后再清,
    // 防宿主全面拒读时每次启动清空历史(清库不再假定回扫必然可重建)
    this.orphanResetPending = false
    this.lastPruneDay = ''
    this.markChain = Promise.resolve()
    this.pending = new Map()
    // 本 boot 实时增量累积器:清表(孤儿清理/重建)会删掉本 boot 实时行,而回扫
    // 按 liveFirstSeq 跳过实时拥区间不再重放,只能由此整体重建;全程保留不清,
    // 任一步失败或清表期间新到的实时写入都留在累积器里,重试即可恢复
    this.bootLive = { buckets: new Map(), sessions: new Map() }
    // 会话索引 pending:<g>|<bucket> → { bucket, sessions:Set };seen 防同桶重复入队
    this.sessionPending = new Map()
    this.sessionSeen = new Set()
    this.flushTimer = undefined
    // ready 永远 resolve:打开失败转降级,操作按调用失败,逃逸拒绝会拖垮宿主
    this.ready = this.initialize(facility).catch((err) => {
      this.openError = err
    })
  }

  async initialize(facility) {
    // 占用不等于无主:开域失败只降级,不关闭其他实例仍在写入的句柄。
    const domain = await facility.open(usageStatsDomain)
    this.domain = domain
    this.table = domain.table(TABLE_BUCKETS)
    this.sessionTable = domain.table(TABLE_SESSIONS)
    // 游标空而已有行:无法区分半写坏态,标记待清理;由采集器确认回扫能读出
    // 至少一个会话后调用 clearOrphanRows,避免宿主全面拒读时反复清空历史
    const cursor = this.readCursor()
    this.orphanResetPending = (cursor?.backfilledSessions?.length ?? 0) === 0 && !this.table.keys().next().done
    // 备份域打开失败仅禁用回退能力,不拖垮主采集(openError 只覆盖主域)
    this.backupDomain = await facility.open(usageBackupDomain).catch(() => undefined)
    this.backupTable = this.backupDomain?.table(TABLE_BUCKETS)
    this.backupSessionTable = this.backupDomain?.table(TABLE_SESSIONS)
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

  requireSessionTable() {
    if (this.openError !== undefined) throw this.degradedError()
    return this.sessionTable
  }

  requireCursor() {
    if (this.openError !== undefined) throw this.degradedError()
    return this.readCursor() ?? {}
  }

  // 同步合并进 pending,不等待持久化;崩溃丢失窗口 = flush 周期。
  // 入队按档保留资格过滤(F14):超出该档留存期的样本不写入——
  // 写后即被 prune 删除是纯 IO 浪费;回扫历史导入经同一通道自动受控。
  // options.live 标记实时路径写入:额外累积进本 boot 累积器,供清表后整体重建
  async record(sample, options = {}) {
    await this.ready
    this.requireTable()
    const nowMs = this.now()
    const model = sample.turn ? MODEL_TURNS : sample.model ? sample.model : MODEL_UNKNOWN
    const provider = sample.turn ? PROVIDER_UNSET : providerOf(model)
    const workspaceId = normalizeWorkspaceId(options.workspaceId)
    const delta = deltaOf(sample, nowMs)
    for (const [g, bucketOf] of GRANULARITIES) {
      if (!withinRetention(g, bucketOf(sample.time), nowMs, this.retentionDays())) continue
      const bucket = bucketOf(sample.time)
      const entry = { ...delta, workspaceId, bucket, provider, model }
      const key = rowKey(g, workspaceId, bucket, provider, model)
      const existing = this.pending.get(key)
      this.pending.set(key, existing ? addDelta(existing, entry) : entry)
      if (options.live === true) this.accumulateBootLive(key, entry)
    }
    this.scheduleFlush()
  }

  accumulateBootLive(key, entry) {
    const existing = this.bootLive.buckets.get(key)
    this.bootLive.buckets.set(key, existing ? addDelta(existing, entry) : entry)
  }

  // 表已清空后按累积器整体重建本 boot 行:累积器是同键本 boot 全量实时增量,
  // 清表期间新到的实时写入已并入其中,故按 key 覆盖 pending 而非累加(否则双计);
  // 去重内存按「表内现存行」重建,已随表删除的键允许回扫重新入队。
  // 不清累积器:重建后再清表仍能恢复,失败重试也不会丢
  rebuildFromBootLive() {
    for (const [key, delta] of this.bootLive.buckets) this.pending.set(key, { ...delta })
    this.sessionSeen.clear()
    for (const [key, entry] of this.bootLive.sessions) {
      this.sessionPending.set(key, { bucket: entry.bucket, workspaceId: entry.workspaceId, sessions: new Set(entry.sessions) })
      for (const id of entry.sessions) this.sessionSeen.add(`${key}|${id}`)
    }
  }

  // 会话索引:桶内去重的真实会话 id。重复记录由内存 seen 短路,跨 boot 由
  // 行内 set 合并兜底;小时档超保留期只落天档。options.live 同 record
  async recordSession(sessionId, time, options = {}) {
    if (typeof sessionId !== 'string' || sessionId === '' || !Number.isFinite(time)) return
    await this.ready
    this.requireSessionTable()
    const nowMs = this.now()
    const workspaceId = normalizeWorkspaceId(options.workspaceId)
    let added = false
    for (const [g, bucketOf] of SESSION_GRANULARITIES) {
      const bucket = bucketOf(time)
      if (!sessionWithinRetention(g, bucket, nowMs)) continue
      const seenKey = `${g}|${workspaceId}|${bucket}|${sessionId}`
      if (this.sessionSeen.has(seenKey)) continue
      this.sessionSeen.add(seenKey)
      added = true
      const key = sessionKey(g, workspaceId, bucket)
      const existing = this.sessionPending.get(key)
      if (existing !== undefined) existing.sessions.add(sessionId)
      else this.sessionPending.set(key, { bucket, workspaceId, sessions: new Set([sessionId]) })
      if (options.live === true) {
        const live = this.bootLive.sessions.get(key)
        if (live !== undefined) live.sessions.add(sessionId)
        else this.bootLive.sessions.set(key, { bucket, workspaceId, sessions: new Set([sessionId]) })
      }
    }
    if (added) this.scheduleFlush()
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
      if (this.pending.size === 0 && this.sessionPending.size === 0) return
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
    await this.flushBuckets()
    await this.flushSessions()
  }

  async flushBuckets() {
    const table = this.requireTable()
    const batch = this.pending
    this.pending = new Map()
    const outcomes = await Promise.allSettled([...batch].map(([key, delta]) => this.applyDelta(table, key, delta)))
    const failures = outcomes.flatMap((outcome, index) => {
      if (outcome.status !== 'rejected') return []
      const key = [...batch.keys()][index]
      const [entryKey, entry] = [key, batch.get(key)]
      // 重排前复核保留资格(F14):失败重试期间样本可能已滑出留存期,不再重排
      const g = key.startsWith(DAILY_KEY_PREFIX) ? GRANULARITY_DAILY : key.startsWith(HOUR_KEY_PREFIX) ? GRANULARITY_HOURLY : GRANULARITY_MINUTE
      if (!withinRetention(g, entry.bucket, this.now(), this.retentionDays())) return []
      const existing = this.pending.get(entryKey)
      this.pending.set(entryKey, existing ? addDelta(existing, entry) : entry)
      return [outcome.reason]
    })
    if (failures.length > 0) throw new AggregateError(failures, 'usage store flush failed')
  }

  async flushSessions() {
    if (this.sessionPending.size === 0) return
    const table = this.requireSessionTable()
    const batch = this.sessionPending
    this.sessionPending = new Map()
    const entries = [...batch]
    const outcomes = await Promise.allSettled(entries.map(([key, entry]) => this.applySessionEntry(table, key, entry)))
    const failures = []
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== 'rejected') continue
      const [key, entry] = entries[index]
      // 重排前复核保留资格:重试窗口内小时桶可能已滑出留存期
      const g = key.startsWith(DAILY_KEY_PREFIX) ? GRANULARITY_DAILY : GRANULARITY_HOURLY
      if (!sessionWithinRetention(g, entry.bucket, this.now())) continue
      const existing = this.sessionPending.get(key)
      if (existing !== undefined) for (const id of entry.sessions) existing.sessions.add(id)
      else this.sessionPending.set(key, entry)
      failures.push(outcome.reason)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'usage store session flush failed')
  }

  async applySessionEntry(table, key, entry) {
    const apply = (current) => ({
      bucket: entry.bucket,
      workspaceId: entry.workspaceId,
      sessions: mergeSessionIds(current?.sessions, entry.sessions),
    })
    try {
      await table.update(key, apply)
    } catch (err) {
      if (!isMissingRecord(err)) throw err
      await table.put(key, { bucket: entry.bucket, workspaceId: entry.workspaceId, sessions: [] })
      await table.update(key, apply)
    }
  }

  async applyDelta(table, key, delta) {
    const apply = (current) => addDelta(current ?? emptyRow(delta.bucket, delta.workspaceId, delta.provider, delta.model, delta.lastSeen), delta)
    try {
      await table.update(key, apply)
    } catch (err) {
      if (!isMissingRecord(err)) throw err
      await table.put(key, emptyRow(delta.bucket, delta.workspaceId, delta.provider, delta.model, delta.lastSeen))
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

  // 小时桶保留固定 15 天,无配置项;会话索引小时行同窗口清理
  async pruneHours() {
    await this.ready
    const table = this.requireTable()
    const cutoff = hourKey(this.now() - HOUR_RETENTION_DAYS * DAY_MS)
    for (const [key, existing] of table.entries()) {
      if (!key.startsWith(HOUR_KEY_PREFIX)) continue
      if (existing.bucket < cutoff) await table.delete(key)
    }
    const sessions = this.requireSessionTable()
    for (const [key, existing] of sessions.entries()) {
      if (!key.startsWith(HOUR_KEY_PREFIX)) continue
      if (existing.bucket < cutoff) await sessions.delete(key)
    }
  }

  async rangeRows(g, from, to, workspaceId) {
    await this.flushNow()
    await this.ready
    const table = this.requireTable()
    const prefix = `${g}|`
    const matched = []
    for (const [key, existing] of table.entries()) {
      if (!key.startsWith(prefix)) continue
      if (workspaceId && existing.workspaceId !== workspaceId) continue
      if (existing.bucket >= from && existing.bucket <= to) matched.push(existing)
    }
    return matched
  }

  // 会话索引窗口行:与 rangeRows 同构,读前先落 pending 保证读己之写
  async sessionRangeRows(g, from, to, workspaceId) {
    await this.flushNow()
    await this.ready
    const table = this.requireSessionTable()
    const prefix = `${g}|`
    const matched = []
    for (const [key, existing] of table.entries()) {
      if (!key.startsWith(prefix)) continue
      if (workspaceId && existing.workspaceId !== workspaceId) continue
      if (existing.bucket >= from && existing.bucket <= to) matched.push(existing)
    }
    return matched
  }

  // 补扫判定:有历史用量但无会话索引 = 旧版本数据,需要一次性补建索引
  hasSessionRows() {
    return this.sessionTable !== undefined && this.sessionTable.size > 0
  }

  hasBucketRows() {
    return this.table !== undefined && this.table.size > 0
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

  // 清空两张表(保留游标):孤儿行清理与重建共用
  async wipeTables() {
    const table = this.requireTable()
    for (const key of [...table.keys()]) await table.delete(key)
    const sessions = this.requireSessionTable()
    for (const key of [...sessions.keys()]) await sessions.delete(key)
  }

  // 清理启动时发现的半写孤儿行:仅当本轮回扫已成功读完至少一个会话才调用。
  // 清理与游标写同链串行,保留 liveFirstSeq 边界。
  // 清表会连本 boot 实时行一起删掉,而回扫对实时拥区间跳过重放:清完按累积器
  // 整体重建;累积器不清,writeGlobal/落盘任一步失败后重试仍能恢复
  async clearOrphanRows() {
    if (!this.orphanResetPending) return false
    await this.enqueueGlobalWrite(async () => {
      await this.flushBatch()
      await this.wipeTables()
      const cursor = this.readCursor() ?? {}
      await this.writeGlobal([], cursor.liveFirstSeq ?? {})
      this.rebuildFromBootLive()
      await this.flushBatch()
    })
    this.orphanResetPending = false
    return true
  }

  reset(boundaries) {
    return this.enqueueGlobalWrite(async () => {
      await this.flushBatch()
      // 清空前快照到备份域:重建丢数据(规则缺陷/中断/口径变化)可整体回退;
      // 备份域不可用时跳过(仅失去回退点,backupInfo 透明展示),重建不被卡死
      await this.snapshotToBackup()
      await this.wipeTables()
      const liveFirstSeq = {}
      if (boundaries) for (const [id, seq] of boundaries) liveFirstSeq[id] = seq
      await this.writeGlobal([], liveFirstSeq)
      // 重建只重放 [0,watermark),实时拥区间由累积器整体回填;累积器不清,
      // 快照/清表/落盘任一步失败后重试仍能恢复
      this.rebuildFromBootLive()
      await this.flushBatch()
      this.orphanResetPending = false
    })
  }

  // 当前全量(表行 + 会话索引 + 游标 + 时刻)写入备份域,覆盖旧备份:恢复点恒为最近一次清空/恢复前;
  // 备份域不可用时跳过(重建不被卡死,仅失去回退点,backupInfo 透明展示)
  async snapshotToBackup() {
    if (this.backupTable === undefined) return
    const cursor = this.readCursor() ?? {}
    for (const key of [...this.backupTable.keys()]) await this.backupTable.delete(key)
    for (const [key, row] of this.requireTable().entries()) await this.backupTable.put(key, row)
    if (this.backupSessionTable !== undefined) {
      for (const key of [...this.backupSessionTable.keys()]) await this.backupSessionTable.delete(key)
      for (const [key, row] of this.requireSessionTable().entries()) await this.backupSessionTable.put(key, row)
    }
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
    // 无快照时回退 = 清空全表与游标,属破坏性动作:直接调用也拒绝,由调用方给出状态码
    if (!this.backupInfo().available) throw new Error('usage backup snapshot unavailable')
    return this.enqueueGlobalWrite(async () => {
      await this.flushBatch()
      const savedRows = [...this.backupTable.entries()]
      const savedSessions = this.backupSessionTable === undefined ? [] : [...this.backupSessionTable.entries()]
      const saved = this.backupDomain.global.get()
      await this.snapshotToBackup()
      const table = this.requireTable()
      for (const key of [...table.keys()]) await table.delete(key)
      for (const [key, row] of savedRows) await table.put(key, row)
      const sessions = this.requireSessionTable()
      for (const key of [...sessions.keys()]) await sessions.delete(key)
      for (const [key, row] of savedSessions) await sessions.put(key, row)
      this.sessionPending = new Map()
      this.sessionSeen.clear()
      // 回退到备份快照后表内容为快照时刻状态,累积器若保留会在下次清表时
      // 复活已回退掉的数据;清空累积器,后续实时数据从回退点重新累积
      this.bootLive = { buckets: new Map(), sessions: new Map() }
      await this.writeGlobal(saved?.backfilledSessions ?? [], saved?.liveFirstSeq ?? {})
      this.orphanResetPending = false
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

const SHARED_STORE_KEY = '__dshUsageDashStores'

// 单例按 facility 关联:插件热重载会换 facility 再 apply,全局单 key 缓存会把
// 绑定旧域的实例泄漏给新一代,或将新一代 open 撞 reserved 固化为永久降级;
// 未降级实例同 facility 复用,降级/异 facility 一律重建
// 可作弱键的 facility 才可缓存:服务缺席桩(非对象)退化为不缓存,每次新建
export function sharedStore(facility, options = {}) {
  const cacheable = (typeof facility === 'object' && facility !== null) || typeof facility === 'function'
  const existing = cacheable ? globalThis[SHARED_STORE_KEY]?.get?.(facility) : undefined
  if (existing && existing.degradation === undefined) return existing
  const store = new UsageStore(facility, options)
  if (cacheable) (globalThis[SHARED_STORE_KEY] ??= new WeakMap()).set(facility, store)
  return store
}

export function __resetSharedStoreForTests() {
  delete globalThis[SHARED_STORE_KEY]
}
