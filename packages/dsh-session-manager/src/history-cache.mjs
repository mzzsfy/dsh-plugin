// 历史输入工作区缓存:每工作区一个 JSON 文件(~/.dsh/historyPrompt/<工作区>-<hash>.json),
// 记录该工作区聚合后的人类输入(带 sid 溯源)。浮层请求直接读文件(毫秒级)立即返回,
// 对齐在后台解压最新产物与缓存合并写回——解压成本不落在用户等待路径上。
// extracts 段持久化每会话的提取结果与其产物 stat 指纹(mtimeMs+size):
// 对齐时先 stat 比对指纹,产物没变的会话不再解压——判断完全基于磁盘,跨重启生效。
// 文件名 = 工作区路径末段(可辨认)+ 路径哈希前缀(防不同目录同名冲突)

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile, rename } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

function workspaceFile(dir, cwd) {
  const leaf = cwd.split(/[\\/]/).filter(Boolean).pop() || 'root'
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  return join(dir, `${leaf}-${hash}.json`)
}

export function ensureCacheDir(dir) {
  return mkdir(dir, { recursive: true })
}

function normalize(parsed, cwd) {
  if (!parsed || parsed.cwd !== cwd || !Array.isArray(parsed.entries)) return null
  return {
    cwd,
    entries: parsed.entries,
    extracts: parsed.extracts && typeof parsed.extracts === 'object' ? parsed.extracts : {},
  }
}

export async function readWorkspaceCache(dir, cwd) {
  try {
    return normalize(JSON.parse(await readFile(workspaceFile(dir, cwd), 'utf8')), cwd)
  } catch {
    return null
  }
}

// 原子写:先写临时文件再改名,进程中断不会留下半截 JSON
export async function writeWorkspaceCache(dir, cwd, cache) {
  await ensureCacheDir(dir)
  const target = workspaceFile(dir, cwd)
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify({ cwd, entries: cache.entries, extracts: cache.extracts }, null, 0), 'utf8')
  await rename(tmp, target)
}

// global 浮层轮询用指纹缓存:每 3s 轮询都全量读取并 JSON.parse 所有工作区缓存文件,
// 单文件 entries 可达数百条,持续打开浮层时是秒级重复大 IO+CPU。以 (mtimeMs,size)
// 指纹复用上次解析结果,产物未变的文件不再读盘;写入侧经临时文件改名,mtime 必变,
// 指纹天然失效。模块级 Map 以全路径为键(防多目录同名文件串扰),条目数有界。
const globalCachePollState = new Map()

export async function listWorkspaceCachesCached(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    // 目录缺失/不可读:仅清本目录条目(分隔符锚定,防误清兄弟目录),条目自愈
    for (const key of globalCachePollState.keys()) {
      if (key.startsWith(dir + sep)) globalCachePollState.delete(key)
    }
    return []
  }
  const live = new Set()
  const caches = await Promise.all(names
    .filter((name) => name.endsWith('.json') && name !== PROMPTS_FILE)
    .map(async (name) => {
      const file = join(dir, name)
      live.add(file)
      let fingerprint
      try {
        const info = await stat(file)
        fingerprint = { mtimeMs: info.mtimeMs, size: info.size }
      } catch {
        globalCachePollState.delete(file)
        return null
      }
      const hit = globalCachePollState.get(file)
      if (hit !== undefined && hit.fp.mtimeMs === fingerprint.mtimeMs && hit.fp.size === fingerprint.size) {
        return hit.parsed
      }
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        if (!parsed || typeof parsed.cwd !== 'string' || !Array.isArray(parsed.entries)) {
          globalCachePollState.delete(file)
          return null
        }
        globalCachePollState.set(file, { fp: fingerprint, parsed })
        return parsed
      } catch {
        globalCachePollState.delete(file)
        return null
      }
    }))
  for (const key of globalCachePollState.keys()) {
    if (!live.has(key)) globalCachePollState.delete(key)
  }
  return caches.filter((cache) => cache && typeof cache.cwd === 'string' && Array.isArray(cache.entries))
}

// 常用提示词:全局单文件(不按工作区),记录用户显式收藏的输入文本。
// 收藏是用户意志,与自动对齐的历史缓存互不覆写
const PROMPTS_FILE = 'prompts.json'

function normalizePrompts(parsed) {
  if (!parsed || !Array.isArray(parsed.items)) return []
  return parsed.items
    .filter((item) => item && typeof item.text === 'string' && item.text.length > 0)
    .map((item) => ({ text: item.text, at: typeof item.at === 'number' ? item.at : 0 }))
}

export async function readPrompts(dir) {
  try {
    return normalizePrompts(JSON.parse(await readFile(join(dir, PROMPTS_FILE), 'utf8')))
  } catch {
    return []
  }
}

export async function writePrompts(dir, items) {
  await ensureCacheDir(dir)
  const target = join(dir, PROMPTS_FILE)
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify({ items }, null, 0), 'utf8')
  await rename(tmp, target)
}
