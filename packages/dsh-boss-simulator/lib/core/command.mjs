// 命令信封与执行槽键:同 commandId 同 payload 返回原结果,同 commandId 不同 payload 拒绝;
// 执行槽冲突键由固定顺序字段序列化(slotKey),Run 派发幂等另由 runId/requestId/指纹承担。
export const ERROR_CODES = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  TASK_PAUSED: 'TASK_PAUSED',
  STALE_EPOCH: 'STALE_EPOCH',
  AUTHORIZATION_REQUIRED: 'AUTHORIZATION_REQUIRED',
  DEPENDENCY_BLOCKED: 'DEPENDENCY_BLOCKED',
  EXECUTION_STILL_ACTIVE: 'EXECUTION_STILL_ACTIVE',
  NOT_FOUND: 'NOT_FOUND',
}

export function fail(code, message) {
  return { ok: false, code, message }
}

export function pass(result) {
  return { ok: true, result }
}

// actionKey 由固定顺序字段数组序列化,相同字段得到同一键
export function actionKeyOf(fields) {
  return JSON.stringify(fields)
}

// 命令信封:同 commandId 同 payloadHash 返回原结果;不同 payload 拒绝重造
export function applyEnvelope(state, { commandId, payloadHash }, run) {
  const receipts = state.commandReceipts ?? {}
  const existing = receipts[commandId]
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      return fail(ERROR_CODES.IDEMPOTENCY_CONFLICT, `相同 commandId 对应不同内容: ${commandId}`)
    }
    return pass({ state, result: existing.result, replayed: true })
  }
  const outcome = run()
  return pass({ state: outcome.state, result: outcome.result, replayed: false })
}
