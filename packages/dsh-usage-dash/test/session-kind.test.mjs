// 需求: 汇总卡「会话数量」只统计真实会话,子 agent 派生会话不计入。
// 判定源为宿主 SessionHeader(version 4): origin='subagent' 是唯一权威派生标记;
// 旧格式派生子会话只留 parentSession + delegationDepth>0,而旧格式用户分支
// (fork)同样带 parentSession 但 delegationDepth=0,故 depth 必须参与判定。

import test from 'node:test'
import assert from 'node:assert/strict'

import { isDerivedSessionHeader } from '../src/session-kind.js'

test('Given origin=subagent When 判定 Then 属派生会话', () => {
  assert.equal(isDerivedSessionHeader({ id: 's1', origin: 'subagent', delegationDepth: 1 }), true)
})

test('Given 旧格式 parentSession+delegationDepth>0 When 判定 Then 属派生会话', () => {
  assert.equal(isDerivedSessionHeader({ id: 's1', parentSession: 's0', delegationDepth: 2 }), true)
})

test('Given 旧格式用户分支 parentSession+delegationDepth=0 When 判定 Then 属真实会话', () => {
  assert.equal(isDerivedSessionHeader({ id: 's1', parentSession: 's0', delegationDepth: 0 }), false)
})

test('Given parentSession 无 delegationDepth When 判定 Then 按真实会话计(无法可靠区分)', () => {
  assert.equal(isDerivedSessionHeader({ id: 's1', parentSession: 's0' }), false)
})

test('Given 无派生字段 When 判定 Then 属真实会话', () => {
  assert.equal(isDerivedSessionHeader({ id: 's1', isSeeded: false }), false)
})

test('Given 缺失 header When 判定 Then 不判为派生(观测性优先,不误排除)', () => {
  assert.equal(isDerivedSessionHeader(undefined), false)
  assert.equal(isDerivedSessionHeader(null), false)
})
