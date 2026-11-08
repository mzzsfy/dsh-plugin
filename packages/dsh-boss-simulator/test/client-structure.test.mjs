import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/client.js'), 'utf8')

test('Given 任务行 When 渲染列表 Then 整行只有一个打开按钮,危险操作留在详情', () => {
  assert.match(source, /h\('button', \{ className: 'bs-row__open'/)
  assert.match(source, /h\('button', \{ className: 'bs-btn bs-btn--danger'[\s\S]{0,400}中断/)
  // 行内不得再嵌按钮:bs-row__open 之后到行结束前不出现新的 button 元素
  assert.doesNotMatch(source, /bs-row__open[\s\S]{0,700}?h\('button'/)
})

test('Given 选中任务 When 窄容器 Then 详情转为全屏对话框并支持 Esc 关闭', () => {
  assert.match(source, /const detailModal = Boolean\(selected && containerWidth < 720\)/)
  assert.match(source, /ResizeObserver/)
  assert.match(source, /'aria-modal'/)
  assert.match(source, /event\.key === 'Escape'/)
  assert.match(source, /@container \(max-width:719px\)\{\.bs-workspace\{grid-template-columns:minmax\(0,1fr\)\}/)
})

test('Given settings draft When leaving or save conflicts Then confirmation and draft retention are visible', () => {
  assert.match(source, /role: 'alertdialog'/)
  assert.match(source, /继续编辑/)
  assert.match(source, /本地草稿已保留/)
  assert.match(source, /核对后再显式保存/)
})

test('Given 新建任务对话框 When 打开 Then 焦点困在层内且字段有可见 label 与逐项错误', () => {
  assert.match(source, /role: 'dialog', 'aria-modal': 'true'/)
  assert.match(source, /useDialogFocus/)
  assert.match(source, /label', \{ htmlFor: 'bs-task-title' \}, '任务标题'/)
  assert.match(source, /label', \{ htmlFor: 'bs-task-criteria' \}, '验收标准'/)
  assert.match(source, /bs-field__error/)
  assert.match(source, /aria-invalid/)
})

test('Given 任务状态 When 渲染列表 Then 按进行中/待处理/已结束分组且已结束默认收起', () => {
  assert.match(source, /const GROUPS = \[/)
  assert.match(source, /setCollapsed\(\{ done: true \}\)|useState\(\{ done: true \}\)/)
  assert.match(source, /bs-group__toggle/)
  // 空态按当前筛选后的可见行判断,否则单选"已结束"且无数据时整页空白
  assert.match(source, /const noTasks = visibleRows\.length === 0/)
  assert.match(source, /filter !== 'all'/)
})

test('Given 数据新鲜度 When 总线就绪 Then 显示实时标识与最后更新时间并可手动刷新', () => {
  assert.match(source, /const \[live, setLive\] = useState\(false\)/)
  assert.match(source, /'实时'/)
  assert.match(source, /'轮询兜底'/)
  assert.match(source, /最后更新 \$\{clockText/)
  assert.match(source, /refreshing \? '正在刷新' : '刷新'/)
})

test('Given 管理员会话异常 When 打开助手 Then 提供两步重建入口', () => {
  assert.match(source, /'重建管理员会话'/)
  assert.match(source, /'再次点击确认重建'/)
  assert.match(source, /startAdmin\(true\)/)
})

test('Given 宿主旧后端 When workspaces 404 Then 提示重启并禁用写操作', () => {
  assert.match(source, /if \(error\.status === 404\) setBackend\('legacy'\)/)
  assert.match(source, /宿主仍在运行旧版后端：重启 dsh 后才能新建、授权和派发/)
  assert.match(source, /disabled: backend === 'legacy', title:/)
})

test('Given 已授权任务 When 派发前 Then 需要显式二次确认', () => {
  assert.match(source, /setConfirmDispatch\(true\)/)
  assert.match(source, /'确认派发，开始消耗模型'/)
  assert.match(source, /'先不派发'/)
})

test('Given 任务待验收 When 无在途 Run Then 提供派发独立验收入口', () => {
  assert.match(source, /const canAccept = idle && value\.businessState === 'awaiting_acceptance'/)
  assert.match(source, /'派发独立验收'/)
  assert.match(source, /dispatchTask\(value, dispatchPhase\)/)
  assert.match(source, /phase,/)
  assert.match(source, /实施报告已提交；派发独立验收通过后才可结案/)
})

test('Given 设置页与对话框 When 打开 Then 引用已声明的读取控制器且焦点不随输入重置', () => {
  // settingsRead 曾被漏声明:打开设置会 ReferenceError,源码守卫须盯住声明本身
  assert.match(source, /const settingsRead = useRef\(null\)/)
  assert.match(source, /settingsRead\.current\?\.abort\(\)/)
  // close 若进依赖数组,每次键入重渲染都会把焦点抢回首项
  assert.match(source, /const closeRef = useRef\(close\)/)
  assert.match(source, /\}, \[open, panelRef\]\)/)
})
