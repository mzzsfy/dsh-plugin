// 轮询纯逻辑层:时间驱动调度 / 失败指数退避 / 统一查询间隔。无 IO,host 半区与单测共用。
// 历史教训:旧 round 分频形态(round 仅在查询时递增)构成死锁——余额类账号首查后
// round 恒 1 永不再查;短窗账号每 tick 必查使用户间隔设置完全失效。改为时间驱动:
// 上次尝试查询时刻(成功失败均记)+ 统一间隔判定到点,退避独立叠加。
// 旧档位间隔(短窗 10 分钟/余额 1 小时)已统一为单一间隔:通知及时性要求余额类
// 账号同节奏,两档常量相等后档位机制退化为恒同值死路径,整体移除。

export const BACKOFF_CAP_MULTIPLE = 8
// 全账号统一查询间隔
export const POLL_INTERVAL_SEC = 10 * 60

// 失败退避状态机:基期 = 统一查询间隔,×2 封顶;成功即恢复。
export function createBackoff({ baseSec }) {
  let failures = 0
  let nextRetryAt = null
  let lastSeenSec = null
  const observe = (nowSec) => {
    // 回拨只平移退避截止点,保留 failures 历史;1 秒抖动也不得把已累计的
    // 指数退避清零,大幅回拨则按同样的剩余时长在新时钟上恢复。
    if (lastSeenSec !== null && nowSec < lastSeenSec && nextRetryAt !== null) {
      nextRetryAt += nowSec - lastSeenSec
    }
    lastSeenSec = nowSec
  }
  return {
    get nextRetryAt() {
      return nextRetryAt
    },
    onFailure(nowSec) {
      observe(nowSec)
      failures += 1
      const delaySec = baseSec * Math.pow(2, Math.min(failures - 1, Math.log2(BACKOFF_CAP_MULTIPLE)))
      nextRetryAt = nowSec + delaySec
    },
    onSuccess() {
      failures = 0
      nextRetryAt = null
    },
    isBlocked(nowSec) {
      observe(nowSec)
      return nextRetryAt !== null && nowSec < nextRetryAt
    },
  }
}

// 上次尝试查询时刻(秒):queriedAt 毫秒历元;缺失/非法(旧数据)回 null 视为立即到点。
export function lastQuerySecOf(last) {
  const queriedAt = last !== null && typeof last === 'object' ? last.queriedAt : undefined
  return typeof queriedAt === 'number' && Number.isFinite(queriedAt)
    ? Math.floor(queriedAt / 1000)
    : null
}

// 时间驱动到点判定:lastQuerySec 为 null(从未查询或旧数据缺时刻)即到点。
// nowSec 小于 lastQuerySec 说明系统时钟回拨,不能按负差值等待一个完整回拨幅度;
// 将回拨视为到点,先恢复轮询,待成功查询后按新钟重新计时。
export function isDue({ lastQuerySec, nowSec, intervalSec }) {
  if (lastQuerySec === null) return true
  if (nowSec < lastQuerySec) return true
  return nowSec - lastQuerySec >= intervalSec
}

// 受限并发执行:worker 池共享游标逐项取号(取号同步完成,无交错),单任务
// 失败/慢速只占用一个 worker 位,不拖满整轮;单任务 reject 会经 Promise.all
// 向上传播(调用方须在 task 内消化预期失败,runQuery 即如此)
export async function runLimited(items, limit, task) {
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      await task(items[cursor++])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
