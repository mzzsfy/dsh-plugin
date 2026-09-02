// 自定义 JS 费用条:最小权限求值。函数源码经 new Function 编译(非 eval 全局),
// 仅传入结构化费用快照,要求返回字符串;异常或非字符串返回一律回退原生渲染。

// 试运行样例:设置区即时回显错误用。
export const FEE_BAR_SAMPLE = {
  turnCost: 0.01,
  sessionCost: 0.5,
  sessionTokens: 12345,
  recentDailyCosts: [0.1, 0.2, 0, 0.3, 0.15, 0.05, 0.5],
}

// 编译失败(语法错误或非函数表达式)返回 null。
export function compileFeeBar(source) {
  if (typeof source !== 'string' || source.trim().length === 0) return null
  try {
    const factory = new Function('"use strict"; return (' + source + ');')
    const fn = factory()
    return typeof fn === 'function' ? fn : null
  } catch {
    return null
  }
}

// 本轮费用差分:首样本无前值,turnCost 置 0(首跳无差分);负差分(清零等)钳为 0。
export function turnCostOf(currentCost, previousCost) {
  if (previousCost === null) return 0
  return Math.max(0, currentCost - previousCost)
}

// 渲染结果:{ fallback: false, text } 或 { fallback: true, error }。
export function renderFeeBar(source, data) {
  const fn = compileFeeBar(source)
  if (!fn) return { fallback: true, error: '费用条函数编译失败' }
  try {
    const text = fn(data)
    if (typeof text !== 'string') return { fallback: true, error: '费用条函数返回非字符串' }
    return { fallback: false, text }
  } catch (error) {
    return { fallback: true, error: error && error.message ? error.message : String(error) }
  }
}
