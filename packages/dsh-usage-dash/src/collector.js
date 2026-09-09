// 采集器:session/event 实时折叠与持久化日志回扫,产出 {time,...} 采集样本交
// store.record 落三粒度。事件判定表、(session,turn,step) 首样本生效、归因链
// message.source > 观测路由 > requestContext 懒播种,均与原插件同构;单次
// 事件 pass 内的去重由 per-session fold 保证,跨 boot/回扫的不重复由持久
// 游标(liveFirstSeq 分区 + backfilledSessions)保证。采集是观测性的:一切
// store 失败计入 recordFailures,绝不成为逃逸拒绝。

import { createArchiveReader } from './archive-reader.js'

const UNKNOWN_SESSION_ID = '(unknown-session)'
const SEQ_UNKNOWN = -1
const DEFAULT_BACKFILL_CONCURRENCY = 4
const MARK_BATCH = 32
const SCAN_LOG_MAX_ENTRIES = 200

// 不可读会话分类:宿主可见性/可读性边界的三代实测形态(见 README 存档兼容)
const SKIP_KINDS = { descriptor: 'descriptor', corrupt: 'corrupt', legacy: 'legacy', other: 'other' }
const SKIP_PATTERNS = [
  // 宿主新校验拒读历史档(0.1.5 descriptor v2),宿主修复后自动补扫
  [SKIP_KINDS.descriptor, /unsupported descriptor version/i],
  // 存档损坏(seq gap 等 fail-closed 拒绝),宿主 repair 后自动补扫
  [SKIP_KINDS.corrupt, /corrupt|seq gap|SessionFormatError/i],
  // 超旧格式词汇(v0 时代字段),宿主迁移链覆盖后自动补扫
  [SKIP_KINDS.legacy, /format v0|unexpected member|does not provide|not a function/i],
]

function classifySkip(detail) {
  for (const [kind, pattern] of SKIP_PATTERNS) {
    if (pattern.test(detail)) return kind
  }
  return SKIP_KINDS.other
}

function emptySkipCounts() {
  return { [SKIP_KINDS.descriptor]: 0, [SKIP_KINDS.corrupt]: 0, [SKIP_KINDS.legacy]: 0, [SKIP_KINDS.other]: 0 }
}

// 官方 dsh-llm 助手流读取器同构镜像(isTokenDelta/runFirstTokenTime/
// assistantStreamFirstTokenTime):从紧凑记录还原首个产出 token 的时刻。
// 语义由 test/stream-parity.test.mjs 锁定,改一侧必须同步 parity
function isTokenDelta(chunk) {
  if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return chunk.text !== ''
  return chunk?.type === 'tool-call-delta' && (chunk.argumentsDelta !== '' || chunk.name !== undefined)
}

function runFirstTokenTime(run) {
  if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts
  let time = run.time0
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) {
      const gap = run.dt[index - 1]
      // 差分短缺属存储形态损坏,按无首 token 处理,保留后续报告锁定机会
      if (typeof gap !== 'number') return undefined
      time += gap
    }
    if (fragments[index] !== '') return time
  }
  return undefined
}

// 已知 packed run 形态白名单:未知记录形态(宿主未来新字段)安全跳过,
// 采集是观测性的,绝不因流记录形态漂移而崩溃
const RUN_RECORD_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

export function assistantStreamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    const time = record?.type === 'chunk'
      ? (isTokenDelta(record.chunk) ? record.time : undefined)
      : RUN_RECORD_TYPES.has(record?.type) ? runFirstTokenTime(record) : undefined
    if (time !== undefined) return time
  }
  return undefined
}

// 会话内单 pass 折叠:跟踪每个 (turn,step) 槽的最新报告,只把首次发射交 store
export class UsageFold {
  constructor() {
    this.seen = new Map()
    // (turn,step) 模型启动时刻:仅 step/start 设定(官方口径 TTFT 含失败尝试,
    // 不随 retry-started 重置);(turn,step) 首 token 时刻:由首个产出 token
    // 的 attempt 锁定,存活于步内重试。时长均为官方 decode 口径:durationMs
    // = 汇报 - 首 token(吞吐分母),ttftMs = 首 token - 启动
    this.starts = new Map()
    this.firstTokens = new Map()
    // 已补发 timing 的键:token 先发后只补一次,重复报告不重复配对
    this.timingDone = new Set()
  }

