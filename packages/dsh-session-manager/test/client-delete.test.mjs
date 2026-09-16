// 删除确认链与强提示契约:删除 = 两击行内确认 + 弹窗强提示,弹窗内确认才发请求。
// 文案与行为同源锁定,防重构丢失强提示使用户误删。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

test('源码契约:删除按钮悬停强提示齐备', () => {
  assert.ok(CLIENT_SRC.includes('会影响其他插件'), '删除提示缺其他插件影响声明')
  assert.ok(CLIENT_SRC.includes('若无特殊需求,请不要删除'), '删除提示缺"若无特殊需求不要删除"劝阻语')
})

// Given 弹窗确认层, When 渲染, Then 强提示文案、会话标题、双按钮齐备且受控挂载
test('源码契约:删除弹窗强提示与受控挂载齐备', () => {
  assert.ok(CLIENT_SRC.includes('sm-dialog'), '缺弹窗样式锚点')
  assert.ok(CLIENT_SRC.includes('DELETE_DIALOG_TITLE'), '缺弹窗标题常量')
  assert.ok(CLIENT_SRC.includes('DELETE_DIALOG_BODY'), '缺弹窗正文常量')
  assert.ok(/DELETE_DIALOG_BODY[\s\S]{0,60}row\.title/.test(CLIENT_SRC), '弹窗正文未携带会话标题')
  assert.ok(CLIENT_SRC.includes("h(DeleteDialog"), '弹窗组件未在应用内挂载')
  assert.ok(CLIENT_SRC.includes('pendingDelete'), '缺待删会话受控状态')
  assert.ok(/pendingDelete[\s\S]{0,80}setPendingDelete\(null\)/.test(CLIENT_SRC), '弹窗取消未清空待删状态')
})

// Given 弹窗确认, When 确认删除, Then 才发删除请求;成功文案按处置模式区分
test('源码契约:弹窗确认触发请求且成功文案区分处置模式', () => {
  assert.ok(CLIENT_SRC.includes('DELETE_TOAST_OS'), '缺 OS 回收站成功文案常量')
  assert.ok(CLIENT_SRC.includes('DELETE_TOAST_QUARANTINE'), '缺回收区成功文案常量')
  assert.ok(CLIENT_SRC.includes("mode === 'quarantine'"), '成功文案未按响应 mode 区分')
  assert.ok(CLIENT_SRC.includes('DELETE_URL'), '缺删除请求地址')
  // 弹窗确认函数与删除请求联动:确认键处理体内发出 DELETE 请求
  assert.ok(/const onDialogConfirm[\s\S]{0,400}DELETE_URL/.test(CLIENT_SRC), '弹窗确认未触发删除请求')
})

// Given 已删除区, When 渲染提示, Then 两种找回路径(OS 还原 / 回收区直接重挂载)均有说明
test('源码契约:已删除区说明覆盖两种找回路径', () => {
  assert.ok(CLIENT_SRC.includes('到系统回收站将会话文件夹还原到原位置'), '缺 OS 回收站还原指引')
  assert.ok(CLIENT_SRC.includes('回收区暂存的会话直接点「重新挂载」即可找回'), '缺回收区直接重挂载指引')
})
