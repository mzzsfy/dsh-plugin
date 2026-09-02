// 用量面板解析器测试:BDD 场景 1-9(见 docs/feat-usage-panel/plan.md)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  toStrictNumber,
  getPath,
  extractByRule,
  parseDeepSeek,
  parseOpenRouter,
  parseKimi,
  parseZhipu,
  parseMiniMax,
  parseNewApi,
  extractCustom,
} from '../src/parsers.mjs'

const HOUR_MS = 60 * 60 * 1000

test('场景1 DeepSeek 余额:双币种 balance_infos 解析', () => {
  const body = {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '2.00', topped_up_balance: '108.00' },
      { currency: 'USD', total_balance: '15.30', granted_balance: '0.00', topped_up_balance: '15.30' },
    ],
  }
  const reading = parseDeepSeek(body)
  assert.equal(reading.kind, 'balance')
  assert.equal(reading.entries.length, 2)
  assert.deepEqual(reading.entries[0], { currency: 'CNY', total: 110, granted: 2, toppedUp: 108, isAvailable: true })
  assert.deepEqual(reading.entries[1], { currency: 'USD', total: 15.3, granted: 0, toppedUp: 15.3, isAvailable: true })
})

test('场景1b DeepSeek 余额:is_available=false 透传,缺省赠送/充值字段为 null', () => {
  const body = { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }
  const reading = parseDeepSeek(body)
  assert.equal(reading.entries[0].isAvailable, false)
  assert.equal(reading.entries[0].granted, null)
  assert.equal(reading.entries[0].toppedUp, null)
})

test('场景2 DeepSeek 错误体:抛出含 message 的错误', () => {
  assert.throws(() => parseDeepSeek({ error: { message: '认证失败', type: 'invalid_request_error' } }), /认证失败/)
  assert.throws(() => parseDeepSeek({}), /balance_infos/)
})

test('场景3 OpenRouter credits:总额/已用/剩余', () => {
  const body = { data: { total_credits: 10, total_usage: 1.58 } }
  const reading = parseOpenRouter(body)
  assert.equal(reading.kind, 'balance')
  assert.deepEqual(reading.entries[0], { currency: 'USD', total: 10, used: 1.58, remaining: 8.42 })
  assert.throws(() => parseOpenRouter({ data: {} }), /total_credits/)
})

test('场景4 Kimi usages:5小时窗口与每周配额', () => {
  const body = {
    limits: [{ detail: { limit: 1500, remaining: 1000, resetTime: '2026-03-01T00:00:00Z' } }],
    usage: { limit: 10000, remaining: 6900, resetTime: '2026-03-02T00:00:00Z' },
    user: { membership: { level: 'LEVEL_3' } },
  }
  const reading = parseKimi(body)
  assert.equal(reading.kind, 'quota')
  assert.equal(reading.windows.length, 2)
  assert.equal(reading.windows[0].label, '5小时')
  assert.equal(reading.windows[0].limit, 1500)
  assert.equal(reading.windows[0].remaining, 1000)
  assert.equal(reading.windows[0].used, 500)
  assert.ok(Math.abs(reading.windows[0].utilization - (500 / 1500) * 100) < 1e-9)
  assert.equal(reading.windows[1].label, '7天')
  assert.equal(reading.membership, 'LEVEL_3')
  assert.throws(() => parseKimi({ limits: [] }), /usage|limits/)
})

test('场景5 智谱 quota:unit 3/6 分窗 + 未分类回填 + 失败体', () => {
  const base = 1740000000000
  const body = {
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 30, nextResetTime: base + 24 * HOUR_MS },
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 12.5, nextResetTime: base + 2 * HOUR_MS },
      ],
    },
  }
  const reading = parseZhipu(body)
  assert.equal(reading.kind, 'quota')
  assert.equal(reading.windows[0].label, '5小时')
  assert.equal(reading.windows[0].utilization, 12.5)
  assert.equal(reading.windows[1].label, '7天')
  assert.equal(reading.windows[1].utilization, 30)

  const heuristic = parseZhipu({
    success: true,
    data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 5, nextResetTime: base }] },
  })
  assert.equal(heuristic.windows.length, 1)
  assert.equal(heuristic.windows[0].label, '5小时')

  assert.throws(() => parseZhipu({ success: false, msg: '额度查询失败' }), /额度查询失败/)
  assert.throws(() => parseZhipu({ success: true, data: { limits: [] } }), /额度窗口/)
})

