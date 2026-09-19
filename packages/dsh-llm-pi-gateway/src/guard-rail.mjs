// 护栏工具:为可能无限阻塞的 await 提供有界等待。挂起形态(boot 收尾树卡死)
// 的防御面:任何外部依赖(动态 import / fiber dispose / 代挂 apply)都不得
// 无限占用 apply 生命周期——超时即降级放行并留诊断日志,底层操作若迟到完成,
// 其副作用由降级路径的既有让位/冲突处理兜底。

// 模块加载护栏:动态 import 命中损伤的包树(如 pnpm 重入损伤 junction 目标)
// 时可能远超正常耗时;30s 足够覆盖冷启动 + 实时扫描的最坏磁盘路径
export const MODULE_LOAD_TIMEOUT_MS = 30 * 1000

// fiber 卸载护栏:dispose 纯内存操作毫秒级完成,5s 覆盖在途流收尾的最坏形态
export const DISPOSE_TIMEOUT_MS = 5 * 1000

// 代挂 apply 护栏:官方插件完整 apply 的上界,覆盖其内部服务等待
export const MOUNT_TIMEOUT_MS = 30 * 1000

/**
 * 有界等待:超时抛出带位置标注与机器可读 code 的错误,底层 promise 不中断
 * (无法中断,迟到完成的副作用由调用方降级路径兜底)。
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label 诊断日志位置标注
 * @returns {Promise<T>}
 * @template T
 */
export async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} 超过 ${ms}ms 未完成,按降级放行`)
      error.code = 'GUARD_RAIL_TIMEOUT'
      reject(error)
    }, ms)
  })
  timer.unref?.()
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** 是否护栏超时错误(降级分支据此区分"真失败"与"未在时限内完成") */
export function isGuardRailTimeout(error) {
  return error?.code === 'GUARD_RAIL_TIMEOUT'
}

