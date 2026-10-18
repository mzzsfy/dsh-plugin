// 请求留档:逐行 JSON(at/method/path/headers 小写键/body 解析后形态,解析失败为 null),
// 追加 scenario 字段供场景断言(只增不改,既有断言读 at/method/path/headers/body)。
// 总大小上限:追加后超 maxBytes 时按行收缩至保留线以下,长驻实例不失控(行完整优先于保留线)。
import { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'

const MAX_LOG_BYTES = 100 * 1024 * 1024

export function createRecorder(logPath, maxBytes = MAX_LOG_BYTES) {
  return (entry) => {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
    truncateToTail(logPath, maxBytes)
  }
}

export function record(recorder, request, parsedBody, scenario) {
  recorder({
    at: new Date().toISOString(),
    method: request.method,
    path: request.url,
    headers: request.headers,
    body: parsedBody,
    scenario,
  })
}

// 超 maxBytes 时保留最近 maxBytes/2 内首个行边界之后的完整行;窗口边界切开末行时回退保留最后一行。
// 经 rename 隔离写回收缩覆盖窗口;并发冲突或写入失败时放弃本次,下条请求重试
function truncateToTail(logPath, maxBytes) {
  try {
    if (statSync(logPath).size <= maxBytes) return
    const keepBytes = maxBytes / 2
    const buf = readFileSync(logPath)
    const cut = buf.length - keepBytes
    const within = buf.indexOf(0x0a, cut)
    const from = within !== -1 && within + 1 < buf.length
      ? within + 1
      : buf.lastIndexOf(0x0a, cut - 1) + 1
    if (from === 0) return
    const staged = `${logPath}.truncating`
    renameSync(logPath, staged)
    writeFileSync(logPath, buf.subarray(from))
    rmSync(staged, { force: true })
  } catch { /* 收缩失败(文件被并发改名、读取冲突或写入失败):放弃本次 */ }
}
