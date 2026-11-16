// 开关样式守卫 BDD:状态选择器回退为裸 input 会误伤同 label 内的其他 input(无报错 UI 损坏),
// 静态断言锁死结构与锚定形态(tn-switch 守卫同构)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('switch 隐藏规则以 input[type="checkbox"] 精确匹配', () => {
  assert.match(source, /\.dm-switch input\[type="checkbox"\] \{ position:absolute/)
})

test('switch 状态选择器禁止裸 input 锚定(防误伤同 label 其他 input)', () => {
  const bare = source.match(/\.dm-switch input:(?!\[type)[a-z-]+/g)
  assert.equal(bare, null, `裸 input 状态选择器: ${bare}`)
})

test('checkbox 仅允许出现在 switchToggle 与白名单勾选组件内,禁止其他裸 checkbox', () => {
  const occurrences = [...source.matchAll(/type: 'checkbox'/g)].map((match) => match.index)
  assert.equal(occurrences.length, 2, `checkbox 字面量出现 ${occurrences.length} 次`)
  const factoryStart = source.indexOf('function switchToggle')
  const factoryEnd = source.indexOf('}', source.indexOf('__thumb', factoryStart))
  const whitelistStart = source.indexOf('function WhitelistPicker')
  const whitelistEnd = source.indexOf('// 安装入口可用性', whitelistStart)
  const switchOccurrence = occurrences.find((index) => index > factoryStart && index < factoryEnd)
  const whitelistOccurrence = occurrences.find((index) => index > whitelistStart && index < whitelistEnd)
  assert.ok(switchOccurrence !== undefined, 'switch checkbox 必须在 switchToggle 工厂内')
  assert.ok(whitelistOccurrence !== undefined, '白名单 checkbox 必须在 WhitelistPicker 内')
})

test('switchToggle 产出顺序为 input 在前 track 在后', () => {
  const factory = source.slice(source.indexOf('function switchToggle'))
  assert.ok(factory.indexOf("h('input'") < factory.indexOf('dm-switch__track'), '工厂内 input 必须先于 track')
})

test('disabled 态 hover 高亮被 :has 守卫排除', () => {
  assert.match(source, /\.dm-switch:not\(:has\(input\[type="checkbox"\]:disabled\)\):hover/)
})
