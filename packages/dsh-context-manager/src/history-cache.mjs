// 历史输入工作区缓存:每工作区一个 JSON 文件(~/.dsh/historyPrompt/<工作区>-<hash>.json),
// 记录该工作区聚合后的人类输入(带 sid 溯源)。浮层请求直接读文件(毫秒级)立即返回,
// 对齐在后台解压最新产物与缓存合并写回——解压成本不落在用户等待路径上。
// extracts 段持久化每会话的提取结果与其产物 stat 指纹(mtimeMs+size):
// 对齐时先 stat 比对指纹,产物没变的会话不再解压——判断完全基于磁盘,跨重启生效。
// 文件名 = 工作区路径末段(可辨认,定长截断)+ 路径哈希前缀(全路径唯一)

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join, sep, resolve } from 'node:path'

// 热重载两代共用文件提交队列,只锁读改写,不锁会话解压。
const commits = globalThis[Symbol.for('@mzzsfy/dsh-context-manager/cache-commits')] ??= new Map()
function commit(file, body) {
  const key = process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file)
  const previous = commits.get(key) ?? Promise.resolve()
  const run = previous.then(body)
  const tail = run.then(() => {}, () => {})
  commits.set(key, tail)
  void tail.then(() => { if (commits.get(key) === tail) commits.delete(key) })
  return run
}

// 文件名末段的定长上限:Windows 单个文件名单元上限 255 个 UTF-16 单元,整条路径还受
// MAX_PATH 约束。末段只作可辨认前缀,唯一性由全路径哈希保证,因此固定截断——
// 超长目录名不再拼出非法文件名(读写恒 ENOENT 且被上层当"无缓存"吞掉)
export const WORKSPACE_LEAF_MAX = 32

// 短暂占用类错误的退避重试:Windows 上目标文件被读取或被杀软扫描时 rename/unlink
// 会瞬态 EPERM/EBUSY,重试一次即过
const BUSY_RETRY_DELAYS_MS = [10, 50]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isBusyError(error) {
  const code = error && error.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

async function retryBusy(run) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (!isBusyError(error) || attempt >= BUSY_RETRY_DELAYS_MS.length) throw error
      await sleep(BUSY_RETRY_DELAYS_MS[attempt])
    }
  }
}

async function pathExists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

// 临时文件名(同目录,保证 rename 同卷)进程实例内唯一:固定 `.tmp` 名会让共用同一
// 缓存目录的两个宿主实例互相抢走对方的临时文件——后者 rename 成功、前者 ENOENT,
// 或被截断的对方内容顶入目标。后缀不是 .json,listWorkspaceCachesCached 天然忽略
let tempSequence = 0
export function workspaceTempFile(target) {
  tempSequence += 1
  return `${target}.${process.pid}-${tempSequence}-${randomBytes(4).toString('hex')}.tmp`
}

// 临时文件改名提交:目标短暂被占用时重试;临时文件已不在而目标已存在时收敛为成功
// (对方实例已把内容落位,把 ENOENT 抛给更新调用方只会让本地确认的写凭空失败)
export async function commitTempFile(tmp, target) {
  try {
    await retryBusy(() => rename(tmp, target))
  } catch (error) {
    if (error && error.code === 'ENOENT' && await pathExists(target)) return
    throw error
  }
}

// 原子写:先写临时文件再改名,进程中断不会留下半截 JSON;失败清掉本次临时文件
async function writeJsonAtomic(target, body) {
  const tmp = workspaceTempFile(target)
  try {
    await writeFile(tmp, body, 'utf8')
    await commitTempFile(tmp, target)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

function workspaceFile(dir, cwd) {
  // 末段取字母数字段(冒号等非法文件名字符剔除):盘根 C:\ 末段 'C:' 直出即非法文件名
  const leaf = (cwd.match(/[A-Za-z0-9\u4e00-\u9fa5]+/g) || []).pop() || 'root'
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  return join(dir, `${leaf.slice(0, WORKSPACE_LEAF_MAX)}-${hash}.json`)
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
export function updateWorkspaceCache(dir, cwd, update) {
  return commit(workspaceFile(dir, cwd), async () => {
    const cache = await update(await readWorkspaceCache(dir, cwd))
    await ensureCacheDir(dir)
    await writeJsonAtomic(workspaceFile(dir, cwd), JSON.stringify({ cwd, entries: cache.entries, extracts: cache.extracts }, null, 0))
    return cache
  })
}

export function writeWorkspaceCache(dir, cwd, cache) {
  return updateWorkspaceCache(dir, cwd, () => cache)
}

// 整份删除工作区缓存:本工作区已无主会话(会话被删除/只剩子会话)时用。走同一条
// 提交队列,不与在途写交错;文件本就不存在按成功处理
export function removeWorkspaceCache(dir, cwd) {
  const target = workspaceFile(dir, cwd)
  return commit(target, async () => {
    try {
      await retryBusy(() => unlink(target))
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
  })
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
  // 文本是收藏的身份:重复项只保留先出现的一条(旧数据/手改文件可能带重复)
  const seen = new Set()
  const items = []
  for (const item of parsed.items) {
    if (!item || typeof item.text !== 'string' || item.text.length === 0 || seen.has(item.text)) continue
    seen.add(item.text)
    items.push({ text: item.text, at: typeof item.at === 'number' ? item.at : 0 })
  }
  return items
}

export async function readPrompts(dir) {
  try {
    return normalizePrompts(JSON.parse(await readFile(join(dir, PROMPTS_FILE), 'utf8')))
  } catch {
    return []
  }
}

export function updatePrompts(dir, update) {
  return commit(join(dir, PROMPTS_FILE), async () => {
    const items = await update(await readPrompts(dir))
    await ensureCacheDir(dir)
    await writeJsonAtomic(join(dir, PROMPTS_FILE), JSON.stringify({ items }, null, 0))
    return items
  })
}

export function writePrompts(dir, items) {
  return updatePrompts(dir, () => items)
}
