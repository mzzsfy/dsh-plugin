import { applySessionEvent, parseRunReport } from './orchestrator.mjs'
import { ACTIVE_RUN_STATES, RUN_STALE_MS, submitReport } from './task.mjs'
import { mergeRunUsage, noteRunUsage } from './usage.mjs'

// 宿主 assistant/message 步骤级用量 → 台账条目;缺 usage 记 null 让 coverage 落到 partial
function observedUsageOf(event) {
  const usage = event.data?.usage
  if (!usage) return null
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    model: event.data?.message?.source?.model ?? null,
  }
}

// 心跳落盘最小间隔:失联阈值的一个小份额。任何本回合的 durable 事件都算活体证据,
// 但每个事件都写一次持久层没有必要——只要远小于 RUN_STALE_MS 就不会被误判失联。
export const HEARTBEAT_MIN_WRITE_MS = Math.floor(RUN_STALE_MS / 5)
// turn/start 只用于把无 turn 的 user/message 归属到回合:最近若干条足够,不留无界历史
const START_EVENTS_KEEP = 8
// 迟到报告可归属的终态:settled 已结算(重放),interrupted 是失联/强制收敛(报告可能只是晚到)
const REPORTABLE_TERMINAL_STATES = new Set(['settled', 'interrupted'])

