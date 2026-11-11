import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 标记价提醒: 现价穿越成本/卖价时叫人一次。
// 场景:
//   Given 卖价标记在 20.00, 价格从 19.50 涨到 20.10
//   When 判定
//   Then 触发一次; 再涨到 20.50 不重复; 回落到 20.01 也不算重新武装(滞回带)
//   Given 没有通知插件
//   Then 走本卡闪烁 + 标题闪烁 + 有权限的系统通知
async function loadClient() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return { plugin, store }
}

const T0 = Date.parse('2026-11-09T02:00:00Z')
const target = { id: 'm1', kind: 'target', price: 20 }
const cost = { id: 'm2', kind: 'cost', price: 10 }

test('卖价上穿只触发一次, 滞回带内不重新武装', async () => {
  const { markAlertOf } = (await loadClient()).plugin.__testing
  const first = markAlertOf({ mark: target, price: 19.5, prev: undefined, now: T0 })
  assert.deepEqual([first.side, first.fire], ['safe', false], '还在下方, 只记录状态')
  const cross = markAlertOf({ mark: target, price: 20.1, prev: 'safe', now: T0 })
  assert.deepEqual([cross.side, cross.fire], ['hit', true], '上穿即触发')
  const again = markAlertOf({ mark: target, price: 20.5, prev: 'hit', now: T0 })
  assert.equal(again.fire, false, '继续在上方不重复')
  const inBand = markAlertOf({ mark: target, price: 19.95, prev: 'hit', now: T0 })
  assert.deepEqual([inBand.side, inBand.fire], ['hit', false], '跌回标记下方但没离开滞回带, 不算重新武装')
  const back = markAlertOf({ mark: target, price: 19.8, prev: 'hit', now: T0 })
  assert.equal(back.side, 'safe', '跌出滞回带才重新武装')
  const recross = markAlertOf({ mark: target, price: 20.2, prev: 'safe', now: T0 })
  assert.equal(recross.fire, true, '冷却之外再次穿越可以再提醒')
})

test('成本跌破方向相反', async () => {
  const { markAlertOf } = (await loadClient()).plugin.__testing
  assert.equal(markAlertOf({ mark: cost, price: 10.2, prev: 'safe', now: T0 }).fire, false, '还在成本上方')
  assert.equal(markAlertOf({ mark: cost, price: 9.9, prev: 'safe', now: T0 }).fire, true, '跌破成本触发')
  assert.equal(markAlertOf({ mark: cost, price: 9.5, prev: 'hit', now: T0 }).fire, false, '继续下跌不重复')
})

test('首次打开时价格已在触发侧也要提醒', async () => {
  const { markAlertOf } = (await loadClient()).plugin.__testing
  assert.equal(markAlertOf({ mark: target, price: 21, prev: undefined, now: T0 }).fire, true, '不提醒等于错过已经发生的事')
})

test('冷却期内不重复, 冷却后回到安全侧再触发', async () => {
  const { markAlertOf } = (await loadClient()).plugin.__testing
  const fired = markAlertOf({ mark: target, price: 20.1, prev: 'safe', now: T0, lastFiredAt: T0 - 60 * 1000 })
  assert.equal(fired.fire, false, '一分钟内不重复叫人')
  const later = markAlertOf({ mark: target, price: 20.1, prev: 'safe', now: T0 + 6 * 60 * 1000, lastFiredAt: T0 })
  assert.equal(later.fire, true, '冷却结束后重新穿越可以提醒')
})

test('文案给出名称、现价、越过的标记与幅度', async () => {
  const { markAlertText } = (await loadClient()).plugin.__testing
  // vm 上下文的对象原型与宿主不同, 逐字段比较, 不整对象 deepEqual
  const text = markAlertText({ name: '贵州茅台', price: 1428, mark: { kind: 'target', price: 1400 }, scale: 2 })
  assert.equal(text.title, '行情提醒 · 贵州茅台')
  assert.equal(text.body, '贵州茅台 现价 1428.00，达到卖价 1400.00（+2.00%）')
  const costText = markAlertText({ name: '甲股', price: 9.5, mark: { kind: 'cost', price: 10 }, scale: 2 })
  assert.match(costText.body, /跌破成本 10\.00（-5\.00%）/)
})

