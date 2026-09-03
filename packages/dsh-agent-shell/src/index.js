// dsh-agent-shell Host 半区:拉起 @mzzsfy/mcp-ssh 的 stdio MCP server,桥接为
// mcp__agent-shell__* 工具;control 通道代理到 /agent-shell/api/*,并为无
// better-sidebar 的环境提供 /agent-shell 简陋页。server 进程意外退出自动重启。

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { createMcpClient } from './mcp-client.mjs'
import { createRoutes } from './routes.mjs'

export const name = 'dsh-agent-shell'
export const inject = ['tools', 'webServer']

const SERVER_NAME = 'agent-shell'
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`
const HOME_DIR = join(homedir(), '.dsh', 'dsh-agent-shell')
const STATE_PATH = join(HOME_DIR, 'server.json')
const START_TIMEOUT_MS = 30 * 1000
const RESTART_MAX = 5
// 工具输出 schema:桥接层把 MCP content 规约成 {text, isError}
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, isError: { type: 'boolean' } },
  required: ['text'],
}

// server 入口 = 包内 bin(bin/mcp-ssh.mjs 调用 main());server.mjs 只导出不自动执行
function serverEntryPath() {
  const pkgUrl = fileURLToPath(import.meta.resolve('@mzzsfy/mcp-ssh/package.json'))
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'))
  return join(dirname(pkgUrl), pkg.bin['mcp-ssh'])
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 同源守卫:浏览器写请求恒带 Origin,与 Host 不符即拒(对齐 dsh-turn-notify)
function rejectCrossOrigin(req, res) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  let sameOrigin = false
  try {
    sameOrigin = new URL(origin).host === req.headers.host
  } catch {
    sameOrigin = false
  }
  if (!sameOrigin) sendJson(res, 403, { error: 'cross-origin write is rejected' })
  return !sameOrigin
}

async function waitStateFile() {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(STATE_PATH, 'utf8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`agent-shell: server 状态文件未生成(${STATE_PATH})`)
}

export function apply(ctx) {
  const tools = ctx.tools
  const webServer = ctx.webServer

  const state = {
    child: null,
    client: null,
    control: null,
    restarts: 0,
    stopping: false,
    registered: [],
    lastError: '',
  }

  async function controlFetch(pathname, { method = 'GET', body, timeoutMs = 60 * 1000 } = {}) {
    const control = state.control
    if (control === undefined || control === null) throw new Error('agent-shell: server 未就绪')
    const response = await fetch(`http://127.0.0.1:${control.port}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${control.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { error: text.slice(0, 200) }
    }
    return { status: response.status, payload }
  }

  function renderToolOutput(args, value) {
    return [{ type: 'text', text: value.text }]
  }

  function registerTools(definitions) {
    for (const definition of definitions) {
      const dispose = tools.register({
        name: TOOL_PREFIX + definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolOutput },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const result = await state.client.callTool(definition.name, args ?? {}, exec.signal)
          const content = Array.isArray(result?.content) ? result.content : []
          const text = content.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block))).join('\n')
          if (result?.isError === true) throw new Error(text)
          return { text, isError: false }
        },
      })
      state.registered.push(dispose)
    }
  }

  async function startServer() {
    const entry = serverEntryPath()
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        AGENT_SHELL_CONTROL: '1',
        AGENT_SHELL_HOME: HOME_DIR,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) console.log(`[agent-shell server] ${text}`)
    })
    state.child = child
    const client = createMcpClient({
      input: child.stdout,
      output: child.stdin,
      onNotification: () => {},
      log: (message) => console.log(`[agent-shell] ${message}`),
    })
    state.client = client
    await client.initialize()
    const list = await client.listTools()
    registerTools(list.tools ?? [])
    state.control = await waitStateFile()
    console.log(`[agent-shell] server ready: ${list.tools?.length ?? 0} tools, control on :${state.control.port}`)
  }

  function disposeBridge() {
    for (const dispose of state.registered.splice(0)) {
      try {
        dispose()
      } catch {}
    }
    if (state.client !== null) {
      state.client.dispose()
      state.client = null
    }
    if (state.child !== null) {
      const child = state.child
      state.child = null
      try {
        child.kill()
      } catch {}
    }
    state.control = null
  }

  async function restartLoop() {
    while (!state.stopping) {
      try {
        await startServer()
        state.restarts = 0
        state.lastError = ''
        await state.client.whenClosed()
      } catch (error) {
        state.lastError = String(error?.message || error)
        console.error(`[agent-shell] server 启动失败: ${state.lastError}`)
      }
      disposeBridge()
      if (state.stopping) break
      state.restarts += 1
      if (state.restarts > RESTART_MAX) {
        console.error(`[agent-shell] 连续重启超过 ${RESTART_MAX} 次,停止重启(${state.lastError})`)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * state.restarts))
    }
  }

  const pageHtml = readFile(join(dirname(fileURLToPath(import.meta.url)), 'page.html'), 'utf8')

  ctx.effect(() => {
    void restartLoop()
    return () => {
      state.stopping = true
      disposeBridge()
    }
  }, 'agent-shell: server lifecycle')

  ctx.effect(() => webServer.register(createRoutes({
    sendJson,
    readBody,
    rejectCrossOrigin,
    pageHtml: () => pageHtml,
    controlFetch,
    serverState: state,
  })), 'agent-shell: /agent-shell routes')
}
