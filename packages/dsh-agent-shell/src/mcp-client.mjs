// 最小 MCP stdio 客户端:newline JSON-RPC 2.0,握手 + tools/list + tools/call。
// 与 @mzzsfy/mcp-ssh 的官方 SDK server 对话;协议面只到本插件所需子集。

import { createLineReader } from './wire.mjs'

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export function createMcpClient({ input, output, onNotification, log = () => {} }) {
  let nextId = 1
  const pending = new Map()
  let closed = false
  const closeWaiters = []

  const writeLine = (message) => {
    if (closed) throw new Error('mcp client: 传输已关闭')
    output.write(JSON.stringify(message) + '\n')
  }

  const disposeLine = createLineReader(input, (message) => {
    if (message === null || typeof message !== 'object') return
    if (message.id === undefined || message.id === null) {
      onNotification?.(message)
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message)
  })

  const onClose = () => {
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('mcp client: server 进程退出'))
    }
    pending.clear()
    for (const waiter of closeWaiters.splice(0)) waiter()
  }
  input.on('close', onClose)
  input.on('error', onClose)
  output.on('error', onClose)

  const request = (method, params, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('mcp client: 传输已关闭'))
        return
      }
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`mcp client: ${method} 超时`))
      }, timeoutMs)
      const onAbort = () => {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error('mcp client: 已取消'))
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(timer)
          reject(new Error('mcp client: 已取消'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      pending.set(id, {
        resolve: (message) => {
          signal?.removeEventListener('abort', onAbort)
          if (message.error !== undefined) reject(new Error(String(message.error.message || 'mcp error')))
          else resolve(message.result)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      try {
        writeLine({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  const notify = (method, params) => writeLine({ jsonrpc: '2.0', method, params })

  return {
    async initialize() {
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-agent-shell', version: '0.1.0' },
      }, { timeoutMs: 30 * 1000 })
      notify('notifications/initialized')
    },
    listTools: () => request('tools/list', {}, { timeoutMs: 30 * 1000 }),
    callTool: (name, args, signal) => request('tools/call', { name, arguments: args }, { signal }),
    whenClosed: () => new Promise((resolve) => {
      if (closed) resolve()
      else closeWaiters.push(resolve)
    }),
    get closed() {
      return closed
    },
    dispose: () => {
      disposeLine()
      try {
        output.end()
      } catch {}
      onClose()
    },
    log,
  }
}