test('有通知插件时全权交给它, 没有才降级闪烁与系统通知', async () => {
  const { deliverMarkAlert } = (await loadClient()).plugin.__testing
  const alert = { title: '行情提醒 · 甲股', body: '甲股 现价 9.50，跌破成本 10.00' }
  const calls = []
  const hub = { version: 1, notify: input => { calls.push(input); return { delivered: ['toast'] } } }
  const bridged = deliverMarkAlert({ alert, key: 'k', hub, blink: () => calls.push('blink'), flash: () => calls.push('flash'), notify: () => { calls.push('notify'); return true } })
  assert.equal(bridged.via, 'bridge')
  assert.equal(bridged.delivered.join(), 'toast')
  assert.equal(calls.length, 1, '装了通知插件就不越权自己闪或弹')
  assert.equal(calls[0].key, 'k')
  assert.equal(calls[0].title, alert.title)
  assert.equal(calls[0].body, alert.body)

  const local = []
  const result = deliverMarkAlert({ alert, key: 'k', hub: null, blink: () => local.push('blink'), flash: () => local.push('flash'), notify: () => { local.push('notify'); return true } })
  assert.deepEqual(local, ['blink', 'flash', 'notify'], '没装通知插件时闪卡片、闪标题, 有权限再弹通知')
  assert.equal(result.via, 'local')
  assert.equal(result.delivered.join(), 'notification')
  const silent = deliverMarkAlert({ alert, key: 'k', hub: null, blink() {}, flash() {}, notify: () => false })
  assert.equal(silent.delivered.length, 0, '没有通知权限就只留闪烁')
})

// ---- 渲染接线: 铃铛是开关, 默认关 ----
const item = (id, name, code, marks) => ({ id, officialName: name, code, exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false, marks })
const stock = item('XSHG:equity:600519', '贵州茅台', '600519', [{ id: 'm1', kind: 'target', price: 1400 }])
const stateWith = quotes => ({ view: {}, busy: {}, data: { control: { revision: 1, watchlist: { order: [stock.id], items: { [stock.id]: stock } }, preferences: { refreshSeconds: 15, colorMode: 'red-up' } }, quotes } })
const runtimeStub = state => ({ getSnapshot: () => state, subscribe: () => () => {}, openDetail() {} })
const renderFloat = async (state, alertOn = false) => {
  const { plugin, store } = await loadClient()
  store.set('ssb-floating', JSON.stringify({ ids: [stock.id], live: true, open: true, mode: 'list' }))
  if (alertOn) store.set('ssb-float-alert', JSON.stringify({ on: true }))
  return { html: renderToStaticMarkup(React.createElement(plugin.__testing.FloatingTicker, { runtime: runtimeStub(state) })), store }
}
const quotes = { [stock.id]: { quote: { last: '1428.00', receivedAt: Date.now() } } }

const bellFill = html => (html.match(/ssb-float-bell[^>]*>\s*<svg[^>]*fill="([A-Za-z]+)"/) || [])[1]

