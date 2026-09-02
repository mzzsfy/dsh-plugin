// 轮询纯逻辑层:间隔解析 / 失败指数退避 / 查询分频。无 IO,host 半区与单测共用。

export const DEFAULT_POLL_INTERVAL_SEC = 600
export const BACKOFF_CAP_MULTIPLE = 8
const HOUR_SEC = 60 * 60

export function resolvePollIntervalSec(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_POLL_INTERVAL_SEC
}

// 失败退避状态机:基期 = 账号查询周期,×2 封顶;成功即恢复。
export function createBackoff({ baseSec }) {
  let failures = 0
  let nextRetryAt = null
  return {
    get nextRetryAt() {
      return nextRetryAt
    },
    onFailure(nowSec) {
      failures += 1
      const delaySec = baseSec * Math.pow(2, Math.min(failures - 1, Math.log2(BACKOFF_CAP_MULTIPLE)))
      nextRetryAt = nowSec + delaySec
    },
    onSuccess() {
      failures = 0
      nextRetryAt = null
    },
    isBlocked(nowSec) {
      return nextRetryAt !== null && nowSec < nextRetryAt
    },
  }
}

// 长窗口分频除数:每 round(1 小时 / 间隔) 轮查询一次。
export function longWindowDivisor(intervalSec) {
  return Math.max(1, Math.round(HOUR_SEC / intervalSec))
}

// 账号级分频判定:含短窗口序列每轮查;仅长窗口按轮次取模。
export function shouldQueryThisRound({ round, hasShortWindow, divisor }) {
  return hasShortWindow || round % divisor === 0
}

// 短窗口档账号判定:从未查询成功(last 为空)按短窗口档处理,首轮即查以尽快建立快照。
export function isShortWindowTier(last, readingHasShort) {
  if (last === null) return true
  return last.ok === true && readingHasShort
}
