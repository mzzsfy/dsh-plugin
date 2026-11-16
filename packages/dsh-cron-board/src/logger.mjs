// logger:每次运行一个日志文件,按任务分目录 logs/<jobId>/<runId>.log;
// 裁剪按文件数(与运行记录元数据同生命周期语义),删除任务连带整目录。

import { mkdir, open, readdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOG_EXT = '.log'
// tail 读取安全上限:单行超长时最多读文件尾部字节窗口,防一次性读入超大日志
const TAIL_READ_BYTES = 512 * 1024

function logPath(rootDir, jobId, runId) {
  return join(rootDir, jobId, runId + LOG_EXT)
}

// 按行切分并丢弃尾部空段(文件以换行结尾)
function splitLines(text) {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// 尾部字节窗口读取:返回 { text, truncated }。
// 窗口起点落在行中间时丢弃半行(否则半行会被当成完整日志行);truncated 表示窗口外仍有内容,
// 与调用方额外多读的行探测一起决定最终截断标记。
async function readTailWindow(file) {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const window = Math.min(size, TAIL_READ_BYTES)
    const start = size - window
    const buffer = Buffer.alloc(window)
    await handle.read(buffer, 0, window, start)
    let text = buffer.toString('utf8')
    let hasEarlier = start > 0
    if (start > 0) {
      // 读窗口前一字节判断首行是否完整:不是换行即窗口从行中间开始,丢弃半行
      const previous = Buffer.alloc(1)
      await handle.read(previous, 0, 1, start - 1)
      if (previous[0] !== 0x0a) {
        // 窗口从行中间开始:优先丢半行保留后续完整行;窗口内没有完整行时
        // 保留这段半行作为兜底内容,不能让尾部视图变成空
        const newline = text.indexOf('\n')
        if (newline >= 0) {
          const remainder = text.slice(newline + 1)
          if (remainder !== '') text = remainder
        }
      }
    }
    return { text, truncated: hasEarlier }
  } finally {
    await handle.close()
  }
}

export function createLogger({ rootDir }) {
  // 读文本:tailLines 缺省读全文;给定时按行取尾部窗口(先限定字节窗口再切行)
  async function readText(jobId, runId, tailLines) {
    const file = logPath(rootDir, jobId, runId)
    try {
      if (tailLines === undefined) {
        return { text: await readFile(file, 'utf8'), truncated: false }
      }
      return await readTailWindow(file)
    } catch (error) {
      if (error && error.code === 'ENOENT') return { text: '', truncated: false }
      throw error
    }
  }

  return {
    append(jobId, runId, chunk) {
      const file = logPath(rootDir, jobId, runId)
      return mkdir(join(rootDir, jobId), { recursive: true }).then(() => {
        // stdout/stderr 合流顺序写入,追加语义
        return writeFile(file, chunk, { flag: 'a', encoding: 'utf8' })
      })
    },
    read(jobId, runId, { tailLines } = {}) {
      return readText(jobId, runId, tailLines).then((outcome) => {
        if (tailLines === undefined) return outcome.text
        const lines = splitLines(outcome.text)
        return lines.slice(-tailLines).join('\n') + (lines.length > 0 ? '\n' : '')
      })
    },
    // 尾部窗口 + 截断标记:多取一行探测更早内容是否还有,面板据此提示「仅显示最后 N 行」;
    // 字节窗口截断(超长行)同样必须标 truncated,且半行已丢弃
    async readTail(jobId, runId, tailLines) {
      const outcome = await readText(jobId, runId, tailLines + 1)
      const lines = splitLines(outcome.text)
      const truncated = outcome.truncated || lines.length > tailLines
      return { text: lines.slice(-tailLines).join('\n') + (lines.length > 0 ? '\n' : ''), truncated }
    },
    async clear(jobId, runId) {
      // 清空 = 内容清零而非删除:文件存在性保持稳定,读路径无需区分「从未运行」与「已清空」
      await truncate(logPath(rootDir, jobId, runId), 0).catch((error) => {
        if (!(error && error.code === 'ENOENT')) throw error
      })
    },
    // 按文件修改时间保留最新 keep 份(runId 为随机 UUID 与时间无关,禁用名字典序)
    async prune(jobId, keep) {
      const dir = join(rootDir, jobId)
      let names
      try {
        names = await readdir(dir)
      } catch (error) {
        if (error && error.code === 'ENOENT') return
        throw error
      }
      const logs = names.filter((name) => name.endsWith(LOG_EXT))
      const withTime = await Promise.all(logs.map(async (name) => {
        const info = await stat(join(dir, name)).catch(() => null)
        return { name, mtimeMs: info ? info.mtimeMs : 0 }
      }))
      withTime.sort((a, b) => a.mtimeMs - b.mtimeMs)
      const stale = withTime.slice(0, Math.max(0, withTime.length - keep))
      for (const item of stale) {
        await rm(join(dir, item.name), { force: true })
      }
    },
    async removeJob(jobId) {
      await rm(join(rootDir, jobId), { recursive: true, force: true })
    },
  }
}
