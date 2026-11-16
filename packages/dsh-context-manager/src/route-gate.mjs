/**
 * 宿主闸门复用。宿主把认证挂在它自己的 `/api` prefix 路由里,而 responder 选择是
 * 「exact 先、最长 prefix 后」——插件注册的 `/api/<pkg>` 更长,先命中,`connection.admit`
 * 从不执行。所以插件路由必须自己回问一次宿主闸门,否则无 cookie 的调用直接进业务面。
 *
 * 服务缺失(非 web 传输、旧宿主)时放行:与原行为一致,不新增自有认证层。
 * 写路由再叠加 Origin↔Host 同源比对与 JSON content-type 校验(用 withRouteGate):
 * 这是浏览器侧 CSRF 防线,不是身份认证;禁止在此实现 Host 白名单/DNS-rebinding
 * 防线/自有 token。
 */

function sendGuardJson(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error }))
}

// 宿主闸门返回的拒绝值只有整数 4xx/5xx 可写进 writeHead;null/0/对象/Promise 一律按
// 默认拒绝码收敛——否则 writeHead 抛 Invalid status code,请求拿不到任何响应。
const REJECTION_MIN = 400
const REJECTION_MAX = 599
const DEFAULT_REJECTION = 403
const isRejectionCode = (value) => Number.isInteger(value) && value >= REJECTION_MIN && value <= REJECTION_MAX

export function rejectUnadmitted(ctx, req, res) {
  let rejection
  try {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
    rejection = connection?.requestRejection?.(req)
  } catch {
    // 闸门自身异常不放行:宁可拒绝,不把故障当认证通过
    rejection = DEFAULT_REJECTION
  }
  if (rejection === undefined) return false
  const status = isRejectionCode(rejection) ? rejection : DEFAULT_REJECTION
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(status === 401 ? 'unauthorized' : 'forbidden')
  return true
}

export function withHostGate(ctx, handler) {
  return async (req, res) => {
    if (rejectUnadmitted(ctx, req, res)) return
    await handler(req, res)
  }
}

// Origin 存在即比对 Host(大小写不敏感);缺 Origin 的非浏览器调用不受影响。
// Origin 非法(无法解析)按跨源拒绝。
export function rejectCrossOrigin(req, res) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  const host = req.headers ? req.headers.host : undefined
  let sameOrigin = false
  try {
    sameOrigin = typeof host === 'string' && new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendGuardJson(res, 403, '跨源请求被拒绝')
  return true
}

// 写方法只接受 JSON:跨站表单(enctype=text/plain 等简单请求)无预检,必须显式拒绝。
// 媒体类型按 essence 精确比较,避免 application/jsonp / text/plain;...application/json 混入。
export const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
export function rejectNonJson(req, res) {
  const contentType = req.headers ? String(req.headers['content-type'] || '') : ''
  const essence = contentType.split(';', 1)[0].trim().toLowerCase()
  if (essence === 'application/json') return false
  sendGuardJson(res, 400, 'content-type 须为 application/json')
  return true
}

// 写路由完整闸门:宿主闸门 → 同源 → JSON。GET/HEAD 只过宿主闸门(无写副作用)
export function withRouteGate(ctx, handler) {
  return async (req, res) => {
    if (rejectUnadmitted(ctx, req, res)) return
    if (WRITE_METHODS.has(String(req.method || '').toUpperCase())) {
      if (rejectCrossOrigin(req, res)) return
      if (rejectNonJson(req, res)) return
    }
    await handler(req, res)
  }
}
