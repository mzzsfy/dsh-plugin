// 浏览器半区路由:'/api/shell-select/*',形态照 dsh-maintain(具名 exact 路由 +
// 方法/跨源守卫 + 业务异常归一 400)。webServer 缺席(headless)时跳过,不影响
// shell 能力本体。faces 由执行器注入,路由层无自有状态。

// 路由前缀
const API_ROOT = '/api/shell-select'

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 同源守卫:浏览器写请求恒带 Origin,与 Host 不符即拒(官方 maintain 同构)
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

const route = (method, handler) => async (req, res) => {
  if (req.method !== method) {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  if (method === 'POST' && rejectCrossOrigin(req, res)) return
  try {
    await handler(req, res)
  } catch (error) {
    sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
  }
}

function readBody(req) {
  const BODY_MAX_BYTES = 64 * 1024
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        rejectBody(new Error('请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/**
 * 挂载配置/探测路由。可写操作(settings.update)在 settings 缺席时由闭包抛错归一 400。
 * @param {object} ctx cordis context
 * @param {{listShells: Function, readConfig: Function, updateConfig: Function, detect: Function, probe: Function}} faces
 */
export function mountRoutes(ctx, faces) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('shell-select: webServer 服务不在场(headless 部署),设置页路由跳过;可用 settings.yaml 配置 shell-select 节')
    return
  }
  const routes = [
    {
      // exact 路由以 path 为唯一键,GET/POST 在同一 handler 内分流
      path: `${API_ROOT}/config`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, { ...faces.readConfig(), resolved: faces.listShells() })
          return
        }
        await route('POST', async (req2, res2) => {
          const patch = JSON.parse(await readBody(req2))
          if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('请求体必须是对象')
          const next = await faces.updateConfig(patch)
          sendJson(res2, 200, { ok: true, resolved: next })
        })(req, res)
      },
    },
    {
      path: `${API_ROOT}/probe`,
      handler: route('POST', async (req, res) => {
        const { path: candidatePath } = JSON.parse(await readBody(req))
        if (typeof candidatePath !== 'string' || candidatePath.length === 0) throw new Error('path 必须是非空字符串')
        sendJson(res, 200, { exists: faces.probe(candidatePath) })
      }),
    },
    {
      path: `${API_ROOT}/detect`,
      handler: route('POST', async (req, res) => {
        const body = JSON.parse(await readBody(req))
        const kinds = Array.isArray(body?.kinds) ? body.kinds : undefined
        sendJson(res, 200, { found: faces.detect(kinds) })
      }),
    },
  ]
  for (const item of routes) {
    ctx.effect(() => webServer.register({ kind: 'exact', path: item.path, handler: item.handler }), `shell-select ${item.path}`)
  }
}
