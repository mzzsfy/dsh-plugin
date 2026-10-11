// client.js 守卫:注册 id 与样式 data-plugin 标记、禁用入口(恢复/状态编辑)。
// 样式缺标记会被宿主 claimStyles 误归属,他插件 HMR 重建即整批误删。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('client.js 注册 id 为完整包名', () => {
  const match = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(match, 'client.js 缺少 __ModuleLoader__.load 注册')
  assert.equal(match[1], name)
})

test('head 注入样式点全部自带 data-plugin', () => {
  const injections = source.split("createElement('style')").length - 1
  const marked = source.split(`setAttribute('data-plugin', '${name}')`).length - 1
  assert.equal(marked, injections, '每个 head 注入样式点必须自带 data-plugin(值=注册包名)')
})

test('React 渲染样式点全部自带 data-plugin', () => {
  const renders = source.split("('style', {").length - 1
  assert.ok(renders > 0, 'client.js 无 React 样式注入点')
  const marked = source.split(`'data-plugin'`).length - 1
  assert.equal(marked, renders, '每个 React 渲染样式点必须自带 data-plugin')
})

test('client.js 不含恢复按钮与状态编辑入口', () => {
  assert.ok(!source.includes('恢复'), '禁止恢复入口文案')
  assert.ok(!source.includes('修改状态'), '禁止状态编辑入口')
  assert.ok(!source.includes('resume'), '禁止 resume 语义入口')
})

test('主面板插槽注册并声明 slots 依赖', () => {
  assert.ok(source.includes("'main'"), '必须注册 main 主面板插槽')
  assert.ok(source.includes("'sidebar.panellist'"), '必须注册侧栏图标位')
  assert.ok(source.includes("inject: ['slots']"), 'client 入口必须声明 slots 服务依赖')
})
