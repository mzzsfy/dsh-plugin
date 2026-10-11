// 打包契约:清单字段、入口存在、干净禁用形态
import { test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))

test('package.json 契约', () => {
  const dsh = pkg.dsh
  if (!dsh) return
  if (dsh.bundle?.patch) {
    if (!existsSync(join(pkgRoot, dsh.bundle.patch))) throw new Error(`patch 文件缺失: ${dsh.bundle.patch}`)
  }
  if (dsh.client && !existsSync(join(pkgRoot, 'src/client.js'))) throw new Error('声明 client 平台但缺 src/client.js')
  if (!pkg.exports['./client'] && !dsh.client) throw new Error('无 client 导出也无 client 声明')
})

test('宿主行 config role 覆盖 cordis.patch 全部插入行', () => {
  const patch = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8')
  const index = readFileSync(join(pkgRoot, 'lib/index.js'), 'utf8')
  for (const m of patch.matchAll(/role:\s*(\w+)/g)) {
    if (!index.includes(`'${m[1]}'`)) throw new Error(`patch 行 role ${m[1]} 未在 Config 枚举中`)
  }
})
