// 会话守门 BDD(v5):轮次将停时的欠动作判定 + 提醒计数闸
// 判据锚定 persona 判据 3 的三条欠动作,纯函数测试无需宿主
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pendingOf, createNudgeGate, nudgeText, MAX_NUDGE } from '../lib/guard.mjs'

const recordOf = (status) => ({ runId: 'r-t-1', status })

test('running 且无活跃段 → 欠 resume', () => {
  assert.deepEqual(pendingOf(recordOf('running'), { active: false }), { need: 'resume', text: '运行中待拉起' })
})

test('running 且有活跃段 → 正常等待,不拦', () => {
  assert.equal(pendingOf(recordOf('running'), { active: true }), undefined)
})

test('waiting_approval → 欠裁决', () => {
  assert.deepEqual(pendingOf(recordOf('waiting_approval'), { active: false }), { need: '裁决', text: '等待裁决' })
})

test('paused 且 awaitingResume → 欠 resume', () => {
  assert.deepEqual(pendingOf(recordOf('paused'), { active: false, awaitingResume: true }), { need: 'resume', text: '已暂停' })
})

test('paused 未请求恢复 → 不拦(页签仅暂停,主循环无欠动作)', () => {
  assert.equal(pendingOf(recordOf('paused'), { active: false, awaitingResume: false }), undefined)
})

test('终态与无现役 run → 不拦', () => {
  assert.equal(pendingOf(recordOf('completed'), undefined), undefined)
  assert.equal(pendingOf(recordOf('cancelled'), undefined), undefined)
  assert.equal(pendingOf(recordOf('failed'), undefined), undefined)
  assert.equal(pendingOf(recordOf('blocked'), undefined), undefined)
  assert.equal(pendingOf(undefined, undefined), undefined)
})

test('提醒计数闸:同 run 上限内放行,超限拒绝,clear 后重置', () => {
  const gate = createNudgeGate()
  for (let i = 0; i < MAX_NUDGE; i += 1) assert.equal(gate.take('r-a'), true)
  assert.equal(gate.take('r-a'), false)
  assert.equal(gate.used('r-a'), MAX_NUDGE)
  // 计数按 run 独立:另一 run 不受影响
  assert.equal(gate.take('r-b'), true)
  gate.clear('r-a')
  assert.equal(gate.used('r-a'), 0)
  assert.equal(gate.take('r-a'), true)
})

test('触顶只在额度用满时成立(供调用方单次告警)', () => {
  const gate = createNudgeGate()
  assert.equal(gate.exhausted('r-c'), false)
  for (let i = 1; i <= MAX_NUDGE; i += 1) {
    gate.take('r-c')
    assert.equal(gate.exhausted('r-c'), i === MAX_NUDGE)
  }
  // 触顶后闩锁:多次调用只首次 true,调用方不再重复告警
  assert.equal(gate.exhausted('r-c'), false)
  // clear 重置闩锁与计数(新一轮欠动作周期重新告警)
  gate.clear('r-c')
  assert.equal(gate.exhausted('r-c'), false)
})

test('提醒文案带 runId / 状态 / 欠动作与应调工具', () => {
  const text = nudgeText('r-x-9', { need: 'resume', text: '运行中待拉起' })
  assert.match(text, /r-x-9/)
  assert.match(text, /rs_workflow_status/)
  assert.match(text, /rs_workflow_resume/)
  assert.match(text, /欠动作=resume/)
})

test('裁决类提醒带转呈真人豁免(避免误伤已等待真人的轮次)', () => {
  const text = nudgeText('r-y-1', { need: '裁决', text: '等待裁决' })
  assert.match(text, /autoApprove/)
  assert.match(text, /已转呈真人/)
  assert.match(text, /可直接结束轮次/)
})