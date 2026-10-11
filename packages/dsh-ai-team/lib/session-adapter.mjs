// 会话适配:sessionController 命令薄封装。业务判定不在本层(架构设计"会话适配"职责边界)。
// QueueAction 的移除动作名以宿主 types 为准(dsh-api-session-controller types.d.ts updateQueue)
const QUEUE_ACTION_REMOVE = 'remove'

export function createSessionAdapter({ sessionController }) {
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

  // 事件流归并:消费宿主 follow 流,把原始 wire 事件回调给归并方;turn 生命周期驱动 Run 终态
  async function* followSessionEvents(sessionId, signal) {
    for await (const frame of sessionController.follow({ address: { kind: 'session', sessionId } }, signal)) {
      if (frame.type === 'event') yield frame.event
    }
  }

  return { ensureSession, dispatchPrompt, cancelSession, followSessionEvents }
}
