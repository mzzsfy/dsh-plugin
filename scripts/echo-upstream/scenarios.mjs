// 场景解析:模型名后缀 → 行为标记。后缀约定与触发形态:
//   -think  产出 thinking/reasoning 块(流式 reasoning delta,非流式 reasoning 内容块)
//   -thinkslow  reasoning 分片慢速流出(真机交互窗口:流式思考行收起/保持断言)
//   -err429 / -err500  HTTP 错误码
//   -drop   流式部分块后中断(非流式不受影响)
//   -slow   流式块间隔(SLOW_CHUNK_INTERVAL_MS)
//   -tool   产出 tool_calls/tool_use(name=TOOL_NAME,流式 finish_reason=tool_calls / anthropic stop_reason=tool_use)
//   -call   同 -tool 形态但工具为 rs_workflow_start(rsww 活跃 run 面板真机触发:会话须锚定 compat-test 模板)
export const THINKING_TEXT = 'echo-upstream-thinking'
export const THINKSLOW_CHUNK_INTERVAL_MS = 600
export const THINKSLOW_CHUNK_SIZE = 3
export const SLOW_CHUNK_INTERVAL_MS = 200
export const TOOL_NAME = 'shell'
// description 为 0.2.0+ 官方 shell 工具 schema 必填属性,缺失即 ToolArgsError(校验先于执行,工具网关收不到)
export const TOOL_ARGUMENTS = '{"command":"echo echo-upstream-tool","description":"echo-upstream tool probe"}'
export const CALL_NAME = 'rs_workflow_start'
// note/done/brief 为 planner-gate(#5/#6/#8)必填,缺任一即拒单(连续 3 次拒单关闭编排入口)
export const CALL_ARGUMENTS = '{"request":"compat rsww run probe","templateId":"compat-test","plan":{"brief":"compat acceptance","steps":[{"ref":"first","note":"echo-upstream -call probe","done":"result 回填"}]}}'

// 场景 → 工具调用载荷:无工具场景返回 null
export function toolCallOf(scenario) {
  if (scenario === 'tool') return { name: TOOL_NAME, arguments: TOOL_ARGUMENTS, id: 'call_echo-upstream', anthropicId: 'toolu_echo-upstream' }
  if (scenario === 'call') return { name: CALL_NAME, arguments: CALL_ARGUMENTS, id: 'call_echo-upstream-call', anthropicId: 'toolu_echo-upstream-call' }
  return null
}

const SUFFIXES = ['-think', '-thinkslow', '-err429', '-err500', '-drop', '-slow', '-tool', '-call']

export function resolveScenario(model) {
  const name = String(model ?? '')
  const hit = SUFFIXES.find((s) => name.endsWith(s))
  return hit === undefined ? 'default' : hit.slice(1)
}
