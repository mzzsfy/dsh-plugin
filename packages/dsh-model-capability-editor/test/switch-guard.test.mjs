// 开关样式守卫 BDD:状态选择器回退为裸 input 会静默隐藏 LevelEditor 的
// mce-text 输入框(同 label 双 input 场景),属无报错的 UI 损坏,静态断言锁死结构
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('switch 隐藏规则以 input[type="checkbox"] 精确匹配', () => {
  assert.match(source, /\.mce-switch input\[type="checkbox"\] \{ position:absolute/)
})

test('switch 状态选择器禁止裸 input 锚定(防误伤同 label 的 mce-text)', () => {
  const bare = source.match(/\.mce-switch input:(?!\[type)[a-z-]+/g)
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
  assert.ok(factory.indexOf("h('input'") < factory.indexOf('mce-switch__track'), '工厂内 input 必须先于 track')
})

test('disabled 态 hover 高亮被 :has 守卫排除', () => {
  assert.match(source, /\.mce-switch:not\(:has\(input\[type="checkbox"\]:disabled\)\):hover/)
})
