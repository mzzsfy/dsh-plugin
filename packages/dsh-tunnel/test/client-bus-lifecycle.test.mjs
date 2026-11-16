// 设置分区生命周期: 同一 factory 的两个插件实例(A/B)必须各自持有租约与订阅,
// 卸载 A 不得清掉 B 的组件订阅; 组件卸载只清自己的数据订阅。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientHarness, tick } from './support/client-harness.mjs'

test('Given 同 factory 的 A/B 已挂载设置分区 When 卸载 A Then 只清 A 的订阅, B 继续刷新', async () => {
  const a = createClientHarness()
  const b = createClientHarness()
  a.activate()
  b.activate()
  a.renderSection()
  b.renderSection()
  await tick()
  assert.equal(a.state.owner.subscriptions.size, 1)
  assert.equal(b.state.owner.subscriptions.size, 1)
  a.dispose()
  assert.equal(a.state.owner.subscriptions.size, 0)
  assert.equal(b.state.owner.subscriptions.size, 1)
  const before = b.requests.length
  b.publish()
  await tick()
  assert.equal(b.requests.length, before + 2)
  b.dispose()
  assert.equal(b.state.owner.subscriptions.size, 0)
})

test('Given 分区组件挂载后再卸载 When 总线推送 Then 该实例不再请求', async () => {
  const harness = createClientHarness()
  harness.activate()
  harness.renderSection()
  await tick()
  assert.equal(harness.state.owner.subscriptions.size, 1)
  harness.dispose()
  assert.equal(harness.state.owner.subscriptions.size, 0)
  const before = harness.requests.length
  harness.publish()
  await tick()
  assert.equal(harness.requests.length, before)
})