  keyOf(event) {
    const data = event.data
    if (typeof data?.turn !== 'number' || typeof data?.step !== 'number') return null
    return `${data.turn}:${data.step}`
  }

  fold(event) {
    if (event.type === 'turn/end') {
      // 一个 turn 恰好结束一次,失败轮也发,无需去重键
      return {
        time: event.time,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turn: true,
      }
    }
    if (event.type === 'step/start' || event.type === 'llm/retry-started') {
      // step/start 恰开一次模型调用,retry-started 标记每次实际启动的重试;
      // 请求只由标记计数,与 token 样本双计;时长起点不随重试重置
      const key = this.keyOf(event)
      if (event.type === 'step/start' && key !== null) this.starts.set(key, event.time)
      return {
        time: event.time,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        request: true,
      }
    }
    if (event.type === 'assistant/attempt') {
      // 首 token 锁定:仅首个产出 token 的 attempt 生效,后续 attempt 不覆盖
      const key = this.keyOf(event)
      if (key !== null && !this.firstTokens.has(key)) {
        const first = assistantStreamFirstTokenTime(event.data?.stream)
        if (typeof first === 'number') this.firstTokens.set(key, first)
      }
      return null
    }
    if (event.type === 'assistant/chunk') {
      const usage = event.data?.chunk?.type === 'usage' ? event.data.chunk.usage : undefined
      return usage ? this.replaceSample(event, usage) : null
    }
    if (event.type === 'assistant/message') {
      return event.data?.usage ? this.replaceSample(event, event.data.usage) : null
    }
    return null
  }

  replaceSample(event, usage) {
    const key = this.keyOf(event)
    const first = key !== null
      ? this.firstTokens.get(key) ?? assistantStreamFirstTokenTime(event.data?.stream)
      : assistantStreamFirstTokenTime(event.data?.stream)
    // decode 配对有效性对齐官方 usageOutputTokens 守卫:输出 token 非有效数值
    // 不建配对(官方同款),首字延迟不受 usage 影响照常采集;
    // 负差值按官方 Math.max(0) 钳 0(时钟回拨计 0 延迟样本),0 时长不附配对
    // (存储侧 0 时长配对天然惰性,防 0 分母放大)
    const decodeable = typeof usage.outputTokens === 'number'
      && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0
    const timing = typeof first === 'number'
      ? {
          durationMs: Math.max(0, event.time - first),
          ttftMs: key !== null && this.starts.has(key) ? Math.max(0, first - this.starts.get(key)) : undefined,
          decodeable,
        }
      : undefined
    const prev = key !== null ? this.seen.get(key) : undefined
    // 首样本生效:内部无条件跟踪最新报告,但交 store 的只有首次发射;
    // 首 token 时刻不在 chunk 事件上,token 先发后由后续报告补纯 timing 增量,
    // 已补发的键不重复补(timingDone 独立集合持久跟踪,防重复报告双计);
    // 补发判定先于四桶和门:usage 全零的报告仍补 timing(token 已由首发承载)
    if (prev) {
      if (timing === undefined || this.timingDone.has(key)) return null
      this.timingDone.add(key)
      return this.emitTimingOnly(usage, timing, event.time)
    }
    // 四桶全零为噪声(不占去重键),纯缓存调用(仅缓存桶非零)仍有效。
    // retry 场景 attempt 先于 chunk 落流时,chunk 首发即带 timing,分母以
    // chunk 时刻近似官方汇报时刻(毫秒级组装间隔),主路径仍由 message 补发
    const sum = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (sum <= 0) return null
    const sample = {
      time: event.time,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    }
    if (key !== null) this.seen.set(key, sample)
    return this.emitSample(sample, timing, key)
  }

