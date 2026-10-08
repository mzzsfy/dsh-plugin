// 场景解析:模型名后缀 → 行为标记。后缀约定与触发形态:
//   -think  产出 thinking/reasoning 块(流式 reasoning delta,非流式 reasoning 内容块)
//   -thinkslow  reasoning 分片慢速流出(真机交互窗口:流式思考行收起/保持断言)
//   -err429 / -err500  HTTP 错误码
//   -drop   流式部分块后中断(非流式不受影响)
//   -slow   流式块间隔(SLOW_CHUNK_INTERVAL_MS)
//   -tool   产出 tool_calls/tool_use(name=TOOL_NAME,流式 finish_reason=tool_calls / anthropic stop_reason=tool_use)
export const THINKING_TEXT = 'echo-upstream-thinking'
export const THINKSLOW_CHUNK_INTERVAL_MS = 600
export const THINKSLOW_CHUNK_SIZE = 3
export const SLOW_CHUNK_INTERVAL_MS = 200
export const TOOL_NAME = 'shell'
// description 为 0.2.0+ 官方 shell 工具 schema 必填属性,缺失即 ToolArgsError(校验先于执行,工具网关收不到)
export const TOOL_ARGUMENTS = '{"command":"echo echo-upstream-tool","description":"echo-upstream tool probe"}'

const SUFFIXES = ['-think', '-thinkslow', '-err429', '-err500', '-drop', '-slow', '-tool']

export function resolveScenario(model) {
  const name = String(model ?? '')
  const hit = SUFFIXES.find((s) => name.endsWith(s))
  return hit === undefined ? 'default' : hit.slice(1)
}
