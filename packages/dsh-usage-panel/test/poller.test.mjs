// 轮询纯逻辑 BDD:时间驱动调度 / 失败退避 / 档位间隔。无外部依赖,定时器由调用方注入。
// 历史:round 分频形态(shouldQueryThisRound/longWindowDivisor)已被时间驱动取代——
// round 仅查询时递增使余额类账号死锁停摆,短窗账号每 tick 必查使用户间隔失效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKOFF_CAP_MULTIPLE,
  SHORT_TIER_INTERVAL_SEC,
  LONG_TIER_INTERVAL_SEC,
  createBackoff,
  tierIntervalSec,
  lastQuerySecOf,
  isDue,
  isShortWindowTier,
} from '../src/poller.mjs'

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

test('场景: 档位间隔 = 序列快照粒度(短档 10 分钟,长档 1 小时)', () => {
  assert.equal(SHORT_TIER_INTERVAL_SEC, 10 * 60)
  assert.equal(LONG_TIER_INTERVAL_SEC, 60 * 60)
  assert.equal(tierIntervalSec(true), SHORT_TIER_INTERVAL_SEC)
  assert.equal(tierIntervalSec(false), LONG_TIER_INTERVAL_SEC)
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
  assert.equal(isDue({ lastQuerySec: 0, nowSec: LONG_TIER_INTERVAL_SEC, intervalSec: LONG_TIER_INTERVAL_SEC }), true)
})

test('场景: 退避与到点独立叠加,双过才查(时序推演锁定)', () => {
  // 短窗账号失败:退避基期 = 档间隔 600;首次失败后 600s 内到点亦被退避压住
  const backoff = createBackoff({ baseSec: SHORT_TIER_INTERVAL_SEC })
  backoff.onFailure(1000)
  const dueAt = (lastQuerySec, nowSec) =>
    !backoff.isBlocked(nowSec) && isDue({ lastQuerySec, nowSec, intervalSec: SHORT_TIER_INTERVAL_SEC })
  assert.equal(dueAt(400, 1500), false, '退避未过(到 1600 才解),尽管 1000 已到点')
  assert.equal(dueAt(400, 1600), true, '退避与到点双过')
})

test('场景: 短窗口档判定,从未成功(含最近失败)按短档,失败不塌缩到长档', () => {
  const readingHasShort = true
  assert.equal(isShortWindowTier(null, readingHasShort), true, 'last 为空视为短窗口档')
  assert.equal(isShortWindowTier(null, false), true, 'last 为空即使无短窗口读数也首轮即查')
  assert.equal(isShortWindowTier({ ok: true, reading: {} }, readingHasShort), true)
  assert.equal(isShortWindowTier({ ok: true, reading: {} }, false), false, '成功且仅长窗口按长档')
  assert.equal(isShortWindowTier({ ok: false, reading: null }, readingHasShort), true, '失败不塌缩:含短窗账号保持短档节奏')
  assert.equal(isShortWindowTier({ ok: false, reading: null }, false), true, '失败的长窗账号也归短档:10 分钟节奏 + 退避压制重试')
})
