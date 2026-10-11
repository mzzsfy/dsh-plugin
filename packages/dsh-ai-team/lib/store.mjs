// 任务存储适配:storageDomain 单域单记录语义的薄封装。
// handle 形态镜像宿主: get(key) missing 抛错; update(key, fn) 同步读改写。
export function createTaskStore(handle) {
  const CONTROL_KEY = 'control'

  async function loadAggregate(taskId) {
    try {
      return await handle.get(`task/${taskId}`)
    } catch (error) {
      if (/missing key/.test(String(error?.message))) return undefined
      throw error
    }
  }

  async function saveAggregate(aggregate) {
    return handle.update(`task/${aggregate.taskId}`, () => aggregate)
  }

  async function updateAggregate(taskId, fn) {
    return handle.update(`task/${taskId}`, (current) => {
      if (current === undefined) throw new Error(`missing key: task/${taskId}`)
      return fn(current)
    })
  }

  async function loadControl() {
    try {
      return await handle.get(CONTROL_KEY)
    } catch (error) {
      if (/missing key/.test(String(error?.message))) {
        return { globalStopped: false, globalStopGeneration: 0, taskAllows: {} }
      }
      throw error
    }
  }

  async function updateControl(fn) {
    return updateControlRecord(handle, fn, { globalStopped: false, globalStopGeneration: 0, taskAllows: {} })
  }

  return { loadAggregate, saveAggregate, updateAggregate, loadControl, updateControl }
}

const MISSING_KEY = /missing[- ]key/i

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

async function updateKeyWithSeed(handle, key, fn, initial) {
  try {
    return await handle.update(key, (current) => fn(current ?? initial))
  } catch (error) {
    if (!MISSING_KEY.test(String(error?.code ?? error?.name ?? error?.message))) throw error
    await handle.put(key, fn(initial))
    return handle.get(key)
  }
}
