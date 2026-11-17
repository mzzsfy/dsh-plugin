// 底部状态条 BDD: 宿主 shell.bottom 槽常驻提示已开放隧道,
// 只在有启用隧道时占位; 数据走与设置分区同一 REST, 由总线推送 + 可见性门控刷新。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createClientHarness, tick } from './support/client-harness.mjs'

const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

test('Given 插件激活 When 注册 Then 底部状态条与设置分区各一条, 旧入口为零', () => {
  const harness = createClientHarness()
  harness.activate()
  assert.equal(harness.bottomCount(), 1)
  assert.equal(harness.sectionCount(), 1)
  assert.equal(harness.panelCount(), 0)
  assert.equal(harness.panellistCount(), 0)
})

test('Given 状态条挂载 When 首次加载 Then 只拉隧道列表(不探活), 不扫描端口', async () => {
  const harness = createClientHarness({ rows: [{ name: 'app', targetPort: 8090, entry: 'path', enabled: true }] })
  harness.activate()
  harness.renderBottom()
  await tick()
  assert.ok(harness.requests.some((request) => request.url === '/api/tunnel/tunnels'))
  assert.equal(harness.requests.some((request) => request.url.includes('probe=')), false, '状态条不得触发逐隧道探活')
  assert.equal(harness.requests.some((request) => request.url.startsWith('/api/tunnel/ports')), false, '状态条不得扫描端口')
})

test('Given 页面隐藏 When 总线推送 Then 不请求; 恢复可见后只补一次', async () => {
  const harness = createClientHarness({ rows: [{ name: 'app', targetPort: 8090, entry: 'path', enabled: true }] })
  harness.activate()
  harness.renderBottom()
  await tick()
  const before = harness.requests.length
  harness.hidePage()
  harness.publish()
  harness.publish()
  await tick()
  assert.equal(harness.requests.length, before)
  harness.showPage()
  await tick()
  assert.equal(harness.requests.length, before + 1, '恢复可见只补一次列表请求')
})

test('Given 总线推送 When 页面可见 Then 每次推送刷新一次', async () => {
  const harness = createClientHarness({ rows: [{ name: 'app', targetPort: 8090, entry: 'path', enabled: true }] })
  harness.activate()
  harness.renderBottom()
  await tick()
  const before = harness.requests.length
  harness.publish()
  await tick()
  assert.equal(harness.requests.length, before + 1)
})

test('Given 插件卸载 When 总线推送 Then 不再请求', async () => {
  const harness = createClientHarness({ rows: [{ name: 'app', targetPort: 8090, entry: 'path', enabled: true }] })
  harness.activate()
  harness.renderBottom()
  await tick()
  const before = harness.requests.length
  harness.dispose()
  harness.publish()
  await tick()
  assert.equal(harness.requests.length, before)
})

test('Given 状态条实现 When 检查源码 Then 不引入周期轮询, 样式带包前缀与标记', () => {
  assert.equal(/setInterval\(/.test(clientSource), false, '状态条不得以短轮询刷新')
  assert.equal(/name: 'shell\.bottom'/.test(clientSource), true)
  assert.equal(/tu-bottom/.test(clientSource), true)
  assert.equal(/tu-bottom__list|tu-bottom__item/.test(clientSource), false, '底部状态条固定单行, 不展开列表')
  assert.equal(/tu-bottom__open/.test(clientSource), true, '单行整体可点击打开详情')
  assert.equal(/全部关闭/.test(clientSource), false, '状态条不提供一键关闭, 避免误关')
})
