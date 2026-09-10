// 开关样式守卫 BDD:状态选择器回退为裸 input 会静默隐藏 label 内其他 input,
// 属无报错的 UI 损坏,故对源文本做静态断言锁死结构(usage-panel 同款守卫)
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

test('switch 状态选择器禁止裸 input 锚定(防误伤 label 内其他 input)', () => {
  const bare = source.match(/\.dm-switch input:(?!\[type)[a-z-]+/g)
  assert.equal(bare, null, `裸 input 状态选择器: ${bare}`)
})

test('switch 文字标签的视觉提前依赖 order 规则,删除即回退到 track 右侧', () => {
  assert.match(source, /\.dm-switch \.dm-row__label \{ order:-1/)
})

test('checkbox 仅允许出现在 Switch 组件内,禁止裸 checkbox 直出', () => {
  const occurrences = [...source.matchAll(/type: 'checkbox'/g)].map((match) => match.index)
  assert.equal(occurrences.length, 1, `checkbox 字面量出现 ${occurrences.length} 次`)
  const factoryStart = source.indexOf('function Switch(')
  const factoryEnd = source.indexOf('dm-switch__thumb', factoryStart)
  assert.ok(occurrences[0] > factoryStart && occurrences[0] < factoryEnd, 'checkbox 字面量不在 Switch 组件内')
})

test('Switch 产出顺序为 input 在前 track 在后', () => {
  const factory = source.slice(source.indexOf('function Switch('))
  assert.ok(factory.indexOf("h('input'") < factory.indexOf('dm-switch__track'), '组件内 input 必须先于 track')
})

test('Switch 的 input 与 track 必须紧邻(状态选择器为紧邻组合器,中间插元素即视觉失效)', () => {
  const factory = source.slice(source.indexOf('function Switch('))
  const inputAt = factory.indexOf("h('input'")
  const trackAt = factory.indexOf("h('span', { className: 'dm-switch__track'")
  assert.ok(inputAt >= 0 && trackAt > inputAt, '前置:input 先于 track')
  const between = factory.slice(inputAt + 1, trackAt)
  assert.equal((between.match(/\bh\('/g) || []).length, 0, 'input 与 track 之间不得插入其他元素')
})
