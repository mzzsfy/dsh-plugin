/**
 * 恢复引擎:消费会话事件,在需要续跑时按宿主节奏补一条用户消息。
 *
 * 判定与发送分离:decide 只读事件给出结论,schedule 管节奏,fire 才落地。
 * 状态按会话驻留内存,进程重启清零(重启恢复由 scan.mjs 另行负责)。
 */

import {
  closureVerdict,
  hasVisibleOutput,
  isMaintenanceTurnStart,
  turnInitiator,
  turnSlice,
  userTookOver,
} from './closure.mjs'
import { cooldownFor, fillTemplate } from './config.mjs'
import { isTransientFailure, parseFailureFacts } from './failure.mjs'
import { isDerivedSessionHeader } from './session-kind.mjs'

/** 宿主重启产生的取消原因;只有这些值得在重启后补一次。 */
const RESTART_CANCEL_CAUSES = new Set(['disposed', 'legacy'])

/** 自己发出的消息 id 只保留近期,避免长期驻留。 */
const SENT_ID_MEMORY = 50

const isSubagent = (session) => isDerivedSessionHeader(session?.header)

function snapshotEvents(session) {
  const read = session?.snapshotEvents
  if (typeof read === 'function') return read.call(session)
  return Array.isArray(session?.events) ? session.events : []
}

export function createEngine({
  ctx,
  config,
  createUserMessage,
  timers = globalThis,
  now = Date.now,
  probe,
}) {
  const states = new Map()
  let disposed = false
  let unregister

  const stateOf = (sessionId) => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = {
        consecutive: 0,
        lastAttemptAt: 0,
        pendingTimer: undefined,
        pending: undefined,
        sentIds: new Set(),
        maintenanceTurn: undefined,
      }
      states.set(sessionId, state)
    }
    return state
  }

  const log = (message) => ctx.logger?.info?.(`[keep-working] ${message}`)

  function cancelPending(state, why) {
    if (state.pendingTimer === undefined) return
    timers.clearTimeout(state.pendingTimer)
    state.pendingTimer = undefined
    state.pending = undefined
    log(`取消待发送(${why})`)
  }

  function rememberSent(state, messageId) {
    state.sentIds.add(messageId)
    if (state.sentIds.size <= SENT_ID_MEMORY) return
    const oldest = state.sentIds.values().next().value
    state.sentIds.delete(oldest)
  }

  /** 按 turn/end 的原因给出动作;undefined 表示不恢复。 */
  function decide(session, event, state) {
    const turn = event.data?.turn
    const reason = event.data?.reason ?? {}
    const events = snapshotEvents(session)

    switch (reason.kind) {
      case 'completed': {
        if (closureVerdict(events, turn).closed) return undefined
        if (!hasVisibleOutput(turnSlice(events, turn)) && config.resumeSilentTurns) {
          return { reason: 'silent', text: config.continueTextSilent }
        }
        if (userTookOver(events, turn, state.sentIds)) return undefined
        if (turnInitiator(events, turn) !== 'user') return undefined
        return { reason: 'closure', text: config.closureText }
      }
      case 'error': {
        const failure = parseFailureFacts(reason.error)
        if (failure === undefined) return undefined
        if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) {
          log(`跳过永久错误 ${failure.code}: ${failure.message}`)
          return undefined
        }
        return {
          reason: 'error',
          text: fillTemplate(config.continueText, {
            code: failure.code,
            message: failure.message,
            status: failure.status,
          }),
        }
      }
      case 'max-tokens':
        return { reason: 'max-tokens', text: config.continueTextMaxTokens }
      case 'interrupted':
        return { reason: 'interrupted', text: config.continueTextInterrupted }
      case 'aborted': {
        if (!RESTART_CANCEL_CAUSES.has(reason.reason?.kind)) return undefined
        return { reason: 'interrupted', text: config.continueTextInterrupted }
      }
      default:
        return undefined
    }
  }

  function fire(session, state, decision) {
    if (disposed || config.paused) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) {
      log(`${session.id}: 无 live agent,放弃本次恢复`)
      return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: decision.text }],
      source: { kind: 'user' },
    })
    try {
      agent.followup(message)
    } catch (error) {
      log(`${session.id}: 投递失败 ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    rememberSent(state, message.id)
    state.lastAttemptAt = now()
    state.consecutive += 1
    log(`${session.id}: 已发送恢复消息(${decision.reason},连续 ${state.consecutive})`)
  }

  /** 离线时挂起,联网后自会重试;探测失败按在线处理,避免永久卡住。 */
  function settle(session, state, decision) {
    if (!config.pauseWhenOffline || probe === undefined) {
      fire(session, state, decision)
      return
    }
    probe().then(
      (online) => {
        if (disposed || config.paused) return
        if (online) {
          fire(session, state, decision)
          return
        }
        state.pendingTimer = timers.setTimeout(() => {
          state.pendingTimer = undefined
          settle(session, state, decision)
        }, config.offlineCheckMs)
      },
      () => fire(session, state, decision),
    )
  }

  function schedule(session, state, decision) {
    if (disposed || config.paused) return
    if (isSubagent(session)) return
    if (state.pendingTimer !== undefined) return
    if (state.consecutive >= config.maxConsecutive) {
      log(`${session.id}: 已达连续上限 ${config.maxConsecutive},等待用户介入`)
      return
    }
    const cooldown = cooldownFor(config, state.consecutive)
    const delay = Math.max(config.graceMs, cooldown - (now() - state.lastAttemptAt))
    state.pending = decision
    state.pendingTimer = timers.setTimeout(() => {
      state.pendingTimer = undefined
      state.pending = undefined
      settle(session, state, decision)
    }, delay)
  }

  function onSessionEvent(session, event) {
    if (disposed) return
    const state = stateOf(session.id)
    switch (event.type) {
      case 'turn/start':
        state.maintenanceTurn = isMaintenanceTurnStart(event) ? event.data?.turn : undefined
        cancelPending(state, '新回合开始')
        return
      case 'turn/end':
        return handleTurnEnd(session, state, event)
      default:
        return
    }
  }

  function handleTurnEnd(session, state, event) {
    const turn = event.data?.turn
    const maintenance = state.maintenanceTurn === turn
    state.maintenanceTurn = undefined
    cancelPending(state, '回合结束')
    if (maintenance) {
      log(`${session.id}: 维护回合不恢复`)
      return
    }
    const decision = decide(session, event, state)
    if (decision !== undefined) schedule(session, state, decision)
  }

  function attach() {
    if (unregister !== undefined) return unregister
    unregister = ctx.on('session/event', onSessionEvent)
    return unregister
  }

  function dispose() {
    disposed = true
    for (const state of states.values()) cancelPending(state, '插件卸载')
    states.clear()
    unregister?.()
    unregister = undefined
  }

  return { attach, dispose, onSessionEvent }
}
