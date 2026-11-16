// 客户端趋势图与总览纯逻辑契约(LOGIC 段求值):
// - 趋势点位、刻度、时间轴与差值零轴
// - 序列单位(百分比/金额/计数)与数值格式化
// - 账号总览统计、额度触顶预测、余额消耗速率
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function clientLogic() {
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  return new Function(
    section
      + '; return { computeTrendGeometry, computeDiffSeries, summaryOf, formatTrendValue, formatTrendDelta,'
      + ' formatAxisTime, formatAgo, formatDuration, unitOfSequence, buildOverview,'
      + ' forecastQuota, forecastBalance, forecastNotes, buildTrendCsv, formatResetCountdown, activeTrendPoint };',
  )()
}

const logic = clientLogic()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

test('趋势几何:绝对值模式生成 Y 轴三档刻度与 X 轴端点', () => {
  const points = [
    { t: 0, v: 0 },
    { t: HOUR, v: 50 },
    { t: 2 * HOUR, v: 100 },
  ]
  const geometry = logic.computeTrendGeometry(points, 'abs', 200, 100, { left: 20, right: 10, top: 10, bottom: 20 })
  assert.deepEqual(geometry.points.map((p) => ({ x: p.x, y: p.y, v: p.v })), [
    { x: 20, y: 80, v: 0 },
    { x: 105, y: 45, v: 50 },
    { x: 190, y: 10, v: 100 },
  ])
  assert.deepEqual(geometry.yTicks.map((tick) => ({ value: tick.value, y: tick.y })), [
    { value: 100, y: 10 },
    { value: 50, y: 45 },
    { value: 0, y: 80 },
  ])
  assert.deepEqual(geometry.xTicks.map((tick) => ({ t: tick.t, x: tick.x })), [
    { t: 0, x: 20 },
    { t: HOUR, x: 105 },
    { t: 2 * HOUR, x: 190 },
  ])
})

test('趋势几何:差值模式包含零轴且点位跨零', () => {
  const points = [
    { t: 0, v: 46 },
    { t: HOUR, v: 47 },
    { t: 2 * HOUR, v: 45 },
  ]
  const geometry = logic.computeTrendGeometry(points, 'diff', 200, 100, { left: 20, right: 10, top: 10, bottom: 20 })
  assert.deepEqual(geometry.points.map((p) => ({ x: p.x, v: p.v })), [
    { x: 20, v: 1 },
    { x: 190, v: -2 },
  ])
  assert.ok(geometry.zeroY > geometry.points[0].y, '零轴应低于正值点')
  assert.ok(geometry.zeroY < geometry.points[1].y, '零轴应高于负值点')
})

test('趋势几何:少于两个点或极值相等时返回明确结果', () => {
  assert.equal(logic.computeTrendGeometry([{ t: 0, v: 1 }], 'abs', 200, 100, { left: 20, right: 10, top: 10, bottom: 20 }), null)
  const flat = logic.computeTrendGeometry([{ t: 0, v: 5 }, { t: HOUR, v: 5 }], 'abs', 200, 100, { left: 20, right: 10, top: 10, bottom: 20 })
  assert.ok(flat.points.every((p) => p.y === 45), '等值序列落在绘图区中线')
  const withNull = logic.computeTrendGeometry([{ t: 0, v: 10 }, { t: HOUR, v: null }, { t: 2 * HOUR, v: 20 }], 'abs', 200, 100, { left: 20, right: 10, top: 10, bottom: 20 })
  assert.deepEqual(withNull.points.map((p) => p.v), [10, 20], '非数值点不进入绘图序列')
})

test('悬停命中:旧索引越界返回 null 而不是崩溃', () => {
  const points = [{ x: 1 }, { x: 2 }]
  assert.equal(logic.activeTrendPoint(points, 5), null)
  assert.equal(logic.activeTrendPoint(points, -1), null)
  assert.equal(logic.activeTrendPoint(points, 1.5), null)
  assert.equal(logic.activeTrendPoint(points, 1), points[1])
  assert.equal(logic.activeTrendPoint(null, 0), null)
})

