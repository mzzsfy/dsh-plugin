// client.js 注册 id 与样式标记守卫:loader 按 graph row id(完整包名)匹配注册,短名即加载失败;
// React 渲染的 style 无 data-plugin 会被宿主 claimStyles 误归属给后续材质化插件,其 HMR 重建即整批误删。
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

test('client.js 样式渲染自带 data-plugin', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  // 渲染点计数用 ('style', { 精确命中 React 形态,排除 DOM 形态的 createElement('style')
  const renders = source.split("('style', {").length - 1
  assert.ok(renders > 0, 'client.js 无样式渲染点')
  const marked = source.split("('style', { 'data-plugin'").length - 1
  assert.equal(marked, renders, '每个样式渲染点都必须携带 data-plugin(值=注册包名),防宿主 claimStyles 误归属后随他插件 HMR 整批误删')
})
