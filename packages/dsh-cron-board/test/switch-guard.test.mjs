// 开关样式守卫 BDD:裸 checkbox/裸 input 状态选择器会静默损坏 UI 或误伤同 label 的文本输入,
// 属无报错的 UI 退化,静态断言锁死 cb-switch 结构(参照 mce-switch 同款守卫)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('switch 隐藏规则以 input[type="checkbox"] 精确匹配', () => {
  assert.match(source, /\.cb-switch input\[type="checkbox"\] \{ position:absolute/)
})

test('switch 状态选择器禁止裸 input 锚定(防误伤同 label 的文本输入)', () => {
  const bare = source.match(/\.cb-switch input:(?!\[type)[a-z-]+/g)
  assert.equal(bare, null, `裸 input 状态选择器: ${bare}`)
})

test('checkbox 仅允许出现在 switchToggle 工厂内,禁止裸 checkbox 直出', () => {
  const occurrences = [...source.matchAll(/type: 'checkbox'/g)].map((match) => match.index)
  assert.equal(occurrences.length, 1, `checkbox 字面量出现 ${occurrences.length} 次`)
  const factoryStart = source.indexOf('function switchToggle')
  const factoryEnd = source.indexOf('}', source.indexOf('__thumb', factoryStart))
  assert.ok(occurrences[0] > factoryStart && occurrences[0] < factoryEnd, 'checkbox 字面量不在 switchToggle 工厂内')
})

test('switchToggle 产出顺序为 input 在前 track 在后', () => {
  const factory = source.slice(source.indexOf('function switchToggle'))
  assert.ok(factory.indexOf("h('input'") < factory.indexOf('cb-switch__track'), '工厂内 input 必须先于 track')
})

test('disabled 态 hover 高亮被 :has 守卫排除', () => {
  assert.match(source, /\.cb-switch:not\(:has\(input\[type="checkbox"\]:disabled\)\):hover/)
})

test('checked/focus-visible/disabled 三态均以 checkbox 锚定', () => {
  assert.match(source, /\.cb-switch input\[type="checkbox"\]:checked \+/)
  assert.match(source, /\.cb-switch input\[type="checkbox"\]:focus-visible \+/)
  assert.match(source, /\.cb-switch input\[type="checkbox"\]:disabled \+/)
})

test('client.js 无顶层词法声明(经典 script 书挡内安全)', () => {
  // IIFE 书挡内允许任意声明;守卫确认整文件被书挡包裹
  const trimmed = source.trim()
  assert.ok(trimmed.startsWith('(() => {'), '必须以 IIFE 书挡开头')
  assert.ok(trimmed.endsWith('})()'), '必须以 IIFE 书挡结尾')
})

test('client.js 主页面双形态挂载契约(默认主界面;设置开关手动移入侧边栏;无自动回退)', () => {
  // Given 用户要求:默认永远主界面;检测到 better-sidebar 提供设置项,由用户手动移入;
  //        移入后页签关闭/禁用不再自动返回主界面(挂载权完全交给用户与侧边栏)
  // Then 静态锁定:模块注册形态、服务软探测、tab 单实例、主界面容器与互斥事件、偏好驱动仲裁
  assert.match(source, /window\.__ModuleLoader__\.load\(\{ id: '@mzzsfy\/dsh-cron-board', factory \}\)/)
  assert.match(source, /ctx\.get\('betterSidebar'\)/)
  assert.match(source, /single: true/)
  assert.match(source, /ctx\.inject\(\['betterSidebar'\]/)
  assert.match(source, /data-cb-board-active/)
  assert.match(source, /dsh-panel-activate/)
  assert.match(source, /function mountStandaloneBoard/)
  // 不再挂设置页分区(入口唯一)
  assert.doesNotMatch(source, /settings\.section/)
  // 挂载仲裁:apply 无条件先落主界面形态;偏好(status.ui.sidebarTab)驱动接入/退出
  assert.match(source, /let standalone = mountStandaloneBoard\(wsModel\)/)
  assert.match(source, /applyPref\(\)/)
  assert.match(source, /ui\.sidebarTab/)
  // 不再自动回退:attach 后不订阅页签状态,无 openTabs/subscribeState 联动
  assert.doesNotMatch(source, /subscribeState/)
  assert.doesNotMatch(source, /openTabs/)
})
