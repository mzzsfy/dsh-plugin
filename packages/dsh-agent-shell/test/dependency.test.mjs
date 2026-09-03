// BDD: 依赖缺失优雅降级 —— resolve 失败进入 dependency-missing 状态而非报错循环
import test from 'node:test'
import assert from 'node:assert/strict'

test('resolveServerEntry:正常解析返回 bin 路径', async () => {
  const { resolveServerEntry } = await import('../src/dependency.mjs')
  const entry = resolveServerEntry('@mzzsfy/mcp-ssh')
  assert.match(entry, /mcp-ssh[\\/]bin[\\/]mcp-ssh\.mjs$/)
})

test('resolveServerEntry:包不存在返回 null 且不抛错', async () => {
  const { resolveServerEntry } = await import('../src/dependency.mjs')
  assert.equal(resolveServerEntry('@mzzsfy/definitely-not-installed-xyz'), null)
})

test('resolveServerEntry:包存在但 bin 字段缺失返回 null', async () => {
  // 构造一个只有 package.json 没有 bin 的假包目录
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'dep-missing-'))
  const pkgDir = join(root, 'node_modules', '@mzzsfy', 'fake-no-bin')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@mzzsfy/fake-no-bin', version: '1.0.0' }))
  // 从 root 内解析(root 下有 node_modules)
  const { pathToFileURL } = await import('node:url')
  const fromUrl = pathToFileURL(join(root, 'probe.js')).href
  const { resolveServerEntry } = await import('../src/dependency.mjs')
  assert.equal(resolveServerEntry('@mzzsfy/fake-no-bin', fromUrl), null)
})

test('resolveServerEntry:bin 指向文件不存在返回 null', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const root = mkdtempSync(join(tmpdir(), 'dep-missing-bin-'))
  const pkgDir = join(root, 'node_modules', '@mzzsfy', 'fake-ghost-bin')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@mzzsfy/fake-ghost-bin', version: '1.0.0', bin: { 'mcp-ssh': './bin/ghost.mjs' } }))
  const fromUrl = pathToFileURL(join(root, 'probe.js')).href
  const { resolveServerEntry } = await import('../src/dependency.mjs')
  assert.equal(resolveServerEntry('@mzzsfy/fake-ghost-bin', fromUrl), null)
})
