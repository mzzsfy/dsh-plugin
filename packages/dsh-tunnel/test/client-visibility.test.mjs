// 看板刷新可见性门控 BDD: 页面隐藏或容器不可见时, 推送只记脏不请求; 恢复可见补拉一次。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createClientHarness, tick } from './support/client-harness.mjs'

const TUNNELS = '/api/tunnel/tunnels'
const settle = async () => { await tick(); await tick() }
const listRequests = (harness) => harness.requests.filter((path) => path === TUNNELS).length

async function mounted(t) {
  const harness = createClientHarness()
  t.after(() => harness.dispose())
  harness.activate()
  await settle()
  harness.renderPanel()
  await settle()
  return harness
}

test('Given 可见 When 挂载与推送 Then 每次刷新都发一次列表请求', async (t) => {
  const harness = await mounted(t)
  assert.equal(listRequests(harness), 1, '挂载即首拉, 且不依赖总线事件')
  harness.publish()
  await settle()
  assert.equal(listRequests(harness), 2)
})

test('Given 页面隐藏 When 连续推送 Then 零请求, 恢复可见后只补一次', async (t) => {
  const harness = await mounted(t)
  harness.hidePage()
  for (let i = 0; i < 3; i += 1) harness.publish()
  await settle()
  assert.equal(listRequests(harness), 1, '隐藏期间不得发请求')

  harness.showPage()
  await settle()
  assert.equal(listRequests(harness), 2, '恢复可见补拉一次')

  harness.showPage()
  await settle()
  assert.equal(listRequests(harness), 2, '无脏标记时重复恢复不重复请求')
})

test('Given 容器不可见 When 推送 Then 零请求, 容器可见后补一次', async (t) => {
  const harness = await mounted(t)
  harness.setNodeVisible(false)
  harness.publish()
  await settle()
  assert.equal(listRequests(harness), 1)

  harness.setNodeVisible(true)
  await settle()
  assert.equal(listRequests(harness), 2)

  harness.setNodeVisible(true)
  await settle()
  assert.equal(listRequests(harness), 2)
})

test('Given 页面隐藏 But 无脏标记 When 恢复 Then 不额外请求', async (t) => {
  const harness = await mounted(t)
  harness.hidePage()
  harness.showPage()
  await settle()
  assert.equal(listRequests(harness), 1)
})

test('Given 面板已卸载 When 推送 Then 不再请求, 可见性监听已摘除', async (t) => {
  const harness = await mounted(t)
  const before = listRequests(harness)
  harness.dispose()
  harness.publish()
  await settle()
  assert.equal(listRequests(harness), before)
  assert.equal(harness.state.docListeners.get('visibilitychange')?.size ?? 0, 0, '卸载必须摘除 visibilitychange 监听')
})
