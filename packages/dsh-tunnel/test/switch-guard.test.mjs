// 开关样式守卫 BDD:裸 checkbox/裸 input 状态选择器会静默损坏 UI 或误伤同 label 的文本输入,
// 属无报错的 UI 退化, 静态断言锁死 tu-switch 结构(参照 cb-switch/mce-switch 同款守卫)。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('switch 隐藏规则以 input[type="checkbox"] 精确匹配', () => {
  assert.match(source, /\.tu-switch input\[type="checkbox"\] \{ position:absolute/)
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

test('插件页卡片为官方 PluginCard 形制: li 卡壳 + 头部折叠 + 令牌同源', () => {
  // Given 官方插件卡片 = ul.cards > li.PluginCard(边框卡壳 + 名称/描述头部 + chevron 折叠)
  // When 本插件卡片注册进同一列表(slot 契约: 外观归插件自持, 官方壳未导出)
  // Then 静态锁定 tu-pc 镜像形制, 防止退化回裸 div 平铺
  assert.match(source, /h\('li', \{ className: 'tu-pc/, '卡片根元素必须是 li(官方列表 ul.cards 的合法子元素)')
  assert.match(source, /\.tu-pc\{border:\.5px solid var\(--dsw-alias-border-l4\)/, '卡壳边框/底色令牌必须与官方 PluginCard 同源')
  assert.match(source, /h\('button', \{ type: 'button', className: 'tu-pc__head'/, '缺少官方形制的头部按钮')
  assert.match(source, /aria-expanded/, '头部必须可折叠并暴露 aria-expanded')
  assert.match(source, /\.tu-pc__hint\{[^}]*var\(--dsw-alias-label-tertiary\)/, '提示文本令牌必须与官方 hint 同源')
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
