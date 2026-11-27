/**
 * 恢复引擎:消费会话事件,在需要续跑时按宿主节奏补一条用户消息。
 *
 * 判定与发送分离:decide 只读事件给出结论,schedule 管节奏,fire 才落地。
 * 状态按会话驻留内存,进程重启清零(重启恢复由 scan.mjs 另行负责)。
 */

import {
  closureVerdict,
  humanInitiatedTurn,
  tailAssistantText,
  turnInitiator,
} from './closure.mjs'
import { cooldownFor, fillTemplate } from './config.mjs'
import { isTransientFailure, parseFailureFacts } from './failure.mjs'
import { REJECTED_BLOCK_CODE, rearmGoal } from './goal.mjs'
import { pendingInbox, QUEUED_RESUME_TEXT } from './inbox.mjs'
import { isDerivedSessionHeader } from './session-kind.mjs'

/** 宿主重启产生的取消原因;只有这些值得在重启后补一次。 */
const RESTART_CANCEL_CAUSES = new Set(['disposed', 'legacy'])

/**
 * 会停住 agent 的回合终态。
 *
 * 宿主的错误回合在 `turn()` 里抛出,不会再进下一回合,durable inbox 里排队的输入
 * 因此没人消费;这些终态的实时判定必须自己插队唤醒。
 */
const QUEUE_RECOVERY_KINDS = new Set(['error', 'max-tokens', 'interrupted', 'blocked'])

/** 自己发出的消息 id 只保留近期,避免长期驻留。 */
const SENT_ID_MEMORY = 50

/** 内存状态按会话驻留;只保留近期活跃的会话,闲置状态回收。 */
export const MAX_SESSION_STATES = 256

