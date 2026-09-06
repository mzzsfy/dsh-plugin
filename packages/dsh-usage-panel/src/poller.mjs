// 轮询纯逻辑层:时间驱动调度 / 失败指数退避 / 档位间隔。无 IO,host 半区与单测共用。
// 历史教训:旧 round 分频形态(round 仅在查询时递增)构成死锁——余额类账号首查后
// round 恒 1 永不再查;短窗账号每 tick 必查使用户间隔设置完全失效。改为时间驱动:
// 上次尝试查询时刻(成功失败均记)+ 档位间隔判定到点,退避独立叠加。

export const BACKOFF_CAP_MULTIPLE = 8
// 短窗口档(5h 序列)查询间隔 = 序列快照粒度(history.mjs GRANULARITY_MS['10m'])
export const SHORT_TIER_INTERVAL_SEC = 10 * 60
// 长窗口档(日/月/余额序列)查询间隔 = 序列快照粒度(history.mjs GRANULARITY_MS['1h'])
export const LONG_TIER_INTERVAL_SEC = 60 * 60

// 失败退避状态机:基期 = 账号档位间隔,×2 封顶;成功即恢复。
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

// 短窗口档账号判定:从未查询成功(含最近一次失败)或最近成功读数含短窗序列。
// 失败归短档:保持 10 分钟调度节奏与 600s 退避基期,避免一次瞬时失败把含 5h
// 窗口的账号塌缩到 1 小时档,造成短窗序列长时间空洞;轰炸由退避指数压制。
export function isShortWindowTier(last, readingHasShort) {
  if (last === null) return true
  return last.ok !== true || readingHasShort
}

// 账号档位间隔:含短窗口序列走短档,否则长档。
export function tierIntervalSec(hasShortWindow) {
  return hasShortWindow ? SHORT_TIER_INTERVAL_SEC : LONG_TIER_INTERVAL_SEC
}

// 上次尝试查询时刻(秒):queriedAt 毫秒历元;缺失/非法(旧数据)回 null 视为立即到点。
export function lastQuerySecOf(last) {
  const queriedAt = last !== null && typeof last === 'object' ? last.queriedAt : undefined
  return typeof queriedAt === 'number' && Number.isFinite(queriedAt)
    ? Math.floor(queriedAt / 1000)
    : null
}

// 时间驱动到点判定:lastQuerySec 为 null(从未查询或旧数据缺时刻)即到点。
export function isDue({ lastQuerySec, nowSec, intervalSec }) {
  if (lastQuerySec === null) return true
  return nowSec - lastQuerySec >= intervalSec
}
