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

test('读侧按版本共享同一份冻结快照, 写入后换对象', async () => {
  const storage = memoryStorage()
  const state = await openState(storage)
  const first = state.get(), second = state.get()
  // 每次读取都深拷贝会把"每标的取一次配置"变成每秒数毫秒; 同一版本读到的内容恒定, 可以共享
  assert.equal(first, second, '同一版本必须返回同一对象')
  assert.equal(Object.isFrozen(first), true, '共享快照必须冻结, 原地改会在严格模式下直接抛错')
  assert.equal(Object.isFrozen(first.preferences), true, '嵌套对象同样冻结')
  await state.mutate(operation(), control => ({ ...control, preferences: { ...control.preferences, refreshSeconds: 30 } }))
  const third = state.get()
  assert.notEqual(third, first, '写入后必须换对象')
  assert.equal(third.preferences.refreshSeconds, 30)
  await state.close()
})

test('台账写入不再保存配置副本', async () => {
  const storage = memoryStorage()
  const state = await openState(storage)
  const config = { providers: [{ id: 'p1', adapterId: 'eastmoney', enabled: true }], routes: [] }
  await state.mutate({ ...operation(), action: 'configuration', payload: config }, control => ({ ...control, routingRevision: control.routingRevision + 1 }))
  const [entry] = state.get().operations
  assert.equal('payload' in entry, false, '台账只留幂等键与结果')
  // 配置副本是台账体积的来源: 去掉后整条控制记录应该远小于载荷本身
  assert.ok(JSON.stringify(state.get()).length < 64 * 1024, '控制记录不因台账膨胀')
  assert.deepEqual(await state.replay({ ...operation(), action: 'configuration', payload: config }), { revision: 1, unchanged: false }, '重放语义不受影响')
  await state.close()
})
