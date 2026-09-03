// dsh-agent-shell Host 半区:拉起 @mzzsfy/mcp-ssh 的 stdio MCP server,桥接为
// mcp__agent-shell__* 工具;control 通道代理到 /agent-shell/api/*,并为无
// better-sidebar 的环境提供 /agent-shell 简陋页。server 进程意外退出自动重启。

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, mkdir } from 'node:fs/promises'
import { createMcpClient } from './mcp-client.mjs'
import { createRoutes } from './routes.mjs'
import { resolveServerEntry } from './dependency.mjs'

export const name = 'dsh-agent-shell'
export const inject = ['tools', 'webServer']

const SERVER_NAME = 'agent-shell'
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`
const DEPENDENCY_NAME = '@mzzsfy/mcp-ssh'
// 依赖缺失后的重探测间隔:依赖装好后无需重启 dsh 即自愈
const DEPENDENCY_RETRY_MS = 30 * 1000
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
    status: 'starting',
    missing: '',
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
    const entry = resolveServerEntry(DEPENDENCY_NAME)
    if (entry === null) {
      state.status = 'dependency-missing'
      state.missing = DEPENDENCY_NAME
      throw new Error(`依赖 ${DEPENDENCY_NAME} 未安装`)
    }
    state.status = 'starting'
    state.missing = ''
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
        state.status = 'ready'
        await state.client.whenClosed()
        state.status = 'server-exited'
      } catch (error) {
        state.lastError = String(error?.message || error)
        if (state.status === 'dependency-missing') {
          // 降级态:固定间隔重探测,不进重启计数,依赖装好后自愈
          console.warn(`[agent-shell] ${state.lastError},${Math.round(DEPENDENCY_RETRY_MS / 1000)}s 后重探测`)
          await sleepUnlessStopping(DEPENDENCY_RETRY_MS)
          continue
        }
        console.error(`[agent-shell] server 启动失败: ${state.lastError}`)
      }
      disposeBridge()
      if (state.stopping) break
      state.restarts += 1
      if (state.restarts > RESTART_MAX) {
        console.error(`[agent-shell] 连续重启超过 ${RESTART_MAX} 次,停止重启(${state.lastError})`)
        break
      }
      await sleepUnlessStopping(1000 * state.restarts)
    }
  }

  // 可中断 sleep:stopping 置位立即返回,避免 stop 时还挂着等间隔
  function sleepUnlessStopping(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(wake, ms)
      function wake() {
        clearInterval(poll)
        resolve()
      }
      const poll = setInterval(() => {
        if (state.stopping) {
          clearTimeout(timer)
          wake()
        }
      }, 500)
    })
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