test('场景5b 智谱 Lite:CREDIT_LIMIT 窗口与 currentValue/usage 反推', () => {
  const base = 1740000000000
  const reading = parseZhipu({
    success: true,
    data: {
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, percentage: 8.4, nextResetTime: base + 2 * HOUR_MS },
        { type: 'CREDIT_LIMIT', unit: 6, percentage: 21, nextResetTime: base + 24 * HOUR_MS },
      ],
      level: 'pro',
    },
  })
  assert.equal(reading.kind, 'quota')
  assert.equal(reading.windows.length, 2)
  assert.equal(reading.windows[0].label, '5小时')
  assert.equal(reading.windows[0].utilization, 8.4)
  assert.equal(reading.windows[1].label, '7天')
  assert.equal(reading.level, 'pro')

  const inferred = parseZhipu({
    success: true,
    data: {
      limits: [{ type: 'CREDIT_LIMIT', unit: 3, currentValue: 25, usage: 500, nextResetTime: base }],
    },
  })
  assert.equal(inferred.windows.length, 1)
  assert.equal(inferred.windows[0].utilization, 5)
})

test('场景5c 智谱 Max:TOKENS_LIMIT 加 TIME_LIMIT 提示数窗口', () => {
  const base = 1740000000000
  const reading = parseZhipu({
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 3, nextResetTime: base + 2 * HOUR_MS },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 81, nextResetTime: base + 5 * 24 * HOUR_MS },
        { type: 'TIME_LIMIT', unit: 5, percentage: 1, currentValue: 8, usage: 4000, remaining: 3992, nextResetTime: base + 3 * HOUR_MS,
          usageDetails: [
            { modelCode: 'search-prime', usage: 4 },
            { modelCode: 'web-reader', usage: 4 },
            { modelCode: 'zread', usage: 0 },
          ] },
      ],
      level: 'max',
    },
  })
  assert.equal(reading.kind, 'quota')
  assert.equal(reading.windows.length, 3)
  assert.equal(reading.windows[0].label, '5小时')
  assert.equal(reading.windows[1].label, '7天')
  assert.equal(reading.windows[2].label, '工具用量')
  assert.equal(reading.windows[2].utilization, 1)
  assert.equal(reading.windows[2].remaining, 3992)
  assert.equal(reading.windows[2].limit, 4000)
  assert.equal(Date.parse(reading.windows[2].resetsAt), base + 3 * HOUR_MS)
  assert.deepEqual(reading.windows[2].details, [
    { model: 'search-prime', usage: 4 },
    { model: 'web-reader', usage: 4 },
    { model: 'zread', usage: 0 },
  ])
  assert.equal(reading.level, 'max')
})

test('场景5d 智谱真实响应:zp-jzjy 账号 CREDIT_LIMIT 原样结构', () => {
  const reading = parseZhipu({
    code: 200,
    msg: '操作成功',
    success: true,
    data: {
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 0, remaining: 12000, percentage: 0 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 59881, remaining: 118, percentage: 99, nextResetTime: 1788507277997 },
      ],
      level: 'pro',
    },
  })
  assert.equal(reading.windows.length, 2)
  assert.equal(reading.windows[0].utilization, 0)
  assert.equal(reading.windows[0].remaining, 12000)
  assert.equal(reading.windows[0].limit, 12000)
  assert.equal(reading.windows[1].utilization, 99)
  assert.equal(reading.windows[1].remaining, 118)
  assert.equal(reading.windows[1].resetsAt, new Date(1788507277997).toISOString())
})

test('场景5c 智谱:仅 TIME_LIMIT 等无关类型时报出见到的类型', () => {
  assert.throws(
    () => parseZhipu({ success: true, data: { limits: [{ type: 'TIME_LIMIT', percentage: 1 }] } }),
    /TIME_LIMIT/,
  )
})

