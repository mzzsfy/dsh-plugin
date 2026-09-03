// 依赖解析层:把 @mzzsfy/mcp-ssh 的入口解析收拢为一处。
// 解析失败(包不存在 / bin 缺失 / bin 文件缺失)一律返回 null,不抛错 ——
// 上层据此进入 dependency-missing 降级态而非报错循环。

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const BIN_NAME = 'mcp-ssh'

/**
 * 解析包内 bin 绝对路径。
 * @param {string} packageName npm 包名
 * @param {string} [fromUrl] 解析起点(测试注入;默认本模块位置)
 * @returns {string|null} bin 绝对路径;任何一步失败返回 null
 */
export function resolveServerEntry(packageName, fromUrl) {
  const base = fromUrl ?? import.meta.url
  let pkgUrl
  try {
    pkgUrl = createRequire(base).resolve(packageName + '/package.json')
  } catch {
    return null
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'))
    // createRequire().resolve 返回文件路径字符串(非 file:// URL)
    const binRelative = typeof pkg.bin === 'object' && pkg.bin !== null ? pkg.bin[BIN_NAME] : pkg.bin
    if (typeof binRelative !== 'string' || binRelative.length === 0) return null
    const binPath = join(dirname(pkgUrl), binRelative)
    return existsSync(binPath) ? binPath : null
  } catch {
    return null
  }
}
