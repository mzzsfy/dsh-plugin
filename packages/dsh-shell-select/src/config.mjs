// 设置 schema 与 argv 组装(纯函数):条目结构、出厂默认、按 kind 的 argv 形。
// pwsh argv 与编码前缀官方 dsh-pwsh-local 同构;bash argv 官方 dsh-bash-local 同构;
// cmd /d /s /c 与 wsl --exec 为本包定义的保守形态。

import z from '@deepseek-ai/schemastery'

// 支持的 shell 形态
export const KINDS = ['pwsh', 'bash', 'cmd', 'wsl']

// path 字段的自动解析标记值:空串走候选探测
export const RESOLVED_AUTO = ''

// pwsh 每命令前置的 UTF-8 输出钉扎(官方同构):子进程按 UTF-8 解码,
// Windows PowerShell 5.1 兜底默认写 OEM 代码页,不加会乱码
export const PWSH_ENCODING_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

// 模板占位符:args 数组中该标记项替换为 command;无标记则 command 追加末项
const COMMAND_PLACEHOLDER = '{command}'

// 执行器预算字段(官方 dsh-pwsh-local Config 同构,默认值逐项对齐;
// cwd 同官方无 default,缺省态由 resolve 落 process.cwd())
const EXECUTOR_DEFAULTS = {
  timeoutMs: 12e4,
  maxTimeoutMs: 6e5,
  maxOutputBytes: 64e3,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 3e3,
}

const shellEntry = z.object({
  id: z.string().required(),
  name: z.string().required(),
  kind: z.union(KINDS).required(),
  path: z.string().default(RESOLVED_AUTO),
  args: z.array(z.string()).default([]),
  login: z.boolean().default(false),
  distro: z.string().default(''),
  env: z.dict(z.string()).default({}),
})

export const Config = z.object({
  shells: z.array(shellEntry).default([
    { id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: RESOLVED_AUTO, args: [] },
    { id: 'git-bash', name: 'Git Bash', kind: 'bash', path: RESOLVED_AUTO, args: [] },
    { id: 'cmd', name: 'CMD', kind: 'cmd', path: RESOLVED_AUTO, args: [] },
  ]),
  default: z.string().default('pwsh'),
  cwd: z.string(),
  timeoutMs: z.number().default(EXECUTOR_DEFAULTS.timeoutMs),
  maxTimeoutMs: z.number().default(EXECUTOR_DEFAULTS.maxTimeoutMs),
  maxOutputBytes: z.number().default(EXECUTOR_DEFAULTS.maxOutputBytes),
  maxSpillBytes: z.number().default(EXECUTOR_DEFAULTS.maxSpillBytes),
  graceMs: z.number().default(EXECUTOR_DEFAULTS.graceMs),
})

/** 出厂默认配置(供文档与测试比对;schema 内 default 为同构静态值)。 */
export function defaultConfig() {
  return Config({})
}

/**
 * 按 id 取条目。
 * @param {Array<{id: string}>} shells
 * @param {string} id
 */
export function entryById(shells, id) {
  return shells.find((entry) => entry.id === id)
}

/**
 * 取本次调用生效的条目:显式 id 优先,缺省落 default。
 * @param {Array<{id: string}>} shells
 * @param {string|undefined} requested 模型传的 shell 参数
 * @param {string} fallbackId 配置的 default
 * @returns {{id: string, name: string, kind: string, path: string, args: string[]}}
 * @throws 未指定且 default 缺失/无效,或指定 id 不存在——文案带配置指引
 */
export function requireEntry(shells, requested, fallbackId) {
  const wanted = requested ?? fallbackId
  const entry = entryById(shells, wanted)
  if (entry !== undefined) return entry
  if (requested === undefined) {
    throw new Error(`no shell client to run: default "${fallbackId}" is not in the configured shells list; configure shells/default in the shell-select settings section or pass an explicit shell argument`)
  }
  throw new Error(`unknown shell client "${requested}"; available: ${shells.map((entry) => entry.id).join(', ') || '(none)'}; configure shells in the shell-select settings section`)
}

/**
 * 按条目组装精确 argv。
 * @param {{kind: string, path: string, args?: string[]}} entry 已解析 path 的条目
 * @param {string} command
 * @returns {string[]}
 */
export function buildArgv(entry, command) {
  if (entry.args !== undefined && entry.args.length > 0) {
    const hasPlaceholder = entry.args.includes(COMMAND_PLACEHOLDER)
    return [entry.path, ...entry.args.map((arg) => arg === COMMAND_PLACEHOLDER ? command : arg),
      ...(hasPlaceholder ? [] : [command])]
  }
  switch (entry.kind) {
    case 'pwsh': return [entry.path, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PWSH_ENCODING_PREAMBLE + command]
    // login:登录壳 source /etc/profile,把 /usr/bin 与 /mingw64/bin 注入 PATH
    // (msys2 无此形态时 tr/sed/gcc 类工具 command not found);默认保持 -c:
    // 官方 dsh-bash-local 同构,且不读 profile,输出无用户脚本副作用
    case 'bash': return [entry.path, ...(entry.login === true ? ['-lc'] : ['-c']), command]
    case 'cmd': return [entry.path, '/d', '/s', '/c', command]
    // distro:发行版选择仅默认形生效;args 模板条目全权接管 argv,模板分支优先
    case 'wsl': {
      const distroPrefix = entry.distro ? ['-d', entry.distro] : []
      return [entry.path, ...distroPrefix, '--exec', 'bash', '-c', command]
    }
    default: throw new Error(`shell-select: unknown kind ${JSON.stringify(entry.kind)}`)
  }
}
