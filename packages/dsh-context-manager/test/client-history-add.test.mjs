// 常用提示词编辑态新增行 BDD:提交落点纯函数切片 + 按钮/键盘接线源码契约。
// client.js 单文件自包含无法 import,切片经 new Function 实例化后断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 切片:注入标记常量起点到历史浮层组件声明终点,范围内仅常量与纯函数
const PURE_START = CLIENT_SRC.indexOf('const HISTORY_BTN_FLAG = ')
const PURE_END = CLIENT_SRC.indexOf('function HistoryDock(')
assert.ok(PURE_START >= 0 && PURE_END > PURE_START, 'client.js 纯函数切片定位失败')
const pure = new Function(
  CLIENT_SRC.slice(PURE_START, PURE_END)
  + '; return { takeAddInput: takeAddInput }',
)()

// 新增行输入节点桩:非受控 input,提交时读 value 并清空
function stubInput(value) {
  return { value }
}

// ── 场景1/2:提交落点 ──

test('takeAddInput:有文本时提交一次并清空输入框', () => {
  const input = stubInput('  总结这次改动  ')
  const submitted = []
  const taken = pure.takeAddInput(input, (text) => submitted.push(text))
  assert.equal(taken, true, '非空文本应提交')
  assert.deepEqual(submitted, ['总结这次改动'], '提交前必须去首尾空白')
  assert.equal(input.value, '', '提交后必须清空输入框')
})

test('takeAddInput:空与全空白不提交,输入框内容保留', () => {
  for (const value of ['', '   ']) {
    const input = stubInput(value)
    const submitted = []
    const taken = pure.takeAddInput(input, (text) => submitted.push(text))
    assert.equal(taken, false, '空白文本不得提交')
    assert.deepEqual(submitted, [], '空白文本不得触发收藏请求')
    assert.equal(input.value, value, '未提交时不得改动输入框内容')
  }
})

test('takeAddInput:输入节点缺失时安全返回 false', () => {
  const submitted = []
  assert.equal(pure.takeAddInput(null, (text) => submitted.push(text)), false)
  assert.deepEqual(submitted, [])
})

// ── 场景3:按钮与键盘同一落点 ──

const addRowStart = CLIENT_SRC.indexOf("className: 'cx-hist__addrow'")
const addRowEnd = CLIENT_SRC.indexOf('// 插话撤回投影', addRowStart)
assert.ok(addRowStart > 0 && addRowEnd > addRowStart, '新增行渲染段定位失败')
const ADD_ROW = CLIENT_SRC.slice(addRowStart, addRowEnd)

test('源码契约:新增行渲染原生按钮,点击与 Enter 共用同一提交函数', () => {
  assert.ok(ADD_ROW.includes("h('button'"), '新增行缺按钮')
  assert.ok(ADD_ROW.includes("className: 'cx-hist__addbtn'"), '按钮缺包前缀类名')
  assert.ok(ADD_ROW.includes("type: 'button'"), '按钮必须声明 type=button 防表单提交')
  assert.ok(/onClick: submitAddPrompt/.test(ADD_ROW), '按钮点击必须接到共用提交函数')
  assert.ok(/event\.key === 'Enter'[\s\S]{0,160}submitAddPrompt\(\)/.test(ADD_ROW), 'Enter 必须复用同一提交函数')
  // 共用实现只有一处:提交逻辑经 takeAddInput 读取非受控输入
  assert.ok(/function submitAddPrompt\(\)[\s\S]{0,200}takeAddInput\(addInputRef\.current, togglePrompt\)/.test(CLIENT_SRC),
    'submitAddPrompt 必须以 takeAddInput 为唯一提交实现')
})

test('源码契约:非受控输入经 ref 读取,按钮不抢输入焦点(触摸键盘不收起)', () => {
  assert.ok(/const addInputRef = React\.useRef\(null\)/.test(CLIENT_SRC), '新增行输入必须经 ref 读取')
  assert.ok(/ref: addInputRef/.test(ADD_ROW), '输入节点必须挂 addInputRef')
  assert.ok(/onMouseDown: \(event\) => event\.preventDefault\(\)/.test(ADD_ROW),
    '按钮按下必须保持输入框焦点,避免移动端虚拟键盘收起')
})

