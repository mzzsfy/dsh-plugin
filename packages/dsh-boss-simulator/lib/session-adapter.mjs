// 会话适配:公开 sessionController API 的薄封装。业务判定留在核心状态机。
// QueueAction 的移除动作名以宿主 types 为准(dsh-api-session-controller types.d.ts updateQueue)
const QUEUE_ACTION_REMOVE = { kind: 'remove' }

export function createSessionAdapter({ sessionController }) {
  // 执行与验收绑定工作区,使用宿主标准 agentPreset 组合。
  async function ensureSession({ sessionId, workspaceId, cwd, agentPreset }) {
    // workspaceId 与 cwd 二选一,创建/收养幂等由宿主保证(sessionId 收养 + cwd/preset 漂移校验)
    const request = {}
    if (sessionId !== undefined) request.sessionId = sessionId
    if (agentPreset !== undefined) request.agentPreset = agentPreset
    if (workspaceId !== undefined) request.workspaceId = workspaceId
    else if (cwd !== undefined) request.cwd = cwd
    return sessionController.create(request)
  }

  async function dispatchPrompt({ sessionId, requestId, content, mode = 'queue' }) {
    // prompt(request, signal):插件无调用方取消语义,挂独立不中止 signal
    return sessionController.prompt({ requestId, sessionId, mode, content }, new AbortController().signal)
  }

  function cancelSession({ sessionId, pendingItemIds = [] }) {
    const result = sessionController.cancel({ sessionId })
    const queue = Promise.all(
      pendingItemIds.map((itemId) => sessionController.updateQueue({ sessionId, itemId, action: QUEUE_ACTION_REMOVE })),
    )
    return Promise.all([result, queue]).then(([cancelValue]) => cancelValue)
  }

  async function inspectSession({ sessionId }) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('停止核对缺少sessionId')
    const signal = new AbortController().signal
    const projection = await sessionController.projections({ sessionId }, signal)
    const inbox = projection?.values?.inbox
    if (!Array.isArray(inbox?.['next-turn']) || !Array.isArray(inbox?.['next-step'])) throw new Error('停止核对缺少inbox投影')
    const pendingItemIds = [...inbox['next-turn'], ...inbox['next-step']].map((message) => {
      if (typeof message?.id !== 'string' || !message.id) throw new Error('inbox排队项缺少id')
      return message.id
    })
    const listing = await sessionController.list({}, signal)
    const session = listing.items.find((item) => item.sessionId === sessionId)
    if (!session || typeof session.running !== 'boolean') throw new Error('停止核对无法确认会话运行状态')
    const verified = await sessionController.projections({ sessionId }, signal)
    if (!Number.isSafeInteger(projection.asOfSeq) || verified?.asOfSeq !== projection.asOfSeq || JSON.stringify(verified.values?.inbox) !== JSON.stringify(inbox)) throw new Error('停止核对期间会话投影发生变化')
    return { sessionId, running: session.running, pendingItemIds: [...new Set(pendingItemIds)], stopped: !session.running && pendingItemIds.length === 0, asOfSeq: projection.asOfSeq }
  }

  // 事件监听同时返回 snapshot 历史和后续 durable 事件,由调用方按本次 requestId 过滤。
  async function* followSessionEvents(sessionId, signal) {
    for await (const frame of sessionController.follow({ address: { kind: 'session', sessionId } }, signal)) {
      if (frame.type === 'snapshot') {
        let records = [...frame.records]
        let hasMore = frame.hasMore
        while (hasMore) {
          const beforeSeq = records[0]?.event?.seq
          if (!Number.isSafeInteger(beforeSeq)) throw new Error('截断的会话日志缺少分页游标')
          const page = await sessionController.page({ address: { kind: 'session', sessionId }, throughSeq: frame.cursor, beforeSeq, maxMessages: 100 })
          if (!page.records.length) throw new Error('会话历史分页未推进')
          if (page.records[0].event.seq >= beforeSeq) throw new Error('会话历史分页游标重复')
          records = [...page.records, ...records]
          hasMore = page.hasMore
        }
        for (const record of records) yield record.event
      } else if (frame.type === 'event') {
        yield frame.event
      }
    }
  }

  return { ensureSession, dispatchPrompt, cancelSession, inspectSession, followSessionEvents }
}