const isSubagent = (session) => isDerivedSessionHeader(session?.header)

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
        lastGoalResumeAt: 0,
        goalRetryTimer: undefined,
        pendingTimer: undefined,
        pending: undefined,
        sentIds: new Set(),
        // 回合事件代际:异步观察返回后据此丢弃过期判定
        version: 0,
        // 在途观察计数:回收闲置状态时不得删掉正在判定的会话
        busy: 0,
      }
      states.set(sessionId, state)
      pruneStates()
    }
    return state
  }

  // 闲置状态回收:有 pending/pendingTimer/在途观察的会话保留,避免把在途恢复清掉
  const pruneStates = () => {
    if (states.size <= MAX_SESSION_STATES) return
    for (const [sessionId, state] of states) {
      if (states.size <= MAX_SESSION_STATES) break
      if (state.pending !== undefined || state.pendingTimer !== undefined || state.goalRetryTimer !== undefined || state.busy > 0) continue
      states.delete(sessionId)
    }
  }

  const log = (message) => ctx.logger?.info?.(`[keep-working] ${message}`)

  let queryWarned = false

  /** 实时判定取一次宿主事件观察切面;旧同步读取面已被宿主禁止新增调用。 */
  async function observeEvents(sessionId) {
    const query = ctx.get?.('sessionQuery')
    if (typeof query?.observeSession !== 'function') {
      if (!queryWarned) {
        queryWarned = true
        log('sessionQuery 不可用,实时恢复停用')
      }
      return undefined
    }
    const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
    if (observation === undefined || observation === null) return undefined
    try {
      return observation.events
    } finally {
      observation[Symbol.dispose]?.()
    }
  }

  function cancelPending(state, why) {
    if (state.pendingTimer !== undefined) {
      timers.clearTimeout(state.pendingTimer)
      state.pendingTimer = undefined
    }
    if (state.pending === undefined) return
    state.pending = undefined
    log(`取消待发送(${why})`)
  }

  function rememberSent(state, messageId) {
    state.sentIds.add(messageId)
    if (state.sentIds.size <= SENT_ID_MEMORY) return
    const oldest = state.sentIds.values().next().value
    state.sentIds.delete(oldest)
  }

  /** 按 turn/end 的原因给出动作;undefined 表示不恢复,{ closed } 表示正常结案。 */
  function decideByReason(event, state, events) {
    const turn = event.data?.turn
    const reason = event.data?.reason ?? {}

    switch (reason.kind) {
      case 'completed': {
        // 末条 assistant 没有可见文本:回合是在没交代的情况下收尾的,按空回合处理
        const answered = tailAssistantText(events, turn).trim() !== ''
        // 关闭结案强制:present/标记仍算结案,交代过就算完成,只保留空回合恢复
        if (!config.enforceClosure) {
          if (closureVerdict(events, turn, { enforce: false }).closed) return { closed: true }
          if (answered) return { closed: true }
          return config.resumeSilentTurns ? { reason: 'silent', text: config.continueTextSilent } : undefined
        }
        const verdict = closureVerdict(events, turn)
        if (verdict.closed) return { closed: true }
        // 有有效文件写入时结案规则优先:没 present 就必须提醒,不能被空回合开关跳过
        if (!answered && verdict.reason !== 'file-write-requires-present') {
          return config.resumeSilentTurns ? { reason: 'silent', text: config.continueTextSilent } : undefined
        }
        if (turnInitiator(events, turn) !== 'user') return undefined
        return { reason: 'closure', text: config.closureText }
      }
      case 'error': {
        if (closureVerdict(events, turn, { enforce: config.enforceClosure }).closed) return { closed: true }
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
        if (closureVerdict(events, turn, { enforce: config.enforceClosure }).closed) return { closed: true }
        return { reason: 'max-tokens', text: config.continueTextMaxTokens }
      case 'interrupted':
        return { reason: 'interrupted', text: config.continueTextInterrupted }
      case 'aborted': {
        if (!RESTART_CANCEL_CAUSES.has(reason.reason?.kind)) return undefined
        return { reason: 'interrupted', text: config.continueTextInterrupted }
      }
      // blocked 不是模型的结案声明,而是宿主 pre-step 被拒(维护闸门、目标预约竞争):
      // 拒绝落在两个 step 之间,等价于中断;归档与子会话由 handBackToGoal 排除
      case 'blocked': {
        if (closureVerdict(events, turn, { enforce: config.enforceClosure }).closed) return { closed: true }
        return { reason: 'interrupted', text: config.continueTextInterrupted, goalDriven: true }
      }
      default:
        return undefined
    }
  }

  /**
   * 排队输入优先于一切恢复护栏。
   *
   * 失败类终态(报错、截断、中断、宿主拒绝)不唤醒 durable inbox,里面排着的是
   * 人的指令:被连续上限、错误分类或结案标记挡住就永远躺在队列里。这类回合改成
   * 插队唤醒,文案只写「继续」;正常结案与用户主动取消仍按原判定。
   */
  function decide(event, state, events) {
    const reason = event.data?.reason ?? {}
    const decision = decideByReason(event, state, events)
    if (decision?.closed === true || reason.kind === 'completed') return decision
    const recoverable =
      QUEUE_RECOVERY_KINDS.has(reason.kind) ||
      (reason.kind === 'aborted' && RESTART_CANCEL_CAUSES.has(reason.reason?.kind))
    if (!recoverable) return decision
    if (pendingInbox(events).count === 0) return decision
    return {
      reason: 'queued',
      text: QUEUED_RESUME_TEXT,
      queued: true,
      ...(decision?.goalDriven === true ? { goalDriven: true } : {}),
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
      // 排队输入必须插队:followup 会追加到 next-turn 队尾,排在人的指令之后
      if (decision.queued === true) agent.steer(message)
      else agent.followup(message)
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
    // 探测在途期间 pending 仍是令牌:新回合或卸载清掉后,迟到的结果必须作废
    if (state.pending !== decision) return
    if (!config.pauseWhenOffline || probe === undefined) {
      state.pending = undefined
      fire(session, state, decision)
      return
    }
    probe().then(
      (online) => {
        if (state.pending !== decision) return
        if (disposed || config.paused) {
          state.pending = undefined
          return
        }
        if (!online) {
          state.pendingTimer = timers.setTimeout(() => {
            state.pendingTimer = undefined
            settle(session, state, decision)
          }, config.offlineCheckMs)
          return
        }
        state.pending = undefined
        fire(session, state, decision)
      },
      () => {
        if (state.pending !== decision) return
        state.pending = undefined
        fire(session, state, decision)
      },
    )
  }

  function schedule(session, state, decision) {
    if (disposed || config.paused) return
    if (isSubagent(session)) return
    if (state.pendingTimer !== undefined || state.pending !== undefined) return
    // 排队的是人的指令:连续上限只封自动恢复,不能把队列锁死在 durable inbox 里
    if (decision.queued !== true && state.consecutive >= config.maxConsecutive) {
      log(`${session.id}: 已达连续上限 ${config.maxConsecutive},等待用户介入`)
      return
    }
    const cooldown = cooldownFor(config, state.consecutive)
    // 墙钟回拨会让 now() - lastAttemptAt 变负,按 0 处理,避免冷却被放大
    const elapsed = Math.max(0, now() - state.lastAttemptAt)
    const delay = Math.max(config.graceMs, cooldown - elapsed)
    state.pending = decision
    state.pendingTimer = timers.setTimeout(() => {
      state.pendingTimer = undefined
      settle(session, state, decision)
    }, delay)
  }

  function onSessionEvent(session, event) {
    if (disposed) return
    const state = stateOf(session.id)
    switch (event.type) {
      case 'turn/start':
        state.version += 1
        cancelPending(state, '新回合开始')
        return
      case 'turn/end':
        state.version += 1
        state.busy += 1
        return handleTurnEnd(session, state, event, state.version)
          .catch((error) => {
            log(`${session.id}: 回合判定失败 ${error instanceof Error ? error.message : String(error)}`)
          })
          .finally(() => { state.busy -= 1 })
      default:
        return
    }
  }

  let archiveWarned = false
  /** 归档集合只读:读不到按未归档处理,写操作的方向性由 scan 负责。 */
  function isSessionArchived(sessionId) {
    try {
      const ids = ctx.get('workspaceRegistry')?.archivedSessionIds
      if (ids === undefined || ids === null || typeof ids[Symbol.iterator] !== 'function') return false
      for (const id of ids) if (id === sessionId) return true
      return false
    } catch (error) {
      // 实时路径无法像扫描那样重试:按未归档放行,但留一次观测面
      if (!archiveWarned) {
        archiveWarned = true
        log(`归档集合不可用,按未归档处理: ${error instanceof Error ? error.message : String(error)}`)
      }
      return false
    }
  }

  /** 冷却到点再接一次:回落消息所在回合可能正常结束,不会再产生 blocked 事件。 */
  function scheduleGoalRetry(session, state, delayMs) {
    if (state.goalRetryTimer !== undefined) return
    state.goalRetryTimer = timers.setTimeout(() => {
      state.goalRetryTimer = undefined
      retryBlockedGoal(session, state)
    }, Math.max(0, delayMs))
  }

  function retryBlockedGoal(session, state) {
    if (disposed || config.paused || isSubagent(session)) return
    if (isSessionArchived(session.id)) return
    const goals = ctx.get('goals')
    if (goals === undefined) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    let view
    try {
      view = goals.get(agent)
    } catch {
      return
    }
    if (view?.phase !== 'blocked' || view.blockedReason?.code !== REJECTED_BLOCK_CODE) return
    if (!rearmGoal(ctx, agent, config)) return
    state.lastGoalResumeAt = now()
    state.consecutive = 0
    log(`${session.id}: 冷却结束,已交回 goal 驱动`)
  }

  /**
   * blocked 回合的目标接回:目标仍归 driver 或人已暂停时不补消息,能接回就接回,
   * 接不回按普通中断补消息(冷却与异常都不能把会话留在无人驱动的状态)。
   */
  function handBackToGoal(session, state) {
    if (disposed || config.paused) return false
    if (isSubagent(session)) return true
    if (isSessionArchived(session.id)) {
      log(`${session.id}: 会话已归档,不恢复`)
      return true
    }
    const goals = ctx.get('goals')
    if (goals === undefined) return false
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return false
    let view
    try {
      view = goals.get(agent)
    } catch {
      return false
    }
    // 目标已完结:没有驱动方,按普通回合处理
    if (view === undefined || view.phase === 'complete') return false
    // driver 还在驱动,或人已暂停:补消息会抢方向
    if (view.phase === 'active' && view.activation !== 'disarmed') return true
    if (view.phase === 'paused' && !config.resumePausedGoals) {
      log(`${session.id}: 目标已暂停,不接管`)
      return true
    }
    // 非预检拒绝的阻塞是模型或人的判断,等人处理
    if (view.phase === 'blocked' && view.blockedReason?.code !== REJECTED_BLOCK_CODE) {
      log(`${session.id}: 目标阻塞码 ${view.blockedReason?.code},等待人工`)
      return true
    }
    const elapsed = Math.max(0, now() - state.lastGoalResumeAt)
    if (state.lastGoalResumeAt !== 0 && elapsed < config.cooldownMs) {
      log(`${session.id}: 目标接回冷却中,先补中断消息`)
      scheduleGoalRetry(session, state, config.cooldownMs - elapsed)
      return false
    }
    if (!rearmGoal(ctx, agent, config)) {
      log(`${session.id}: 目标接回失败,改按普通中断补消息`)
      return false
    }
    if (state.goalRetryTimer !== undefined) {
      timers.clearTimeout(state.goalRetryTimer)
      state.goalRetryTimer = undefined
    }
    state.lastGoalResumeAt = now()
    state.consecutive = 0
    log(`${session.id}: 已交回 goal 驱动`)
    return true
  }

  async function handleTurnEnd(session, state, event, version) {
    const turn = event.data?.turn
    cancelPending(state, '回合结束')
    let events
    try {
      events = await observeEvents(session.id)
    } catch (error) {
      log(`${session.id}: 读取会话事件失败 ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // 观察是异步的:期间来了新的回合事件,本次判定整体作废
    if (disposed || events === undefined || state.version !== version) return
    // 真人发起的回合说明人已介入:恢复额度,封顶不再永久沉默。
    // 判定按消息 id 排除本插件自投递的消息,不依赖"下一个 turn/start 是我们的"这一猜测。
    if (humanInitiatedTurn(events, turn, state.sentIds)) {
      if (state.consecutive > 0) log(`${session.id}: 用户回合,连续计数清零`)
      state.consecutive = 0
      state.lastAttemptAt = 0
    }
    const decision = decide(event, state, events)
    // 正常结案代表恢复目的已达成:清零连续计数,后续回合重新获得额度
    if (decision?.closed === true) {
      state.consecutive = 0
      state.lastAttemptAt = 0
      log(`${session.id}: 已结案,连续计数清零`)
      return
    }
    if (decision === undefined) return
    if (decision.goalDriven === true && handBackToGoal(session, state)) return
    schedule(session, state, decision)
  }

  function attach() {
    if (unregister !== undefined) return unregister
    unregister = ctx.on('session/event', onSessionEvent)
    return unregister
  }

  function dispose() {
    disposed = true
    for (const state of states.values()) {
      cancelPending(state, '插件卸载')
      if (state.goalRetryTimer !== undefined) {
        timers.clearTimeout(state.goalRetryTimer)
        state.goalRetryTimer = undefined
      }
    }
    states.clear()
    unregister?.()
    unregister = undefined
  }

  return { attach, dispose, onSessionEvent, stateCount: () => states.size }
}
