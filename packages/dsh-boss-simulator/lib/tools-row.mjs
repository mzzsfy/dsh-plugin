// 工具行:把业务工具注册进 tools 服务。角色凭证取会话预设 id(受管登记),不接受模型自填。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAgentTools } from './agent-tools.mjs'
import { ADMIN_PRESET_ID } from './presets.mjs'

// 公司管理工具仅对唯一工作台入口开放,不向普通/标准执行会话发布
const TOOL_NAME = 'boss_simulator'
const TOOL_DESCRIPTION = `公司管理唯一工作台工具。tool 取以下操作，参数放在 args：
- boss_simulator_create_task: taskId,title,projectWorkspaceId,definition:{goal,scope,acceptanceCriteria:[{criterionId,text}]}
- boss_simulator_define_workitem: taskId,workItemId,title,scope,requiredCriterionIds
- boss_simulator_authorize_task: taskId,sourceMessageRef（明确用户授权的会话消息引用）
- boss_simulator_dispatch_run: taskId,workItemId,runId,requestId,phase(implement/fix/accept/integrate),content；integrate 可指定 actorRole(executor/reviewer)。稳定 runId/requestId 重试不得换内容。创建标准会话执行；验收使用独立标准会话，先有实施报告才能验收。
- boss_simulator_query_tasks: taskId；查询 runs/reports/状态，报告由 durable 事件采集，不能直接写报告。
- boss_simulator_close_task: taskId,passReportId,conclusion；仅引用当前有效独立验收 pass。
- boss_simulator_request_resume: taskId,resumeIntentId,sourceMessageRef,expectedExecutionEpoch?；全局停止代次由服务端读取。
- boss_simulator_confirm_resume: taskId,resumeIntentId；宿主核对旧会话停止后才能放行。`

export function registerToolRow(ctx, deps) {
  const tools = createAgentTools(deps)
  const disposer = ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      tool: { type: 'string', required: true, description: '操作名：boss_simulator_create_task/define_workitem/authorize_task/dispatch_run/query_tasks/close_task/request_resume/confirm_resume，均带 boss_simulator_ 前缀' },
      args: { type: 'object', additionalProperties: true, description: '业务工具参数' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_params, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(params, execution) {
      // 子会话可继承父会话的管理员预设,必须在此拒绝:管理动作只允许工作台会话本身
      if (isDerivedSession(execution)) throw new Error('子会话不得调用公司管理工具')
      const presetId = presetOf(execution)
      if (presetId !== ADMIN_PRESET_ID) throw new Error('公司管理工具仅限管理员工作台会话')
      return tools.handle(params.tool, params.args ?? {}, { role: 'admin' })
    },
  }))
  // 非受管会话对本工具 deny 兜底(deny-only guard)
  const restrict = ctx.tools.guard((execution) => {
    const name = execution?.name ?? execution?.toolName
    if (name !== TOOL_NAME) return undefined
    if (isDerivedSession(execution)) return '子会话不得调用公司管理工具'
    return presetOf(execution) === ADMIN_PRESET_ID ? undefined : '公司管理工具仅限管理员工作台会话'
  })
  return () => { disposer(); restrict() }
}

// 子会话判定:origin 权威;无 origin 的旧记录按 parentSession + delegationDepth。
// 宿主子会话未显式选预设时继承父会话预设,只查预设会把子会话误当管理员。
function isDerivedSession(execution) {
  const header = execution?.agent?.session?.header
  if (!header) return false
  if (header.origin === 'subagent') return true
  return header.parentSession !== undefined && (header.delegationDepth ?? 0) >= 1
}

function presetOf(execution) {
  const agentCtx = execution?.agent?.ctx
  const registry = agentCtx?.get?.('agentPresets')
  return registry?.composedPreset?.(agentCtx) ?? null
}
