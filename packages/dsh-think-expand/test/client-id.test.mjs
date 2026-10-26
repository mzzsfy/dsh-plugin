// client.js 注册 id 守卫:loader 按 graph row id(完整包名)匹配注册,短名即加载失败。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))

test('client.js 注册 id 为完整包名', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const match = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(match, 'client.js 缺少 __ModuleLoader__.load 注册')
  assert.equal(match[1], name)
})

test('client.js 样式注入点全部带 data-plugin 标记', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const created = source.match(/createElement\('style'\)/g)?.length ?? 0
  const marked = source.match(/setAttribute\('data-plugin',\s*'@mzzsfy\/dsh-think-expand'\)/g)?.length ?? 0
  assert.ok(created > 0, 'client.js 无样式注入点,守卫失去对象')
  assert.equal(created, marked, '存在缺 data-plugin 标记的样式注入点')
})