test('数值格式化:按百分比/金额/计数输出', () => {
  assert.equal(logic.formatTrendValue(46, { kind: 'pct' }), '46%')
  assert.equal(logic.formatTrendValue(0.5, { kind: 'pct' }), '0.5%')
  assert.equal(logic.formatTrendValue(8.05, { kind: 'money', symbol: '¥' }), '¥8.05')
  assert.equal(logic.formatTrendValue(1200, { kind: 'count' }), '1200')
  assert.equal(logic.formatTrendValue(NaN, { kind: 'pct' }), '—')
  assert.equal(logic.formatTrendDelta(1.5, { kind: 'pct' }), '+1.5%')
  assert.equal(logic.formatTrendDelta(-0.12, { kind: 'money', symbol: '¥' }), '-¥0.12')
  assert.equal(logic.formatTrendDelta(0, { kind: 'pct' }), '0%')
})

test('时间格式:轴标签按跨度切换时分与月日,相对时间按区间取整', () => {
  const t = new Date(2026, 0, 1, 10, 0).getTime()
  assert.equal(logic.formatAxisTime(t, 5 * HOUR), '10:00')
  assert.equal(logic.formatAxisTime(t, 7 * DAY), '01/01')
  const now = 10 * DAY
  assert.equal(logic.formatAgo(now, now - 30 * 1000), '刚刚')
  assert.equal(logic.formatAgo(now, now - 5 * 60 * 1000), '5 分钟前')
  assert.equal(logic.formatAgo(now, now - 2 * HOUR), '2 小时前')
  assert.equal(logic.formatAgo(now, now - 3 * DAY), '3 天前')
  assert.equal(logic.formatDuration(30 * 60 * 1000), '30 分钟')
  assert.equal(logic.formatDuration(5 * HOUR), '5 小时')
  assert.equal(logic.formatDuration(3 * DAY), '3 天')
})

test('额度倒计时:单一「后重置」后缀,过期显示已可重置', () => {
  const now = new Date(2026, 0, 1, 10, 0).getTime()
  assert.equal(logic.formatResetCountdown(new Date(now + 30 * 60 * 1000).toISOString(), now), '30分钟后重置')
  assert.equal(logic.formatResetCountdown(new Date(now + 3 * HOUR).toISOString(), now), '3小时后重置')
  assert.equal(logic.formatResetCountdown(new Date(now + 2 * DAY).toISOString(), now), '2天后重置')
  assert.equal(logic.formatResetCountdown(new Date(now - HOUR).toISOString(), now), '已可重置')
  assert.equal(logic.formatResetCountdown(null, now), null)
})

test('序列单位:额度窗口按 remaining/limit 判别计数,余额按币种,缺读数回落数字', () => {
  const quota = {
    kind: 'quota',
    windows: [
      { label: '5小时', remaining: 30, limit: 100, utilization: 70 },
      { label: '7天', remaining: null, limit: null, utilization: 46 },
    ],
  }
  assert.deepEqual(logic.unitOfSequence(quota, '5h'), { kind: 'count', limit: 100 })
  assert.deepEqual(logic.unitOfSequence(quota, '7d'), { kind: 'pct' })
  assert.deepEqual(logic.unitOfSequence({ kind: 'balance', entries: [{ currency: 'CNY', remaining: 8.05 }] }, 'balance'), {
    kind: 'money', currency: 'CNY', symbol: '¥',
  })
  assert.deepEqual(logic.unitOfSequence({ kind: 'balance', entries: [{ currency: 'USD' }] }, 'month'), {
    kind: 'money', currency: 'USD', symbol: '$',
  })
  assert.deepEqual(logic.unitOfSequence(null, '5h'), { kind: 'number' })
})

