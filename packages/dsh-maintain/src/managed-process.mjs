import { spawn } from 'node:child_process'
import { join } from 'node:path'

const OUTPUT_LIMIT = 16 * 1024
const KILL_GRACE_MS = 5 * 1000

export function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    spawn(executable, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false }).on('error', () => {})
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

export function runProcess({ executable, args = [], cwd, env, timeoutMs, onOutput }) {
  if (typeof executable !== 'string' || !Array.isArray(args) || !args.every(a => typeof a === 'string') || !(timeoutMs > 0)) {
    throw new Error('受控进程参数无效')
  }
  return new Promise(resolve => {
    const startedAt = Date.now()
    let stdoutTail = ''
    let stderrTail = ''
    let timedOut = false
    let settled = false
    let timer
    let grace
    let child
    const finish = (code, stillRunning = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      child?.unref()
      resolve({ ok: code === 0 && !timedOut, code, timedOut, stillRunning, pid: child?.pid ?? null, stdoutTail, stderrTail, durationMs: Date.now() - startedAt })
    }
    try {
      child = spawn(executable, args, { shell: false, cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      stderrTail = error.message
      finish(null)
      return
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdoutTail = (stdoutTail + chunk).slice(-OUTPUT_LIMIT); onOutput?.(chunk) })
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-OUTPUT_LIMIT); onOutput?.(chunk) })
    child.on('error', error => { stderrTail = (stderrTail + error.message).slice(-OUTPUT_LIMIT) })
    child.on('close', code => finish(code))
    timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
      // 超时后的残留不作可复用证明，调用方保留失败目录和锁诊断。
      grace = setTimeout(() => finish(null, true), KILL_GRACE_MS)
    }, timeoutMs)
  })
}
