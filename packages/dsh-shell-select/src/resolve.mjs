// shell 可执行文件候选探测(纯函数):候选顺序、自动解析与批量探测。
// 官方 dsh-pwsh-local candidatePwshPaths 语义同构,扩展 bash/cmd/wsl 三类。
// 存在性判定与官方 lstat 语义一致(isFile || isSymbolicLink),由构造方注入。

import { lstatSync } from 'node:fs'

// PATH 分隔符:仅 Windows 分号(本包 v1 仅 win32 激活)
const PATH_SEP = ';'

// 各 kind 的探测锚点:主 ProgramFiles;x86 与 LOCALAPPDATA 仅 bash 有常见安装
const PF_RELATIVE = {
  pwsh: [['PowerShell', '7', 'pwsh.exe']],
  bash: [['Git', 'bin', 'bash.exe']],
}

const PF_X86_RELATIVE = {
  bash: [['Git', 'bin', 'bash.exe']],
}

// LOCALAPPDATA 下的附加锚点(仅 bash 的 per-user Git 安装)
const LAD_RELATIVE = {
  bash: [['Programs', 'Git', 'bin', 'bash.exe']],
}

// System32 单文件锚点
const SYSTEM32_FILES = {
  pwsh: 'WindowsPowerShell\\v1.0\\powershell.exe',
  cmd: 'cmd.exe',
  wsl: 'wsl.exe',
}

// PATH 探测的可执行名
const PATH_EXECUTABLES = {
  pwsh: 'pwsh.exe',
  bash: 'bash.exe',
}

// MSYS2 默认安装锚点:真实 bash.exe 优先。msys2.exe(Cygwin 控制台启动器)
// 在管道 stdio 下 exit 0 且零输出——命令静默失败,任何情形不得进入候选
const MSYS2_ANCHORS = [
  'C:\\msys64\\usr\\bin\\bash.exe',
  'C:\\msys64\\bin\\bash.exe',
]

/**
 * 一个 kind 的候选路径,按解析顺序。显式参数化(env)保证纯函数性。
 * @param {string} kind pwsh|bash|cmd|wsl
 * @param {object} env 模拟进程环境
 * @returns {string[]}
 */
export function candidatePaths(kind, env) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env.LocalAppData ?? ''
  const system32 = `${env.SystemRoot ?? 'C:\\WINDOWS'}\\System32`
  const pathEntries = (env.PATH ?? '')
    .split(PATH_SEP)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0)
  // bash 的 PATH 探测排除 SystemRoot 下条目:System32\bash.exe 是 WSL forwarder,
  // 误命中会让 git-bash 客户端实际跑 WSL bash(方言/路径全变)。
  // 斜杠形态归一后比较,正斜杠 PATH 条目(手动配置)同样命中;剥尾分隔符防前缀永不匹配
  const systemRoot = String(env.SystemRoot ?? 'C:\\WINDOWS').toLowerCase().replace(/\//g, '\\').replace(/[\\/]+$/, '')
  const pathEntriesForKind = (kind) => (kind === 'bash'
    ? pathEntries.filter((entry) => !entry.toLowerCase().replace(/\//g, '\\').startsWith(`${systemRoot}\\`))
    : pathEntries)
  const candidates = []
  for (const relative of PF_RELATIVE[kind] ?? []) candidates.push([programFiles, ...relative].join('\\'))
  for (const relative of PF_X86_RELATIVE[kind] ?? []) candidates.push([programFilesX86, ...relative].join('\\'))
  for (const relative of LAD_RELATIVE[kind] ?? []) {
    if (localAppData.length > 0) candidates.push([localAppData, ...relative].join('\\'))
  }
  if (kind === 'bash') candidates.push(...MSYS2_ANCHORS)
  for (const entry of pathEntriesForKind(kind)) {
    const executable = PATH_EXECUTABLES[kind]
    if (executable !== undefined) candidates.push(`${entry}\\${executable}`)
  }
  const system32File = SYSTEM32_FILES[kind]
  if (system32File !== undefined) candidates.push(`${system32}\\${system32File}`)
  return candidates
}

/**
 * 解析一个 shell 条目的可执行路径:显式 path 原样信任;空 path 走候选探测。
 * @param {{kind: string, path: string}} entry
 * @param {(candidate: string) => boolean} exists 存在性判定(lstat 语义)
 * @param {object} [env] 模拟进程环境,缺省用 process.env
 * @returns {string|undefined} 无候选命中时 undefined
 */
export function resolveEntryPath(entry, exists, env = process.env) {
  if (entry.path.length > 0) return entry.path
  for (const candidate of candidatePaths(entry.kind, env)) {
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * 批量探测:给定 kind 集合,返回全部命中候选(保持 kind 顺序与候选顺序,
 * 同路径去重)。
 * @param {string[]} kinds
 * @param {object} env
 * @param {(candidate: string) => boolean} exists
 * @returns {{kind: string, path: string}[]}
 */
export function detectCandidates(kinds, env, exists) {
  const seen = new Set()
  const found = []
  for (const kind of kinds) {
    for (const candidate of candidatePaths(kind, env)) {
      if (seen.has(candidate)) continue
      if (!exists(candidate)) continue
      seen.add(candidate)
      found.push({ kind, path: candidate })
    }
  }
  return found
}

/** 生产存在性判定:官方 lstat 语义(isFile || isSymbolicLink,目录不匹配)。 */
export function candidateExists(candidate) {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}
