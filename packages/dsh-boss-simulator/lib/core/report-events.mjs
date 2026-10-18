import { applySessionEvent, parseRunReport } from './orchestrator.mjs'
import { submitReport } from './task.mjs'

export function createRunReportCollector({ taskId, sessionId, store, onRejected = () => {} }) {
  const requests = new Map()
  const assistants = new Map()
  const endings = new Map()
  const starts = new Map()
  const startEvents = new Map()
  const completedTurns = new Set()
  const rejectedTurns = new Set()

  function clearTurn(turn) {
    requests.delete(turn)
    assistants.delete(turn)
    endings.delete(turn)
    starts.delete(turn)
  }

  async function reconcile(turn) {
    if (!requests.has(turn) || !assistants.has(turn) || !endings.has(turn)) return
    const requestId = requests.get(turn)
    const assistantEvent = assistants.get(turn)
    const end = endings.get(turn)

    if (end.reason?.kind !== 'completed' || assistantEvent.data?.interrupted === true) {
      clearTurn(turn)
      return
    }
    const aggregate = await store.loadAggregate(taskId)
    const matches = Object.values(aggregate?.runs ?? {}).filter((candidate) => candidate.sessionId === sessionId && candidate.requestId === requestId && !['settled', 'rejected'].includes(candidate.state))
    if (matches.length !== 1) return
    const run = matches[0]
    async function diagnose(kind, message) {
      await store.updateAggregate(taskId, current => {
        const active = current.runs[run.runId]
        return { ...current, runs: { ...current.runs, [run.runId]: { ...active, reportDiagnostic: { kind, message, eventSeq: assistantEvent.seq, turn } } } }
      })
      onRejected(run, message)
    }
    const parsed = parseRunReport(assistantEvent.data?.message?.content, run)
    if (!parsed.ok) {
      if (!rejectedTurns.has(turn)) {
        await diagnose('invalid_report', parsed.message)
        rejectedTurns.add(turn)
      }
      return
    }

    if (completedTurns.has(turn)) return
    const reportId = `${sessionId}:${assistantEvent.seq}`
    let submitFailure = null
    const updated = await store.updateAggregate(taskId, (current) => {
      const currentRun = current?.runs?.[run.runId]
      if (!currentRun || currentRun.sessionId !== sessionId || currentRun.requestId !== requestId || ['settled', 'rejected'].includes(currentRun.state)) return current
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
      completedTurns.add(turn)
      clearTurn(turn)
      return
    }
    if (submitFailure) {
      await diagnose('report_rejected', submitFailure)
      return
    }
    clearTurn(turn)
  }

  async function accept(event) {
    const turn = event.type === 'user/message'
      ? [...startEvents.values()].filter(start => start.seq < event.seq).sort((a, b) => b.seq - a.seq)[0]?.data.turn
      : event.data?.turn
    if (!Number.isSafeInteger(turn)) return
    if (event.type === 'turn/start') {
      startEvents.set(turn, event)
      starts.set(turn, event.time)
      const requestId = requests.get(turn)
      if (!requestId) return
      return store.updateAggregate(taskId, (current) => {
        const run = Object.values(current?.runs ?? {}).find((candidate) => candidate.sessionId === sessionId && candidate.requestId === requestId)
        if (!run || !['submitted', 'running'].includes(run.state)) return current
        if (run.startedAt === event.time) return current
        if (run.state === 'submitted') {
          const started = applySessionEvent(current, { runId: run.runId, type: 'turn.start', at: event.time })
          return started.ok ? started.aggregate : current
        }
        return { ...current, runs: { ...current.runs, [run.runId]: { ...run, startedAt: event.time } } }
      })
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind !== 'user' || typeof source.rpcId !== 'string') return
      requests.set(turn, source.rpcId)
      const aggregate = await store.loadAggregate(taskId)
      const run = Object.values(aggregate?.runs ?? {}).find((candidate) => candidate.sessionId === sessionId && candidate.requestId === source.rpcId && candidate.state === 'submitted')
      if (run) {
        const startAt = starts.get(turn) ?? event.time
        await store.updateAggregate(taskId, (current) => {
          const currentRun = current?.runs?.[run.runId]
          if (!currentRun || currentRun.sessionId !== sessionId || currentRun.requestId !== source.rpcId || !['submitted', 'running'].includes(currentRun.state) || currentRun.startedAt === startAt) return current
          if (currentRun.state === 'running') return { ...current, runs: { ...current.runs, [run.runId]: { ...currentRun, startedAt: startAt } } }
          const started = applySessionEvent(current, { runId: run.runId, type: 'turn.start', at: startAt })
          return started.ok ? started.aggregate : current
        })
      }
      return reconcile(turn)
    }
    if (event.type === 'assistant/message') {
      if ((assistants.get(turn)?.seq ?? -1) < event.seq) assistants.set(turn, event)
      return reconcile(turn)
    }
    if (event.type === 'turn/end') {
      endings.set(turn, { time: event.time, reason: event.data?.reason })
      return reconcile(turn)
    }
  }

  return { accept }
}
