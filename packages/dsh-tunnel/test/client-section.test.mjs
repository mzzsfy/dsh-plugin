// 设置分区注册面 BDD: 0.2.0 只保留 settings.section, 旧主面板/侧栏/插件卡/捆绑配置全部移除。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClientHarness, tick } from './support/client-harness.mjs'

const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

test('Given 插件激活 When 注册 Then 设置分区与底部状态条各一条, 旧四类入口为零', () => {
  const harness = createClientHarness()
  harness.activate()
  assert.equal(harness.sectionCount(), 1)
  assert.equal(harness.bottomCount(), 1)
  assert.equal(harness.panelCount(), 0)
  assert.equal(harness.panellistCount(), 0)
  assert.equal(harness.pluginCardCount(), 0)
  const entry = [...harness.state.buckets.get('settings.section')][0]
  assert.deepEqual(entry.options, { name: 'settings.section', id: 'tunnel', order: 47, label: '穿透隧道' })
})

test('Given 分区已注册 When 挂载 Then 并行拉取隧道(带探活)与状态, 不提前扫端口', async () => {
  const harness = createClientHarness()
  harness.activate()
  harness.renderSection()
  await tick()
  assert.ok(harness.requests.some((request) => request.url === '/api/tunnel/tunnels?probe=1'))
  assert.ok(harness.requests.some((request) => request.url === '/api/tunnel/status'))
  assert.equal(harness.requests.some((request) => request.url.startsWith('/api/tunnel/ports')), false, '端口列表默认折叠, 不应自动扫描')
})

test('Given 页面隐藏 When 总线推送 Then 不请求; 恢复可见后只补一次', async () => {
  const harness = createClientHarness()
  harness.activate()
  harness.renderSection()
  await tick()
  const before = harness.requests.length
  harness.hidePage()
  harness.publish()
  harness.publish()
  await tick()
  assert.equal(harness.requests.length, before)
  harness.showPage()
  await tick()
  assert.equal(harness.requests.length, before + 2, '恢复可见补一次列表+状态请求')
})

test('Given 页面可见 When 总线推送 Then 每次推送刷新一次', async () => {
  const harness = createClientHarness()
  harness.activate()
  harness.renderSection()
  await tick()
  const before = harness.requests.length
  harness.publish()
  await tick()
  assert.equal(harness.requests.length, before + 2)
})

test('Given 分区卸载 When 再推送 Then 不再请求', async () => {
  const harness = createClientHarness()
  harness.activate()
  harness.renderSection()
  await tick()
  const before = harness.requests.length
  harness.dispose()
  harness.publish()
  await tick()
  assert.equal(harness.requests.length, before)
})

test('Given 操作菜单 When 源码检查 Then 菜单走 body portal 并固定定位(不被设置面板滚动区裁剪)', () => {
  assert.match(clientSource, /tu-menu--floating/)
  assert.match(clientSource, /createPortal\(menu, document\.body\)/)
  assert.match(clientSource, /position:fixed;right:auto;top:auto;z-index:1200/)
  assert.match(clientSource, /\.tu-set,\.tu-bottom,\.tu-menu\{/, '菜单 portal 到 body 后必须自带颜色 token, 否则背景透明')
  assert.doesNotMatch(clientSource, /disabled: mode === 'edit'/, '隧道名在编辑弹窗里必须可改')
})

test('Given 源码 When 检查 Then 不再包含旧注册面与 sidebarTab 协议', () => {
  assert.doesNotMatch(clientSource, /slots\.register\(\s*\{\s*name:\s*'main'/)
  assert.doesNotMatch(clientSource, /sidebar\.panellist/)
  assert.doesNotMatch(clientSource, /settings\.plugin\.item/)
  assert.doesNotMatch(clientSource, /plugins\.bundle\.config/)
  assert.doesNotMatch(clientSource, /betterSidebar/)
  assert.doesNotMatch(clientSource, /sidebarTab/)
  assert.match(clientSource, /name: 'settings\.section', id: SECTION_ID, order: SECTION_ORDER, label: SECTION_LABEL/)
})