// ── 场景4:输入法组合态 ──

test('源码契约:新增行 Enter 跳过输入法组合态', () => {
  assert.ok(/event\.key === 'Enter'\s*&&\s*!event\.isComposing/.test(ADD_ROW),
    '组合输入未上屏时 Enter 不得提交')
})

test('源码契约:重命名行 Enter 同样跳过输入法组合态', () => {
  const editStart = CLIENT_SRC.indexOf('const editRow = (item, index)')
  const editEnd = CLIENT_SRC.indexOf('const hitCount =', editStart)
  const EDIT_ROW = CLIENT_SRC.slice(editStart, editEnd)
  assert.ok(editStart > 0 && editEnd > editStart, '重命名行渲染段定位失败')
  assert.ok(/event\.key === 'Enter'\s*&&\s*!event\.isComposing/.test(EDIT_ROW),
    '组合输入确认候选不得触发改名提交')
})

test('源码契约:重命名走原位重命名路由,不再用两次 toggle 把条目搬到首位', () => {
  const start = CLIENT_SRC.indexOf('function renamePrompt(')
  const end = CLIENT_SRC.indexOf('\n  }', start)
  const RENAME = CLIENT_SRC.slice(start, end)
  assert.ok(start > 0 && RENAME.length > 0, '重命名实现定位失败')
  assert.ok(/api\(PROMPTS_RENAME_URL/.test(RENAME), '重命名必须走 rename 路由(host 原位替换保顺序)')
  assert.ok(!/togglePrompt\(/.test(RENAME), '重命名不得再拆成两次 toggle(会把条目 unshift 到首位)')
  assert.ok(/const PROMPTS_RENAME_URL = '\/api\/context\/prompts\/rename'/.test(CLIENT_SRC), '缺少 rename 路由常量')
})

const KEYDOWN_START = CLIENT_SRC.indexOf('function onKeyDown(event)')
const KEYDOWN = CLIENT_SRC.slice(KEYDOWN_START, CLIENT_SRC.indexOf("document.addEventListener('keydown', onKeyDown, true)", KEYDOWN_START))
assert.ok(KEYDOWN_START > 0 && KEYDOWN.length > 0, '全局键盘层定位失败')

test('源码契约:焦点在浮层内按钮上时 Enter 放行原生激活,不被列表回填劫持', () => {
  assert.ok(/if \(root && active && active\.tagName === 'BUTTON' && root\.contains\(active\)\) return/.test(KEYDOWN),
    '按钮聚焦时 Enter 必须交给浏览器原生 click(编辑态「添加」是主路径)')
})

test('源码契约:新增行占位文案不再依赖 Enter 键', () => {
  assert.ok(!ADD_ROW.includes('Enter 添加'), '占位文案不得把 Enter 作为唯一添加路径')
  assert.ok(ADD_ROW.includes('输入常用提示词'), '占位文案应保留输入说明')
})

// ── 场景5:触摸设备不依赖悬停 ──

const CSS_START = CLIENT_SRC.indexOf('const CSS = [')
const CSS_END = CLIENT_SRC.indexOf('const INPUTS_URL = ')
const CSS = CLIENT_SRC.slice(CSS_START, CSS_END)

test('源码契约:触摸设备收藏星标常显,不依赖 hover 才出现', () => {
  assert.ok(/@media \(hover: none\) \{[\s\S]*?\.cx-hist__star \{ opacity:1; \}/.test(CSS),
    '无 hover 设备必须常显星标(否则收藏入口不可发现)')
})

test('源码契约:新增按钮视觉按主按钮规范(实底 accent + hover 加深)', () => {
  assert.ok(/\.cx-hist__addbtn \{[^}]*background:var\(--cx-accent\)/.test(CSS), '主按钮实底缺 accent')
  assert.ok(/\.cx-hist__addbtn:hover \{ background:var\(--cx-accent-deep\)/.test(CSS), 'hover 未加深')
  assert.ok(/\.cx-hist__addbtn:focus-visible \{ outline:2px solid var\(--cx-focus\)/.test(CSS), '缺焦点环')
})
