// 单文件原子替换:临时文件 + rename。写入被截断/写满/中断时目标文件保持旧内容,
// 不留半截 JSON;临时名按实例唯一且必带熵(同文件可能被多个实例在 HMR 换插件的
// 短窗口内同时持有,固定临时名会互相抢同一路径)。调用方负责建目录与写前状态复查
// (historyStore 同构)。IO 以参数注入:host 半区传真实 fs,单测注入故障桩。
// 失败路径 finally 删除临时文件:accounts.json 含明文 Key,不能把半截凭据留在目录。
// 目标已存在时先复制到临时文件,再覆盖内容后改名,保留原文件的 mode/ACL。

import { randomBytes } from 'node:crypto'
import { chmod, copyFile, rename, stat, unlink, writeFile } from 'node:fs/promises'

const DEFAULT_IO = { chmod, copyFile, rename, stat, unlink, writeFile }

export function createAtomicWriter(file, io) {
  const fs = { ...DEFAULT_IO, ...(io || {}) }
  // 实例唯一临时名
  const tempFile = `${file}.tmp.${randomBytes(4).toString('hex')}`
  return async function writeAtomically(text) {
    const existing = await fs.stat(file).catch(() => null)
    try {
      // 复制旧目标再覆写:新临时文件继承原 mode(及平台支持的 ACL),
      // 避免 rename 后把 accounts.json 的权限放大成进程默认值。
      if (existing) await fs.copyFile(file, tempFile)
      await fs.writeFile(tempFile, text, existing ? { encoding: 'utf8', mode: existing.mode & 0o7777 } : 'utf8')
      if (existing && typeof fs.chmod === 'function') {
        await fs.chmod(tempFile, existing.mode & 0o7777).catch(() => {})
      }
      await fs.rename(tempFile, file)
    } finally {
      await fs.unlink(tempFile).catch(() => {})
    }
  }
}
