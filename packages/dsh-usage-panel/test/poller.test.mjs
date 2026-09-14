// 轮询纯逻辑 BDD:时间驱动调度 / 失败退避 / 统一查询间隔。无外部依赖,定时器由调用方注入。
// 历史:round 分频形态(shouldQueryThisRound/longWindowDivisor)已被时间驱动取代——
// round 仅查询时递增使余额类账号死锁停摆,短窗账号每 tick 必查使用户间隔失效。
// 档位间隔(短档 10 分钟/长档 1 小时)已被统一间隔取代——通知及时性要求余额类账号
// 与短窗账号同节奏,两档常量相等后档位机制退化为恒同值死路径,整体移除。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKOFF_CAP_MULTIPLE,
  POLL_INTERVAL_SEC,
  createBackoff,
  lastQuerySecOf,
  isDue,
  runLimited,
} from '../src/poller.mjs'
import { evaluateAccount, createNotifyState } from '../src/notify.mjs'

// 宿主 tick 周期(index.js TICK_SEC=30s)的测试替身:语义=tick 远小于轮询间隔
const TICK_SEC = 30

test('场景: 失败退避指数增长并封顶', () => {
  const backoff = createBackoff({ baseSec: 600 })
  assert.equal(backoff.isBlocked(0), false, '初始不退避')
  backoff.onFailure(0)
  assert.equal(backoff.nextRetryAt, 600)
  backoff.onFailure(600)
  assert.equal(backoff.nextRetryAt, 1800)
  backoff.onFailure(1800)
  assert.equal(backoff.nextRetryAt, 4200)
  backoff.onFailure(4200)
  // 封顶 = 基期 * 8
  assert.equal(backoff.nextRetryAt, 4200 + 600 * BACKOFF_CAP_MULTIPLE)
})

test('场景: 成功即恢复退避', () => {
  const backoff = createBackoff({ baseSec: 600 })
  backoff.onFailure(0)
  backoff.onSuccess()
  assert.equal(backoff.isBlocked(1), false)
  backoff.onFailure(1)
  assert.equal(backoff.nextRetryAt, 1 + 600, '恢复后按基期重新退避')
})

test('场景: 退避期间被跳过,到期放行', () => {
  const backoff = createBackoff({ baseSec: 600 })
  backoff.onFailure(0)
  assert.equal(backoff.isBlocked(599), true)
  assert.equal(backoff.isBlocked(600), false)
})

test('场景: 统一查询间隔 10 分钟,余额类账号与短窗账号同节奏', () => {
  assert.equal(POLL_INTERVAL_SEC, 10 * 60)
})

test('场景: 上次尝试查询时刻换算,缺失或非法回 null 视为立即到点', () => {
  assert.equal(lastQuerySecOf(null), null)
  assert.equal(lastQuerySecOf(undefined), null)
  assert.equal(lastQuerySecOf({ ok: true }), null, '旧数据无 queriedAt')
  assert.equal(lastQuerySecOf({ queriedAt: 'bad' }), null)
  assert.equal(lastQuerySecOf({ queriedAt: 1700000000000 }), 1700000000)
  assert.equal(lastQuerySecOf({ queriedAt: 1700000000500 }), 1700000000, '毫秒截断到秒')
})

test('场景: 时间驱动到点判定', () => {
  assert.equal(isDue({ lastQuerySec: null, nowSec: 1000, intervalSec: 600 }), true, '从未查询立即到点')
  assert.equal(isDue({ lastQuerySec: 500, nowSec: 1099, intervalSec: 600 }), false, '未满间隔')
  assert.equal(isDue({ lastQuerySec: 500, nowSec: 1100, intervalSec: 600 }), true, '恰满间隔到点')
  assert.equal(isDue({ lastQuerySec: 0, nowSec: POLL_INTERVAL_SEC, intervalSec: POLL_INTERVAL_SEC }), true)
})

test('场景: 退避与到点独立叠加,双过才查(时序推演锁定)', () => {
  // 失败:退避基期 = 统一间隔;首次失败后一个周期内到点亦被退避压住
  const backoff = createBackoff({ baseSec: POLL_INTERVAL_SEC })
  backoff.onFailure(1000)
  const dueAt = (lastQuerySec, nowSec) =>
    !backoff.isBlocked(nowSec) && isDue({ lastQuerySec, nowSec, intervalSec: POLL_INTERVAL_SEC })
  assert.equal(dueAt(400, 1500), false, '退避未过(到 1600 才解),尽管 1000 已到点')
  assert.equal(dueAt(400, 1600), true, '退避与到点双过')
})

