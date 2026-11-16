// HTTP 面共用件:JSON 响应、方法白名单、有界请求体读取与解析。
// 宿主闸门、同源守卫与写路由 JSON content-type 见 route-gate.mjs(全仓一致),
// 路由注册一律用 withRouteGate 包处理器,此处不重复做这些判断(单一实现)。

export function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 方法闸门:白名单外回 405 并给出 Allow,避免 GET 落到写入口、写方法落到只读投影
export function rejectMethod(req, res, allowed) {
  const method = req.method ?? 'GET'
  if (allowed.includes(method)) return false
  res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: allowed.join(', ') })
  res.end(JSON.stringify({ error: `方法不受支持: ${method}`, code: 'METHOD_NOT_ALLOWED', allow: allowed }))
  return true
}

export const BODY_LIMIT_BYTES = 64 * 1024

// 有界读取:超限即排空请求体并拒绝(丢弃数据但不销毁连接)。
// 宣告长度预检拦不住 chunked;而销毁 socket 会让客户端收到 ECONNRESET、丢掉 413 响应
// (已发出的字节可能还在对端缓冲里,被 RST 一并丢弃),所以选择排空而非复位。
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const over = () => reject(Object.assign(new Error('请求体超过大小上限'), { statusCode: 413 }))
    const declared = Number(req.headers?.['content-length'] ?? 0)
    if (declared > BODY_LIMIT_BYTES) {
      // 数据继续流入但一律丢弃:连接保持可写,413 能正常送达。
      // 排空期间客户端可能中断,吞掉流的 error 以免成为未处理事件
      req.on('error', () => {})
      req.resume?.()
      over()
      return
    }
    const chunks = []
    let size = 0
    let exceeded = false
    req.on('data', (chunk) => {
      if (exceeded) return
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        exceeded = true
        chunks.length = 0
        req.resume?.()
        over()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', (error) => { if (!exceeded) reject(error) })
  })
}

// 写路由解析入口:闸门(宿主→同源→JSON content-type)由 withRouteGate 承担,
// 此处只读体与解析。返回 null 表示"已回过响应"(400),处理器据此原样退出。
export async function readJsonBody(req, res) {
  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    throw Object.assign(error, { statusCode: error.statusCode ?? 400 })
  }
  let parsed
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' })
    return null
  }
  // JSON null/数组/标量都不是可用的请求体:不拦会走到处理器里"缺字段"分支甚至无响应悬挂
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: '请求体须为 JSON 对象' })
    return null
  }
  return parsed
}
