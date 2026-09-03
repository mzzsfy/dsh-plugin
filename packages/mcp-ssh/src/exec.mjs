// 本机命令执行:平台默认 shell(cmd / sh),进程树终止,输出头尾截断。
// stdin 可选预喂;超时杀树;stdout/stderr 独立限量。

import { spawn } from 'node:child_process'
import { platform } from 'node:os'

const WIN32 = platform() === 'win32'
export const OUTPUT_CHAR_LIMIT = 200 * 1024
// 截断时保留头部与尾部比例
const HEAD_RATIO = 0.6

// 平台 shell 执行:win32 走 shell:true(Node 正确处理 cmd 引号),POSIX 用 /bin/sh -c
export function spawnShell(command, options = {}) {
  if (WIN32) return spawn(command, { ...options, shell: true })
  return spawn('/bin/sh', ['-c', command], options)
}

// 树终止:Windows taskkill /T;POSIX 依赖 detached 进程组负 pid
export function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (WIN32) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      child.kill('SIGKILL')
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

// 流式解码 + 头尾保留截断;返回 { text(), truncated }
export function createCapture(limit = OUTPUT_CHAR_LIMIT) {
  const decoder = new TextDecoder('utf-8', { stream: true })
  let head = ''
  let tail = ''
  let total = 0
  let truncated = false
  return {
    push(chunk) {
      const text = decoder.decode(chunk, { stream: true })
      total += text.length
      if (head.length + tail.length < limit) {
        const room = limit - head.length
        if (text.length <= room) {
          head += text
        } else {
          head += text.slice(0, room)
          tail = text.slice(room)
        }
      } else {
        tail += text
        const overflow = tail.length - Math.floor(limit * (1 - HEAD_RATIO))
        if (overflow > 0) tail = tail.slice(overflow)
      }
      if (head.length + tail.length > limit) truncated = true
    },
    end() {
      const rest = decoder.decode()
      if (rest) this.push(Buffer.from(rest))
      return { truncated }
    },
    text() {
      const mark = truncated
        ? `\n[输出已截断,完整长度 ${total} 字符,仅保留头尾]\n`
        : ''
      return head + mark + tail
    },
  }
}

// 同步执行一条本地命令。返回 { exitCode, signal, timedOut, durationMs, stdout, stderr, truncated }
export function runLocal(command, { cwd, timeoutMs, stdin, env } = {}, onSpawn) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnShell(command, {
        cwd: cwd || undefined,
        env: env ? { ...process.env, ...env } : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !WIN32,
      })
    } catch (error) {
      resolve({ exitCode: 1, signal: null, timedOut: false, durationMs: 0, stdout: '', stderr: String(error.message || error), truncated: false })
      return
    }
    onSpawn?.(child)
    const out = createCapture()
    const err = createCapture()
    const startedAt = Date.now()
    let timedOut = false
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)
    }
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      err.push(Buffer.from(String(error.message || error)))
      resolve({ exitCode: 1, signal: null, timedOut: false, durationMs: Date.now() - startedAt, stdout: out.text(), stderr: err.text(), truncated: out.truncated || err.truncated })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      out.end()
      err.end()
      resolve({
        exitCode: timedOut ? null : code,
        signal: timedOut ? null : signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: out.text(),
        stderr: timedOut ? err.text() + '\n[命令超时被终止]' : err.text(),
        truncated: out.truncated || err.truncated,
      })
    })
    if (stdin) child.stdin.write(stdin)
    child.stdin.end()
  })
}
