// HTTP 层('/api/tool-gate/*'):具名 exact 路由 + 共享 route-gate 闸门(宿主闸门 +
// 写方法同源/JSON content-type)+ 请求体形态校验 + 业务异常归一 400。写请求
// 守卫与体校验集中在 writeRoute,routes 表驱动;webServer 缺席(headless)只
// 告警跳过,不打断行。

import { withRouteGate } from './route-gate.mjs'
import { cleanAllowlist } from './config.mjs'

export { cleanAllowlist }

const API_ROOT = '/api/tool-gate'

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 请求体上限:超限按 413 回,不静默截断。
const BODY_MAX_BYTES = 1024 * 1024

const bodyTooLarge = () => Object.assign(new Error('请求体超过上限'), { overLimit: true })

// 超限后继续丢弃流入而不销毁 socket:先 destroy 的话 413 送不出去,对端只见
// ECONNRESET(桩测试不覆盖真实 socket,漏掉过一轮)。
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

/** 请求体白名单形态校验:缺字段/非数组/含非字符串或空白项一律 400,不静默清空。 */
function requireAllowlist(body) {
  if (!Array.isArray(body.allowlist)) throw new Error('allowlist 须为工具名数组')
  if (body.allowlist.some((name) => typeof name !== 'string' || name.trim() === '')) {
    throw new Error('allowlist 每项须为非空工具名字符串')
  }
  return body.allowlist
}

/** 写请求公共序列(同源与 JSON content-type 已由 route-gate 判定):JSON 解析
 * (坏体 400 / 超限 413)→ 业务异常归一 400。 */
async function writeRoute(req, res, handler) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    const overLimit = error?.overLimit === true
    sendJson(res, overLimit ? 413 : 400, { error: overLimit ? error.message : '请求体须为 JSON' })
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
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('tool-gate: webServer 服务不在场(headless 部署),设置页路由跳过;收敛本体不受影响')
    return
  }
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
          sendJson(res, 200, await faces.updateAllowlist(cleanAllowlist(requireAllowlist(body))))
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
    ctx.effect(() => webServer.register({ kind: 'exact', path: item.path, handler: withRouteGate(ctx, item.handler) }), `tool-gate ${item.path}`)
  }
}
