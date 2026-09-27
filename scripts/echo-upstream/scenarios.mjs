// 场景解析:模型名后缀 → 行为标记。后缀约定与触发形态:
//   -think  产出 thinking/reasoning 块(流式 reasoning delta,非流式 reasoning 内容块)
//   -err429 / -err500  HTTP 错误码
//   -drop   流式部分块后中断(非流式不受影响)
//   -slow   流式块间隔(SLOW_CHUNK_INTERVAL_MS)
export const THINKING_TEXT = 'echo-upstream-thinking'
export const SLOW_CHUNK_INTERVAL_MS = 200

const SUFFIXES = ['-think', '-err429', '-err500', '-drop', '-slow']

export function resolveScenario(model) {
  const name = String(model ?? '')
  const hit = SUFFIXES.find((s) => name.endsWith(s))
  return hit === undefined ? 'default' : hit.slice(1)
}
