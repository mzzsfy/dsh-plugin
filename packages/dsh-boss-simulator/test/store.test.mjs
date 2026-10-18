// 存储适配层测试:聚合持久化语义(桩句柄,镜像 storageDomain 单记录 update 原子读改写)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTaskStore, updateControlRecord } from '../lib/store.mjs'
import { createTask, defineWorkItem, authorizeTask } from '../lib/core/task.mjs'
import { stopAll } from '../lib/core/global-control.mjs'

const INITIAL_CONTROL = { globalStopped: false, globalStopGeneration: 0, taskAllows: {} }

// 桩:单记录 update 同步读改写,missing-key 抛错(镜像宿主语义)
function fakeHandle() {
  const records = new Map()
  return {
    async get(key) {
      if (!records.has(key)) throw new Error(`missing key: ${key}`)
      return records.get(key)
    },
    async put(key, value) { records.set(key, structuredClone(value)) },
    async update(key, fn) {
      const current = records.has(key) ? records.get(key) : undefined
      const next = fn(current === undefined ? undefined : structuredClone(current))
      records.set(key, next)
      return next
    },
    _records: records,
  }
}

// Given 宿主 JSON 表,When 写入并重建 store,Then 仅保留 DTO 并恢复运行时能力。
function jsonTable({ missingThrows = false } = {}) {
  const records = new Map()
  function missing(key) {
    return Object.assign(new Error(`record absent: ${key}`), { name: 'DomainError', code: 'missing-key' })
  }
  function persist(key, value) {
    assert.equal(Object.hasOwn(value, 'now'), false)
    assert.deepEqual(value, JSON.parse(JSON.stringify(value)))
    records.set(key, JSON.parse(JSON.stringify(value)))
  }
  return {
    get(key) {
      if (missingThrows && !records.has(key)) throw missing(key)
      return records.get(key)
    },
    entries() { return new Map(records).entries() },
    async put(key, value) { persist(key, value) },
    async update(key, fn) {
      if (!records.has(key)) throw missing(key)
      persist(key, fn(records.get(key)))
    },
  }
}

function taskFixture(now) {
  return createTask({ taskId: 't1', title: '任务', projectWorkspaceId: 'workspace', definition: { goal: '交付' }, now }).result
}

for (const missingThrows of [false, true]) {
  test(`JSON 表缺失读取(${missingThrows ? 'missing-key' : 'undefined'}):任务缺失,全局控制可立即迁移`, async () => {
    const store = createTaskStore(jsonTable({ missingThrows }), { now: () => 100 })
    assert.equal(await store.loadAggregate('absent'), undefined)
    const control = await store.loadControl()
    assert.deepEqual(JSON.parse(JSON.stringify(control)), {
      globalStopped: false, globalStopGeneration: 0, concurrencySnapshot: null, stopOperations: {}, commandReceipts: {},
    })
    const next = stopAll(control, { commandId: 'stop-1', payloadHash: 'hash', sourceRef: 'source' })
    assert.equal(next.result.state.stopOperations['stop-stop-1'].requestedAt, 100)
    assert.equal(next.result.state.now(), 100)
  })
}

test('JSON 聚合保存后重建 store:运行时时钟可驱动状态迁移且不修改宿主记录', async () => {
  const table = jsonTable()
  const task = taskFixture(() => 1)
  const originalNow = task.now
  const saved = await createTaskStore(table, { now: () => 100 }).saveAggregate(task)
  assert.equal(saved.now(), 100)
  assert.equal(task.now, originalNow)
  assert.equal(Object.hasOwn(table.get('task/t1'), 'now'), false)
  const store = createTaskStore(table, { now: () => 200 })
  const loaded = await store.loadAggregate('t1')
  assert.equal(loaded.now(), 200)
  assert.equal(Object.hasOwn(table.get('task/t1'), 'now'), false)
  const updated = await store.updateAggregate('t1', (current) => defineWorkItem(current, { workItemId: 'w1', title: '执行' }).result.aggregate)
  assert.equal(updated.updatedAt, 200)
  assert.equal(updated.now(), 200)
  assert.equal(Object.hasOwn(table.get('task/t1'), 'now'), false)
})

