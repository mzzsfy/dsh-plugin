// 存储适配层测试:聚合持久化语义(桩句柄,镜像 storageDomain 单记录 update 原子读改写)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTaskStore, updateControlRecord } from '../lib/store.mjs'

const INITIAL_CONTROL = { globalStopped: false, globalStopGeneration: 0, taskAllows: {} }

// 桩:单记录 update 同步读改写,missing-key 抛错(镜像宿主语义)
function fakeHandle() {
  const records = new Map()
  return {
    async get(key) {
      if (!records.has(key)) throw new Error(`missing key: ${key}`)
      return records.get(key)
    },
    async update(key, fn) {
      const current = records.has(key) ? records.get(key) : undefined
      const next = fn(current === undefined ? undefined : structuredClone(current))
      records.set(key, next)
      return next
    },
    _records: records,
  }
}

test('初始读取:记录缺失时返回 undefined,由调用方初始化', async () => {
  const store = createTaskStore(fakeHandle())
  assert.equal(await store.loadAggregate('t1'), undefined)
})

test('保存聚合后可读回', async () => {
  const store = createTaskStore(fakeHandle())
  const agg = { taskId: 't1', appliedActions: {}, runs: [] }
  await store.saveAggregate(agg)
  assert.deepEqual(await store.loadAggregate('t1'), agg)
})

test('updateAggregate 原子读改写:并发更新不互相覆盖', async () => {
  const store = createTaskStore(fakeHandle())
  await store.saveAggregate({ taskId: 't1', appliedActions: {}, runs: [], revision: 0 })
  await Promise.all([
    store.updateAggregate('t1', (agg) => ({ ...agg, runs: [...agg.runs, 'a'], revision: agg.revision + 1 })),
    store.updateAggregate('t1', (agg) => ({ ...agg, runs: [...agg.runs, 'b'], revision: agg.revision + 1 })),
  ])
  const agg = await store.loadAggregate('t1')
  assert.equal(agg.runs.length, 2)
  assert.equal(agg.revision, 2)
})

test('全局控制记录独立读写', async () => {
  const store = createTaskStore(fakeHandle())
  const initial = await store.loadControl()
  assert.equal(initial.globalStopped, false)
  await store.updateControl((c) => ({ ...c, globalStopped: true, globalStopGeneration: c.globalStopGeneration + 1 }))
  const control = await store.loadControl()
  assert.equal(control.globalStopped, true)
  assert.equal(control.globalStopGeneration, 1)
})

test('updateControlRecord:missing-key 以 initial 兜底首写', async () => {
  const handle = fakeHandle()
  const next = await updateControlRecord(handle, (c) => ({ ...c, globalStopped: true }), INITIAL_CONTROL)
  assert.equal(next.globalStopped, true)
})

test('updateControlRecord:非 missing-key 错误原样抛出,不清空既有控制态', async () => {
  const handle = fakeHandle()
  await updateControlRecord(handle, (c) => ({ ...c, globalStopped: true }), INITIAL_CONTROL)
  const hostile = {
    async update() { throw Object.assign(new Error('io died'), { code: 'EIO' }) },
    async get() { return { globalStopped: true, globalStopGeneration: 3, taskAllows: {} } },
    async put() { throw new Error('兜底不应执行') },
  }
  await assert.rejects(() => updateControlRecord(hostile, (c) => ({ ...c, globalStopped: false }), INITIAL_CONTROL), /io died/)
})
