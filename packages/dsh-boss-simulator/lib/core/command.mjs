// 命令信封与业务幂等(数据与工具契约"命令信封与返回"):同 commandId 同 payload 返回原结果,
// 同 commandId 不同 payload 拒绝;业务幂等键固定为 JSON.stringify([causeId, actionKey])。
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

export function appliedKeyOf(causeId, actionKey) {
  return JSON.stringify([causeId, actionKey])
}

// effect(aggregate) 返回 { aggregate, result };登记动作时冻结 payloadHash
export function applyCommand(aggregate, { causeId, actionKey, payloadHash }, effect) {
  if (!causeId || !actionKey) return fail(ERROR_CODES.INVALID_ARGUMENT, '缺少 causeId 或 actionKey')
  const applied = aggregate.appliedActions ?? {}
  const key = appliedKeyOf(causeId, actionKey)
  const existing = applied[key]
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      return fail(ERROR_CODES.IDEMPOTENCY_CONFLICT, `相同命令键对应不同内容: ${causeId}/${actionKey}`)
    }
    return pass({ aggregate, result: existing.result, replayed: true })
  }
  const { aggregate: next, result } = effect(aggregate)
  return pass({
    aggregate: { ...next, appliedActions: { ...applied, [key]: { result, payloadHash } } },
    result,
    replayed: false,
  })
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
