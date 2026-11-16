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
  // 可达性:aria 关联 + 初始焦点落取消 + Escape 出口
  assert.ok(CLIENT_SRC.includes("'aria-labelledby'"), '弹窗缺 aria-labelledby')
  assert.ok(CLIENT_SRC.includes("'aria-describedby'"), '弹窗缺 aria-describedby')
  assert.ok(/cancelRef\.current\.focus\(\)/.test(CLIENT_SRC), '弹窗初始焦点未落取消键')
  assert.ok(/key === 'Escape'/.test(CLIENT_SRC), '弹窗缺 Escape 取消出口')
})

// Given 弹窗确认, When 确认删除, Then 才发删除请求;成功文案按处置模式区分
test('源码契约:弹窗确认触发请求且成功文案区分处置模式', () => {
  assert.ok(CLIENT_SRC.includes('DELETE_TOAST_OS'), '缺 OS 回收站成功文案常量')
  assert.ok(CLIENT_SRC.includes('DELETE_TOAST_QUARANTINE'), '缺回收区成功文案常量')
  assert.ok(CLIENT_SRC.includes("mode === 'quarantine'"), '成功文案未按响应 mode 区分')
  assert.ok(CLIENT_SRC.includes('DELETE_URL'), '缺删除请求地址')
  // 弹窗确认函数与删除请求联动:确认键处理体内发出 DELETE 请求
  assert.ok(/function onDialogConfirm[\s\S]{0,700}DELETE_URL/.test(CLIENT_SRC), '弹窗确认未触发删除请求')
})

// Given 已删除区, When 渲染提示, Then 两种找回路径(OS 还原 / 回收区直接重挂载)均有说明
test('源码契约:已删除区说明覆盖两种找回路径', () => {
  assert.ok(CLIENT_SRC.includes('到系统回收站将会话文件夹还原到原位置'), '缺 OS 回收站还原指引')
  assert.ok(CLIENT_SRC.includes('回收区暂存的会话直接点「重新挂载」即可找回'), '缺回收区直接重挂载指引')
})

// Given 删除与重挂载是服务端长事务(回收站命令 60s + 级联逐子会话), When 前端发请求,
// Then 走独立长超时,不共用普通请求的 8s(否则服务端仍在执行而面板谎报失败)
test('源码契约:删除与重挂载使用独立长超时,超时文案说明仍在执行', () => {
  const timeoutMatch = CLIENT_SRC.match(/const API_TIMEOUT_MS = (\d+) \* 1000/)
  const longMatch = CLIENT_SRC.match(/const LONG_ACTION_TIMEOUT_MS = (\d+) \* 60 \* 1000/)
  assert.ok(timeoutMatch, '缺普通请求超时常量')
  assert.ok(longMatch, '缺长事务超时常量')
  assert.ok(Number(longMatch[1]) * 60 > Number(timeoutMatch[1]), '长事务超时必须显著大于普通请求超时')
  assert.ok(/const LONG_ACTION_TIMEOUT_HINT = '[^']*仍在执行[^']*'/.test(CLIENT_SRC), '超时文案未说明服务端仍在执行')
  // 两个长事务入口都要显式传 timeoutMs(源内 2 处:删除 + 重挂载)
  const explicit = CLIENT_SRC.match(/timeoutMs: LONG_ACTION_TIMEOUT_MS/g) || []
  assert.equal(explicit.length, 2, '删除/重挂载未各自显式使用长超时')
  assert.ok(/api\(DELETE_URL, \{ method: 'POST', body: JSON\.stringify\(\{ sessionId: row\.id \}\), timeoutMs: LONG_ACTION_TIMEOUT_MS \}\)/.test(CLIENT_SRC),
    '删除请求未接长超时')
  assert.ok(/api\(REMOUNT_URL, \{ method: 'POST', body: JSON\.stringify\(\{ sessionId: row\.sessionId \}\), timeoutMs: LONG_ACTION_TIMEOUT_MS \}\)/.test(CLIENT_SRC),
    '重挂载请求未接长超时')
})
