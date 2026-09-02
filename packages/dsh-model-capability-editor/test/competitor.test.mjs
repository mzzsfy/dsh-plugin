// BDD:竞品 dsh-better-reasoning-effort 写入痕迹检测(词汇表外 autofill 标记字段)

import test from 'node:test'
import assert from 'node:assert/strict'
import { detectCompetitorTraces } from '../src/logic.mjs'

test('reasoningEffortsUnset / inputUnset 标记字段 → 告警条目 id', () => {
  const models = [
    { id: 'a', reasoningEffortsUnset: true },
    { id: 'b' },
    { id: 'c', inputUnset: true },
  ]
  assert.deepEqual(detectCompetitorTraces(models), ['a', 'c'])
})

test('无痕迹返回空列表;非数组输入安全返回空', () => {
  assert.deepEqual(detectCompetitorTraces([{ id: 'b', input: ['text'] }]), [])
  assert.deepEqual(detectCompetitorTraces(undefined), [])
})
