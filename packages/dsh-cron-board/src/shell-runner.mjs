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
    // 返回 { promise, cancel }:cancel 幂等杀树并先落 cancelled 终态;
    // close 回调对已取消运行只做杀树兜底不覆盖终态
    run({ job, env, logSink }) {
      let resolveOutcome
      const promise = new Promise((resolve) => { resolveOutcome = resolve })
      const child = spawn(job.command, {
        shell: true,
        cwd: job.workdir || workdirFallback,
        env: { ...process.env, ...env },
        detached: !isWindows,
      })
      let timedOut = false
      let cancelled = false
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
          // 父 shell 可先退出而子孙仍持有管道;宽限后无条件清理整个 POSIX 组。
          if (!isWindows) {
            setTimeout(() => {
              try { process.kill(-child.pid, 'SIGKILL') }
              catch {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
              }
            }, KILL_GRACE_MS).unref()
          }
        }, job.timeoutMs)
      }

      child.on('error', (error) => {
        clearTimeout(timeoutGuard)
        logSink.append('\n[cron-board] 进程启动失败: ' + String(error) + '\n')
        resolveOutcome({ status: 'fail', exitCode: null })
      })
      child.on('close', (code) => {
        clearTimeout(timeoutGuard)
        // 取消路径已先落终态,close 不覆盖
        if (cancelled) return
        resolveOutcome({
          status: timedOut ? 'timeout' : code === 0 ? 'success' : 'fail',
          exitCode: code,
        })
      })
      const cancel = () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        cancelled = true
        logSink.append('\n[cron-board] 运行被取消,强制终止\n')
        killTree(child)
        resolveOutcome({ status: 'cancelled', exitCode: null })
      }
      return { promise, cancel }
    },
  }
}
