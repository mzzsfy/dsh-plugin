// 开关结构守卫 BDD(DEVELOPMENT/plugin-client-conventions.md 强制项):
// 布尔控件必须是 switch = label.<prefix>-switch > input[type="checkbox"] + track > thumb,
// 裸 checkbox / 缺 track / 缺 thumb / checkbox 不再是 track 相邻兄弟都属无报错 UI 退化。
// 本守卫解析客户端源码中的 CSS 规则与 DOM 调用树(非 includes 类名),注释文本不参与断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeSwitch } from './switch-structure.mjs'

const PREFIX = 'tg'
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
const facts = analyzeSwitch(source, PREFIX)

test('Given 注入的开关 CSS When 解析规则 Then 隐藏 checkbox + track 胶囊 + thumb 圆点齐备', () => {
  const { css } = facts
  assert.ok(css.source.length > 0, `未解析到 .${PREFIX}-switch CSS`)
  assert.ok(css.hidden, `缺少 .${PREFIX}-switch input[type="checkbox"] 隐藏规则`)
  assert.match(css.hidden.body, /position\s*:\s*absolute/, 'checkbox 未绝对定位(视觉隐藏前提)')
  assert.match(css.hidden.body, /opacity\s*:\s*0/, 'checkbox 未视觉隐藏')
  assert.ok(css.trackRule, `缺少 .${PREFIX}-switch__track 规则`)
  assert.equal(css.trackRule.selector, `.${PREFIX}-switch__track`)
  assert.match(css.trackRule.body, /width\s*:/)
  assert.match(css.trackRule.body, /height\s*:/)
  assert.match(css.trackRule.body, /border-radius\s*:\s*(?:999px|50%)/, 'track 不是胶囊形')
  assert.ok(css.thumbRule, `缺少 .${PREFIX}-switch__thumb 规则`)
  assert.match(css.thumbRule.body, /border-radius\s*:\s*(?:999px|50%)/, 'thumb 不是圆点')
})

test('Given 开关状态选择器 When 解析 Then checked/focus/disabled 均以 input[type="checkbox"] 锚定', () => {
  const { css } = facts
  assert.ok(css.checkedTrack, '缺少 :checked + track 选中态规则')
  assert.ok(css.checkedThumb, '缺少 :checked 下 track > thumb 后裔规则(选中位移)')
  assert.match(css.checkedThumb.body, /(?:transform|left)\s*:/, 'thumb 选中态无位移')
  assert.ok(css.focusTrack, '缺少 :focus-visible + track 焦点态规则')
  assert.match(css.focusTrack.body, /outline\s*:/, '焦点态无可见轮廓')
  assert.ok(css.disabledTrack, '缺少 :disabled + track 禁用态规则')
  assert.deepEqual(css.bareStateSelectors, [], '状态选择器不得裸 input 锚定(会误伤同 label 其他 input)')
})

test('Given 开关渲染调用 When 解析 DOM 树 Then 根为 label 且 input/track/thumb 三件套顺序正确', () => {
  assert.ok(facts.roots.length >= 1, '未解析到 switch 根元素(根类名缺失或不在 label 上)')
  for (const fact of facts.roots) {
    const where = `第 ${fact.line} 行 switch`
    assert.equal(fact.root.tag, 'label', `${where} 根元素必须是 label`)
    assert.ok(fact.input, `${where} 缺少直接子节点 input[type="checkbox"]`)
    assert.equal(fact.input.tag, 'input')
    assert.equal(fact.input.type, 'checkbox', `${where} 控件语义不是 checkbox`)
    assert.match(fact.input.propsText, /\bchecked\b/, `${where} checkbox 未受控`)
    assert.ok(fact.track, `${where} 缺少 track 后裔`)
    assert.equal(fact.track.tag, 'span', `${where} track 必须是 span`)
    assert.ok(fact.thumbIndex >= 0, `${where} track 内缺少 thumb 后裔`)
    assert.equal(fact.track.children[fact.thumbIndex].tag, 'span', `${where} thumb 必须是 span`)
    assert.ok(fact.adjacent, `${where} input 与 track 必须相邻兄弟(CSS + 选择器依赖)`)
  }
})

test('Given 源码全部 checkbox 字面量 When 逐一定位 Then 每个都位于 switch 结构内(无裸 checkbox)', () => {
  assert.ok(facts.checkboxLiterals.length >= facts.roots.length, 'checkbox 数量少于 switch 根数量')
  const naked = facts.checkboxLiterals.filter((item) => !item.insideSwitch)
  assert.deepEqual(naked, [], `存在开关结构外的裸 checkbox: ${naked.map((item) => item.line).join(', ')}`)
})

test('Given 注释中写入退化开关文本 When 重新解析 Then 结构与 CSS 结论不变(断言不依赖注释)', () => {
  const decoy = [
    `// .${PREFIX}-switch input:checked + .${PREFIX}-switch__track { background: red; }`,
    '/* 本行若被当作 CSS,会伪造裸 input 状态选择器;若被当作 DOM,会伪造 switch 根 */',
    source,
  ].join('\n')
  const parsed = analyzeSwitch(decoy, PREFIX)
  assert.equal(parsed.roots.length, facts.roots.length)
  assert.equal(parsed.checkboxLiterals.length, facts.checkboxLiterals.length)
  assert.deepEqual(parsed.css.bareStateSelectors, [])
  assert.equal(Boolean(parsed.css.hidden), Boolean(facts.css.hidden))
})