export function createRunReportCollector({ taskId, sessionId, store, onRejected = () => {}, onError = () => {} }) {
  const requests = new Map()
  const assistants = new Map()
  const endings = new Map()
  const starts = new Map()
  const startEvents = new Map()
  // 活体时间双账:observed = 内存最新事件时间(每个 durable 事件都推进,不节流);
  // flushed = 最近一次落盘/已排定的时间,只作节流基准。节流只推迟落盘,绝不丢事件时间
  // (否则长工具调用期间没有写盘时,15 分钟失联阈值会按旧时间把在飞 Run 误杀)。
  const observedAt = new Map()
  const flushedAt = new Map()
  const flushTimers = new Map()
  let disposed = false

  async function writeHeartbeat(runId, at) {
    flushedAt.set(runId, at)
    try {
      await store.updateAggregate(taskId, (latest) => {
        const target = latest?.runs?.[runId]
        if (!target || !ACTIVE_RUN_STATES.has(target.state) || (target.lastEventAt ?? -Infinity) >= at) return latest
        return { ...latest, runs: { ...latest.runs, [runId]: { ...target, lastEventAt: at } } }
      })
    } catch (error) {
      // 后台补写没有调用方接错误:告警后可读,下一次事件/补写会重试,不阻断事件处理
      onError(`[boss-simulator] 心跳落盘失败(${runId}): ${String(error?.message ?? error).slice(0, 160)}`)
    }
  }

  function scheduleFlush(runId, delayMs) {
    if (disposed || flushTimers.has(runId)) return
    const timer = setTimeout(() => {
      flushTimers.delete(runId)
      const at = observedAt.get(runId)
      if (Number.isFinite(at)) writeHeartbeat(runId, at)
    }, Math.max(0, delayMs))
    timer.unref?.()
    flushTimers.set(runId, timer)
  }

  function cancelFlush(runId) {
    const timer = flushTimers.get(runId)
    if (timer) clearTimeout(timer)
    flushTimers.delete(runId)
  }

  // 跟随结束(会话无在飞 Run / 断线放弃)即停补写:定时器不跨跟随存活,不写已终态 Run
  function dispose() {
    disposed = true
    for (const timer of flushTimers.values()) clearTimeout(timer)
    flushTimers.clear()
  }

  function clearTurn(turn) {
    requests.delete(turn)
    assistants.delete(turn)
    endings.delete(turn)
    starts.delete(turn)
  }

  function runOf(aggregate, runId) {
    const run = aggregate?.runs?.[runId]
    return run && run.sessionId === sessionId ? run : undefined
  }

  // 迟到报告可采纳判据:失联收敛(非用户停止)、任务仍 active、定义与执行代次未变。
  // 满足时只标记 adoptable 供人工/后续版本采纳;不自动复活已收敛的 Run(防停止后被迟到事件复活)。
  function adoptableOf(aggregate, run) {
    if (run.state !== 'interrupted' || run.stopObserved !== 'unreachable') return false
    const control = aggregate?.control ?? {}
    if (control.state !== 'active') return false
    if (run.definitionRevision !== aggregate.definitionRevision) return false
    return run.executionEpoch === control.executionEpoch
  }

  // 迟到报告出口:Run 已终态时不静默丢弃,落 reportDiagnostic(可采纳的附解析后报告)
  async function noteLateReport(turn, run, assistantEvent, end) {
    if (!REPORTABLE_TERMINAL_STATES.has(run.state)) { clearTurn(turn); return }
    const reportId = `${sessionId}:${assistantEvent.seq}`
    const aggregate = await store.loadAggregate(taskId)
    if (aggregate?.reports?.[reportId]) { clearTurn(turn); return }
    const parsed = parseRunReport(assistantEvent.data?.message?.content, run)
    const message = parsed.ok
      ? `迟到的执行报告:Run 已收敛(${run.state}),报告未自动采纳`
      : `迟到的执行报告无法解析:Run 已收敛(${run.state});${parsed.message}`
    const diagnostic = {
      kind: 'late_report',
      message,
      eventSeq: assistantEvent.seq,
      turn,
      at: end.time,
      reportId,
      adoptable: parsed.ok && adoptableOf(aggregate, run),
      ...(parsed.ok ? { report: parsed.report } : {}),
    }
    const updated = await store.updateAggregate(taskId, (current) => {
      const target = current?.runs?.[run.runId]
      if (!target || ACTIVE_RUN_STATES.has(target.state)) return current
      const existing = target.reportDiagnostic
      if (existing?.kind === 'late_report' && existing.eventSeq === assistantEvent.seq) return current
      return { ...current, runs: { ...current.runs, [run.runId]: { ...target, reportDiagnostic: diagnostic } } }
    })
    if (updated?.runs?.[run.runId]?.reportDiagnostic?.eventSeq === assistantEvent.seq) onRejected(run, message)
    clearTurn(turn)
  }

  async function reconcile(turn) {
    const runId = requests.get(turn)
    if (runId === undefined || !assistants.has(turn) || !endings.has(turn)) return
    const assistantEvent = assistants.get(turn)
    const end = endings.get(turn)

    if (end.reason?.kind !== 'completed' || assistantEvent.data?.interrupted === true) {
      clearTurn(turn)
      return
    }
    const aggregate = await store.loadAggregate(taskId)
    const run = runOf(aggregate, runId)
    if (!run) { clearTurn(turn); return }
    if (!ACTIVE_RUN_STATES.has(run.state)) {
      await noteLateReport(turn, run, assistantEvent, end)
      return
    }
    async function diagnose(kind, message) {
      await store.updateAggregate(taskId, current => {
        const target = current.runs[run.runId]
        // 同一事件的诊断只落一次:事件重放不重复刷写,落盘失败后重放仍会补写
        if (target.reportDiagnostic?.kind === kind && target.reportDiagnostic?.eventSeq === assistantEvent.seq) return current
        return { ...current, runs: { ...current.runs, [run.runId]: { ...target, reportDiagnostic: { kind, message, eventSeq: assistantEvent.seq, turn } } } }
      })
      onRejected(run, message)
    }
    const parsed = parseRunReport(assistantEvent.data?.message?.content, run)
    if (!parsed.ok) {
      await diagnose('invalid_report', parsed.message)
      return
    }

    const reportId = `${sessionId}:${assistantEvent.seq}`
    let submitFailure = null
    const updated = await store.updateAggregate(taskId, (current) => {
      const currentRun = current?.runs?.[run.runId]
      if (!currentRun || currentRun.sessionId !== sessionId || !ACTIVE_RUN_STATES.has(currentRun.state)) return current
      let next = current
      const startAt = starts.get(turn) ?? currentRun.startedAt
      if (startAt !== undefined) {
        const started = applySessionEvent(next, { runId: run.runId, type: 'turn.start', at: startAt })
        if (!started.ok) return current
        next = started.aggregate
      }
      const ended = applySessionEvent(next, { runId: run.runId, type: 'turn.end', at: end.time })
      if (!ended.ok) return current
      const submitted = submitReport(ended.aggregate, { ...parsed.report, reportId, runId: run.runId, sessionId, eventSeq: assistantEvent.seq })
      if (!submitted.ok) {
        submitFailure = submitted.message
        return current
      }
      return submitted.result.aggregate
    })
    if (updated?.reports?.[reportId]) {
      clearTurn(turn)
      return
    }
    if (submitFailure) {
      await diagnose('report_rejected', submitFailure)
      return
    }
    clearTurn(turn)
  }

  // 跟随期逐调用记账:用法与报告同为 durable 事实。终态 Run 的迟到用量同样真实发生,
  // 直接并入台账(同 invocationKey 幂等),不因状态变化静默丢弃。
  async function noteUsage(turn, event) {
    const runId = requests.get(turn)
    if (runId === undefined) return
    const invocationKey = `${sessionId}:${event.seq}`
    // 先读后写:run 不存在时零写
    const current = await store.loadAggregate(taskId)
    const run = runOf(current, runId)
    if (!run) return
    await store.updateAggregate(taskId, (latest) => {
      const target = latest?.runs?.[run.runId]
      if (!target) return latest
      const usage = observedUsageOf(event)
      if (!ACTIVE_RUN_STATES.has(target.state)) {
        const merged = mergeRunUsage(latest, { runId: run.runId, usage: usage === null ? null : { ...usage, invocationKey } })
        if (merged.ok) return merged.result.aggregate
        return { ...latest, runs: { ...latest.runs, [run.runId]: { ...target, usageDiagnostic: { code: merged.code, message: merged.message, invocationKey } } } }
      }
      const noted = noteRunUsage(latest, { runId: run.runId, invocationKey, usage })
      const next = noted.ok ? noted.result.aggregate : latest
      if (!Number.isFinite(event.time) || (next.runs[run.runId].lastEventAt ?? -Infinity) >= event.time) return next
      return { ...next, runs: { ...next.runs, [run.runId]: { ...next.runs[run.runId], lastEventAt: event.time } } }
    })
  }

  // 心跳:本回合任一 durable 事件(tool/用户消息/重复 turn/start/报告/结束)都推进
  // 内存活体时间;落盘按 HEARTBEAT_MIN_WRITE_MS 节流,窗口结束补写最新观测值。
  // 只认 assistant 消息会让长时间工具调用被失联阈值误杀。
  async function heartbeat(turn, at) {
    const runId = requests.get(turn)
    if (runId === undefined || !Number.isFinite(at)) return
    const current = await store.loadAggregate(taskId)
    const run = runOf(current, runId)
    if (!run || !ACTIVE_RUN_STATES.has(run.state)) return
    const known = Math.max(run.lastEventAt ?? -Infinity, observedAt.get(runId) ?? -Infinity)
    if (known >= at) return
    observedAt.set(runId, at)
    const lastFlushed = flushedAt.get(runId) ?? run.lastEventAt
    const sinceFlush = lastFlushed === undefined ? Infinity : at - lastFlushed
    if (sinceFlush < HEARTBEAT_MIN_WRITE_MS) {
      scheduleFlush(runId, HEARTBEAT_MIN_WRITE_MS - sinceFlush)
      return
    }
    cancelFlush(runId)
    await writeHeartbeat(runId, at)
  }

  function rememberStart(turn, event) {
    startEvents.set(turn, event)
    while (startEvents.size > START_EVENTS_KEEP) startEvents.delete(startEvents.keys().next().value)
  }

  async function handle(event, turn) {
    if (event.type === 'turn/start') {
      rememberStart(turn, event)
      starts.set(turn, event.time)
      const runId = requests.get(turn)
      if (runId === undefined) return
      return store.updateAggregate(taskId, (current) => {
        const run = runOf(current, runId)
        if (!run || !['submitted', 'running'].includes(run.state)) return current
        // 重复 turn/start(宿主重放或多回合同 Run)也刷新活体时间
        if (run.startedAt === event.time && (run.lastEventAt ?? -Infinity) >= event.time) return current
        if (run.state === 'submitted') {
          const started = applySessionEvent(current, { runId: run.runId, type: 'turn.start', at: event.time })
          return started.ok ? started.aggregate : current
        }
        return { ...current, runs: { ...current.runs, [run.runId]: { ...run, startedAt: event.time, lastEventAt: Math.max(run.lastEventAt ?? -Infinity, event.time) } } }
      })
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind !== 'user' || typeof source.rpcId !== 'string') return
      // 回合绑定按 runId 落账且只绑一次:同 turn 的 steer 消息带新的 rpcId,匹配不到任何 Run,
      // 若覆盖绑定会让本回合的报告/用量/心跳全部断链。
      const aggregate = await store.loadAggregate(taskId)
      const candidate = Object.values(aggregate?.runs ?? {}).find((run) => run.sessionId === sessionId && run.requestId === source.rpcId)
      if (candidate && !requests.has(turn)) requests.set(turn, candidate.runId)
      const runId = requests.get(turn)
      // 非本 Run 的派发提示(steer)不推进本回合的起始时间
      if (runId === undefined || candidate?.runId !== runId) return reconcile(turn)
      const run = candidate
      const startAt = starts.get(turn) ?? event.time
      await store.updateAggregate(taskId, (current) => {
        const currentRun = current?.runs?.[run.runId]
        if (!currentRun || currentRun.sessionId !== sessionId || !['submitted', 'running'].includes(currentRun.state) || currentRun.startedAt === startAt) return current
        if (currentRun.state === 'running') return { ...current, runs: { ...current.runs, [run.runId]: { ...currentRun, startedAt: startAt, lastEventAt: event.time } } }
        const started = applySessionEvent(current, { runId: run.runId, type: 'turn.start', at: startAt })
        return started.ok ? started.aggregate : current
      })
      return reconcile(turn)
    }
    if (event.type === 'assistant/message') {
      if ((assistants.get(turn)?.seq ?? -1) < event.seq) assistants.set(turn, event)
      await noteUsage(turn, event)
      return reconcile(turn)
    }
    if (event.type === 'turn/end') {
      endings.set(turn, { time: event.time, reason: event.data?.reason })
      // 非 completed 回合不会产出报告:立即回收回合内中间态,防长会话累积
      if (event.data?.reason?.kind !== 'completed') clearTurn(turn)
      return reconcile(turn)
    }
  }

  async function accept(event) {
    const turn = event.type === 'user/message'
      ? [...startEvents.values()].filter(start => start.seq < event.seq).sort((a, b) => b.seq - a.seq)[0]?.data.turn
      : event.data?.turn
    if (!Number.isSafeInteger(turn)) return
    const result = await handle(event, turn)
    await heartbeat(turn, event.time)
    return result
  }

  function lastObservedAt(runId) {
    return observedAt.get(runId)
  }

  return { accept, dispose, lastObservedAt }
}
