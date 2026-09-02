// 历史文件持久化守卫:读取/解析失败时把坏文件备份为 .bak(覆盖旧备份)并拒绝写入,
// 防止空 store 覆盖 history.json 造成数据丢失;恢复成功读取后解除损坏标记。
// IO 以参数注入,host 半区传真实 fs,单测传临时目录。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const BAK_SUFFIX = '.bak'
export const HISTORY_BROKEN_MESSAGE = '历史文件已损坏已备份,已暂停写入以防数据丢失'

function isMissing(error) {
  return Boolean(error) && error.code === 'ENOENT'
}

export function createHistoryStore({ file, io }) {
  const fs = io || { mkdir, readFile, rename, writeFile }
  let sequences = {}
  let loaded = false
  let broken = false
  let chain = Promise.resolve()
  return {
    get sequences() {
      return sequences
    },
    get broken() {
      return broken
    },
    // 损坏状态下不短路,重读以支持恢复(坏文件已备份移走,重读得到 ENOENT 即解除)
    ensure() {
      if (loaded && !broken) return Promise.resolve(sequences)
      loaded = true
      return fs
        .readFile(file, 'utf8')
        .then((text) => {
          const parsed = JSON.parse(text)
          if (parsed && parsed.sequences && typeof parsed.sequences === 'object') sequences = parsed.sequences
          broken = false
        })
        .catch((error) => {
          if (isMissing(error)) {
            broken = false
            return undefined
          }
          broken = true
          // 备份失败不阻断损坏标记,写入仍被拒绝
          return fs.rename(file, file + BAK_SUFFIX).catch(() => {})
        })
        .then(() => sequences)
    },
    persist() {
      if (broken) return Promise.reject(new Error(HISTORY_BROKEN_MESSAGE))
      chain = chain.then(async () => {
        await fs.mkdir(dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify({ sequences }, null, 2), 'utf8')
      })
      return chain
    },
  }
}
