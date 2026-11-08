import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionStateOf } from '../src/market-model.mjs'

// 时段判断是纯函数: 输入 UTC 时刻, 输出该市场的交易阶段。用固定时刻断言, 不依赖运行时的真实时钟。
const at = iso => Date.parse(iso)

test('S1 沪深盘中与午休按北京时间划分', () => {
  assert.equal(sessionStateOf('XSHG', at('2026-11-06T02:00:00Z')), 'trading')
  assert.equal(sessionStateOf('XSHE', at('2026-11-06T04:00:00Z')), 'break')
  assert.equal(sessionStateOf('XSHG', at('2026-11-06T07:00:00Z')), 'closed')
  assert.equal(sessionStateOf('XSHG', at('2026-11-06T01:00:00Z')), 'preopen')
})

test('S2 港股下午收盘延到 16:00, 与沪深同期时刻不同相', () => {
  // 北京时间 15:30: 沪深已收盘, 港股仍在交易
  assert.equal(sessionStateOf('XSHG', at('2026-11-06T07:30:00Z')), 'closed')
  assert.equal(sessionStateOf('XHKG', at('2026-11-06T07:30:00Z')), 'trading')
  // 港股午休 12:00-13:00
  assert.equal(sessionStateOf('XHKG', at('2026-11-06T04:30:00Z')), 'break')
})

test('S3 美股按纽约时间, 北京白天处于开市前', () => {
  assert.equal(sessionStateOf('XNAS', at('2026-11-06T08:20:00Z')), 'preopen')
  assert.equal(sessionStateOf('XNYS', at('2026-11-06T15:00:00Z')), 'trading')
  // 美东 20:00 已收盘
  assert.equal(sessionStateOf('XNAS', at('2026-11-07T01:00:00Z')), 'closed')
})

test('S4 日韩英各自的时段', () => {
  assert.equal(sessionStateOf('XJPX', at('2026-11-06T01:00:00Z')), 'trading')
  // 东京 11:45 午休
  assert.equal(sessionStateOf('XJPX', at('2026-11-06T02:45:00Z')), 'break')
  assert.equal(sessionStateOf('XKRX', at('2026-11-06T01:00:00Z')), 'trading')
  assert.equal(sessionStateOf('XLON', at('2026-11-06T09:00:00Z')), 'trading')
  // 伦敦 17:00 收盘
  assert.equal(sessionStateOf('XLON', at('2026-11-06T17:00:00Z')), 'closed')
})

test('S5 周末恒为休市, 不看时段', () => {
  // 2026-11-07 是周六, 港股与美股均休市
  assert.equal(sessionStateOf('XHKG', at('2026-11-07T02:00:00Z')), 'closed')
  assert.equal(sessionStateOf('XHKG', at('2026-11-07T05:00:00Z')), 'closed')
  assert.equal(sessionStateOf('XNAS', at('2026-11-07T15:00:00Z')), 'closed')
  assert.equal(sessionStateOf('XSHG', at('2026-11-08T02:00:00Z')), 'closed')
})

test('S6 未知交易所不猜时段', () => {
  assert.equal(sessionStateOf('NOSUCH', at('2026-11-06T02:00:00Z')), 'unknown')
  assert.equal(sessionStateOf(undefined, at('2026-11-06T02:00:00Z')), 'unknown')
})

test('S7 收盘后按时间点报数据, 不再把收盘后的时长算成延迟', async () => {
  const { deriveDelay } = await import('../src/collector.mjs')
  const quote = at => ({ delayKind: 'unknown', delaySeconds: null, quoteAt: at })
  // 交易中: 两分钟前 => delayed + 秒差
  const live = deriveDelay(quote('2026-11-06T08:58:00Z'), () => Date.parse('2026-11-06T09:00:00Z'), true)
  assert.deepEqual({ kind: live.delayKind, s: live.delaySeconds }, { kind: 'delayed', s: 120 })
  // 休市: 同一份报价不改口径成"延迟一小时", 标 closed 交给界面报时间点
  const closed = deriveDelay(quote('2026-11-06T07:00:00Z'), () => Date.parse('2026-11-06T08:00:00Z'), false)
  assert.deepEqual({ kind: closed.delayKind, s: closed.delaySeconds }, { kind: 'closed', s: null })
  // 实时窗口内不受 trading 影响
  const fresh = deriveDelay(quote('2026-11-06T08:59:40Z'), () => Date.parse('2026-11-06T09:00:00Z'), false)
  assert.equal(fresh.delayKind, 'realtime')
})
