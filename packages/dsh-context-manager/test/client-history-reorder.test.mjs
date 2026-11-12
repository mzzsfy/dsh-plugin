// 常用提示词拖动排序 BDD:落位计算与数组移动纯函数切片 + 源码契约(手柄/指针接线/
// 轮询停链/持久化/键盘移动/样式)。client.js 单文件自包含无法 import,切片经
// new Function 实例化后断言;事件与渲染接线由源码契约锁定。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 切片:与 parity 同区段(历史范围常量 → 历史浮层组件声明),范围内仅常量与纯函数
const PURE_START = CLIENT_SRC.indexOf('const HISTORY_SCOPES = ')
const PURE_END = CLIENT_SRC.indexOf('function HistoryDock(')
assert.ok(PURE_START >= 0 && PURE_END > PURE_START, 'client.js 纯函数切片定位失败')
const pure = new Function(
  CLIENT_SRC.slice(PURE_START, PURE_END)
  + '; return { resolveDropIndex: resolveDropIndex, moveByInsert: moveByInsert, keyboardInsert: keyboardInsert }',
)()

// 行矩形夹具:行高 36,首行 top=0
function rowsOf(count, height = 36) {
  return Array.from({ length: count }, (_, index) => ({ top: index * height, bottom: (index + 1) * height }))
}

// ── 场景1:指针位置 → 插入位 ──

test('resolveDropIndex:以每行中点为分界,指针在上半区落在该行之前', () => {
  const rows = rowsOf(3)
  assert.equal(pure.resolveDropIndex(rows, 10), 0)
  assert.equal(pure.resolveDropIndex(rows, 17), 0, '恰在中点之上仍属本行前半')
  assert.equal(pure.resolveDropIndex(rows, 19), 1)
  assert.equal(pure.resolveDropIndex(rows, 53), 1)
  assert.equal(pure.resolveDropIndex(rows, 55), 2)
})

test('resolveDropIndex:超出最后一行落到列表末尾,空列表落 0', () => {
  const rows = rowsOf(3)
  assert.equal(pure.resolveDropIndex(rows, 999), 3)
  assert.equal(pure.resolveDropIndex([], 50), 0)
})

test('resolveDropIndex:非整数/缺失行安全(退化为末尾,不抛错)', () => {
  assert.equal(pure.resolveDropIndex(rowsOf(2), Number.NaN), 2)
  assert.equal(pure.resolveDropIndex(undefined, 10), 0)
})

// ── 场景2:数组按插入位移动 ──

test('moveByInsert:向下移动时插入位按原列表语义补偿,末位落到列表尾', () => {
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 0, 3), ['B', 'C', 'A'])
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 0, 2), ['B', 'A', 'C'])
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 1, 3), ['A', 'C', 'B'])
})

test('moveByInsert:向上移动直接插入目标位', () => {
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 2, 0), ['C', 'A', 'B'])
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 1, 0), ['B', 'A', 'C'])
})

test('moveByInsert:原地插入与相邻插入均不改变顺序,越界源项原样返回', () => {
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 1, 1), ['A', 'B', 'C'])
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 1, 2), ['A', 'B', 'C'])
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 5, 1), ['A', 'B', 'C'])
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], -1, 1), ['A', 'B', 'C'])
})

test('moveByInsert:不修改入参(渲染态数组不可变)', () => {
  const list = ['A', 'B', 'C']
  pure.moveByInsert(list, 0, 3)
  assert.deepEqual(list, ['A', 'B', 'C'])
})

// ── 场景3:键盘排序的插入位(端点停住)──

test('keyboardInsert:上移插到前一位之前,下移插到后一位之后', () => {
  assert.equal(pure.keyboardInsert('ArrowUp', 2, 3), 1)
  assert.equal(pure.keyboardInsert('ArrowDown', 1, 3), 3)
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 1, pure.keyboardInsert('ArrowDown', 1, 3)), ['A', 'C', 'B'])
  assert.deepEqual(pure.moveByInsert(['A', 'B', 'C'], 2, pure.keyboardInsert('ArrowUp', 2, 3)), ['A', 'C', 'B'])
})

test('keyboardInsert:首项上移与末项下移返回 -1(边界停住)', () => {
  assert.equal(pure.keyboardInsert('ArrowUp', 0, 3), -1)
  assert.equal(pure.keyboardInsert('ArrowDown', 2, 3), -1)
  assert.equal(pure.keyboardInsert('ArrowUp', 0, 1), -1)
  assert.equal(pure.keyboardInsert('ArrowDown', 0, 1), -1)
})

// ── 场景4:手柄渲染与事件接线 ──

