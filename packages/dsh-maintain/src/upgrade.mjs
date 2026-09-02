// 升级命令执行器:受控 spawn + 超时树终止 + 尾部输出收集。
// 自建而非用宿主 ctx.subprocess:需以假命令真实进程做单测,且行为完全本地可控。
// 命令模板是含参数的完整 shell 命令串,两端都必须 shell 化执行:Windows 经 cmd.exe
// (.cmd shim,CVE-2024-27980 加固后 spawn 无 shell 会拒绝 .cmd),POSIX 经 /bin/sh -c
// (shell:false 会把整串当可执行文件路径,必 ENOENT)。同源校验是动作路由的防线,
// shell 化不扩大攻击面。

import { spawn } from 'node:child_process'

const OUTPUT_TAIL_BYTES = 2000
const SPAWN_ERROR_CODE = 127

function collectTail(stream) {
  let text = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    text = (text + chunk).slice(-OUTPUT_TAIL_BYTES)
  })
  return () => text.trim()
}

function killTree(child, platform) {
  if (platform === 'win32') {
    if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGKILL')
}

// 执行结束返回结果对象,一切失败(含 spawn 本身失败)都收敛为 ok:false,不抛错。
export function runUpgrade({ command, timeoutMs }) {
  const platform = process.platform
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        ok: false,
        code: SPAWN_ERROR_CODE,
        timedOut: false,
        stdoutTail: '',
        stderrTail: error && error.message ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      })
      return
    }

    let settled = false
    const getStdoutTail = collectTail(child.stdout)
    const getStderrTail = collectTail(child.stderr)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child, platform)
      child.on('close', () => resolve({
        ok: false,
        code: null,
        timedOut: true,
        stdoutTail: getStdoutTail(),
        stderrTail: getStderrTail(),
        durationMs: Date.now() - startedAt,
      }))
    }, timeoutMs)

    child.on('error', () => {
      // error 事件后必有 close;此处不 resolve,交给 close 统一收敛
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        code,
        timedOut: false,
        stdoutTail: getStdoutTail(),
        stderrTail: getStderrTail(),
        durationMs: Date.now() - startedAt,
      })
    })
  })
}
