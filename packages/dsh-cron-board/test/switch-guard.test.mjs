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

test('client.js 必含 settings.section 槽注册与空 apply 返回形态', () => {
  assert.match(source, /inject: \['slots'\]/)
  assert.match(source, /ctx\.slots\.inject\('settings\.section'/)
  assert.match(source, /window\.__ModuleLoader__\.load\(\{ id: '@mzzsfy\/dsh-cron-board', factory \}\)/)
})
