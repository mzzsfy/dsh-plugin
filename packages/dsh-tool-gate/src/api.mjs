// HTTP 层('/api/tool-gate/*'):具名 exact 路由 + 跨源守卫 + 业务异常归一
// 400(shell-select api.mjs 同构:exact 路由 path 唯一键,GET/POST 同
// handler 分流)。守卫集中在 dispatch,routes 表驱动。

const API_ROOT = '/api/tool-gate'

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 同源守卫:浏览器写请求恒带 Origin,与 Host 不符即拒(shell-select 同构)
function rejectCrossOrigin(req, res) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  const host = String((req.headers && req.headers.host) || '')
  let sameOrigin = false
  try {
    sameOrigin = host.length > 0 && new URL(origin).host === host.toLowerCase()
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { error: '跨源请求被拒绝' })
  return true
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 1024 * 1024) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/** 白名单清洗:保序剔非字符串/空串/重复(SC-12)。 */
export function cleanAllowlist(list) {
  const seen = new Set()
  const out = []
  for (const name of Array.isArray(list) ? list : []) {
    if (typeof name !== 'string' || name.trim() === '') continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 写请求公共序列:跨源守卫 → JSON 解析(失败 400)→ 业务异常归一 400。 */
async function writeRoute(req, res, handler) {
  if (rejectCrossOrigin(req, res)) return
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    sendJson(res, 400, { error: '请求体须为 JSON' })
    return
  }
  try {
    await handler(body)
  } catch (error) {
    sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
  }
}

/**
 * 挂载路由行。faces = { readState, updateAllowlist, updateEnabled }。
 * @param {object} ctx 行上下文(webServer 服务在场,inject 门控)
 * @param {object} faces 业务适配层
 */
export function mountRoutes(ctx, faces) {
  const webServer = ctx.get('webServer')
  const routes = [
    {
      path: `${API_ROOT}/state`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, faces.readState())
      },
    },
    {
      path: `${API_ROOT}/allowlist`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        await writeRoute(req, res, async (body) => {
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('请求体必须是对象')
          sendJson(res, 200, await faces.updateAllowlist(cleanAllowlist(body.allowlist)))
        })
      },
    },
    {
      path: `${API_ROOT}/enabled`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        await writeRoute(req, res, async (body) => {
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('请求体必须是对象')
          if (typeof body.enabled !== 'boolean') throw new Error('enabled 须为布尔')
          sendJson(res, 200, await faces.updateEnabled(body.enabled))
        })
      },
    },
    {
      path: `${API_ROOT}/collapse`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        await writeRoute(req, res, async (body) => {
          if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('请求体必须是对象')
          if (typeof body.collapse !== 'boolean') throw new Error('collapse 须为布尔')
          sendJson(res, 200, await faces.updateCollapse(body.collapse))
        })
      },
    },
  ]
  for (const item of routes) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: item.path, handler: item.handler }), `tool-gate ${item.path}`)
  }
}
