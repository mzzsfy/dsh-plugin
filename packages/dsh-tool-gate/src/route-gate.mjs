/**
 * 宿主闸门复用。宿主把认证挂在它自己的 `/api` prefix 路由里,而 responder 选择是
 * 「exact 先、最长 prefix 后」——插件注册的 `/api/<pkg>` 更长,先命中,`connection.admit`
 * 从不执行。所以插件路由必须自己回问一次宿主闸门,否则无 cookie 的调用直接进业务面。
 *
 * 服务缺失(非 web 传输、旧宿主)时放行:与原行为一致,不新增自有认证层。
 */

export function rejectUnadmitted(ctx, req, res) {
  let rejection
  try {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
    rejection = connection?.requestRejection?.(req)
  } catch {
    // 闸门自身异常不放行:宁可拒绝,不把故障当认证通过
    rejection = 403
  }
  if (rejection === undefined) return false
  res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

export function withHostGate(ctx, handler) {
  return async (req, res) => {
    if (rejectUnadmitted(ctx, req, res)) return
    await handler(req, res)
  }
}