const EDIT_ROW_START = CLIENT_SRC.indexOf('const editRow = (item, index)')
const EDIT_ROW_END = CLIENT_SRC.indexOf('const hitCount =', EDIT_ROW_START)
assert.ok(EDIT_ROW_START > 0 && EDIT_ROW_END > EDIT_ROW_START, '编辑态行渲染段定位失败')
const EDIT_ROW = CLIENT_SRC.slice(EDIT_ROW_START, EDIT_ROW_END)

const GRIP_START = CLIENT_SRC.indexOf('function gripSvg(')
const GRIP_END = CLIENT_SRC.indexOf('function startDrag(')
assert.ok(GRIP_START > 0 && GRIP_END > GRIP_START, '手柄渲染段定位失败')
const GRIP = CLIENT_SRC.slice(GRIP_START, GRIP_END)

const DRAG_START = CLIENT_SRC.indexOf('function startDrag(')
const DRAG_END = CLIENT_SRC.indexOf('function commitOrder(')
assert.ok(DRAG_START > 0 && DRAG_END > DRAG_START, '拖动处理段定位失败')
const DRAG = CLIENT_SRC.slice(DRAG_START, DRAG_END)

test('源码契约:仅编辑态行渲染拖动手柄,非编辑态行不出现手柄', () => {
  assert.ok(EDIT_ROW.includes('gripHandle('), '编辑态行必须渲染拖动手柄')
  const ROW_START = CLIENT_SRC.indexOf('const rowButton = (item, index)')
  const ROW_END = CLIENT_SRC.indexOf('// 编辑态行', ROW_START)
  assert.ok(ROW_START > 0 && ROW_END > ROW_START, '非编辑态行渲染段定位失败')
  assert.ok(!CLIENT_SRC.slice(ROW_START, ROW_END).includes('gripHandle'),
    '非编辑态行不得渲染手柄(仅编辑态可拖)')
})

