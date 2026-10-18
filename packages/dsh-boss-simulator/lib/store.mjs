import { createGlobalControl } from './core/global-control.mjs'

// 存储只接收 DTO,根级时钟在读取和原子迁移回调边界恢复。
export function createTaskStore(handle, { now = Date.now } = {}) {
  function withClock(record) {
    if (record === undefined) return undefined
    return { ...record, now }
  }

  async function loadRecord(key) {
    try {
      return await handle.get(key)
    } catch (error) {
      if (isMissingKey(error)) return undefined
      throw error
    }
  }

  async function loadAggregate(taskId) {
    return withClock(await loadRecord(`task/${taskId}`))
  }

  async function saveAggregate(aggregate) {
    await handle.put(`task/${aggregate.taskId}`, withoutClock(aggregate))
    return loadAggregate(aggregate.taskId)
  }

  async function updateAggregate(taskId, fn) {
    await handle.update(`task/${taskId}`, (current) => {
      if (current === undefined) throw new Error(`missing key: task/${taskId}`)
      return withoutClock(fn(withClock(current)))
    })
    return loadAggregate(taskId)
  }

  async function listAggregates() {
    return Array.from(handle.entries())
      .filter(([key]) => key.startsWith('task/'))
      .map(([, record]) => withClock(record))
  }

  async function loadControl() {
    return withClock((await loadRecord('control')) ?? createGlobalControl(now))
  }

  async function updateControl(fn) {
    await updateControlRecord(handle, (current) => withoutClock(fn(withClock(current))), createGlobalControl(now))
    return loadControl()
  }

  return { loadAggregate, saveAggregate, updateAggregate, listAggregates, loadControl, updateControl }
}

function withoutClock(record) {
  const { now, ...dto } = record
  return dto
}

const MISSING_KEY = /missing[- ]key/i

function isMissingKey(error) {
  if (error?.code !== undefined) return error.code === 'missing-key'
  return MISSING_KEY.test(String(error?.message ?? error?.name))
}

// 控制记录 RMW:missing-key 才允许以 initial 兜底首写,其余错误原样抛出(防清空既有控制态)
export async function updateControlRecord(handle, fn, initial) {
  return updateKeyWithSeed(handle, 'control', fn, initial)
}

// 设置记录 RMW:与控制记录同款 missing-key 兜底
export async function updateSettingsRecord(handle, fn, initial) {
  return updateKeyWithSeed(handle, 'settings', fn, initial)
}

// 索引类小记录的同款 missing-key 兜底首写
export async function updateIndexRecord(handle, fn, initial) {
  return updateKeyWithSeed(handle, 'taskIndex', fn, initial)
}

// 管理员绑定记录:面板管理员入口的幂等依据;missing/未设视为无绑定
export async function loadAdminBinding(handle) {
  return (await handle.get('adminBinding')) ?? null
}

export async function updateAdminBindingRecord(handle, fn) {
  return updateKeyWithSeed(handle, 'adminBinding', fn, null)
}

async function updateKeyWithSeed(handle, key, fn, initial) {
  try {
    return await handle.update(key, (current) => fn(current ?? initial))
  } catch (error) {
    if (!isMissingKey(error)) throw error
    await handle.put(key, fn(initial))
    return handle.get(key)
  }
}
