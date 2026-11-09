import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'

// K线十字线读数:
//   Given 日K/分时图
//   When 鼠标移到某根上
//   Then 浮层给出那根的时间、开高低收、涨跌与量
async function load() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return plugin.__testing
}

test('K线悬停读出给出开高低收、涨跌与量', async () => {
  const { crosshairTipLines, crosshairTimeText } = await load()
  const lines = crosshairTipLines({ candle: { open: 3800, high: 3900, low: 3790, close: 3880, volume: 1e8 }, scale: 2, preClose: 3800 })
  assert.deepEqual([...lines], ['开 3800.00　高 3900.00', '低 3790.00　收 3880.00', '+2.11%　量 1.0亿'])
  assert.equal(crosshairTimeText('2026-07-07', false), '2026-07-07', '日K按业务日期, 不做时区换算')
  assert.equal(crosshairTimeText({ year: 2026, month: 7, day: 7 }, false), '2026-07-07')
})

test('分时悬停只给价与涨跌, 没有成交量序列时不硬凑一行', async () => {
  const { crosshairTipLines, crosshairTimeText } = await load()
  const lines = crosshairTipLines({ candle: { value: 444.6 }, scale: 2, trend: true, preClose: 426.2, volume: null })
  assert.deepEqual([...lines], ['价 444.60', '+4.32%'])
  const withVolume = crosshairTipLines({ candle: { value: 444.6 }, scale: 2, trend: true, preClose: 426.2, volume: 1.2e4 })
  assert.deepEqual([...withVolume].slice(2), ['量 1万'], '有量时才补一行')
  assert.equal(crosshairTimeText(Date.parse('2026-11-09T02:00:00Z') / 1000, true, 'Asia/Shanghai'), '10:00', '分时按市场时区给时钟')
})

test('缺价格时读出不编造数字', async () => {
  const { crosshairTipLines } = await load()
  const lines = crosshairTipLines({ candle: { open: null, high: null, low: null, close: null }, scale: 2, preClose: null })
  assert.deepEqual([...lines], ['开 —　高 —', '低 —　收 —', '—　量 —'])
})

test('辅助线读数按开着的线成对列出', async () => {
  const { crosshairTipLines } = await load()
  const lines = crosshairTipLines({ candle: { open: 4140, high: 4160, low: 4130, close: 4150, volume: 6.5e10 }, scale: 2, preClose: 4100, series: [['MA5', 4145.5], ['MA60', 4102.25], ['BOLL上', 4200]] })
  assert.deepEqual([...lines].slice(3), ['MA5 4145.50　MA60 4102.25', 'BOLL上 4200.00'], '成对排一行, 末尾单独一条也保留')
})

test('读数浮层不越出画布', async () => {
  const { crosshairTipStyle } = await load()
  const inside = crosshairTipStyle({ point: { x: 100, y: 80 }, width: 600, height: 340 })
  assert.equal(inside.left, 114, '默认落在光标右下方')
  assert.equal(inside.top, 94)
  const corner = crosshairTipStyle({ point: { x: 590, y: 330 }, width: 600, height: 340 })
  assert.ok(corner.left + 204 <= 600, '右侧贴边时向左收')
  assert.ok(corner.top + 160 <= 340, '底部贴边时向上收')
})

test('日K每根的涨跌以它前一根收盘为基准', async () => {
  const { crosshairTipLines, timeKeyOf } = await load()
  const lines = crosshairTipLines({ candle: { open: 4140, high: 4160, low: 4130, close: 4150, volume: 6.5e10 }, scale: 2, preClose: 4100 })
  assert.equal(lines[2], '+1.22%　量 650.0亿', '相对前收 4100 而不是当日昨收')
  assert.equal(timeKeyOf({ year: 2026, month: 5, day: 26 }), '2026-5-26', 'BusinessDay 拍平成可比较的键')
  assert.equal(timeKeyOf('2026-05-26'), '2026-05-26')
})
