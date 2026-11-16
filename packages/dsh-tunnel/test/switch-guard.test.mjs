// 开关样式守卫 BDD:裸 checkbox/裸 input 状态选择器会静默损坏 UI 或误伤同 label 的文本输入,
// 属无报错的 UI 退化, 静态断言锁死 tu-switch 结构(参照 cb-switch/tn-switch 同款守卫)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('switch 隐藏规则以 input[type="checkbox"] 精确匹配', () => {
  assert.match(source, /\.tu-switch input\[type="checkbox"\]\s*\{\s*position:absolute/)
})

test('switch 状态选择器禁止裸 input 锚定(防误伤同 label 的文本输入)', () => {
  const bare = source.match(/\.tu-switch input:(?!\[type)[a-z-]+/g)
  assert.equal(bare, null, `裸 input 状态选择器: ${bare}`)
})

test('checkbox 仅允许出现在 switchToggle 工厂内, 禁止裸 checkbox 直出', () => {
  const occurrences = [...source.matchAll(/type: 'checkbox'/g)].map((match) => match.index)
  assert.equal(occurrences.length, 1, `checkbox 字面量出现 ${occurrences.length} 次`)
  const factoryStart = source.indexOf('function switchToggle')
  const factoryEnd = source.indexOf('}', source.indexOf('__thumb', factoryStart))
  assert.ok(occurrences[0] > factoryStart && occurrences[0] < factoryEnd, 'checkbox 字面量不在 switchToggle 工厂内')
})

test('switchToggle 产出顺序为 input 在前 track 在后', () => {
  const factory = source.slice(source.indexOf('function switchToggle'))
  assert.ok(factory.indexOf("h('input'") < factory.indexOf('tu-switch__track'), '工厂内 input 必须先于 track')
})

test('disabled 态 hover 高亮被 :has 守卫排除', () => {
  assert.match(source, /\.tu-switch:not\(:has\(input\[type="checkbox"\]:disabled\)\):hover/)
})

test('checked/focus-visible/disabled 三态均以 checkbox 锚定', () => {
  assert.match(source, /\.tu-switch input\[type="checkbox"\]:checked \+/)
  assert.match(source, /\.tu-switch input\[type="checkbox"\]:focus-visible \+/)
  assert.match(source, /\.tu-switch input\[type="checkbox"\]:disabled \+/)
})

test('设置分区为紧凑卡组: 560px 容器 + 行内地址/状态, 不再有旧插件卡', () => {
  assert.match(source, /\.tu-set\{[^}]*max-width:560px/, '设置分区必须遵守 560px 内容宽度')
  assert.match(source, /className: 'tu-row__url'/, '隧道行必须有完整地址')
  assert.match(source, /className: 'tu-row__meta'/, '隧道行必须有状态/统计辅助行')
  assert.match(source, /urlDisabled/, '停用/路由错误行必须关闭地址入口')
  assert.match(source, /tu-row__url--disabled/, '停用/路由错误地址需要禁用样式')
  assert.doesNotMatch(source, /tu-pc/, '旧插件卡形制必须移除')
})

test('client.js 无顶层词法声明(经典 script 书挡内安全)', () => {
  // IIFE 书挡内允许任意声明;守卫确认整文件被书挡包裹
  const trimmed = source.trim()
  assert.ok(trimmed.startsWith('(() => {'), '必须以 IIFE 书挡开头')
  assert.ok(trimmed.endsWith('})()'), '必须以 IIFE 书挡结尾')
})

test('类名前缀全量 tu-(插件样式全局注入, 跨包类名冲突即互相覆盖)', () => {
  const classNames = [...source.matchAll(/className: '([a-z][a-z0-9_-]*)/g)].map((match) => match[1])
  const foreign = classNames.filter((name) => !name.startsWith('tu-'))
  assert.deepEqual(foreign, [], `存在非 tu- 前缀类名: ${[...new Set(foreign)].join(', ')}`)
})

test('只注册 settings.section, 旧插件卡与侧栏历史入口全部移除', () => {
  assert.match(source, /ctx\.slots\.inject\('settings\.section'/)
  assert.doesNotMatch(source, /ctx\.slots\.inject\('settings\.plugin\.item'/)
  assert.doesNotMatch(source, /ctx\.slots\.inject\('plugins\.bundle\.config'/)
  assert.doesNotMatch(source, /betterSidebar/)
})

test('aiTools 只保留宿主配置面, 不在设置分区重复摆放', () => {
  assert.doesNotMatch(source, /aiTools/, '设置分区不重复 ai 开关, 避免双写')
})
