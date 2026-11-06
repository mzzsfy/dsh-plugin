// 看板形态仲裁 BDD: 全局面板与 better-sidebar 页签二选一, 由偏好驱动。
// 状态机不变量: 任意时刻最多一个入口; 装载失败保留旧形态(不出现双无); 偏好回滚后重试。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createClientHarness, tick } from './support/client-harness.mjs'

const settle = async () => { await tick(); await tick() }

test('Given 偏好开且侧边栏在场 When 激活 Then 只挂页签, 不挂主面板', async (t) => {
  const harness = createClientHarness({ ui: { sidebarTab: true }, sidebar: true })
  t.after(() => harness.dispose())
  harness.activate()
  await settle()
  assert.equal(harness.tabCount(), 1)
  assert.equal(harness.panelCount(), 0)
  assert.equal(harness.panellistCount(), 0)
})

test('Given 偏好关且侧边栏在场 When 激活 Then 只挂主面板', async (t) => {
  const harness = createClientHarness({ ui: { sidebarTab: false }, sidebar: true })
  t.after(() => harness.dispose())
  harness.activate()
  await settle()
  assert.equal(harness.panelCount(), 1)
  assert.equal(harness.tabCount(), 0)
})

test('Given 无侧边栏 When 侧栏晚到 Then 从主面板切到页签, 不残留两个入口', async (t) => {
  const harness = createClientHarness({ ui: { sidebarTab: true } })
  t.after(() => harness.dispose())
  harness.activate()
  await settle()
  assert.equal(harness.panelCount(), 1)
  assert.equal(harness.tabCount(), 0)

  harness.provideSidebar()
  await settle()
  assert.equal(harness.tabCount(), 1)
  assert.equal(harness.panelCount(), 0)
})

test('Given 页签注册失败 When 切换 Then 旧主面板仍在(先装新后卸旧), 偏好回滚且有告警', async (t) => {
  let panelsDuringAttempt = -1
  let harness
  harness = createClientHarness({
    ui: { sidebarTab: true },
    sidebar: true,
    failRegisterTab: true,
    onRegisterTab: () => { panelsDuringAttempt = harness.panelCount() },
  })
  t.after(() => harness.dispose())
  harness.activate()
  await settle()
  assert.equal(panelsDuringAttempt, 1, '装载新形态时旧形态必须还在')
  assert.equal(harness.panelCount(), 1, '失败后保留旧形态')
  assert.equal(harness.tabCount(), 0)
  assert.ok(harness.warnings.some((line) => line.includes('看板形态切换失败')))
})

test('Given 偏好反复切换 When 每次 publish Then 入口数恒为 1', async (t) => {
  const harness = createClientHarness({ ui: { sidebarTab: false }, sidebar: true })
  t.after(() => harness.dispose())
  harness.activate()
  await settle()
  const samples = [harness.panelCount() + harness.tabCount()]
  for (const next of [true, false, true, false]) {
    harness.setSidebarTab(next)
    harness.publish()
    await settle()
    samples.push(harness.panelCount() + harness.tabCount())
  }
  assert.deepEqual(samples, [1, 1, 1, 1, 1])
  assert.equal(harness.panelCount(), 1)
})

test('Given 激活后停用 When 卸载 Then 两种形态全部摘除', async (t) => {
  const harness = createClientHarness({ ui: { sidebarTab: true }, sidebar: true })
  harness.activate()
  await settle()
  assert.equal(harness.tabCount(), 1)
  harness.dispose()
  assert.equal(harness.panelCount(), 0)
  assert.equal(harness.tabCount(), 0)
  assert.equal(harness.panellistCount(), 0)
})

test('Given 侧边栏缺席 When 多次 publish Then 形态稳定在主面板(不反复重挂)', async (t) => {
  const harness = createClientHarness({ ui: { sidebarTab: true } })
  t.after(() => harness.dispose())
  harness.activate()
  await settle()
  for (let i = 0; i < 3; i += 1) {
    harness.publish()
    await settle()
  }
  assert.equal(harness.panelCount(), 1)
  assert.equal(harness.tabCount(), 0)
})
