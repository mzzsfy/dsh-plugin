// wait 手动打断注册表:键为 sessionId:terminalId,同键全部 wait 共享一次 skip。
// 键移除与 abort 原子生效,重复 skip 幂等返回 0;release 仅移除自身,不动其他等待。

const keyOf = (sessionId, terminalId) => `${sessionId}:${terminalId}`

export function createWaitSkipRegistry() {
  const pending = new Map()
  return {
    register(key, controller) {
      let set = pending.get(key)
      if (set === undefined) {
        set = new Set()
        pending.set(key, set)
      }
      set.add(controller)
    },
    release(key, controller) {
      const set = pending.get(key)
      if (set === undefined) return
      set.delete(controller)
      if (set.size === 0) pending.delete(key)
    },
    skip(sessionId, terminalId) {
      const key = keyOf(sessionId, terminalId)
      const set = pending.get(key)
      if (set === undefined) return 0
      pending.delete(key)
      for (const controller of set) controller.abort()
      return set.size
    },
    abortAll() {
      for (const set of pending.values()) for (const controller of set) controller.abort()
      pending.clear()
    },
  }
}
