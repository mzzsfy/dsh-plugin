// metadata 模板透传:字符串值支持 {sessionId} / {marker} 占位符,其余值原样。
// 标记注入与模板独立:合并时 user_id 键恒为派生标记,模板其余键照常透传。

const PLACEHOLDER_SESSION_ID = '{sessionId}'
const PLACEHOLDER_MARKER = '{marker}'

/**
 * 渲染一个模板值:字符串替换占位符,对象/数组递归,其他类型原样。
 * @param {unknown} value 模板值
 * @param {{sessionId: string, marker: string}} vars 占位符取值
 */
export function renderTemplate(value, vars) {
  if (typeof value === 'string') {
    return value
      .replaceAll(PLACEHOLDER_SESSION_ID, vars.sessionId)
      .replaceAll(PLACEHOLDER_MARKER, vars.marker)
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, vars))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderTemplate(item, vars)]),
    )
  }
  return value
}
