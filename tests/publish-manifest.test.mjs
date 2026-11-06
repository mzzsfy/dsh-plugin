// 发布面守卫:scoped 包首发必须声明 publishConfig.access=public。
// npm 对 scoped 包首次发布默认 restricted,缺声明会在唯一发布入口失败(E402)
// 或被误发为私有;发布脚本同时传 --access public 作双保险。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

test('scoped 包全部声明 publishConfig.access=public', () => {
  const packagesDir = join(repoRoot, 'packages')
  const missing = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (String(manifest.name ?? '').startsWith('@') && manifest.publishConfig?.access !== 'public') missing.push(entry.name)
  }
  assert.deepEqual(missing, [], 'scoped 包缺 publishConfig.access=public: ' + missing.join(', '))
})
