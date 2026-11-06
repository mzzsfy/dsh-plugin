// HTTP 面共用件:JSON 响应、同源守卫、有界请求体读取。写路由只在 Origin 与 Host 同源时放行。
export function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export function rejectCrossOrigin(req, res) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  let sameOrigin = false
  try {
    sameOrigin = new URL(origin).host === req.headers.host
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { error: '跨源请求被拒绝' })
  return true
}

export const BODY_LIMIT_BYTES = 64 * 1024

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length'] ?? 0)
    if (declared > BODY_LIMIT_BYTES) {
      reject(Object.assign(new Error('请求体超过大小上限'), { statusCode: 413 }))
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        reject(Object.assign(new Error('请求体超过大小上限'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 写路由统一解析入口:同源守卫 → 读取 → JSON 解析;失败按可读文案返回 null
export async function readJsonBody(req, res) {
  if (rejectCrossOrigin(req, res)) return null
  const raw = await readBody(req).catch((error) => { throw Object.assign(error, { statusCode: error.statusCode ?? 400 }) })
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' })
    return null
  }
}
