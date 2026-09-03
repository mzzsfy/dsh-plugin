// MCP server 装配:官方 SDK,stdio 传输。main() 由 bin 调用(Windows argv[1] 判定不可靠,
// 采纳参考实现结论);start() 供测试与嵌入方编程启动。

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, PingRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { createGuard } from './guard.mjs'
import { createTools } from './tools.mjs'
import { createControl } from './control.mjs'
import { homeDirOf } from './config.mjs'

export const SERVER_INFO = { name: 'agent-shell', version: '0.1.0' }

export function createCore({ env = process.env, log = () => {} } = {}) {
  const core = {
    guard: createGuard(env),
    registry: new Map(),
    sourceOverride: null,
    controlEnabled: false,
    emit: () => {},
    log,
  }
  core.tools = createTools(core)
  if (env.AGENT_SHELL_CONTROL === '1') {
    const control = createControl({ core, homeDir: homeDirOf(env), log })
    core.control = control
    core.controlEnabled = true
    core.emit = (event) => control.emit(event)
  }
  return core
}

export async function start({ env = process.env, log = () => {} } = {}) {
  const core = createCore({ env, log })
  if (core.control !== undefined) await core.control.start()
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: core.tools.definitions }))
  server.setRequestHandler(PingRequestSchema, () => ({}))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    log(`tools/call ${name}`)
    try {
      return await core.tools.call(name, args ?? {})
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: String(error?.message || error) }) }], isError: true }
    }
  })
  const stop = async () => {
    if (core.control !== undefined) await core.control.stop()
    await server.close()
  }
  return { core, server, stop }
}

export async function main({ env = process.env } = {}) {
  const log = (message) => {
    // 日志只走 stderr:stdout 是 MCP 协议通道
    process.stderr.write(`[agent-shell] ${message}\n`)
  }
  const { server, core, stop } = await start({ env, log })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`ready (serverInfo=${SERVER_INFO.name}@${SERVER_INFO.version}, control=${core.controlEnabled ? 'on' : 'off'})`)
  const shutdown = () => {
    stop().catch(() => {}).finally(() => process.exit(0))
  }
  // stdio MCP 生命周期惯例:客户端关闭 stdin 即退出
  process.stdin.once('end', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
