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

export function createLogger({ rootDir }) {
  return {
    append(jobId, runId, chunk) {
      const file = logPath(rootDir, jobId, runId)
      return mkdir(join(rootDir, jobId), { recursive: true }).then(() => {
        // stdout/stderr 合流顺序写入,追加语义
        return writeFile(file, chunk, { flag: 'a', encoding: 'utf8' })
      })
    },
    async read(jobId, runId, { tailLines } = {}) {
      const file = logPath(rootDir, jobId, runId)
      let text
      try {
        if (tailLines === undefined) {
          text = await readFile(file, 'utf8')
        } else {
          const handle = await open(file, 'r')
          try {
            const { size } = await handle.stat()
            const window = Math.min(size, TAIL_READ_BYTES)
            const buffer = Buffer.alloc(window)
            await handle.read(buffer, 0, window, size - window)
            text = buffer.toString('utf8')
          } finally {
            await handle.close()
          }
        }
      } catch (error) {
        if (error && error.code === 'ENOENT') return ''
        throw error
      }
      if (tailLines === undefined) return text
      const lines = text.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      return lines.slice(-tailLines).join('\n') + (lines.length > 0 ? '\n' : '')
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
