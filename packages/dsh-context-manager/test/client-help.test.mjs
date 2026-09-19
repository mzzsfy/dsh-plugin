import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// 设置项悬停说明契约:说明常量必须存在且逐项挂到对应开关(开关行工厂调用位)。
// 断言以工厂调用为锚:行文本与说明常量必须出现在同一 switchRow(...) 调用内,
// 防常量互换挂载或挂错行仍通过
test('源码契约:六项设置的悬停说明齐备且挂到对应控件', () => {
  const TITLES = {
    HISTORY_SWITCH_TITLE: '历史输入浮层开关',
    HISTORY_BUTTON_SWITCH_TITLE: '输入框历史按钮开关',
    STEER_SWITCH_TITLE: '插话撤回开关',
    FORK_SWITCH_TITLE: '对话 fork 开关',
    FORK_AUTO_RESEND_SWITCH_TITLE: '分叉后自动重发开关',
  }
  for (const [name, label] of Object.entries(TITLES)) {
    assert.ok(CLIENT_SRC.includes('const ' + name + ' ='), '缺悬停说明常量 ' + name)
  }
  const rowAnchors = [
    { constant: 'HISTORY_SWITCH_TITLE', text: "'历史输入浮层(Alt+↑)'", label: TITLES.HISTORY_SWITCH_TITLE },
    { constant: 'HISTORY_BUTTON_SWITCH_TITLE', text: "'输入框历史按钮'", label: TITLES.HISTORY_BUTTON_SWITCH_TITLE },
    { constant: 'STEER_SWITCH_TITLE', text: "'插话撤回'", label: TITLES.STEER_SWITCH_TITLE },
    { constant: 'FORK_SWITCH_TITLE', text: "'对话 fork'", label: TITLES.FORK_SWITCH_TITLE },
    { constant: 'FORK_AUTO_RESEND_SWITCH_TITLE', text: "'分叉后自动重发'", label: TITLES.FORK_AUTO_RESEND_SWITCH_TITLE },
  ]
  for (const { constant, text, label } of rowAnchors) {
    // 限定长度的跨行窗口而非单行 [^\n]*:合法的多行格式化(prettier)不误报,
    // 常量与行文本漂移出同一调用(>200 字符)仍会被检出
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const mounted = new RegExp('switchRow\\([\\s\\S]{0,200}' + escaped + '[\\s\\S]{0,200}' + constant).test(CLIENT_SRC)
    assert.ok(mounted, label + ' 未挂对应悬停说明(常量与行文本不在同一工厂调用内)')
  }
})

// 说明文案与行为同源的抽样锁定:核心语义缺失即为文案回归
test('源码契约:悬停说明覆盖各设置的关键行为语义', () => {
  assert.ok(CLIENT_SRC.includes('←/→ 切换范围'), '历史说明缺范围切换语义')
  assert.ok(CLIENT_SRC.includes('刷新页面生效'), '开关说明缺刷新生效提示')
  assert.ok(CLIENT_SRC.includes('含附件的插话不可撤回'), '撤回说明缺附件限制')
  assert.ok(CLIENT_SRC.includes('进行中的轮(回复尚未完成)'), 'fork 说明缺进行中轮可分叉语义')
  assert.ok(CLIENT_SRC.includes('停止本会话该轮未完成的回复'), 'fork 说明缺进行中轮分叉后止损语义')
  assert.ok(CLIENT_SRC.includes('无文本输入的轮'), 'fork 说明缺纯图等无文本轮限制')
  assert.ok(CLIENT_SRC.includes('回填子会话输入框'), 'fork 说明缺重试回填语义')
  assert.ok(CLIENT_SRC.includes('尾号递增'), 'fork 说明缺标题递增语义')
  assert.ok(CLIENT_SRC.includes('重生成语义'), '自动重发说明缺重生成语义')
})

// 搜索功能源码契约:query 双写 + 组合输入守卫 + 命中计数 + 两级 Esc
test('源码契约:历史浮层搜索的实现要素齐备', () => {
  assert.ok(CLIENT_SRC.includes('onCompositionStart'), '搜索框应处理 IME 组合输入开始')
  assert.ok(CLIENT_SRC.includes('onCompositionEnd'), '搜索框应处理 IME 组合输入结束')
  assert.ok(CLIENT_SRC.includes('composingRef'), '组合输入期间应经 ref 守卫跳过过滤')
  assert.ok(CLIENT_SRC.includes('cx-hist__count'), '应有命中计数样式锚点')
  assert.ok(CLIENT_SRC.includes('filterHistoryInputs(raw, next)'), '过滤应作用于原始条目集')
  assert.ok(CLIENT_SRC.includes('queryRef.current'), 'query 应双写 ref 供键盘层读取')
})
