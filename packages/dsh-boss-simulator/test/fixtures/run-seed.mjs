// 测试夹具:不经 HTTP 与 Run 服务,直接用 core 状态机铺"可派发任务 + 已投递 Run"。
// 生产派发入口是 lib/run-service.mjs;这里只为主编排(停止/核对/恢复)提供前置状态。
import {
  createTask, defineWorkItem, authorizeTask, checkExecutionPermission, recordRun, markSessionExecutor,
} from '../../lib/core/task.mjs'

export const GLOBAL_CONTROL = { globalStopped: false, globalStopGeneration: 0 }

export function makeReadyTask(now, { criterionIds = ['c1'] } = {}) {
  let aggregate = createTask({
    taskId: 't1', title: '任务一', projectWorkspaceId: 'ws1',
    definition: { goal: 'g', acceptanceCriteria: criterionIds.map((criterionId) => ({ criterionId, text: '标准' })) },
    now,
  }).result
  aggregate = defineWorkItem(aggregate, { workItemId: 'w1', title: '子项', requiredCriterionIds: criterionIds }).result.aggregate
  return authorizeTask(aggregate, { sourceMessageRef: { sessionId: 's0', messageId: 'm1' } }).result.aggregate
}

// 在已授权任务上登记一个已受理的 Run(状态 submitted),供回合事件与停止核对使用
export function seedRun(aggregate, { runId = 'r1', workItemId = 'w1', phase = 'implement', actorRole, sessionId = 's1', requestId = `req-${runId}`, state = 'submitted' } = {}) {
  const role = actorRole ?? (phase === 'accept' ? 'reviewer' : 'executor')
  const permission = checkExecutionPermission(aggregate, GLOBAL_CONTROL, { workItemId, phase, actorRole: role })
  if (!permission.ok) throw new Error(permission.message)
  const recorded = recordRun(aggregate, { runId, workItemId, phase, actorRole: role, sessionId, requestId, slotKey: permission.result.slotKey, globalControl: GLOBAL_CONTROL })
  if (!recorded.ok) throw new Error(recorded.message)
  let next = recorded.result.aggregate
  next = { ...next, runs: { ...next.runs, [runId]: { ...next.runs[runId], state } } }
  if (role === 'executor') next = markSessionExecutor(next, { sessionId, runIds: [runId] }).result.aggregate
  return next
}
