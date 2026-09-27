// api: REST 路由 /api/tunnel/*。宿主 webServer 仅支持 exact/prefix 注册,
// 本插件注册一条 prefix, handler 内按 method + 路径段表驱动分发(:name 路径段捕获);
// 隧道增删改查直通宿主半区 tunnelsApi(open/list/close 同一入口, 与 ai 工具面同表);
// 错误语义对齐仓内惯例: 业务错误中文透传, 系统级错误收敛固定文案并落服务端日志。

const BODY_MAX_BYTES = 64 * 1024

export const ROUTE_PREFIX = '/api/tunnel'

export const MESSAGES = {
  notFound: '接口不存在',
  badJsonBody: '请求体不是合法 JSON',
  bodyTooLarge: '请求体超过上限',
  systemError: '操作失败(系统级错误, 详见服务端日志)',
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function respondError(res, error, logSystem) {
  const isSystem = Boolean(error && typeof error.code === 'string' && error.code !== '')
  if (isSystem && logSystem) logSystem(String(error && error.stack || error))
  const message = isSystem ? MESSAGES.systemError : (error && error.message ? error.message : String(error))
  sendJson(res, 400, { error: message })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        reject(new Error(MESSAGES.bodyTooLarge))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    if (error && error.message === MESSAGES.bodyTooLarge) throw error
    throw new Error(MESSAGES.badJsonBody)
  }
  return body && typeof body === 'object' ? body : {}
}

// readUi/updateUi: 设置读写在宿主半区(settings 服务语义归属 index.js), 此处仅路由
export function createApi({ tunnelsApi, readUi, updateUi, logSystem }) {
  const routes = [
    { method: 'GET', segments: ['tunnels'], handler: () => ({ items: tunnelsApi.list().tunnels }) },
    { method: 'POST', segments: ['tunnels'], handler: ({ body }) => {
      const outcome = tunnelsApi.open(body)
      if (!outcome.ok) throw new Error(outcome.error)
      return outcome
    } },
    { method: 'DELETE', segments: ['tunnels', ':name'], handler: ({ params }) => tunnelsApi.close({ name: params.name }) },
    { method: 'GET', segments: ['status'], handler: () => ({ ui: readUi(), total: tunnelsApi.list().tunnels.length }) },
    { method: 'POST', segments: ['ui-settings'], handler: ({ body }) => updateUi(body) },
  ]

  function matchRoute(method, segments) {
    for (const route of routes) {
      if (route.method !== method || route.segments.length !== segments.length) continue
      const params = {}
      let matched = true
      for (let i = 0; i < segments.length && matched; i++) {
        const expected = route.segments[i]
        if (expected.startsWith(':')) {
          try {
            params[expected.slice(1)] = decodeURIComponent(segments[i])
          } catch {
            matched = false
          }
        } else matched = expected === segments[i]
      }
      if (matched) return { route, params }
    }
    return null
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost')
      const pathname = url.pathname.startsWith(ROUTE_PREFIX + '/')
        ? url.pathname.slice(ROUTE_PREFIX.length)
        : url.pathname === ROUTE_PREFIX ? '/' : null
      if (pathname === null) {
        sendJson(res, 404, { error: MESSAGES.notFound })
        return
      }
      const segments = pathname.split('/').filter(Boolean)
      try {
        const matched = matchRoute(req.method, segments)
        if (!matched) {
          sendJson(res, 404, { error: MESSAGES.notFound })
          return
        }
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined
        sendJson(res, 200, await matched.route.handler({ req, res, url, params: matched.params, body }))
      } catch (error) {
        respondError(res, error, logSystem)
      }
    },
  }
}