test('源码契约:手柄为原生按钮且带 aria-label,点击不触发行内其它动作', () => {
  assert.ok(/h\('button', \{/.test(GRIP), '手柄必须是原生按钮(role=button 的 span 会被全局键盘层当行回填)')
  assert.ok(/type: 'button'/.test(GRIP), '手柄须显式 type=button,避免隐式提交')
  assert.ok(/tabIndex: 0/.test(GRIP), '手柄必须可键盘聚焦')
  assert.ok(/['"]aria-label['"]: '[^']+'/.test(GRIP), '手柄必须有 aria-label')
  assert.ok(/onClick: \(event\) => event\.stopPropagation\(\)/.test(GRIP), '手柄点击不得冒泡触发行级动作')
})

test('源码契约:手柄图标走 React 元素(DOM 节点不能作为 React 子节点,实测崩 slot)', () => {
  assert.ok(/h\('svg'/.test(GRIP), '手柄图标必须用 React 元素渲染')
  assert.ok(!/createElementNS/.test(GRIP), '手柄图标不得返回 DOM 节点(React #31)')
})

test('源码契约:指针按下起拖并阻止默认(防文本选择/输入框失焦)', () => {
  assert.ok(/onPointerDown: \(event\) => startDrag\(event, index\)/.test(GRIP), '手柄须接线 startDrag')
  assert.ok(/event\.preventDefault\(\)/.test(DRAG), 'pointerdown 必须 preventDefault')
  assert.ok(/setPointerCapture|addEventListener\('pointermove'/.test(DRAG), '拖动须接管指针移动')
})

test('源码契约:拖动期间停轮询并丢弃迟到响应,松手后重新拉起轮询', () => {
  assert.ok(/stopRepull\(\)/.test(DRAG), '起拖必须停掉当前范围轮询链')
  const APPLY_START = CLIENT_SRC.indexOf('function applyResult(')
  const APPLY_END = CLIENT_SRC.indexOf('\n  function ', APPLY_START + 1)
  const APPLY = CLIENT_SRC.slice(APPLY_START, APPLY_END)
  assert.ok(/dragRef\.current !== null/.test(APPLY), '拖动中到达的响应不得覆盖用户拖动顺序')
  assert.ok(/requestScope\(promptsIdx\)/.test(CLIENT_SRC), '提交后必须重拉恢复轮询链')
})

test('源码契约:松手先乐观更新本地顺序,再 POST 排序,失败 toast 并回滚重拉', () => {
  const COMMIT_START = CLIENT_SRC.indexOf('function commitOrder(')
  const COMMIT_END = CLIENT_SRC.indexOf('\n  function ', COMMIT_START + 1)
  const COMMIT = CLIENT_SRC.slice(COMMIT_START, COMMIT_END)
  assert.ok(COMMIT_START > 0 && COMMIT.length > 0, '提交函数定位失败')
  assert.ok(/api\(PROMPTS_REORDER_URL/.test(COMMIT), '必须走排序路由')
  assert.ok(/method: 'POST'/.test(COMMIT), '排序必须 POST')
  assert.ok(/JSON\.stringify\(\{ texts \}\)/.test(COMMIT), '请求体为完整文本顺序')
  assert.ok(/toast\(/.test(COMMIT), '失败必须有用户可见反馈')
  assert.ok(/restartPromptPoll/.test(COMMIT), '成功/失败都必须重新拉起轮询(对齐服务端顺序)')
  assert.ok(/rawItemsRef\.current = next/.test(COMMIT), '乐观更新须写回原始条目引用')
  const POLL_START = CLIENT_SRC.indexOf('function restartPromptPoll()')
  assert.ok(POLL_START > 0 && /requestScope\(promptsIdx\)/.test(CLIENT_SRC.slice(POLL_START, POLL_START + 400)),
    '恢复轮询须走当前范围的请求入口')
})

test('源码契约:搜索过滤中不渲染手柄(子集排序无语义)', () => {
  assert.ok(/const canDrag = query\.trim\(\) === ''/.test(CLIENT_SRC), '缺少可拖判定')
  assert.ok(/canDrag \? gripHandle\(item\.text, index\) : null/.test(EDIT_ROW), '过滤中必须隐藏手柄')
})

test('源码契约:键盘 ↑/↓ 在手柄聚焦时移动条目,全局选择层放行', () => {
  assert.ok(/function moveByKey\(/.test(CLIENT_SRC), '缺少键盘移动实现')
  assert.ok(/ArrowUp/.test(CLIENT_SRC.slice(CLIENT_SRC.indexOf('function moveByKey('), CLIENT_SRC.indexOf('function moveByKey(') + 900)),
    '键盘移动须识别 ArrowUp')
  const KEYDOWN_START = CLIENT_SRC.indexOf('function onKeyDown(event)')
  const KEYDOWN = CLIENT_SRC.slice(KEYDOWN_START, CLIENT_SRC.indexOf("document.addEventListener('keydown', onKeyDown, true)", KEYDOWN_START))
  assert.ok(/cx-hist__grip/.test(KEYDOWN), '全局键盘层须对聚焦手柄放行 ↑/↓')
})

test('源码契约:卸载/关闭浮层时清理拖动监听与动画帧', () => {
  // 监听实例随指针存储:摘除必须用与注册同一份引用(闭包身份过期会漏摘)
  const DETACH_START = CLIENT_SRC.indexOf('function detachDrag(')
  const DETACH = CLIENT_SRC.slice(DETACH_START, CLIENT_SRC.indexOf('\n  }', DETACH_START))
  assert.ok(/pointer\.listeners/.test(DETACH), '摘除必须按存储的监听实例,不得用当帧闭包函数')
  for (const type of ['pointermove', 'pointerup', 'pointercancel', 'visibilitychange']) {
    assert.ok(new RegExp(`removeEventListener\\('${type}'`).test(DETACH), `摘除必须覆盖 ${type}`)
  }
  assert.ok(/removeEventListener\('blur'/.test(DETACH), '摘除必须覆盖失焦兜底')
  assert.ok(/cancelAnimationFrame/.test(DETACH), '摘除必须取消自动滚动帧')
  assert.ok(/startDrag[\s\S]*pointer\.frame = requestAnimationFrame\(autoScrollDrag\)/.test(DRAG),
    '自动滚动帧须在监听注册后由指针持有')
  const EFFECT_START = CLIENT_SRC.indexOf('useEffect(() => {')
  const EFFECT = CLIENT_SRC.slice(EFFECT_START, CLIENT_SRC.indexOf('useEffect(() => stopRepull', EFFECT_START))
  assert.ok(/detachDrag\(\)/.test(EFFECT), '关闭浮层/卸载的 effect 必须调用 detachDrag')
})

test('源码契约:拖动丢失 pointerup 时的兜底(按钮态松开/失焦/切后台)', () => {
  const MOVE_START = CLIENT_SRC.indexOf('function moveDrag(')
  const MOVE = CLIENT_SRC.slice(MOVE_START, CLIENT_SRC.indexOf('\n  }', MOVE_START))
  assert.ok(/event\.buttons === 0/.test(MOVE), '指针按钮态已松开即视为取消拖动')
  assert.ok(/cancelDrag\(\)/.test(MOVE), '兜底路径必须取消拖动并清引用')
  assert.ok(/addEventListener\('blur'/.test(DRAG), '窗口失焦必须取消拖动')
  assert.ok(/addEventListener\('visibilitychange'/.test(DRAG), '切后台必须取消拖动')
  assert.ok(/document\.hidden/.test(CLIENT_SRC), '切后台判定须读 document.hidden')
})

test('源码契约:pointercancel/pointerup 校验指针 id,多指不互相取消', () => {
  const CANCEL_START = CLIENT_SRC.indexOf('function cancelDrag(')
  const CANCEL = CLIENT_SRC.slice(CANCEL_START, CLIENT_SRC.indexOf('\n  }', CANCEL_START))
  assert.ok(/event\.pointerId !== pointer\.pointerId/.test(CANCEL), 'pointercancel 必须校验指针 id')
  const END_START = CLIENT_SRC.indexOf('function endDrag(')
  assert.ok(/event\.pointerId !== pointer\.pointerId/.test(CLIENT_SRC.slice(END_START, END_START + 400)),
    'pointerup 必须校验指针 id')
})

test('源码契约:顺序提交串行化,连续操作不得先发后到', () => {
  const COMMIT_START = CLIENT_SRC.indexOf('function commitOrder(')
  const COMMIT = CLIENT_SRC.slice(COMMIT_START, CLIENT_SRC.indexOf('\n  function ', COMMIT_START + 1))
  assert.ok(/commitChainRef\.current = commitChainRef\.current/.test(COMMIT), '排序提交必须挂在上一次提交之后')
  assert.ok(/const commitChainRef = useRef\(Promise\.resolve\(\)\)/.test(CLIENT_SRC), '缺少串行化链引用')
  assert.ok(/stopRepull\(\)/.test(COMMIT), '提交前须作废在途响应,防旧快照先落地覆盖新顺序')
})

test('源码契约:键盘排序按文本实时定位,连续按键不因旧索引移错条目', () => {
  const KEY_START = CLIENT_SRC.indexOf('function moveByKey(')
  const KEY = CLIENT_SRC.slice(KEY_START, CLIENT_SRC.indexOf('\n  }', KEY_START))
  assert.ok(/list\.findIndex\(\(item\) => item\.text === text\)/.test(KEY), '键盘排序须按文本定位当前位置')
  assert.ok(/keyboardInsert\(event\.key, from, list\.length\)/.test(KEY), '插入位须基于实时位置计算')
})

test('源码契约:插入线只在真正改变顺序的目标位显示', () => {
  const DROP_START = CLIENT_SRC.indexOf('const dropIndex = ')
  const DROP_LINE = CLIENT_SRC.slice(DROP_START, CLIENT_SRC.indexOf('\n', DROP_START))
  assert.ok(/drag\.drop !== drag\.from \+ 1/.test(DROP_LINE), '落回原位下一位不改变顺序,不得画插入线')
  assert.ok(/dropIndex === index/.test(EDIT_ROW), '插入线判定须用有效目标位')
  assert.ok(!/drag\.drop !== drag\.from && drag\.drop === index/.test(EDIT_ROW), '不得直接用原始 drop 判定')
})

test('源码契约:拖动失败响应不得清空列表', () => {
  const REQ_START = CLIENT_SRC.indexOf('function requestScope(')
  const REQ = CLIENT_SRC.slice(REQ_START, CLIENT_SRC.indexOf('function fill(', REQ_START))
  const CATCH = REQ.slice(REQ.indexOf('.catch('))
  assert.ok(/dragRef\.current !== null/.test(CATCH), '拖动期间请求失败不得清空列表')
})

// ── 场景4:样式与可见性 ──

const CSS_START = CLIENT_SRC.indexOf('const CSS = [')
const CSS_END = CLIENT_SRC.indexOf('const INPUTS_URL = ')
const CSS = CLIENT_SRC.slice(CSS_START, CSS_END)

test('源码契约:手柄样式按设计规范(包前缀类名/语义 token/touch-action)', () => {
  assert.ok(/\.cx-hist__grip \{[^}]*touch-action:none/.test(CSS), '手柄必须禁用触摸默认手势,否则拖动与滚动打架')
  assert.ok(/\.cx-hist__grip \{[^}]*color:var\(--cx-text-dim\)/.test(CSS), '手柄颜色须走语义 token')
  assert.ok(/\.cx-hist__grip:hover \{ color:var\(--cx-text\)/.test(CSS), '手柄 hover 须加深')
  assert.ok(/\.cx-hist__grip:focus-visible \{ outline:2px solid var\(--cx-focus\)/.test(CSS), '手柄缺焦点环')
})

test('源码契约:拖动视觉(源行淡化 + 插入位指示线)存在且走 accent token', () => {
  assert.ok(/\.cx-hist__editrow--drag \{[^}]*opacity/.test(CSS), '源行需淡化')
  assert.ok(/\.cx-hist__editrow--drop-before \{[^}]*var\(--cx-accent\)/.test(CSS), '插入位指示须用 accent')
  assert.ok(/\.cx-hist__editrow--drop-after \{[^}]*var\(--cx-accent\)/.test(CSS), '列表末尾插入位指示须用 accent')
})

test('源码契约:触屏无 hover 时手柄常显(拖动入口可发现)', () => {
  assert.ok(/@media \(hover: none\) \{[\s\S]*?\.cx-hist__grip \{ opacity:1; \}/.test(CSS),
    '无 hover 设备必须常显手柄')
})
