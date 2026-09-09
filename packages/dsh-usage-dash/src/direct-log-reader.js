// 会话档案文件直读器:宿主 persistence 服务 fail-closed 拒读(descriptor 校验、
// 格式校验、seq gap 等)时,对磁盘档案做降级直读。统计只消费 usage 词汇
// (assistant/message 的 usage 与 request/context 路由),无需完整会话语义,
// 宽松解析即可恢复;corrupt(seq gap)与 legacy(未知成员)对统计无影响。
//
// 物理格式(与宿主 jsonl 后端同构):首行 header JSON + 事件行 JSONL 文本,
// 按 zstd 帧独立压缩顺序拼接;帧以 magic 28 b5 2f fd 起始。压缩由 Node 内置
// node:zlib 提供(Node >= 24),不依赖宿主模块,不受宿主升级影响。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// 档案根目录:DSH_HOME 可重定向(多版本共存测试的隔离约定),默认 ~/.dsh
function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

// 按帧边界切分 zstd 流:帧首 magic 定位,各帧解压范围到下一 magic 或流尾
function frameRanges(bytes) {
  const ranges = []
  let at = bytes.indexOf(ZSTD_MAGIC)
  while (at >= 0) {
    if (ranges.length > 0) ranges[ranges.length - 1].end = at
    ranges.push({ start: at, end: bytes.length })
    at = bytes.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
  }
  return ranges
}

// 多帧解压;任何一帧失败即整体失败(宁缺勿错,调用方按原拒读路径上报)
export function decodeZstdFile(bytes) {
  const ranges = frameRanges(bytes)
  if (ranges.length === 0) throw new Error('no zstd frame found')
  let text = ''
  for (const range of ranges) {
    text += zstdDecompressSync(bytes.subarray(range.start, range.end)).toString('utf8')
  }
  return text
}

// JSONL 文本 → 宽松事件流:首行为档案 header,其余行逐行解析,坏行跳过;
// 只要求行能解出 JSON 对象,词汇/代际差异由上层折叠消化
export function parseJsonlEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const row = JSON.parse(trimmed)
      if (row && typeof row === 'object' && row.type !== undefined && row.type !== 'session/header') {
        events.push(row)
      }
    } catch {}
  }
  return events
}

// 会话目录定位:sessions/<cwd 编码桶>/<id>/;桶名是宿主对 cwd 的编码,不解析,
// 逐桶探测 id 子目录
export function findSessionDir(id, root = sessionsRoot()) {
  const sessions = root
  if (!existsSync(sessions)) return undefined
  for (const bucket of readdirSync(sessions)) {
    const candidate = join(sessions, bucket, id)
    if (existsSync(candidate) && statDirSync(candidate)) return candidate
  }
  return undefined
}

function statDirSync(path) {
  try {
    return readdirSync(path).length >= 0
  } catch {
    return false
  }
}

// 会话目录内选最新代档案:V3 专用名优先,退化为任意 jsonl(压缩/明文)
function pickLogFile(dir) {
  const names = readdirSync(dir)
  const v3 = names.find((name) => name.startsWith('session.v3.') && name.endsWith('.zstd'))
  if (v3) return join(dir, v3)
  const compressed = names.find((name) => name.endsWith('.jsonl.zstd'))
  if (compressed) return join(dir, compressed)
  const plain = names.find((name) => name.endsWith('.jsonl'))
  if (plain) return join(dir, plain)
  return undefined
}

// 直读单会话事件流;文件缺失/无法解压抛错,由调用方决定降级链终止
export function readSessionLogDirect(id, root) {
  const dir = findSessionDir(id, root)
  if (dir === undefined) throw new Error(`session artifact directory not found: ${id}`)
  const file = pickLogFile(dir)
  if (file === undefined) throw new Error(`session artifact file not found: ${id}`)
  const bytes = readFileSync(file)
  const text = file.endsWith('.zstd') ? decodeZstdFile(bytes) : bytes.toString('utf8')
  return parseJsonlEvents(text)
}

// 磁盘全量会话 id:sessions/<cwd 编码桶>/<id>/;旧代宿主的 list 不枚举新代
// 文件名的档案,直读侧补齐可见集
export function listSessionIdsDirect(root = sessionsRoot()) {
  if (!existsSync(root)) return []
  const ids = []
  for (const bucket of readdirSync(root)) {
    const bucketPath = join(root, bucket)
    let entries
    try {
      entries = readdirSync(bucketPath)
    } catch {
      continue
    }
    for (const id of entries) {
      if (existsSync(join(bucketPath, id, 'session.jsonl.zstd')) || existsSync(join(bucketPath, id, 'session.v3.jsonl.zstd'))) {
        ids.push(id)
      }
    }
  }
  return ids
}
