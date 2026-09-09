// ShellRunner:shell 形式执行 command,stdout/stderr 合流写 logSink(日志文件即执行现场);
// 环境变量注入叠加 process.env 基础之上;超时强制终止进程树记 timeout。
// Windows 下 shell:true 生成 cmd.exe 包装进程,直接 kill 不杀孙进程且管道不关闭,
// 须按平台杀整棵进程树:Windows taskkill /T,POSIX detached 进程组信号。

import { spawn } from 'node:child_process'

const KILL_GRACE_MS = 5 * 1000

const isWindows = process.platform === 'win32'

// 杀整棵进程树;调用方保证 child 仍在运行
function killTree(child) {
  if (isWindows) {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGKILL')
  }
}

export function createShellRunner({ workdirFallback }) {
  return {
    run({ job, env, logSink }) {
      return new Promise((resolve) => {
        const child = spawn(job.command, {
          shell: true,
          cwd: job.workdir || workdirFallback,
          env: { ...process.env, ...env },
          detached: !isWindows,
        })
        let timedOut = false
        let timeoutGuard

        const onChunk = (chunk) => {
          logSink.append(chunk.toString('utf8'))
        }
        child.stdout.on('data', onChunk)
        child.stderr.on('data', onChunk)

        if (job.timeoutMs > 0) {
          timeoutGuard = setTimeout(() => {
            timedOut = true
            logSink.append('\n[cron-board] 运行超时,强制终止\n')
            killTree(child)
            // 终止宽限兜底:树未被清干净时直接 SIGKILL 兜底(POSIX;Windows /F 已强杀)
            setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            }, KILL_GRACE_MS)
          }, job.timeoutMs)
        }

        child.on('error', (error) => {
          clearTimeout(timeoutGuard)
          logSink.append('\n[cron-board] 进程启动失败: ' + String(error) + '\n')
          resolve({ status: 'fail', exitCode: null })
        })
        child.on('close', (code) => {
          clearTimeout(timeoutGuard)
          resolve({
            status: timedOut ? 'timeout' : code === 0 ? 'success' : 'fail',
            exitCode: code,
          })
        })
      })
    },
  }
}