test('JSON 重启后在同一原子回调连续定义工作项和授权,展开对象仍保留时钟', async () => {
  const table = jsonTable()
  await createTaskStore(table).saveAggregate(taskFixture(() => 1))
  const store = createTaskStore(table, { now: () => 200 })
  const updated = await store.updateAggregate('t1', (current) => {
    const defined = defineWorkItem(current, { workItemId: 'w1', title: '执行' })
    assert.equal(defined.ok, true)
    const authorized = authorizeTask(defined.result.aggregate, { sourceMessageRef: 'authorization' })
    assert.equal(authorized.ok, true)
    return authorized.result.aggregate
  })
  assert.equal(updated.businessState, 'ready')
  assert.equal(updated.recordRevision, 3)
  assert.equal(updated.updatedAt, 200)
  assert.equal(updated.authorization.authorizedAt, 200)
  assert.equal(updated.workItems.w1.title, '执行')
  assert.equal(Object.hasOwn(table.get('task/t1'), 'now'), false)
})

test('全局控制 JSON 往返后仍可停止,返回值不依赖 update 的结果', async () => {
  const table = jsonTable()
  const store = createTaskStore(table, { now: () => 100 })
  const first = await store.updateControl((current) => stopAll(current, { commandId: 'first', payloadHash: 'hash', sourceRef: 'source' }).result.state)
  assert.equal(first.globalStopGeneration, 1)
  assert.equal(first.now(), 100)
  const restarted = createTaskStore(table, { now: () => 200 })
  const loaded = await restarted.loadControl()
  assert.equal(loaded.now(), 200)
  assert.equal(Object.hasOwn(table.get('control'), 'now'), false)
  const second = await restarted.updateControl((current) => stopAll(current, { commandId: 'second', payloadHash: 'hash', sourceRef: 'source' }).result.state)
  assert.equal(second.globalStopGeneration, 2)
  assert.equal(second.stopOperations['stop-second'].requestedAt, 200)
  assert.equal(second.now(), 200)
  assert.equal(Object.hasOwn(table.get('control'), 'now'), false)
})

test('listAggregates 使用公开 entries 只列任务并注入时钟', async () => {
  const table = jsonTable()
  const store = createTaskStore(table, { now: () => 100 })
  await store.saveAggregate(taskFixture(() => 1))
  await table.put('settings', { values: {} })
  const tasks = await store.listAggregates()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].taskId, 't1')
  assert.equal(tasks[0].now(), 100)
  assert.equal(Object.hasOwn(table.get('task/t1'), 'now'), false)
})

test('store 读取与写入 EIO 原样抛出,即使错误消息包含 missing key 也不兜底', async () => {
  const error = Object.assign(new Error('missing key caused io failure'), { code: 'EIO' })
  const store = createTaskStore({
    get() { throw error },
    async put() { throw error },
    async update() { throw error },
  })
  for (const operation of [
    () => store.loadAggregate('t1'), () => store.loadControl(),
    () => store.saveAggregate(taskFixture(() => 1)),
    () => store.updateAggregate('t1', (current) => current),
    () => store.updateControl((current) => current),
  ]) await assert.rejects(operation, (actual) => actual === error)
})

test('updateAggregate 缺失拒绝而不创建任务', async () => {
  const store = createTaskStore(jsonTable())
  await assert.rejects(() => store.updateAggregate('absent', (current) => current), /absent/)
  assert.equal(await store.loadAggregate('absent'), undefined)
})

test('初始读取:记录缺失时返回 undefined,由调用方初始化', async () => {
  const store = createTaskStore(fakeHandle())
  assert.equal(await store.loadAggregate('t1'), undefined)
})

test('保存聚合后可读回', async () => {
  const store = createTaskStore(fakeHandle())
  const agg = { taskId: 't1', appliedActions: {}, runs: [] }
  await store.saveAggregate(agg)
  assert.deepEqual(JSON.parse(JSON.stringify(await store.loadAggregate('t1'))), agg)
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
