// 浏览器半区路由:'/api/shell-select/*',形态照 dsh-maintain(具名 exact 路由 +
// 共享 route-gate 闸门:宿主闸门 + 写方法同源/JSON content-type + 业务异常归一)。
// webServer 缺席(headless)时跳过,不影响 shell 能力本体。faces 由执行器注入,
// 路由层无自有状态。

import { withRouteGate } from './route-gate.mjs'

// 路由前缀
const API_ROOT = '/api/shell-select'

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 请求体上限:超限按 413 回,不静默截断。
const BODY_MAX_BYTES = 64 * 1024

const bodyTooLarge = () => Object.assign(new Error('请求体超过上限'), { overLimit: true })

// 超限后继续丢弃流入而不销毁 socket:先 destroy 的话响应送不出去,对端只见
// ECONNRESET(只有真实 socket 才暴露,桩测试永远通过)。
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let settled = false
    const chunks = []
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (settled) return
      if (size > BODY_MAX_BYTES) {
        settle(rejectBody, bodyTooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(resolveBody, Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => settle(rejectBody, error))
  })
}

const route = (method, handler) => async (req, res) => {
  if (req.method !== method) {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  try {
    await handler(req, res)
  } catch (error) {
    const overLimit = error?.overLimit === true
    sendJson(res, overLimit ? 413 : 400, { error: error && error.message ? error.message : String(error) })
  }
}

/**
 * 挂载配置/探测路由。可写操作(settings.update)在 settings 缺席时由闭包抛错归一 400。
 * @param {object} ctx cordis context
 * @param {{listShells: Function, readConfig: Function, updateConfig: Function, detect: Function, probe: Function, pathMap: Function}} faces
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
          const { resolved, refreshFailed, noExecutor } = await faces.updateConfig(patch)
          sendJson(res2, 200, { ok: true, resolved, refreshFailed, noExecutor })
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
      path: `${API_ROOT}/pathmap`,
      handler: route('GET', async (req, res) => {
        sendJson(res, 200, faces.pathMap())
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
    ctx.effect(() => webServer.register({ kind: 'exact', path: item.path, handler: withRouteGate(ctx, item.handler) }), `shell-select ${item.path}`)
  }
}
