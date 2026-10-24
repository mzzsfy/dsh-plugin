import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createTerminalTool } from './lib/tool.mjs'
import { readControllerViewport } from './lib/private-screen.mjs'
import { createPumpFactory } from './lib/attach-pump.mjs'

export const name = 'dsh-shared-terminal'
export const inject = ['terminalController', 'tools']
// 仅实测过私有结构的精确版本;其余版本 clean-disable。
export const SUPPORTED_VERSIONS = Object.freeze(['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2', '0.2.1-rc.2', '0.2.1-rc.3'])
// 两代写模型:0.2.0 系(自 rc.1 起)与 0.2.1-alpha.2 蹭 UI 附着直调 write;0.2.1-rc.2 起 write 移除,改自持 attach 泵
const METHODS_LEGACY = ['shells', 'list', 'create', 'write', 'close', 'terminal']
const METHODS_SHARED = ['shells', 'list', 'create', 'attach', 'close', 'terminal']
const require = createRequire(import.meta.url)

export function registerTerminalTool(ctx, { version, defineTool }) {
  const controller = ctx.get('terminalController')
  const tools = ctx.get('tools')
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
  ctx.effect(() => {
    const stopTool = tools.register(createTerminalTool({ controller, readScreen: readControllerViewport, defineTool, pumpFactory }))
    return () => { stopTool?.(); pumpFactory?.dispose() }
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
