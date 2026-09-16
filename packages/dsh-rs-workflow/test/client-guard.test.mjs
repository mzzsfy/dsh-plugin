// 体量守卫:lib 每源文件 ≤ 600 行;client 单文件预算 ≤ 1500 行(平台单入口约束);
// client 设置页关键契约(模块注册/守卫类名/别名 token)钉住
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_LINES = 600
const CLIENT_MAX_LINES = 1500

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(mjs|js)$/.test(name) && !name.endsWith('.test.mjs')) out.push(full)
  }
  return out
}

test('Given 全部 lib 源文件 When 统计行数 Then 每文件 ≤ 600 行', () => {
  const files = walk(join(PKG_ROOT, 'lib'))
  assert.ok(files.length >= 5)
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n').length
    assert.ok(lines <= MAX_LINES, `${file} 行数 ${lines} 超限 ${MAX_LINES}`)
  }
})

test('Given client.js When 统计行数 Then ≤ 1500 行(平台单入口,分区 banner 预算)', () => {
  const lines = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8').split('\n').length
  assert.ok(lines <= CLIENT_MAX_LINES, `client.js 行数 ${lines} 超预算 ${CLIENT_MAX_LINES}`)
})

test('Given client.js When 检查关键契约 Then 自注册形态/路由前缀/类名前缀/别名 token 齐备', () => {
  const text = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(text.includes('__ModuleLoader__.load'))
  assert.ok(text.includes("id: '@mzzsfy/dsh-rs-workflow'"))
  assert.ok(text.includes('/api/rsww/'))
  assert.ok(!text.includes('/api/rs-workflow/'))
  assert.ok(text.includes('--dsw-alias-'))
  // 开关规约:checkbox 锚定 + track/thumb 结构
  assert.ok(text.includes('.rsww-switch input[type="checkbox"]:checked + .rsww-switch__track'))
})

test('Given client.js When 检查视图职责 Then 会话页签(v5 恢复)+设置页分区并存,无 v4 运行时残留', () => {
  const text = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  // v5:会话页签恢复(FlowView/FlowChip 经会话感知条件注入)
  assert.ok(text.includes("'conversation.view'"), 'v5 会话页签必须在场')
  assert.ok(text.includes("'conversation.session.header.actions'"), 'v5 会话胶囊必须在场')
  // v5 修订四处:裁决来源徽标/waiting_approval 态/plan.source/warnings 徽标
  assert.ok(text.includes("waiting_approval: { label: '待审批'"), '状态表须含 waiting_approval')
  assert.ok(text.includes("'代审'") && text.includes("'真人'"), '裁决来源徽标(代审/真人)')
  assert.ok(text.includes("'模型规划'") && text.includes("'模板全序'"), 'plan.source 标识')
  assert.ok(text.includes("React.createElement(Badge, { tone: 'warn' }, '警告 ' + warnings.length)"), 'warnings 徽标')
  assert.ok(text.includes("by: 'user'"), '页签裁决提交带 by:user')
  // 设置页不承载运行记录(会话页签唯一视图)
  assert.equal(text.includes("{ key: 'runs'"), false, '设置页不得有运行记录子页')
})

test('Given client.js When 检查死通道 Then 不得派发无监听的 window 自定义事件', () => {
  const text = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(!text.includes('dispatchEvent'), '禁止 window.dispatchEvent 死通道')
})

test('Given client.js When 检查复制能力 Then 规范面板与全文展开须挂复制按钮(双通道写入)', () => {
  const text = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(text.includes('navigator.clipboard?.writeText'), 'clipboard API 优先')
  assert.ok(text.includes("execCommand('copy')"), '非安全上下文 execCommand 兜底')
  assert.ok(text.includes('h(CopyButton, { text: specText })'), '模板规范面板挂复制')
})

test('Given client.js When 检查模板详情 Then 只读弹窗+一键检验覆盖所有模板卡', () => {
  const text = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(text.includes("'template?id='"), '详情数据经 host 解析路由')
  assert.ok(text.includes('h(TemplateViewer, { entry: viewing'), '查看态接线')
  assert.ok(text.includes("onClick: onView }, '详情'"), '所有模板卡带详情入口')
  assert.ok(text.includes("dryRun: true }"), '一键检验走 dryRun 不落盘')
  assert.ok(text.includes('rsww-modal'), '悬浮弹窗壳')
})

test('Given client.js When 检查 color 值 Then 不使用裸 hex(仅 alias token 或 fallback)', () => {
  const text = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const cssMatch = text.match(/const CSS = `([\s\S]*?)`/)
  assert.ok(cssMatch)
  const css = cssMatch[1]
  // 允许 rgba fallback 与 color-mix;裸 hex 色值不允许(别名 token 主导,fallback 允许)
  const bareHex = css.match(/(?<![-#])[0-9a-fA-F]{6}\b/g) || []
  assert.deepEqual(bareHex, [])
})
