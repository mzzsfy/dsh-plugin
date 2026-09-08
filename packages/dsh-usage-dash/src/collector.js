// 采集器:session/event 实时折叠与持久化日志回扫,产出 {time,...} 采集样本交
// store.record 落三粒度。事件判定表、(session,turn,step) 首样本生效、归因链
// message.source > 观测路由 > requestContext 懒播种,均与原插件同构;单次
// 事件 pass 内的去重由 per-session fold 保证,跨 boot/回扫的不重复由持久
// 游标(liveFirstSeq 分区 + backfilledSessions)保证。采集是观测性的:一切
// store 失败计入 recordFailures,绝不成为逃逸拒绝。

const UNKNOWN_SESSION_ID = '(unknown-session)'
const SEQ_UNKNOWN = -1
const DEFAULT_BACKFILL_CONCURRENCY = 4
const MARK_BATCH = 32
const SCAN_LOG_MAX_ENTRIES = 200

// 会话内单 pass 折叠:跟踪每个 (turn,step) 槽的最新报告,只把首次发射交 store
export class UsageFold {
  constructor() {
    this.seen = new Map()
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
      // 请求只由标记计数,与 token 样本双计
      return {
        time: event.time,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        request: true,
      }
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
    // 四桶全零为噪声;纯缓存调用(仅缓存桶非零)仍有效
    const sum = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (sum <= 0) return null
    const key = this.keyOf(event)
    const sample = {
      time: event.time,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    }
    if (key === null) return sample
    const prev = this.seen.get(key)
    this.seen.set(key, sample)
    // 首样本生效:内部无条件跟踪最新报告,但交 store 的只有首次发射的独立拷贝
    return prev ? null : { ...sample }
  }
}

function sessionIdOf(target) {
  const id = target?.id
  return typeof id === 'string' && id !== '' ? id : UNKNOWN_SESSION_ID
}

// 规范 provider/model 引用:双全拼引用,仅 model 用裸名
function refOf(route) {
  if (!route) return undefined
  if (route.provider && route.model) return `${route.provider}/${route.model}`
  return route.model || undefined
}

export class UsageCollector {
  constructor(ctx, store) {
    this.ctx = ctx
    this.store = store
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
      skippedSessions: log.filter((entry) => entry.kind === 'skipped').length,
      recordFailures: log.filter((entry) => entry.kind === 'record').length,
      log,
    }
  }

  // 扫描异常日志:供面板明细展示,超上限丢最旧
  pushLog(kind, detail) {
    const log = this.#state.log
    log.push({ time: Date.now(), kind, detail })
    if (log.length > SCAN_LOG_MAX_ENTRIES) log.splice(0, log.length - SCAN_LOG_MAX_ENTRIES)
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
    await this.backfill(this.ctx.sessionPersistence, this.ctx.sessions, controller.signal)
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

  // 回扫:persistence.list 驱动,逐会话全新 fold 重放;seen 独自决定是否重扫,
  // liveFirstSeq 边界划走实时已拥区间,liveness 复查防陈旧快照放大重放范围,
  // inheritedCut 跳过 fork 继承前缀。只有干净重放完的会话进游标,失败下轮重试
  async backfill(persistence, sessions, signal) {
    if (this.#state.running) return
    if (signal?.aborted) return
    this.#state.running = true
    this.#state.error = undefined
    try {
      const headers = await persistence.list(signal)
      const seen = await this.store.seenSessions()
      const liveSeq = await this.store.liveSequences()
      const targets = headers.filter((header) => !seen.has(header.id))
      this.#state.total = targets.length
      this.#state.done = 0
      this.#state.log = []
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
            const inspection = await persistence.inspect(header.id, signal)
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
