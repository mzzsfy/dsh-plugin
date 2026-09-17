// compat 脚本共享工具:路径常量与跨平台子进程执行
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const COMPAT_ROOT = join(REPO_ROOT, '.compat')
export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const DSHMARKET_PIN = '1.47.0'
export const DEFAULT_PORT = 9191
// 与 CI test job 同源:session-manager 顶层 import zod,经仓库根 node_modules 解析
export const ZOD_PIN = '4.5.4'
// pnpm 11 对未批准的依赖构建脚本按错误处理;清单 = 真实 profile 同款 + 宿主安装闭包(原生模块)
export const ALLOW_BUILDS = [
  'cloudflared',
  'node-pty',
  'cpu-features',
  'ssh2',
  '"@google/genai"',
  'protobufjs',
  'koffi',
  '"@deepseek-ai/dsh-subprocess-local"',
]

export function workspaceYaml() {
  return [
    'packages:\n  - .\n',
    `nodeLinker: hoisted\nautoInstallPeers: false\nminimumReleaseAge: 0\n`,
    'allowBuilds:\n' + ALLOW_BUILDS.map((name) => `  ${name}: true\n`).join(''),
  ].join('')
}

// Windows 下 npm/pnpm 是 .cmd 入口,spawn 必须经 shell 或补全后缀
export function cmdName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

export function runCmd(name, args, { cwd, capture = true, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    // Windows 下 npm/pnpm 是 .cmd 入口,必须经 shell(参数均不含空白,拼接安全)
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn([name, ...args].join(' '), { cwd, shell: true, windowsHide: true })
      : spawn(cmdName(name), args, { cwd, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      if (capture) stdout += chunk
      if (onStdout) onStdout(chunk)
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${name} ${args.join(' ')} 退出码 ${code}\n${stderr.slice(-2000)}`))
    })
  })
}

export function log(msg) {
  console.log(`[compat] ${msg}`)
}
