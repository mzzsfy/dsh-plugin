// 配置:黑白名单、审批模式。文件位于 AGENT_SHELL_HOME/config.json(默认 ~/.agent-shell),
// 热加载:mtime 变化即重读;内置默认黑名单始终合并生效,用户配置追加或覆盖模式。

import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const DEFAULT_APPROVAL_TIMEOUT_MS = 90 * 1000
export const DEFAULT_COMMAND_TIMEOUT_MS = 120 * 1000
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000

// 内置危险命令基线:匹配整条命令字符串,大小写不敏感。
// 用户配置的 blacklist 是追加,白名单命中可豁免黑名单(审批仍按 approvalMode)。
export const BUILTIN_BLACKLIST = [
  // 盘面毁灭
  String.raw`rm\s+(-[a-z]*[rf]{1,2}[a-z]*\s+)+(\/|~|\*|\.)\s*$`,
  String.raw`rm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)`,
  String.raw`\bmkfs(\.\w+)?\b`,
  String.raw`\bdd\b[^|]*\bof=\/dev\/`,
  String.raw`\bwipefs\b`,
  String.raw`\bblkdiscard\b`,
  // 系统控制
  String.raw`(^|\s|;|&&|\|)\s*(sudo\s+)?(shutdown|reboot|poweroff|halt|init)\s+(0|6|-h|-r|now)`,
  // 递归权限灾害
  String.raw`chmod\s+-R\s+777\s+\/(\s|$)`,
  String.raw`chown\s+-R\s+\S+\s+\/(\s|$)`,
  // fork 炸弹
  String.raw`:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;?\s*:`,
  // 重定向覆盖设备
  String.raw`>\s*\/dev\/(sd|nvme|vd|hd)`,
  // Windows(compile 统一 i 标志;JS RegExp 不支持 (?i) 内联)
  String.raw`\bformat\s+[a-z]:`,
  String.raw`\b(rd|rmdir|del|erase)\b[^&|;]*\/[sq][^&|;]*\s+c:\\(\s|$)`,
  String.raw`\bRemove-Item\b[^|;]*-Recurse[^|;]*\s+C:\\(\s|$)`,
]

export const DEFAULT_CONFIG = Object.freeze({
  // blacklist: 命中即拦(走审批);whitelist: 命中即放行(仅 mode=whitelist 时作为准入, blacklist 模式下作为黑名单豁免)
  // mode: 'blacklist'(默认,命中黑名单走审批)| 'whitelist'(不在白名单走审批)
  mode: 'blacklist',
  blacklist: [],
  whitelist: [],
  // 审批模式:'ui' = 挂起等 UI 批准(control 未开时自动降级为 'deny');'deny' = 直接拒绝
  approvalMode: 'ui',
  approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
})

export function homeDirOf(env = process.env) {
  return env.AGENT_SHELL_HOME || join(homedir(), '.agent-shell')
}

export function configPathOf(env = process.env) {
  return join(homeDirOf(env), 'config.json')
}

const AS_LIST = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : []

// 合并:字符串数组字段用户与内置拼接去重;标量字段用户覆盖;未知字段丢弃
export function mergeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = source.mode === 'whitelist' ? 'whitelist' : 'blacklist'
  const approvalMode = source.approvalMode === 'deny' ? 'deny' : 'ui'
  const approvalTimeoutMs = Number.isFinite(source.approvalTimeoutMs) && source.approvalTimeoutMs > 0
    ? Math.min(source.approvalTimeoutMs, 10 * 60 * 1000)
    : DEFAULT_CONFIG.approvalTimeoutMs
  return {
    mode,
    blacklist: [...new Set([...BUILTIN_BLACKLIST, ...AS_LIST(source.blacklist)])],
    whitelist: [...new Set(AS_LIST(source.whitelist))],
    approvalMode,
    approvalTimeoutMs,
  }
}

export async function readConfigFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    return mergeConfig(JSON.parse(text))
  } catch {
    return mergeConfig(undefined)
  }
}

// 幂等写:临时文件 + rename,读侧 mtime 热加载
export async function writeConfigFile(path, patch) {
  const next = mergeConfig({ ...DEFAULT_CONFIG, ...patch })
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.tmp'
  await writeFile(temp, JSON.stringify({
    mode: next.mode,
    blacklist: AS_LIST(patch?.blacklist) ?? [],
    whitelist: AS_LIST(patch?.whitelist) ?? [],
    approvalMode: next.approvalMode,
    approvalTimeoutMs: next.approvalTimeoutMs,
  }, null, 2))
  await rename(temp, path)
  return next
}

// 热加载器:缓存 mtime,变化才重读;无效正则在编译期剔除并计数,避免坏规则反复抛错
export function createConfigWatcher(path, { now = Date.now, probe = mtimeOf } = {}) {
  let cached = mergeConfig(undefined)
  let cachedAt = 0
  let cachedMtime = null
  let broken = new Map()
  return {
    current: () => cached,
    async refresh(force = false) {
      const stamp = now()
      if (!force && stamp - cachedAt < 2000) return cached
      cachedAt = stamp
      const mtime = await probe(path)
      if (!force && mtime !== null && mtime === cachedMtime) return cached
      cachedMtime = mtime
      const next = await readConfigFile(path)
      broken = new Map()
      cached = {
        ...next,
        compile(kind) {
          const out = []
          for (const source of next[kind]) {
            try {
              out.push(new RegExp(source, 'i'))
            } catch {
              broken.set(source, 'invalid regex')
            }
          }
          return out
        },
      }
      return cached
    },
    brokenRules: () => broken,
  }
}

async function mtimeOf(path) {
  try {
    const { stat } = await import('node:fs/promises')
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}
