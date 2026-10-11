// 工具行:把业务工具注册进 tools 服务。角色凭证取会话预设 id(受管登记),不接受模型自填。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAgentTools } from './agent-tools.mjs'
import { WORKER_PRESET_ID } from './presets.mjs'

// 预设 id 精确匹配→角色(防自建同名前缀预设越权)
const ROLE_BY_PRESET = { 'ai-team-admin': 'admin', 'ai-team-dispatcher': 'dispatcher', [WORKER_PRESET_ID]: 'worker' }
const TOOL_NAME = 'ai_team'
const TOOL_DESCRIPTION = 'AI 团队任务控制室工具(create/authorize/dispatch/report/confirm/query)'

export function registerToolRow(ctx, deps) {
  const tools = createAgentTools(deps)
  const disposer = ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      tool: { type: 'string', required: true, description: '业务工具名(ai_team_create_task/ai_team_report_result 等)' },
      args: { type: 'object', additionalProperties: true, description: '业务工具参数' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_params, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(params, execution) {
      const role = roleOf(execution)
      if (!role) throw new Error('当前会话未受管,禁止调用 AI 团队工具')
      return tools.handle(params.tool, params.args ?? {}, { role })
    },
  }))
  // 非受管会话对本工具 deny 兜底(deny-only guard)
  const restrict = ctx.tools.guard((execution) => {
    const name = execution?.name ?? execution?.toolName
    if (name !== TOOL_NAME) return undefined
    return roleOf(execution) ? undefined : 'AI 团队工具仅限受管角色预设会话'
  })
  return () => { disposer(); restrict() }
}

// 角色解析:宿主把预设 id 放在不同深度(agent.agentPreset 字符串/会话 meta),广谱收集首命中
function roleOf(execution) {
  const found = []
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > 4) return
    for (const [key, value] of Object.entries(node)) {
      if (value === null || value === undefined) continue
      if (key === 'agentPreset' && typeof value === 'string') found.push(value)
      else if (key === 'agentPreset' && typeof value === 'object') found.push(String(value.id ?? ''))
      else if (typeof value === 'object') walk(value, depth + 1)
    }
  }
  walk(execution, 0)
  for (const id of found) if (ROLE_BY_PRESET[id]) return ROLE_BY_PRESET[id]
  return null
}