test('刷新开关是图标按钮, 形状表示点下去会发生什么', async () => {
  const { html } = await renderFloat(stateWith(quotes))
  const liveButton = html => (html.match(/<button[^>]*class="ssb-float-icon ssb-float-live[^"]*"[^>]*>[\s\S]*?<\/button>/) || [''])[0]
  const running = liveButton(html)
  assert.match(running, /aria-label="暂停自动刷新"/, '正在刷新时给暂停动作')
  assert.match(running, /<rect /, '暂停图标是两条竖条')
  assert.match(running, /title="行情每 10 秒自动刷新，点击暂停"/, '悬停说明含义与默认间隔')

  const { plugin, store } = await loadClient()
  store.set('ssb-floating', JSON.stringify({ ids: [stock.id], open: true, mode: 'list', live: false }))
  const pausedHtml = renderToStaticMarkup(React.createElement(plugin.__testing.FloatingTicker, { runtime: runtimeStub(stateWith(quotes)) }))
  const paused = liveButton(pausedHtml)
  assert.match(paused, /aria-label="恢复自动刷新"/, '暂停后给恢复动作')
  assert.match(paused, /<path d="M5\.2 3\.2/, '恢复图标是播放三角')
  assert.match(paused, /title="自动刷新已暂停，点击恢复"/)
  assert.match(pausedHtml, /title="打开 贵州茅台 详情"/, '底部详情图标给出悬停提示, 不靠猜')
})

test('桥接版本不符或抛错时退回本地降级, 不能静默丢失', async () => {
  const { plugin } = await loadClient()
  const { deliverMarkAlert } = plugin.__testing
  const alert = { title: '行情提醒', body: '现价 10.00' }
  const local = []
  const viaLocal = hub => deliverMarkAlert({ alert, key: 'k', hub, blink: () => local.push('blink'), flash: () => local.push('flash'), notify: () => false })
  const old = { version: 2, notify: () => ({ delivered: ['toast'] }) }
  assert.equal(viaLocal(old).via, 'local', '版本不符说明接口不可信')
  const broken = { version: 1, notify: () => { throw new Error('boom') } }
  assert.equal(viaLocal(broken).via, 'local', '桥接抛错要自己兜住')
  assert.equal(local.length, 4, '两次都走了闪烁与高亮')
  const muted = { version: 1, notify: () => ({ delivered: [] }) }
  assert.deepEqual({ ...viaLocal(muted) }, { via: 'bridge', delivered: [] }, '通道被用户关掉时不算失败, 也不绕过')
  assert.equal(local.length, 4, '尊重设置, 不额外闪本地')
})

test('没有成交价时不提醒, 不能把 null 当成 0 跌破成本', async () => {
  const { plugin } = await loadClient()
  const { markAlertOf } = plugin.__testing
  const mark = { id: 'm1', kind: 'cost', price: 100 }
  const verdict = markAlertOf({ mark, price: NaN, prev: 'safe', lastFiredAt: null, now: 1 })
  assert.equal(verdict.fire, false, '停牌无 last 时不能 fire')
  assert.equal(verdict.side, 'safe', '也不能把状态改写成 hit')
})

test('标题与列表行都用小号淡字标出股票代码', async () => {
  const { html: list } = await renderFloat(stateWith(quotes))
  assert.match(list, /class="ssb-float-code"[^>]*>600519/, '列表行带代码')
  const { plugin, store } = await loadClient()
  store.set('ssb-floating', JSON.stringify({ ids: [stock.id], open: true, mode: 'kline', securityId: stock.id }))
  const kline = renderToStaticMarkup(React.createElement(plugin.__testing.FloatingTicker, { runtime: runtimeStub(stateWith(quotes)) }))
  assert.match(kline, /class="ssb-float-code"[^>]*>600519/, '标题带代码')
})

test('图模式在曲线下方常驻一行标记价, 不必悬停', async () => {
  const { plugin, store } = await loadClient()
  store.set('ssb-floating', JSON.stringify({ ids: [stock.id], open: true, mode: 'kline' }))
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.FloatingTicker, { runtime: runtimeStub(stateWith(quotes)) }))
  assert.match(html, /class="ssb-float-marks"/, '标记价清单常驻')
  assert.match(html, /ssb-legend-target[^>]*>卖价 1400\.00/, '用图表色板的卖价色标出')
})

test('铃铛是悬浮窗上的开关, 默认空心、开启填实', async () => {
  const { html, store } = await renderFloat(stateWith(quotes))
  assert.match(html, /class="ssb-float-icon ssb-float-bell/, '铃铛常驻底部')
  assert.match(html, /aria-pressed="false"/, '默认关闭')
  assert.match(html, /开启标记价提醒/, '关闭态给出开启动作')
  assert.equal(bellFill(html), 'none', '关闭态是空心轮廓')
  assert.equal(store.get('ssb-float-alert'), undefined, '渲染不改写偏好')
  const { html: onHtml } = await renderFloat(stateWith(quotes), true)
  assert.match(onHtml, /ssb-float-bell on/, '开启态由偏好驱动')
  assert.match(onHtml, /关闭标记价提醒/)
  assert.equal(bellFill(onHtml), 'currentColor', '开启态填实')
})
