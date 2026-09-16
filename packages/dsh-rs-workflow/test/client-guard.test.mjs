// 体量守卫:lib/engine 每源文件 ≤ 600 行;client 单文件预算 ≤ 1500 行(平台单入口约束);
// client 半区关键契约(模块注册/守卫类名/别名 token)钉住
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

test('Given 全部 lib/engine 源文件 When 统计行数 Then 每文件 ≤ 600 行', () => {
  const files = [
    ...walk(join(PKG_ROOT, 'lib')),
    ...walk(join(PKG_ROOT, 'engine')),
  ]
  assert.ok(files.length >= 15)
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
  // 控制通道契约:cancel/pause/resume/message 四 kind
  for (const kind of ['cancel', 'pause', 'resume', 'message']) {
    assert.ok(text.includes(`'${kind}'`), kind)
  }
})

test('Given client.js When 检查视图职责 Then 运行记录唯一视图=会话页签,设置页无全局运行列表', () => {
  const text = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  // 运行中心已砍(设计决议:run 寄生会话,跨会话检索交给宿主会话搜索)
  assert.ok(!text.includes('运行中心'), '设置页不得再出现运行中心子页')
  assert.ok(!text.includes("key: 'runs'"), '设置页子页不得含 runs 键')
  // 页签按本会话过滤,终态卡内嵌重跑/续跑/删除
  assert.ok(text.includes('r.sessionId === getSessionId()'), 'FlowView 须按当前会话过滤')
  assert.ok(text.includes("'resume-from'") && text.includes("'run-remove'"), '续跑/删除路由消费保留')
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
