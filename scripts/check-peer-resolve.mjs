// 验证:仓库包目录内能否解析全部 peer 依赖(Node ESM/require 双语义)。
// 包集从各包 peerDependencies 动态生成(I05):手工清单曾随包演进漂移失真。
// 核验面 = main 入口静态 import 的 peer:client.js 浏览器面(react 等经宿主
// 模块表 require 注入)不经 Node 解析链,不在断言内;无 Node 入口消费的 peer
// 与无包内安装态的包一律跳过防宿主态误报
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgsRoot = join(repo, 'packages')
let bad = 0
for (const dir of readdirSync(pkgsRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const pkgDir = join(pkgsRoot, dir.name)
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  const peers = Object.keys(manifest.peerDependencies ?? {})
  if (peers.length === 0 || !manifest.main) continue
  const entryPath = join(pkgDir, manifest.main)
  if (!existsSync(entryPath)) continue
  const entrySource = readFileSync(entryPath, 'utf8')
  const nodeConsumed = peers.filter((dep) => entrySource.includes("'" + dep + "'") || entrySource.includes('"' + dep + '"'))
  if (nodeConsumed.length === 0) {
    console.log(`SKIP ${manifest.name ?? dir.name}(peer 仅浏览器面消费)`)
    continue
  }
  if (!existsSync(join(pkgDir, 'node_modules'))) {
    console.log(`SKIP ${manifest.name ?? dir.name}(无包内安装态,peer 由宿主满足)`)
    continue
  }
  const require = createRequire(pathToFileURL(join(pkgDir, 'package.json')))
  for (const dep of nodeConsumed) {
    try {
      require.resolve(dep)
      console.log(`${manifest.name ?? dir.name} -> ${dep}: OK`)
    } catch (e) {
      console.log(`${manifest.name ?? dir.name} -> ${dep}: FAIL (${e.code})`)
      bad++
    }
  }
}
process.exitCode = bad ? 1 : 0