test('总览:账号状态、币种余额合计、最高额度与最近更新', () => {
  const accounts = [
    {
      name: 'A', last: { ok: true, queriedAt: 1000, reading: { kind: 'quota', windows: [{ label: '7天', utilization: 46 }, { label: '5小时', utilization: 1 }] } },
    },
    { name: 'B', last: { ok: false, queriedAt: 2000, reading: null } },
    {
      name: 'C', last: { ok: true, queriedAt: 3000, reading: { kind: 'balance', entries: [{ currency: 'CNY', remaining: 8.05 }, { currency: 'USD', total: 1 }] } },
    },
  ]
  assert.deepEqual(logic.buildOverview(accounts), {
    total: 3,
    ok: 2,
    error: 1,
    never: 0,
    balances: [{ currency: 'CNY', value: 8.05 }, { currency: 'USD', value: 1 }],
    topQuota: { accountName: 'A', label: '7天', utilization: 46 },
    lastUpdated: 3000,
  })
  assert.deepEqual(logic.buildOverview([]), {
    total: 0, ok: 0, error: 0, never: 0, balances: [], topQuota: null, lastUpdated: null,
  })
})

test('额度预测:当前窗口内斜率触顶早于重置为预警,历史不足或缺少重置时间为空', () => {
  const now = 10 * DAY
  const resetsAt = new Date(now + 4 * HOUR).toISOString()
  const points = [
    { t: now - HOUR, v: 80 },
    { t: now, v: 90 },
  ]
  const forecast = logic.forecastQuota(points, {
    suffix: '5h', resetsAt, unit: { kind: 'pct' }, currentUtilization: 90, now,
  })
  assert.equal(forecast.kind, 'warn')
  assert.ok(Math.abs(forecast.hoursToFull - 1) < 1e-9)
  assert.ok(Math.abs(forecast.hoursUntilReset - 4) < 1e-9)
  assert.equal(logic.forecastQuota([{ t: now, v: 90 }], {
    suffix: '5h', resetsAt, unit: { kind: 'pct' }, currentUtilization: 90, now,
  }), null)
  assert.equal(logic.forecastQuota(points, {
    suffix: '5h', resetsAt: null, unit: { kind: 'pct' }, currentUtilization: 90, now,
  }), null)
  assert.equal(logic.forecastQuota([
    { t: now - 10 * 60 * 1000, v: 80 },
    { t: now, v: 90 },
  ], {
    suffix: '5h', resetsAt, unit: { kind: 'pct' }, currentUtilization: 90, now,
  }), null, '观测跨度不足一小时不外推')
  const slow = logic.forecastQuota([
    { t: now - HOUR, v: 80 },
    { t: now, v: 80.05 },
  ], {
    suffix: '5h', resetsAt, unit: { kind: 'pct' }, currentUtilization: 80.05, now,
  })
  assert.equal(slow.kind, 'safe', '斜率不超过 0.05pp/h 时不预警')
})

test('额度预测:计数单位按 limit 换算利用率', () => {
  const now = 10 * DAY
  const resetsAt = new Date(now + 4 * HOUR).toISOString()
  const points = [
    { t: now - HOUR, v: 50 },
    { t: now, v: 40 },
  ]
  const forecast = logic.forecastQuota(points, {
    suffix: '5h', resetsAt, unit: { kind: 'count', limit: 100 }, currentUtilization: 60, now,
  })
  assert.equal(forecast.kind, 'warn')
  assert.ok(Math.abs(forecast.hoursToFull - 4) < 1e-9)
})

test('余额预测:近 7 天负斜率换算出可用天数,平盘为 flat', () => {
  const now = 10 * DAY
  const points = [
    { t: now - 7 * DAY, v: 10 },
    { t: now, v: 5 },
  ]
  const forecast = logic.forecastBalance(points, { remaining: 5, now })
  assert.equal(forecast.kind, 'burn')
  assert.ok(Math.abs(forecast.perDay - (-5 / 7)) < 1e-9)
  assert.ok(Math.abs(forecast.daysLeft - 7) < 1e-9)
  assert.equal(logic.forecastBalance([{ t: now - DAY, v: 5 }, { t: now, v: 5 }], { remaining: 5, now }).kind, 'flat')
})