test('场景: 受限并发执行——全项被处理,慢任务不阻塞其他 worker', async () => {
  // Given 6 项任务,并发 2:每个任务挂起直到放行;并发内慢任务(后放行)只占 1 个 worker 位
  const processed = []
  const release = []
  const task = async (item) => {
    await new Promise((resolve) => release.push(resolve))
    processed.push(item)
  }
  const done = runLimited([1, 2, 3, 4, 5, 6], 2, task)
  // When 恰有 2 个任务在途(worker 数 = 并发上限)
  assert.equal(release.length, 2, '并发上限决定在途任务数')
  // 放行在途任务使其完成并取号下一项
  release.splice(0).forEach((resolve) => resolve())
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(release.length, 2, '完成后立即补位')
  release.splice(0).forEach((resolve) => resolve())
  await new Promise((resolve) => setTimeout(resolve, 0))
  release.splice(0).forEach((resolve) => resolve())
  await done
  // Then 全部 6 项被处理,无重复无遗漏
  assert.equal(processed.length, 6)
  assert.deepEqual([...processed].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
})

test('场景: 受限并发执行——单任务失败不中断其余任务(失败由 task 内消化)', async () => {
  // Given task 对偶数项抛错但就地消化(生产用法:runQuery().catch 口径),runLimited 恒 resolve
  const processed = []
  const task = async (item) => {
    try {
      if (item % 2 === 0) throw new Error('boom-' + item)
      processed.push(item)
    } catch { /* 单项失败只占自己的 worker 位 */ }
  }
  // When 5 项、并发 2
  await runLimited([1, 2, 3, 4, 5], 2, task)
  // Then 奇数项全被处理
  assert.deepEqual([...processed].sort((a, b) => a - b), [1, 3, 5])
})

test('场景: 受限并发执行——空列表与并发大于任务数', async () => {
  const processed = []
  await runLimited([], 4, async (item) => processed.push(item))
  assert.deepEqual(processed, [])
  await runLimited([1, 2], 8, async (item) => processed.push(item))
  assert.deepEqual(processed, [1, 2])
})

// 端到端时钟推演:自动轮询 tick 驱动(无任何手动刷新)下,读数新越阈值即产出通知。
// Given tick 周期远小于轮询间隔,阈值 91%,上游 utilization 按轮次爬升。
// When 宿主 tick 循环按 isDue 判定到点轮次并执行查询 + 沿触发评估。
// Then 通知在越线轮次由自动路径产出,armed 解除后不重发。
test('场景: 自动轮询 tick 驱动下阈值穿越产出通知(无手动刷新)', () => {
  let nowSec = 0
  const utilizationByRound = [40, 55, 70, 93, 95, 60]
  let round = 0
  const account = { id: 'acct-sim', name: '模拟账号', last: null, notifyState: createNotifyState() }
  const backoff = createBackoff({ baseSec: POLL_INTERVAL_SEC })
  const events = []
  for (; round < utilizationByRound.length && nowSec <= POLL_INTERVAL_SEC * utilizationByRound.length + TICK_SEC; nowSec += TICK_SEC) {
    const due = !backoff.isBlocked(nowSec) && isDue({
      lastQuerySec: lastQuerySecOf(account.last),
      nowSec,
      intervalSec: POLL_INTERVAL_SEC,
    })
    if (!due) continue
    // runQuery 成功路径:落读数记 queriedAt(成功失败均记),退避恢复
    const queriedAt = nowSec * 1000
    account.last = {
      ok: true,
      reading: {
        kind: 'quota',
        windows: [{ label: '5小时', utilization: utilizationByRound[round++], remaining: null, limit: null, resetsAt: '2026-01-01T00:00:00Z' }],
      },
      error: null,
      queriedAt,
    }
    backoff.onSuccess()
    // evaluateAndDispatch 评估段:通知开,阈值 91%
    const outcome = evaluateAccount({
      account,
      rule: { quotaThresholdPct: 91, balanceThreshold: null, resetNotice: true },
      state: account.notifyState,
      seq: events.length,
      ts: queriedAt,
    })
    account.notifyState = outcome.state
    events.push(...outcome.events)
  }
  assert.equal(round, utilizationByRound.length, '每轮到点均被 tick 驱动查询')
  assert.equal(events.length, 1, '自动路径恰好产出一次阈值通知')
  assert.equal(events[0].detail.value, 93, '通知发生在越线轮次')
  assert.equal(account.notifyState.windows['5小时'].armed, false, '越线后武装解除')
})
