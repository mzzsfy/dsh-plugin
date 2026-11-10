import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, DEFAULT_ALLOWLIST, defaultAllowlistFor, resolveConfig, resolveConfigStrict, unwrapConfig } from '../src/config.mjs'

test('出厂默认:核心工具白名单 + enabled + collapse', () => {
  const config = resolveConfig({})
  assert.deepEqual(config.allowlist, [...DEFAULT_ALLOWLIST])
  assert.equal(config.enabled, true)
  assert.equal(config.collapse, true)
})

test('平台出厂白名单:跨平台只差终端工具,插件注入工具仅 Windows shell 例外', () => {
  const win = defaultAllowlistFor('win32')
  const linux = defaultAllowlistFor('linux')
  const darwin = defaultAllowlistFor('darwin')
  assert.deepEqual(win, [
    'read', 'edit', 'write', 'shell', 'pwsh', 'glob', 'grep', 'todo_write',
    'ask_user_question', 'present', 'web_search', 'skill', 'subagent', 'job_kill', 'read_image',
  ])
  assert.deepEqual(linux, [
    'read', 'edit', 'write', 'bash', 'glob', 'grep', 'todo_write',
    'ask_user_question', 'present', 'web_search', 'skill', 'subagent', 'job_kill', 'read_image',
  ])
  assert.deepEqual(darwin, linux)
  // 终端槽位:Windows = shell-select 的 shell + 官方 pwsh;POSIX 只有官方 bash
  const terminalSlot = (list) => list.filter((name) => ['shell', 'pwsh', 'bash'].includes(name))
  assert.deepEqual(terminalSlot(win), ['shell', 'pwsh'])
  assert.deepEqual(terminalSlot(linux), ['bash'])
  const nonTerminal = (list) => list.filter((name) => !['shell', 'pwsh', 'bash'].includes(name))
  assert.deepEqual(nonTerminal(win), nonTerminal(linux))
  // 第三方插件工具(浏览器 cdp / 检索联邦等)不在出厂白名单
  for (const pluginTool of ['bcdp_help', 'multi_search', 'platform_search', 'boss_simulator']) {
    assert.ok(!win.includes(pluginTool), `${pluginTool} 不应默认启用`)
    assert.ok(!linux.includes(pluginTool), `${pluginTool} 不应默认启用`)
  }
  assert.deepEqual([...DEFAULT_ALLOWLIST], defaultAllowlistFor())
})

test('volatile ref 容器解箱:get() 协议', () => {
  const config = resolveConfig(unwrapConfig({
    allowlist: { get: () => ['read'] },
    enabled: { get: () => false },
    collapse: { get: () => false },
  }))
  assert.deepEqual(config.allowlist, ['read'])
  assert.equal(config.enabled, false)
  assert.equal(config.collapse, false)
})

test('落盘坏值宽容降级:类型不符键降 schema 默认(行不死)', () => {
  const config = resolveConfig({ allowlist: { broken: true }, enabled: 'yes', collapse: 1 })
  assert.deepEqual(config.allowlist, [...DEFAULT_ALLOWLIST])
  assert.equal(config.enabled, true)
  assert.equal(config.collapse, true)
})

test('执行面严格解析:ref 容器未解箱即抛(炸在收敛点)', () => {
  assert.throws(() => resolveConfigStrict({ allowlist: { get: () => [] } }), /形态非法/)
})

test('执行面严格解析:collapse 非布尔即抛', () => {
  assert.throws(() => resolveConfigStrict({ collapse: 'yes' }), /形态非法/)
})

test('执行面严格解析:普通对象合法输入直通', () => {
  const config = resolveConfigStrict({ allowlist: ['shell'], enabled: false, collapse: false })
  assert.deepEqual(config.allowlist, ['shell'])
  assert.equal(config.enabled, false)
  assert.equal(config.collapse, false)
})

test('resolveConfig 幂等:二轮 resolve 不炸不可扩展产物', () => {
  const first = resolveConfig({ allowlist: ['read'] })
  const second = resolveConfig(first)
  assert.deepEqual(second.allowlist, ['read'])
})