  emitSample(sample, timing, key) {
    if (timing === undefined) return { ...sample }
    // decode 口径聚合对:分子 decodeTokens 与分母 durationMs 同源配对
    if (timing.decodeable && timing.durationMs > 0) {
      sample.decodeTokens = sample.outputTokens
      sample.durationMs = timing.durationMs
    }
    if (timing.ttftMs !== undefined) sample.ttftMs = timing.ttftMs
    if (key !== undefined && key !== null) this.timingDone.add(key)
    return { ...sample }
  }

  emitTimingOnly(usage, timing, time) {
    // 纯 timing 增量:token 桶全零不重复计数,decodeTokens 单独承载速度分子
    const delta = {
      time,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    if (timing.decodeable && timing.durationMs > 0) {
      delta.decodeTokens = usage.outputTokens
      delta.durationMs = timing.durationMs
    }
    if (timing.ttftMs !== undefined) delta.ttftMs = timing.ttftMs
    return delta
  }
}

function sessionIdOf(target) {
  const id = target?.id
  return typeof id === 'string' && id !== '' ? id : UNKNOWN_SESSION_ID
}

// 规范 provider/model 引用:双全拼引用,仅 model 用裸名;
// 与 client 侧注入点B turnModelOf 双实现同源(routes[].model 是裸模型名,展示侧才拼 provider),改一侧必须同步 parity
export function refOf(route) {
  if (!route) return undefined
  if (route.provider && route.model) return `${route.provider}/${route.model}`
  return route.model || undefined
}

export class UsageCollector {
  constructor(ctx, store) {
    this.ctx = ctx
    this.store = store
    // store 写合并周期落盘的失败行接入扫描异常日志,面板可观测
    store.onFlushError = (error) => {
      this.pushLog('record', error instanceof Error ? error.message : String(error))
    }
    this.folds = new Map()
    this.routes = new Map()
    this.started = false
    this.liveMarked = new Set()
    this.liveMarkBuffer = new Map()
    this.liveMarkFlushScheduled = false
    this.scanController = null
    this.resetInFlight = null
    this.#state = {
      running: false,
      total: 0,
      done: 0,
      scannedSessions: 0,
      lastSessionId: undefined,
      error: undefined,
      log: [],
      // 计数独立累加,不受日志截断影响;skipped 细分供面板归因
      skippedTotal: 0,
      recordTotal: 0,
      skipCounts: emptySkipCounts(),
    }
    // error 保留给采集器自身故障;单会话读取失败走日志 skipped 条目,计数由日志派生
  }

  #state

