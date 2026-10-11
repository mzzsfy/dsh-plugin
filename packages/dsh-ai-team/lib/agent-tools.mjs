// 业务工具面 v2:管理员/调度员/实施角色的结构化命令入口,状态机全部在 core/task。
// 角色凭证来自受管会话登记(caller),不接受模型自填;状态迁移经 updateAggregate RMW 原子落盘。
import { createTask, defineWorkItem, authorizeTask, submitReport, requestResume } from './core/task.mjs'

const ROLE_CAPABILITIES = {
  admin: new Set(['ai_team_create_task', 'ai_team_define_workitem', 'ai_team_authorize_task', 'ai_team_query_tasks']),
  dispatcher: new Set(['ai_team_define_workitem', 'ai_team_report_result', 'ai_team_request_resume', 'ai_team_query_tasks']),
  worker: new Set(['ai_team_report_result', 'ai_team_query_tasks']),
}

function assertRole(caller, tool) {
  const allowed = ROLE_CAPABILITIES[caller?.role]
  if (!allowed || !allowed.has(tool)) throw new Error(`角色 ${caller?.role ?? '未知'} 无权调用 ${tool}`)
}

function requireOk(outcome) {
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome
}

function updateTask(store, taskId, transition) {
  return store.updateAggregate(taskId, (aggregate) => {
    if (!aggregate) throw new Error(`任务不存在: ${taskId}`)
    return requireOk(transition(aggregate)).result.aggregate
  })
}

export function createAgentTools({ store, now }) {
  async function handle(tool, args, caller) {
    assertRole(caller, tool)
    if (tool === 'ai_team_create_task') {
      if (await store.loadAggregate(args.taskId)) throw new Error(`任务已存在: ${args.taskId}`)
      const created = requireOk(createTask({ taskId: args.taskId, title: args.title, projectWorkspaceId: args.projectWorkspaceId, definition: args.definition, priority: args.priority, now }))
      await store.saveAggregate(created.result)
      return { ok: true, taskId: created.result.taskId, businessState: created.result.businessState }
    }
    if (tool === 'ai_team_define_workitem') {
      await updateTask(store, args.taskId, (aggregate) => defineWorkItem(aggregate, args))
      return { ok: true }
    }
    if (tool === 'ai_team_authorize_task') {
      const authorized = await updateTask(store, args.taskId, (aggregate) => authorizeTask(aggregate, { sourceMessageRef: args.sourceMessageRef }))
      return { ok: true, businessState: authorized.businessState, controlState: authorized.control.state }
    }
    if (tool === 'ai_team_report_result') {
      await updateTask(store, args.taskId, (aggregate) => submitReport(aggregate, {
        reportId: args.reportId, runId: args.runId, verdict: args.verdict,
        coveredCriterionIds: args.coveredCriterionIds, issues: args.issues, evidence: args.evidence,
      }))
      return { ok: true }
    }
    if (tool === 'ai_team_request_resume') {
      const current = await store.loadAggregate(args.taskId)
      if (!current) throw new Error(`任务不存在: ${args.taskId}`)
      const requested = requireOk(requestResume(current, {
        resumeIntentId: args.resumeIntentId,
        sourceMessageRef: args.sourceMessageRef,
        expectedExecutionEpoch: args.expectedExecutionEpoch ?? current.control.executionEpoch,
        globalStopGeneration: args.globalStopGeneration,
      }))
      await store.saveAggregate(requested.result.aggregate)
      return { ok: true, controlState: requested.result.aggregate.control.state }
    }
    if (tool === 'ai_team_query_tasks') {
      return { ok: true, aggregate: await store.loadAggregate(args.taskId) }
    }
    throw new Error(`未知工具: ${tool}`)
  }

  return { handle }
}
