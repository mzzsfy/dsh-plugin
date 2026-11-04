import test from 'node:test'
import assert from 'node:assert/strict'
import { openState } from '../src/state.mjs'
import { memoryStorage, operation } from './helpers.mjs'
test('S03/S04/S06/S07 写失败不改真源，幂等重放不重复写，空变更不写盘', async () => {
  const storage = memoryStorage(), events = []
  const state = await openState(storage, () => events.push(1))
  const change = c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 30 } })
  storage.broken = true
  await assert.rejects(state.mutate(operation(), change), e => e.code === 'STORAGE_WRITE_FAILED')
  assert.equal(state.get().revision, 0)
  assert.equal(events.length, 0)
  storage.broken = false
  const result = await state.mutate(operation(), change)
  assert.deepEqual(await state.mutate(operation(), change), result)
  assert.equal(storage.writes, 1)
  await assert.rejects(state.mutate({ ...operation(), payload: 'different' }, change), e => e.code === 'OPERATION_REUSED')
  await state.mutate(operation(2, 1), c => c)
  assert.equal(storage.writes, 1)
})
test('S01/S02 两个同revision的并发写只有一个提交', async () => {
  const storage = memoryStorage(), events = []
  const state = await openState(storage, () => events.push('changed'))
  const change = c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 30 } })
  const results = await Promise.allSettled([state.mutate(operation(1), change), state.mutate(operation(2), change)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT')
  assert.equal(state.get().revision, 1)
  assert.equal(storage.writes, 1)
  assert.equal(events.length, 1)
})
