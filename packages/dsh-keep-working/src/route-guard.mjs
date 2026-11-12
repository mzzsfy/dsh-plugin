/**
 * 写路由守卫(与全仓同构):浏览器跨站表单可发 text/plain 且载荷为合法 JSON,
 * 仅方法守卫不足以阻断 drive-by 写,补同源比对与 JSON 内容类型双校验。
 *
 * 两条放行口径与 dsh-session-manager 一致:
 * - 无 Origin 的非浏览器调用(本地 CLI/脚本)放行
 * - 完全不带 content-type 的调用放行
 */

export function rejectCrossOrigin(req, res, sendJson) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  let sameOrigin = false
  try {
    const host = req.headers.host
    sameOrigin = typeof host === 'string' && host.length > 0 && new URL(origin).host === host.toLowerCase()
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { ok: false, error: '跨源请求被拒绝' })
  return true
}

export function rejectNonJson(req, res, sendJson) {
  const type = req.headers ? req.headers['content-type'] : undefined
  if (typeof type !== 'string' || type.trim() === '') return false
  if (type.split(';')[0].trim().toLowerCase() === 'application/json') return false
  sendJson(res, 415, { ok: false, error: '仅接受 application/json 请求体' })
  return true
}

export function guardWrite(req, res, sendJson) {
  return rejectCrossOrigin(req, res, sendJson) || rejectNonJson(req, res, sendJson)
}
