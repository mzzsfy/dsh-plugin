// 业务工具只对唯一管理员入口开放,执行/验收报告通过服务端事件读取而非模型工具直写。
import { createTask, defineWorkItem, authorizeTask, requestResume, closeTask, confirmResume } from './core/task.mjs'
import { createRunService } from './run-service.mjs'

const ROLE_CAPABILITIES = {
  admin: new Set(['boss_simulator_create_task', 'boss_simulator_define_workitem', 'boss_simulator_authorize_task', 'boss_simulator_request_resume', 'boss_simulator_query_tasks', 'boss_simulator_dispatch_run', 'boss_simulator_close_task', 'boss_simulator_confirm_resume']),
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

export function createAgentTools(deps) {
  const { store, now } = deps
  async function handle(tool, args, caller) {
    assertRole(caller, tool)
    if (tool === 'boss_simulator_create_task') {
      if (await store.loadAggregate(args.taskId)) throw new Error(`任务已存在: ${args.taskId}`)
      const created = requireOk(createTask({ taskId: args.taskId, title: args.title, projectWorkspaceId: args.projectWorkspaceId, definition: args.definition, priority: args.priority, now }))
      await store.saveAggregate(created.result)
      return { ok: true, taskId: created.result.taskId, businessState: created.result.businessState }
    }
    if (tool === 'boss_simulator_define_workitem') {
      await updateTask(store, args.taskId, (aggregate) => defineWorkItem(aggregate, args))
      return { ok: true }
    }
    if (tool === 'boss_simulator_authorize_task') {
      const authorized = await updateTask(store, args.taskId, (aggregate) => authorizeTask(aggregate, { sourceMessageRef: args.sourceMessageRef }))
      return { ok: true, businessState: authorized.businessState, controlState: authorized.control.state }
    }
    if (tool === 'boss_simulator_request_resume') {
      const global = await store.loadControl()
      const requested = await updateTask(store, args.taskId, current => requestResume(current, {
        resumeIntentId: args.resumeIntentId,
        sourceMessageRef: args.sourceMessageRef,
        expectedExecutionEpoch: args.expectedExecutionEpoch ?? current.control.executionEpoch,
        globalStopGeneration: global.globalStopGeneration,
      }))
      return { ok: true, controlState: requested.control.state }
    }
    if (tool === 'boss_simulator_dispatch_run') {
      if (!deps.sessionAdapter) throw new Error('标准会话适配未就绪')
      return createRunService(deps).dispatch(args)
    }
    if (tool === 'boss_simulator_close_task') {
      const closed = await updateTask(store, args.taskId, aggregate => closeTask(aggregate, args))
      return { ok: true, businessState: closed.businessState }
    }
    if (tool === 'boss_simulator_confirm_resume') {
      if (!deps.confirmResume) throw new Error('恢复核对服务未就绪')
      return deps.confirmResume(args)
    }
    if (tool === 'boss_simulator_query_tasks') {
      return { ok: true, aggregate: await store.loadAggregate(args.taskId) }
    }
    throw new Error(`未知工具: ${tool}`)
  }

  return { handle }
}
