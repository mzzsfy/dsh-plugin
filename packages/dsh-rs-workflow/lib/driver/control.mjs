// 控制平面注册表:cancel/resume 即时通道直调 RunDriver;message 经 driver 落账(队列单例不持有 store)
export const registry = {
  drivers: new Map(),
  initiators: new Map(),
}

export function registerDriver(runId, driver) {
  registry.drivers.set(runId, driver)
}

export function unregisterDriver(runId) {
  registry.drivers.delete(runId)
}

export function registerInitiator(sessionId, start) {
  registry.initiators.set(sessionId, start)
}

export function unregisterInitiator(sessionId) {
  registry.initiators.delete(sessionId)
}

export function initiatorOf(sessionId) {
  return registry.initiators.get(sessionId)
}

// post 受理语义:活跃(未终态且已注册 driver)才受理;落账经 driver 自持 store
export function post(runId, event) {
  const driver = registry.drivers.get(runId)
  if (!driver) return false
  return driver.handlePost(event)
}
