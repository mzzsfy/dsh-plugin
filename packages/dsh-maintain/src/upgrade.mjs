// 升级命令执行器:受控 spawn + 超时树终止 + 尾部输出收集。
// 自建而非用宿主 ctx.subprocess:需以假命令真实进程做单测,且行为完全本地可控。
// 命令模板是含参数的完整 shell 命令串,两端都必须 shell 化执行:Windows 经 cmd.exe
// (.cmd shim,CVE-2024-27980 加固后 spawn 无 shell 会拒绝 .cmd),POSIX 经 /bin/sh -c
// (shell:false 会把整串当可执行文件路径,必 ENOENT)。访问控制完全由外层鉴权
// 插件(dsh-web-startup-auth)负责,shell 化不扩大攻击面。

import { spawn } from 'node:child_process'

const OUTPUT_TAIL_BYTES = 2000
const SPAWN_ERROR_CODE = 127
// 树终止后的宽限期:子进程树拒死(权限/管道悬挂)时强制收敛,防升级门闩永久卡死
const KILL_GRACE_MS = 5 * 1000

function collectTail(stream) {
  let text = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    text = (text + chunk).slice(-OUTPUT_TAIL_BYTES)
  })
  return () => text.trim()
}

// POSIX 侧 detached 建进程组,超时按组杀(对齐 win32 taskkill /T 语义);
// npm install 派生的孙进程不再幸存占住 stdio 管道。
function killTree(child, platform) {
  if (platform === 'win32') {
    if (child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => {})
    }
    return
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // 进程组已不存在,回退直杀
    }
  }
  child.kill('SIGKILL')
}

// 执行结束返回结果对象,一切失败(含 spawn 本身失败与树终止后进程拒死)都收敛为
// ok:false,不抛错、不悬挂:kill 后等 close,宽限期到点仍未 close 即强制 resolve。
export function runUpgrade({ command, timeoutMs }) {
  const platform = process.platform
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(command, {
        shell: true,
        detached: platform !== 'win32',
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
    let killRequested = false
    const getStdoutTail = collectTail(child.stdout)
    const getStderrTail = collectTail(child.stderr)
    const settle = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      // 兜底收敛时拒死进程仍持有 stdio 管道:显式销毁并不再让子进程持有事件循环,
      // 防宿主退出悬挂与门闩释放后的管道泄漏
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      resolve({
        ok: code === 0,
        code,
        timedOut: killRequested,
        stdoutTail: getStdoutTail(),
        stderrTail: getStderrTail(),
        durationMs: Date.now() - startedAt,
      })
    }
    const timer = setTimeout(() => {
      killRequested = true
      killTree(child, platform)
      // 树终止后正常路径等 close;拒死场景由宽限期兜底强制收敛
      graceTimer = setTimeout(() => settle(null), KILL_GRACE_MS)
    }, timeoutMs)
    let graceTimer = null

    child.on('error', () => {
      // error 事件后必有 close;此处不 resolve,交给 close 统一收敛
    })

    child.on('close', (code) => {
      settle(code)
    })
  })
}
