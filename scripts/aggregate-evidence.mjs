import { lstat, mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export async function createEvidenceLogDir(root) {
  const resolved = resolve(root)
  let info
  try {
    info = await lstat(resolved)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (info?.isSymbolicLink()) throw new Error(`证据日志根目录不接受符号链接: ${resolved}`)
  if (!info) {
    await mkdir(resolved, { recursive: true })
    info = await lstat(resolved)
  }
  if (!info.isDirectory()) throw new Error(`证据日志根目录必须是目录: ${resolved}`)
  return mkdtemp(join(resolved, 'aggregate-tests-'))
}
