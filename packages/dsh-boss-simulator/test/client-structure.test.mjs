import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/client.js'), 'utf8')
const compatibility = readFileSync(join(root, '兼容性测试.md'), 'utf8')

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
  assert.match(source, /bs-workspace--single/)
  assert.match(source, /\.bs-empty-state\{[^}]*max-width:720px/)
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

test('Given 已授权任务 When 派发前 Then 需要显式二次确认且确认按钮标明推进目标', () => {
  assert.match(source, /setConfirmDispatch\(true\)/)
  assert.match(source, /确认派发实施（\$\{targetLabel\}），开始消耗模型/)
  assert.match(source, /'先不派发'/)
})

test('Given 任务待验收 When 无在途 Run Then 提供派发独立验收入口', () => {
  assert.match(source, /const canAccept = idle && target\?\.phase === 'accept'/)
  assert.match(source, /'派发独立验收'/)
  assert.match(source, /dispatchTask\(value\)/)
  assert.match(source, /实施报告已提交；派发独立验收通过后才可结案/)
})

test('Given 多子项任务 When 派发 Then 目标取自服务端推进计划而不是第一个子项', () => {
  assert.match(source, /const target = detailReady \? \(detail\.nextDispatch \?\? null\) : null/)
  assert.match(source, /workItemId: target\.workItemId/)
  assert.doesNotMatch(source, /workItems\?\.\[0\]\?\.workItemId/, '客户端不得自行选定第一个子项')
})

test('Given 设置页与对话框 When 打开 Then 引用已声明的读取控制器且焦点不随输入重置', () => {
  // settingsRead 曾被漏声明:打开设置会 ReferenceError,源码守卫须盯住声明本身
  assert.match(source, /const settingsRead = useRef\(null\)/)
  assert.match(source, /settingsRead\.current\?\.abort\(\)/)
  // close 若进依赖数组,每次键入重渲染都会把焦点抢回首项
  assert.match(source, /const closeRef = useRef\(close\)/)
  assert.match(source, /\}, \[open, panelRef\]\)/)
})

test('Given 全局停止解除 When 本版不扩面板入口 Then 明确声明 API-only 且客户端不私接', () => {
  // R2-W1:全局停止/解除只经 board interrupt 路由;面板不渲染 globalControl,也不提供入口
  assert.match(compatibility, /全局控制\(API-only\)/)
  assert.match(compatibility, /global:true,resume:true/)
  assert.match(compatibility, /不提供全局停止\/解除入口/)
  assert.doesNotMatch(source, /globalStopped|globalStopGeneration/, '客户端不得渲染全局控制态')
  assert.doesNotMatch(source, /global: true/, '客户端不提供全局停止入口')
  assert.doesNotMatch(source, /resume: true/, '客户端不提供全局解除入口')
})

test('Given 迟到报告诊断 When 渲染执行记录 Then 诊断可见且标注可否采纳;删除确认说明作用域', () => {
  assert.match(source, /run\.reportDiagnostic \? h\('span'/, 'reportDiagnostic 必须有渲染出口')
  assert.match(source, /late_report: '迟到报告'/)
  assert.match(source, /内容完整，可人工采纳/)
  assert.match(source, /执行记录、报告与用量台账/, '删除确认/完成提示须说明删掉什么')
  assert.match(source, /宿主会话与其历史/, '删除文案不得暗示宿主历史被删')
  assert.equal(/执行会话与历史记录不再属于本看板/.test(source), false, '旧文案把宿主历史说成被删,必须移除')
})
