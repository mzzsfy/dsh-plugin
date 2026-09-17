// client.js 注册 id 与样式标记守卫:loader 按 graph row id(完整包名)匹配注册,短名即加载失败;
// 样式查重键 STYLE_ID 兼作 data-plugin 标记值,短名会使自身 rebuilt 删不到旧样式,重注被跳过。
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

test('client.js 样式注入自带 data-plugin 且值为注册包名', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const injections = source.split("createElement('style')").length - 1
  assert.ok(injections > 0, 'client.js 无样式注入点')
  assert.ok(source.includes(`STYLE_ID = '${name}'`), 'STYLE_ID 必须等于注册包名(值=注册 id),短名会使自身 rebuilt 删不到旧样式')
  const marked = source.split("setAttribute('data-plugin'").length - 1
  assert.equal(marked, injections, '每个样式注入点都必须设置 data-plugin,防宿主 claimStyles 误归属后随他插件 HMR 整批误删')
})