test('场景6 MiniMax remains:剩余百分比反推已用,周窗口按状态开关', () => {
  const body = {
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      current_interval_remaining_percent: 88,
      end_time: 1740000000000,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 70,
      weekly_end_time: 1740600000000,
    }],
  }
  const reading = parseMiniMax(body)
  assert.equal(reading.kind, 'quota')
  assert.equal(reading.windows.length, 2)
  assert.equal(reading.windows[0].utilization, 12)
  assert.equal(reading.windows[1].utilization, 30)

  const noWeekly = parseMiniMax({
    base_resp: { status_code: 0 },
    model_remains: [{ model_name: 'general', current_interval_remaining_percent: 50 }],
  })
  assert.equal(noWeekly.windows.length, 1)

  assert.throws(
    () => parseMiniMax({ base_resp: { status_code: 1001, status_msg: 'key 无效' } }),
    /key 无效/,
  )
  assert.throws(
    () => parseMiniMax({ base_resp: { status_code: 0 }, model_remains: [] }),
    /general/,
  )
})

test('场景7 NewApi token:quota 换算 USD,无限额度报错', () => {
  const QUOTA_PER_USD = 500000
  const body = {
    code: 200,
    data: { total_granted: 5 * QUOTA_PER_USD, total_used: QUOTA_PER_USD, total_available: 4 * QUOTA_PER_USD, unlimited_quota: false },
  }
  const reading = parseNewApi(body)
  assert.equal(reading.kind, 'balance')
  assert.deepEqual(reading.entries[0], { currency: 'USD', total: 5, used: 1, remaining: 4 })

  assert.throws(
    () => parseNewApi({ code: 200, data: { unlimited_quota: true } }),
    /无限额度/,
  )
  assert.throws(() => parseNewApi({ code: 401, message: '无权进行此操作,未登录' }), /无权/)
})

test('场景8 custom extract:点路径/add/subtract/divide/常量', () => {
  const data = { info: { max_budget: 100, spend: 40 }, a: 1, b: 2 }
  assert.equal(extractByRule(data, 'info.max_budget'), 100)
  assert.equal(extractByRule(data, { op: 'subtract', paths: ['info.max_budget', 'info.spend'] }), 60)
  assert.equal(extractByRule(data, { op: 'add', paths: ['a', 'b'] }), 3)
  assert.equal(extractByRule(data, { op: 'divide', path: 'info.max_budget', by: 4 }), 25)
  assert.equal(extractByRule(data, 42), 42)
  assert.equal(extractByRule(data, 'info.missing'), null)
  assert.equal(extractByRule(data, { op: 'subtract', paths: ['info.max_budget', 'info.missing'] }), null)

  const reading = extractCustom(data, {
    remaining: { op: 'subtract', paths: ['info.max_budget', 'info.spend'] },
    maxBudget: 'info.max_budget',
    spend: 'info.spend',
    unit: 'CNY',
  })
  assert.deepEqual(reading, { currency: 'CNY', remaining: 60, total: 100, used: 40 })
  assert.throws(() => extractCustom(data, { remaining: 'info.missing' }), /remaining/)
})

test('场景8b getPath 原型链逃逸被拒绝', () => {
  assert.equal(getPath({}, '__proto__'), undefined)
  assert.equal(getPath({ a: 1 }, 'constructor'), undefined)
})

test('场景9 严格数值:非数值一律 NaN', () => {
  assert.ok(Number.isNaN(toStrictNumber('1,234')))
  assert.ok(Number.isNaN(toStrictNumber('')))
  assert.ok(Number.isNaN(toStrictNumber(null)))
  assert.ok(Number.isNaN(toStrictNumber(false)))
  assert.ok(Number.isNaN(toStrictNumber('$12')))
  assert.equal(toStrictNumber('12.5'), 12.5)
  assert.equal(toStrictNumber(' 7 '), 7)
  assert.equal(toStrictNumber(0), 0)
})
