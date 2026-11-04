import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createTerminalTool } from './lib/tool.mjs'
import { readControllerViewport } from './lib/private-screen.mjs'
import { createPumpFactory } from './lib/attach-pump.mjs'
import { createWaitSkipRegistry } from './lib/wait-skip.mjs'

export const name = 'dsh-shared-terminal'
export const inject = ['terminalController', 'tools', 'webServer']
// 仅实测过私有结构的精确版本;其余版本 clean-disable。
export const SUPPORTED_VERSIONS = Object.freeze(['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5'])
// 两代写模型:0.2.0 系(自 rc.1 起)与 0.2.1-alpha.2 蹭 UI 附着直调 write;0.2.1-rc.2 起 write 移除,改自持 attach 泵
const METHODS_LEGACY = ['shells', 'list', 'create', 'write', 'close', 'terminal']
const METHODS_SHARED = ['shells', 'list', 'create', 'attach', 'close', 'terminal']
const WAIT_SKIP_PATH = '/api/shared-terminal/wait/skip'
const WAIT_SKIP_BODY_MAX_BYTES = 64 * 1024
const require = createRequire(import.meta.url)

const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const readBody = (req, res) => new Promise((resolve, reject) => {
  let size = 0
  let over = false
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > WAIT_SKIP_BODY_MAX_BYTES) {
      // 只暂停流入并标记超限,不销毁 socket:连接毁了 413 就送不出去
      over = true
      req.pause()
      reject(Object.assign(new Error('请求体超过上限'), { overLimit: true }))
      return
    }
    if (!over) chunks.push(chunk)
  })
  req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')) })
  req.on('error', () => { if (!over) reject(new Error('请求体读取失败')) })
  // 超限后 end 不再流到(已暂停):挂 res 收尾销毁,防 socket 悬挂
  res.on('finish', () => req.destroy())
})

// 跨源防护以 Origin 与 Host 同源比对为上限(仓库安全边界约定,不做自有认证层)
const rejectCrossOrigin = (req, res) => {
  const origin = req.headers?.origin
  if (!origin) return false
  let sameOrigin = false
  try {
    sameOrigin = new URL(origin).host === req.headers?.host
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { error: '跨源请求被拒绝' })
  return true
}

// wait 手动打断路由:client 卡片「跳过等待」经此 abort 同键全部 pending wait
function createWaitSkipHandler(waitSkipRegistry) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (rejectCrossOrigin(req, res)) return
    let body
    try {
      body = JSON.parse(await readBody(req, res))
    } catch (error) {
      const overLimit = error?.overLimit === true
      sendJson(res, overLimit ? 413 : 400, { error: overLimit ? error.message : '请求体须为 JSON' })
      return
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const terminalId = typeof body?.terminalId === 'string' ? body.terminalId.trim() : ''
    if (sessionId === '' || terminalId === '') {
      sendJson(res, 400, { error: 'sessionId 与 terminalId 不能为空' })
      return
    }
    sendJson(res, 200, { ok: true, skipped: waitSkipRegistry.skip(sessionId, terminalId) })
  }
}

// 供 apply 装配与测试捕获共用的路由注册体
function registerWaitSkipRoutes(ctx, { waitSkipRegistry, tools, controller, defineTool, version }) {
  const webServer = ctx.get('webServer')
  const hasLegacyWrite = typeof controller?.write === 'function'
  const required = hasLegacyWrite ? METHODS_LEGACY : METHODS_SHARED
  if (!SUPPORTED_VERSIONS.includes(version) || typeof defineTool !== 'function'
    || typeof tools?.register !== 'function' || !(controller?.owners instanceof Map)
    || required.some((method) => typeof controller[method] !== 'function')
    || [...controller.owners.values()].some((owner) => !(owner?.terminals instanceof Map))) {
    ctx.logger?.warn?.(`[dsh-shared-terminal] 需要 Controller ${SUPPORTED_VERSIONS.join(' 或 ')} 与私有 lookup/queue,插件停用`)
    return
  }
  const pumpFactory = hasLegacyWrite ? undefined : createPumpFactory(controller)
  const waitSkipHandler = createWaitSkipHandler(waitSkipRegistry)
  ctx.effect(() => {
    const stopTool = tools.register(createTerminalTool({ controller, readScreen: readControllerViewport, defineTool, pumpFactory, waitSkipRegistry }))
    // 形状漂移(有服务无 register)直接抛错暴露宿主 API 变更,不做静默降级
    const unregisterRoute = webServer.register({ kind: 'exact', path: WAIT_SKIP_PATH, handler: waitSkipHandler })
    return () => {
      stopTool?.()
      unregisterRoute?.()
      waitSkipRegistry.abortAll()
      return pumpFactory?.dispose()
    }
  })
}

export function registerTerminalTool(ctx, { version, defineTool, waitSkipRegistry = createWaitSkipRegistry() }) {
  registerWaitSkipRoutes(ctx, {
    version,
    defineTool,
    controller: ctx.get('terminalController'),
    tools: ctx.get('tools'),
    waitSkipRegistry,
  })
}

export async function apply(ctx) {
  try {
    const toolsEntry = await realpath(require.resolve('@deepseek-ai/dsh-tools'))
    const hostRequire = createRequire(toolsEntry)
    const manifest = JSON.parse(await readFile(hostRequire.resolve('@deepseek-ai/dsh-api-terminal-controller/package.json'), 'utf8'))
    const api = await import(pathToFileURL(toolsEntry).href)
    registerTerminalTool(ctx, { version: manifest.version, defineTool: api.defineTool })
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-shared-terminal] 宿主依赖加载失败,插件停用: ${error.message}`)
  }
}
