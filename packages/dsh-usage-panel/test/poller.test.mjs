// 轮询纯逻辑 BDD:间隔解析 / 失败退避 / 查询分频。无外部依赖,定时器由调用方注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_POLL_INTERVAL_SEC,
  BACKOFF_CAP_MULTIPLE,
  resolvePollIntervalSec,
  createBackoff,
  longWindowDivisor,
  shouldQueryThisRound,
  isShortWindowTier,
} from '../src/poller.mjs'

const HOUR_SEC = 60 * 60

test('场景: 间隔解析,非法值回落默认', () => {
  assert.equal(resolvePollIntervalSec(undefined), DEFAULT_POLL_INTERVAL_SEC)
  assert.equal(resolvePollIntervalSec(0), DEFAULT_POLL_INTERVAL_SEC)
  assert.equal(resolvePollIntervalSec(-5), DEFAULT_POLL_INTERVAL_SEC)
  assert.equal(resolvePollIntervalSec('abc'), DEFAULT_POLL_INTERVAL_SEC)
  assert.equal(resolvePollIntervalSec(Number.NaN), DEFAULT_POLL_INTERVAL_SEC)
  assert.equal(resolvePollIntervalSec(60), 60)
  assert.equal(resolvePollIntervalSec(120.5), 120.5)
})

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

test('场景: 分频除数 = round(1 小时 / 间隔)', () => {
  assert.equal(longWindowDivisor(600), Math.round(HOUR_SEC / 600))
  assert.equal(longWindowDivisor(HOUR_SEC), 1)
  assert.equal(longWindowDivisor(3600 + 1), 1, '间隔超过 1 小时退化为每轮')
})

test('场景: 长窗口账号按分频轮次查询', () => {
  const divisor = longWindowDivisor(600)
  assert.equal(shouldQueryThisRound({ round: 1, hasShortWindow: true, divisor }), true, '短窗口每轮查')
  assert.equal(shouldQueryThisRound({ round: 1, hasShortWindow: false, divisor }), false)
  assert.equal(shouldQueryThisRound({ round: divisor, hasShortWindow: false, divisor }), true)
  assert.equal(shouldQueryThisRound({ round: divisor * 2, hasShortWindow: false, divisor }), true)
})

test('场景: 含任一短窗口序列的账号归短窗口档', () => {
  assert.equal(shouldQueryThisRound({ round: 3, hasShortWindow: true, divisor: 6 }), true)
})

test('场景: 短窗口档判定,从未查询成功的账号首轮即查', () => {
  const readingHasShort = true
  assert.equal(isShortWindowTier(null, readingHasShort), true, 'last 为空视为短窗口档')
  assert.equal(isShortWindowTier(null, false), true, 'last 为空即使无短窗口读数也首轮即查')
  assert.equal(isShortWindowTier({ ok: true, reading: {} }, readingHasShort), true)
  assert.equal(isShortWindowTier({ ok: true, reading: {} }, false), false, '成功但仅长窗口按分频')
  assert.equal(isShortWindowTier({ ok: false, reading: null }, readingHasShort), false, '查询失败不按短窗口档')
})