  status() {
    const log = [...this.#state.log]
    return {
      running: this.#state.running,
      total: this.#state.total,
      done: this.#state.done,
      scannedSessions: this.#state.scannedSessions,
      lastSessionId: this.#state.lastSessionId,
      error: this.#state.error,
      skippedSessions: this.#state.skippedTotal,
      recordFailures: this.#state.recordTotal,
      skippedBreakdown: { ...this.#state.skipCounts },
      log,
    }
  }

  // 扫描异常日志:供面板明细展示,超上限丢最旧;计数独立累加不随截断漂移
  pushLog(kind, detail) {
    const log = this.#state.log
    log.push({ time: Date.now(), kind, detail })
    if (log.length > SCAN_LOG_MAX_ENTRIES) log.splice(0, log.length - SCAN_LOG_MAX_ENTRIES)
    if (kind === 'skipped') {
      this.#state.skippedTotal += 1
      this.#state.skipCounts[classifySkip(detail)] += 1
    } else if (kind === 'record') {
      this.#state.recordTotal += 1
    }
  }

  get running() {
    return this.#state.running
  }

  // reset 引发的重扫同样 running 为 true,409 守卫据此区分两种 running
  get rebuilding() {
    return this.resetInFlight !== null
  }

  start() {
    if (this.started) return
    this.started = true
    this.ctx.on?.('session/event', (session, event) => {
      const sid = sessionIdOf(session)
      this.markLiveSession(sid, event?.seq)
      if (event.type === 'request/context') {
        if (event.data?.provider && event.data?.model) this.routes.set(sid, `${event.data.provider}/${event.data.model}`)
        else if (event.data?.model) this.routes.set(sid, event.data.model)
      }
      let fromSource
      if (event.type === 'assistant/message') {
        fromSource = refOf(event.data?.message?.source)
        if (fromSource !== undefined) this.routes.set(sid, fromSource)
      }
      const sample = this.foldFor(sid).fold(event)
      if (!sample) return
      // turn 标记落合成行不归因;其余样本先取本调用 source,再取会话路由
      if (!sample.turn) sample.model = fromSource ?? this.routeFor(sid)
      void this.store.record(sample).catch((error) => {
        this.pushLog('record', error?.message ?? String(error))
      })
    })
    // 释放销毁会话的内存桶,防长跑宿主按会话数累积
    this.ctx.on?.('session/disposed', (session) => {
      const sid = sessionIdOf(session)
      this.folds.delete(sid)
      this.routes.delete(sid)
    })
  }

  routeFor(sid) {
    const known = this.routes.get(sid)
    if (known !== undefined) return known
    // request/context 只在路由变更时落日志,先于采集器存在的会话靠
    // requestContext() 懒播种归因,否则用量全部落入 (unknown)
    const ref = refOf(this.ctx.sessions?.get?.(sid)?.requestContext?.())
    if (ref !== undefined) this.routes.set(sid, ref)
    return ref
  }

  foldFor(sid) {
    let fold = this.folds.get(sid)
    if (!fold) {
      fold = new UsageFold()
      this.folds.set(sid, fold)
    }
    return fold
  }

  // 首个被观测的实时事件写入游标边界,合批为单次 markLiveSequences;
  // -1 哨兵记录"观测到但边界未知",语义是重放零事件,宁漏不冒双计
  markLiveSession(sid, firstSeq) {
    if (sid === UNKNOWN_SESSION_ID || this.liveMarked.has(sid)) return
    this.liveMarked.add(sid)
    this.liveMarkBuffer.set(sid, typeof firstSeq === 'number' ? firstSeq : SEQ_UNKNOWN)
    if (this.liveMarkFlushScheduled) return
    this.liveMarkFlushScheduled = true
    queueMicrotask(() => {
      this.liveMarkFlushScheduled = false
      const batch = [...this.liveMarkBuffer.entries()]
      this.liveMarkBuffer.clear()
      if (batch.length > 0) {
        void this.store.markLiveSequences(batch).catch((error) => {
          this.pushLog('record', error?.message ?? String(error))
        })
      }
    })
  }

  // 单控制器槽:boot 回扫、reset 重扫共用,新扫描先中止旧扫描
  async rescan() {
    this.scanController?.abort()
    const controller = new AbortController()
    this.scanController = controller
    await this.store.readyPromise()
    // 适配发生在宿主服务边界:回扫主体只面向 ArchiveReader 内部契约
    const reader = createArchiveReader(this.ctx.sessionPersistence)
    await this.backfill(reader, this.ctx.sessions, controller.signal)
  }

  abort() {
    this.scanController?.abort()
  }

  // wipe 时刻为每个活跃会话取日志长度作重放上界:回扫恰好重建 [0,watermark)
  // 一次,watermark 起的事件仍归在跑的实时路径;seq 读不出沿用旧游标边界,
  // 无则 -1 哨兵。死会话不进边界,全量重放即精确。并发调用合并为一次重建
  resetAndRescan() {
    if (this.resetInFlight) return this.resetInFlight
    this.resetInFlight = (async () => {
      const previous = await this.store.liveSequences()
      const boundaries = new Map()
      for (const handle of this.ctx.sessions.list()) {
        const seq = handle.seq
        if (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0) {
          boundaries.set(handle.id, seq)
          continue
        }
        const old = previous.get(handle.id)
        boundaries.set(handle.id, typeof old === 'number' ? old : SEQ_UNKNOWN)
      }
      await this.store.reset(boundaries)
      await this.rescan()
    })().finally(() => {
      this.resetInFlight = null
    })
    return this.resetInFlight
  }

  // 回扫:ArchiveReader 契约驱动(宿主 persistence 多版本适配见 archive-reader),
  // 逐会话全新 fold 重放;seen 独自决定是否重扫,liveFirstSeq 边界划走实时
  // 已拥区间,liveness 复查防陈旧快照放大重放范围,inheritedCut 跳过 fork
  // 继承前缀。只有干净重放完的会话进游标,失败下轮重试
  async backfill(reader, sessions, signal) {
    if (this.#state.running) return
    if (signal?.aborted) return
    this.#state.running = true
    this.#state.error = undefined
    try {
      const headers = await reader.list(signal).catch((error) => {
        // 枚举失败(含宿主 API 未识别)按采集器自身故障呈现,面板可见
        this.#state.error = error instanceof Error ? error.message : String(error)
        throw error
      })
      const seen = await this.store.seenSessions()
      const liveSeq = await this.store.liveSequences()
      const targets = headers.filter((header) => !seen.has(header.id))
      this.#state.total = targets.length
      this.#state.done = 0
      this.#state.log = []
      this.#state.skippedTotal = 0
      this.#state.recordTotal = 0
      this.#state.skipCounts = emptySkipCounts()
      const workerCount = Math.min(DEFAULT_BACKFILL_CONCURRENCY, Math.max(1, targets.length))
      let next = 0
      const completed = []
      const flushCompleted = async () => {
        if (completed.length === 0) return
        const batch = completed.splice(0, completed.length)
        await this.store.markSeenSessions(batch)
      }
      const worker = async () => {
        for (;;) {
          if (signal?.aborted) return
          const i = next++
          if (i >= targets.length) return
          const header = targets[i]
          this.#state.lastSessionId = header.id
          const boundary = liveSeq.get(header.id)
          // 活跃会话仅在有有效边界时安全重放前缀;无边界或 -1 哨兵说明
          // 事件归本 boot 实时路径,或会话 mid-scan 恢复、边界在快照后写入
          const isLiveNow = sessions.list().some((item) => item.id === header.id)
          if (isLiveNow && (boundary === undefined || boundary < 0)) {
            this.#state.done += 1
            continue
          }
          const fromScratch = boundary === undefined
          const replayNothing = !fromScratch && boundary < 0
          const skipLiveOwned = (event) => {
            if (replayNothing) return true
            if (fromScratch) return false
            return typeof event.seq === 'number' && event.seq >= boundary
          }
          // 每会话全新 fold:(turn,step) 键按会话隔离,并发重放不共享
          const fold = new UsageFold()
          let route = ''
          try {
            const inspection = await reader.readLog(header.id, signal)
            const inheritedCut = inspection.inheritedEventCount
            for (const event of inspection.events) {
              if (signal?.aborted) return
              if (skipLiveOwned(event)) continue
              if (inheritedCut > 0 && typeof event.seq === 'number' && event.seq < inheritedCut) continue
              // 继承前缀整体跳过含路由播种:子会话路由在首次变更时重新宣告
              if (event.type === 'request/context') {
                if (event.data?.provider && event.data?.model) route = `${event.data.provider}/${event.data.model}`
                else if (event.data?.model) route = event.data.model
              } else if (event.type === 'assistant/message') {
                const ref = refOf(event.data?.message?.source)
                if (ref !== undefined) route = ref
              }
              const sample = fold.fold(event)
              if (sample) {
                if (!sample.turn) sample.model = route || undefined
                await this.store.record(sample)
              }
            }
            completed.push(header.id)
            if (completed.length >= MARK_BATCH) await flushCompleted()
            this.#state.scannedSessions += 1
          } catch (error) {
            // 读取失败(如宿主报会话日志损坏)按定案跳过:记日志并继续,不中断回扫、不挂错误横幅
            this.pushLog('skipped', error?.message ? `${header.id} ${error.message}` : header.id)
          } finally {
            this.#state.done += 1
          }
        }
      }
      await Promise.all(Array.from({ length: workerCount }, () => worker()))
      await flushCompleted()
    } finally {
      this.#state.running = false
    }
  }
}
