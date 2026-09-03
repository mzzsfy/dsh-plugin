// 最小 MCP stdio 客户端(测试用):newline JSON-RPC,握手 + tools/list + tools/call
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mcp-ssh.mjs')

export function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let buffer = ''
  const pending = new Map()
  let nextId = 1
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const resolver = pending.get(message.id)
      if (resolver) {
        pending.delete(message.id)
        resolver(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    // 静默:诊断时手动打开
    if (env.AGENT_TEST_VERBOSE) process.stderr.write(chunk)
  })
  const request = (method, params, timeoutMs = 30000) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting ${method}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  async function initialize() {
    const response = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-shell-test', version: '0.0.0' },
    })
    notify('notifications/initialized')
    return response
  }
  const stop = () => new Promise((resolve) => {
    child.stdin.end()
    child.kill('SIGKILL')
    child.on('close', resolve)
  })
  return { child, request, notify, initialize, stop, listTools: () => request('tools/list'), callTool: (name, args) => request('tools/call', { name, arguments: args }) }
}

export function textOf(response) {
  return JSON.parse(response.result.content[0].text)
}
