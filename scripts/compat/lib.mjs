// compat 脚本共享工具:路径常量与跨平台子进程执行
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, symlinkSync } from 'node:fs'

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const COMPAT_ROOT = join(REPO_ROOT, '.compat')
export const DSH_PACKAGE = '@deepseek-ai/dsh'
// dshmarket 固定 pin:旧宿主全家桶可共启的前提;allowBuilds 与根桥 pin 的对照来源均为
// docs/兼容性测试/测试与隔离方法.md 的 profile 章节与 CI test job,升级时同步复核
export const DSHMARKET_PIN = '1.47.0'
// 上游 dsh-app-boot 幽灵依赖 cordis-plugin-group(顶层 import 未声明,已考察宿主世代均缺),
// nodeLinker: hoisted 下整树无人声明不安装,boot 必炸;宿主闭包显式补装,移除条件与
// 手工流程对照见 docs/兼容性测试/测试与隔离方法.md 被测宿主安装节
export const CORDIS_GROUP_PIN = '1.0.2'
// compat 专用端口段起点,与人工隔离惯例的 9191 隔离,避免端口清理误杀开发者实例
export const DEFAULT_PORT = 9291
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

export function runCmd(name, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    // Windows 下 npm/pnpm 是 .cmd 入口,必须经 shell(参数均不含空白,拼接安全)
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn([name, ...args].join(' '), { cwd, shell: true, windowsHide: true })
      : spawn(cmdName(name), args, { cwd, shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${name} ${args.join(' ')} 退出码 ${code}\n${stderr.slice(-2000)}`))
    })
  })
}

// 目录符号链接(win32 junction 无需特权;父目录不存在先建)
export function symlinkDir(src, dst) {
  mkdirSync(dirname(dst), { recursive: true })
  symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
}

// 端口占用清理(linux 侧 fuser 来自 ubuntu 镜像自带 psmisc)
export function killPortOwner(port) {
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -ExpandProperty OwningProcess -Unique | ' +
      'ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }'], { windowsHide: true })
  } else {
    spawnSync('fuser', ['-k', `${port}/tcp`], { windowsHide: true })
  }
}

export function log(msg) {
  console.log(`[compat] ${msg}`)
}
