// 交互会话:启动后持有进程,输出实时累积,agent 与 UI 共用 read/send 通道。
// 上限与空闲回收防泄漏;每会话输出留全量增量游标,环形上限按字节淘汰。

import { spawn } from 'node:child_process'
import { spawnShell, killTree } from './exec.mjs'

export const SESSION_LIMIT = 8
export const SESSION_IDLE_MS = 10 * 60 * 1000
// 单会话输出保留字节上限(超过丢最旧)
const SESSION_BUFFER_BYTES = 1024 * 1024

export function createSessions({ now = Date.now } = {}) {
  let seq = 0
  const sessions = new Map()

  function sweep() {
    const stamp = now()
    for (const [id, session] of sessions) {
      if (session.child.exitCode !== null || session.child.signalCode !== null) {
        if (stamp - session.lastActiveAt >= SESSION_IDLE_MS) sessions.delete(id)
        continue
      }
      if (stamp - session.lastActiveAt >= SESSION_IDLE_MS) {
        killTree(session.child)
        session.status = 'killed-idle'
        sessions.delete(id)
      }
    }
  }

  // 启动交互会话(host=null 本机;SSH 会话由 ssh.mjs 包装 argv 传入)
  function start(command, { host = null, argv = null, cwd, env } = {}) {
    sweep()
    if (sessions.size >= SESSION_LIMIT) {
      const error = new Error(`交互会话已达上限 ${SESSION_LIMIT},请先 kill 空闲会话`)
      error.code = 'SESSION_LIMIT'
      throw error
    }
    const base = {
      cwd: cwd || undefined,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    }
    const child = argv !== null
      ? spawn(argv[0], argv[1], base)
      : spawnShell(command, base)
    const id = `s-${++seq}-${now().toString(36)}`
    const session = {
      id, command, host, child,
      createdAt: now(), lastActiveAt: now(),
      status: 'running', exitCode: null, signal: null,
      buffer: [], bufferedBytes: 0, totalBytes: 0,
      waiters: [],
    }
    const pushBuffer = (chunk) => {
      session.totalBytes += chunk.length
      session.buffer.push(chunk)
      session.bufferedBytes += chunk.length
      while (session.bufferedBytes > SESSION_BUFFER_BYTES && session.buffer.length > 1) {
        session.bufferedBytes -= session.buffer[0].length
        session.buffer.shift()
      }
      session.lastActiveAt = now()
      for (const waiter of session.waiters.splice(0)) waiter()
    }
    child.stdout.on('data', pushBuffer)
    child.stderr.on('data', pushBuffer)
    child.on('error', (error) => {
      session.status = 'error'
      session.error = String(error.message || error)
      pushBuffer(Buffer.from(`\n[启动失败] ${session.error}\n`))
    })
    child.on('close', (code, signal) => {
      session.status = code === null && signal ? 'killed' : 'exited'
      session.exitCode = code
      session.signal = signal
      pushBuffer(Buffer.from(`\n[会话结束 code=${code} signal=${signal}]\n`))
    })
    sessions.set(id, session)
    return session
  }

  function get(id) {
    const session = sessions.get(id)
    if (!session) {
      const error = new Error(`未知会话 ${id}`)
      error.code = 'NO_SESSION'
      throw error
    }
    return session
  }

  // 读增量:since 为字节游标(基于 totalBytes 截断前的完整流)
  function read(id, since = 0) {
    const session = get(id)
    if (!Number.isInteger(since) || since < 0) since = 0
    const parts = []
    let offset = 0
    for (const chunk of session.buffer) {
      const start = Math.max(since - offset, 0)
      if (start < chunk.length) parts.push(chunk.subarray(start))
      offset += chunk.length
    }
    return {
      session: describe(session),
      output: Buffer.concat(parts).toString('utf-8'),
      cursor: session.totalBytes,
    }
  }

  function send(id, text, { newline = true } = {}) {
    const session = get(id)
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      throw new Error(`会话已结束,无法写入`)
    }
    session.child.stdin.write(text + (newline ? '\n' : ''))
    session.lastActiveAt = now()
    return describe(session)
  }

  // 终止并等待进程真正退出(Windows taskkill 异步,避免 running 状态悬挂)
  async function kill(id) {
    const session = get(id)
    if (session.status === 'running') {
      const closed = new Promise((resolve) => session.child.once('close', resolve))
      killTree(session.child)
      await closed
    }
    return describe(session)
  }

  function describe(session) {
    return {
      id: session.id,
      command: session.command,
      host: session.host,
      status: session.status,
      exitCode: session.exitCode,
      running: session.status === 'running',
      totalBytes: session.totalBytes,
      createdAt: session.createdAt,
    }
  }

  function list() {
    return [...sessions.values()].map(describe)
  }

  // 等待输出增长或状态变化(轮询的替代,短等待;控制通道用)
  function waitChange(id, timeoutMs) {
    const session = get(id)
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      session.waiters.push(done)
    })
  }

  return { start, read, send, kill, list, get, describe, sweep }
}
