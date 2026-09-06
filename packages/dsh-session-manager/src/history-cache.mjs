// 历史输入工作区缓存:每工作区一个 JSON 文件(~/.dsh/historyPrompt/<工作区>-<hash>.json),
// 记录该工作区聚合后的人类输入(带 sid 溯源)。浮层请求直接读文件(毫秒级)立即返回,
// 对齐在后台解压最新产物与缓存合并写回——解压成本不落在用户等待路径上。
// extracts 段持久化每会话的提取结果与其产物 stat 指纹(mtimeMs+size):
// 对齐时先 stat 比对指纹,产物没变的会话不再解压——判断完全基于磁盘,跨重启生效。
// 文件名 = 工作区路径末段(可辨认)+ 路径哈希前缀(防不同目录同名冲突)

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

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

export async function listWorkspaceCaches(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const caches = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => {
      try {
        return normalize(JSON.parse(await readFile(join(dir, name), 'utf8')), undefined) === undefined
          ? null
          : JSON.parse(await readFile(join(dir, name), 'utf8'))
      } catch {
        return null
      }
    }))
  return caches.filter((cache) => cache && typeof cache.cwd === 'string' && Array.isArray(cache.entries))
}
