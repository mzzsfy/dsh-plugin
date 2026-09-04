// 全量加载冒烟:逐个动态 import 各包 main,任何命名导出缺失/模块错误即暴露。
// dsh 本体升级后必跑;用法:
//   node scripts/smoke-load.mjs           # 测仓库工作副本
//   node scripts/smoke-load.mjs --profile # 测 profile node_modules 安装副本
import { createRequire } from 'module'
import { pathToFileURL, fileURLToPath } from 'url'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const profileNm = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules')
const profileMode = process.argv.includes('--profile')
const base = profileMode ? join(profileNm, '@mzzsfy') : join(repoRoot, 'packages')

const require2 = createRequire(import.meta.url)
const failures = []
for (const dir of readdirSync(base, { withFileTypes: true })) {
  // junction 在 Dirent 上是 symlink 而非 directory,两者都要收
  if (!dir.isDirectory() && !dir.isSymbolicLink()) continue
  const pkgDir = join(base, dir.name)
  const manifest = join(pkgDir, 'package.json')
  if (!existsSync(manifest)) continue
  const { main, name } = JSON.parse(readFileSync(manifest, 'utf8'))
  try {
    await import(pathToFileURL(join(pkgDir, main)).href)
    console.log(`OK   ${name ?? dir.name}`)
  } catch (error) {
    failures.push({ pkg: name ?? dir.name, error })
    console.log(`FAIL ${name ?? dir.name} | ${String(error.message).split('\n')[0]}`)
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} 个包加载失败`)
  process.exitCode = 1
}