test('余额预测:余额归零或未知时仍保持 burn 方向,不伪造可用天数', () => {
  const now = 10 * DAY
  const points = [{ t: now - 7 * DAY, v: 10 }, { t: now, v: 5 }]
  const zero = logic.forecastBalance(points, { remaining: 0, now })
  assert.equal(zero.kind, 'burn')
  assert.equal(zero.daysLeft, 0)
  assert.ok(zero.perDay < 0)
  for (const remaining of [null, undefined]) {
    const forecast = logic.forecastBalance(points, { remaining, now })
    assert.equal(forecast.kind, 'burn')
    assert.equal(forecast.daysLeft, null)
    assert.ok(forecast.perDay < 0)
  }
})

test('预测提示:额度预警与余额消耗生成面向用户的文案', () => {
  const now = 10 * DAY
  const quotaAccount = {
    name: 'A',
    last: {
      ok: true,
      queriedAt: now,
      reading: {
        kind: 'quota',
        windows: [{ label: '5小时', utilization: 90, resetsAt: new Date(now + 4 * HOUR).toISOString() }],
      },
    },
  }
  const quotaNote = logic.forecastNotes(quotaAccount, {
    '5h': { points: [{ t: now - HOUR, v: 80 }, { t: now, v: 90 }] },
  }, now)
  assert.equal(quotaNote.kind, 'warn')
  assert.match(quotaNote.text, /5小时/)
  assert.match(quotaNote.text, /触顶/)

  const balanceAccount = {
    name: 'B',
    last: {
      ok: true,
      queriedAt: now,
      reading: { kind: 'balance', entries: [{ currency: 'CNY', remaining: 5 }] },
    },
  }
  const balanceNote = logic.forecastNotes(balanceAccount, {
    balance: { points: [{ t: now - 7 * DAY, v: 10 }, { t: now, v: 5 }] },
  }, now)
  assert.equal(balanceNote.kind, 'info')
  assert.match(balanceNote.text, /日均/)
  assert.match(balanceNote.text, /可用/)

  const unknownBalanceAccount = {
    name: 'C',
    last: {
      ok: true,
      queriedAt: now,
      reading: { kind: 'balance', entries: [{ currency: 'CNY' }] },
    },
  }
  const unknownNote = logic.forecastNotes(unknownBalanceAccount, {
    balance: { points: [{ t: now - 7 * DAY, v: 10 }, { t: now, v: 5 }] },
  }, now)
  assert.equal(unknownNote.kind, 'info')
  assert.match(unknownNote.text, /剩余余额未知/)

  const emptyBalanceAccount = {
    name: 'D',
    last: {
      ok: true,
      queriedAt: now,
      reading: { kind: 'balance', entries: [{ currency: 'CNY', remaining: 0 }] },
    },
  }
  const emptyNote = logic.forecastNotes(emptyBalanceAccount, {
    balance: { points: [{ t: now - 7 * DAY, v: 10 }, { t: now, v: 5 }] },
  }, now)
  assert.equal(emptyNote.kind, 'info')
  assert.match(emptyNote.text, /余额已耗尽/)
})

test('摘要:最新/均值/最低/最高/总变化按数值返回', () => {
  const summary = logic.summaryOf([{ t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 3 }])
  assert.deepEqual(summary, { latest: 3, avg: 2, min: 1, max: 3, totalChange: 2 })
})

test('CSV 导出:表头、首行空差值、后续行差值与列转义', () => {
  const csv = logic.buildTrendCsv([
    { t: Date.UTC(2026, 10, 15, 10, 0, 0), v: 46 },
    { t: Date.UTC(2026, 10, 15, 11, 0, 0), v: 47.5 },
  ], { kind: 'pct' })
  const lines = csv.split('\r\n')
  assert.equal(lines[0], '"采样时间","数值","较前值"')
  assert.equal(lines[1].split(',').slice(1).join(','), '"46%",""')
  assert.equal(lines[2].split(',').slice(1).join(','), '"47.5%","+1.5%"')
  assert.equal(lines[1].split(',')[0].startsWith('"') && lines[1].split(',')[0].endsWith('"'), true)
})
