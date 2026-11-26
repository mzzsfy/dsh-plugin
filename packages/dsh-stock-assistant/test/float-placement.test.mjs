import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 悬浮窗的屏内约束:
//   Given 拖动落点写在 localStorage 的绝对坐标
//   When 浏览器视口缩小 / 页面缩放, 或卡片因换模式长高
//   Then 整张卡仍完整落在视口内, 且保存的坐标不被改写
//   When 视口放大回原尺寸
//   Then 卡片回到用户拖到的位置
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

function loadClient(viewportSize = null) {
  let plugin
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const document = viewportSize ? { documentElement: { clientWidth: viewportSize.width, clientHeight: viewportSize.height } } : undefined
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, document, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return { ...plugin.__testing, __store: store }
}

const { clampFloatPlacement, FLOAT_MARGIN, FLOAT_WIDTH, FLOAT_HEIGHT } = loadClient()
const viewport = { width: 1280, height: 900 }
const card = { width: FLOAT_WIDTH, height: FLOAT_HEIGHT }

// 用户可见契约: 边距 8px、卡宽 288px, 且与样式里的宽度/锚定同源; 期望值写死, 不用实现常量自算
test('夹取口径与样式声明一致', () => {
  assert.equal(FLOAT_MARGIN, 8)
  assert.equal(FLOAT_WIDTH, 288)
  assert.equal(FLOAT_HEIGHT, 210)
  assert.match(source, /.ssb-float {[^}]*right:24px; bottom:24px/, '无坐标时靠样式锚在右下角')
  assert.match(source, /.ssb-float {[^}]*width:288px/, '默认宽度与 FLOAT_WIDTH 同源')
})

test('保存坐标在视口内时原样放置', () => {
  assert.deepEqual({ ...clampFloatPlacement({ ...card, viewport, x: 100, y: 80 }) }, { x: 100, y: 80 })
  // 贴边也算合法: 右下正好留出一个边距时不移动
  const x = viewport.width - card.width - FLOAT_MARGIN, y = viewport.height - card.height - FLOAT_MARGIN
  assert.deepEqual({ ...clampFloatPlacement({ ...card, viewport, x, y }) }, { x, y })
})

test('视口缩小到保存坐标之外时收回右下边距内', () => {
  const placed = clampFloatPlacement({ ...card, viewport: { width: 700, height: 520 }, x: 980, y: 640 })
  assert.deepEqual({ ...placed }, { x: 404, y: 302 }, '700-288-8 / 520-210-8')
})

test('只有一边越界时另一边保持不动', () => {
  const placed = clampFloatPlacement({ ...card, viewport, x: 10, y: 5000 })
  assert.equal(placed.x, 10)
  assert.equal(placed.y, 682, '900-210-8')
})

test('卡片长高后按实际高度上移, 不是按旧高度', () => {
  const tall = { width: card.width, height: 400 }
  assert.equal(clampFloatPlacement({ ...tall, viewport, x: 100, y: 640 }).y, 492, '900-400-8')
})

test('卡片比视口还大时贴左上边距, 保留左上角可见', () => {
  assert.deepEqual({ ...clampFloatPlacement({ width: 900, height: 800, viewport: { width: 640, height: 480 }, x: 0, y: 0 }) }, { x: 8, y: 8 })
})

test('视口比卡片还窄时收到边距, 不出现负坐标', () => {
  assert.deepEqual({ ...clampFloatPlacement({ ...card, viewport: { width: 1, height: 1 }, x: 500, y: 500 }) }, { x: 8, y: 8 })
})


// 页面缩放的夹取契约: CSS zoom / transform 不改布局视口(clientWidth 恒为 1280), 只放大视觉尺寸。
// 期望值写死为字面量: 缩放 1.5 时卡宽视觉 432、高 315、边距 12。
test('缩放后按视觉尺寸夹取, 再换算回布局坐标', () => {
  const placed = clampFloatPlacement({ ...card, viewport, scale: 1.5, x: 5000, y: 5000 })
  // 布局坐标 = (视口 - 卡片视觉尺寸 - 视觉边距) / 缩放: (1280-432-12)/1.5 与 (900-315-12)/1.5
  assert.equal(Number(placed.x.toFixed(2)), 557.33)
  assert.equal(Number(placed.y.toFixed(2)), 382)
  assert.equal(placed.x * 1.5 + card.width * 1.5, 1268, '视觉右缘留 12px 边距')
  assert.equal(placed.y * 1.5 + card.height * 1.5, 888, '视觉下缘留 12px 边距')
})

test('缩放前就在屏内的坐标不被缩放误夹', () => {
  assert.deepEqual({ ...clampFloatPlacement({ ...card, viewport, scale: 1.5, x: 100, y: 80 }) }, { x: 100, y: 80 })
})

test('缩小到 0.8 不越界时保持原样', () => {
  assert.deepEqual({ ...clampFloatPlacement({ ...card, viewport, scale: 0.8, x: 900, y: 600 }) }, { x: 900, y: 600 })
})

test('缩放后卡片视觉尺寸超过视口时贴左上边距', () => {
  const placed = clampFloatPlacement({ width: 900, height: 800, viewport: { width: 640, height: 480 }, scale: 1.5, x: 0, y: 0 })
  assert.deepEqual({ ...placed }, { x: 8, y: 8 }, '视觉边距 12 换算回布局坐标仍是 8')
})

test('缩放比为 1 时与未缩放完全同值', () => {
  const args = { ...card, viewport, x: 5000, y: 5000 }
  assert.deepEqual({ ...clampFloatPlacement({ ...args, scale: 1 }) }, { ...clampFloatPlacement(args) })
  assert.deepEqual({ ...clampFloatPlacement({ ...args, scale: 1 }) }, { x: 984, y: 682 }, '1280-288-8 / 900-210-8')
})

// 渲染侧接线: 夹取必须落在组件真正写出的样式上, 纯函数对而组件没接等于没修
const item = { id: 'XSHG:equity:600001', exchange: 'XSHG', code: '600001', officialName: '标的1', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
const state = {
  view: {},
  busy: {},
  data: {
    control: { revision: 1, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: { refreshSeconds: 15, colorMode: 'red-up', floatRefreshSeconds: 10 } },
    quotes: {},
  },
}
const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, subscribeTrend: () => () => {}, trendRevision: () => 0, trendContext: () => 'test', getTrend: () => null, openDetail() {} }
const positionOf = html => {
  const tag = /<div[^>]*role="complementary"[^>]*>/.exec(html)?.[0] || ''
  return /style="([^"]*)"/.exec(tag)?.[1] || ''
}
function renderFloat(pref) {
  const { FloatingTicker, __store: store } = loadClient(viewport)
  store.set('ssb-floating', JSON.stringify({ open: true, mode: 'list', ids: [item.id], ...pref }))
  return renderToStaticMarkup(React.createElement(FloatingTicker, { runtime: runtimeStub }))
}

test('组件渲染时写入夹取后的坐标', () => {
  const html = renderFloat({ x: 980, y: 640 })
  assert.match(positionOf(html), /left:980px/, '视口内原样写回')
  assert.match(positionOf(html), /top:640px/)
  // 坐标在视口外: 渲染时收回, 但本地保存值不动
  const outside = renderFloat({ x: 5000, y: 5000 })
  assert.doesNotMatch(positionOf(outside), /left:5000px/, '越界坐标不得原样渲染')
  assert.match(positionOf(outside), /left:984px/, '1280-288-8')
  assert.match(positionOf(outside), /top:682px/, '900-210-8')
})

test('坐标缺失或写坏时退回样式里的右下角锚定', () => {
  // 写坏包括非数值(字符串/对象)：JSON 里 NaN 会变成 null, 单独测字符串才覆盖到 Number.isFinite 这一支
  for (const pref of [{}, { x: null, y: null }, { x: 'abc', y: {} }]) {
    const html = renderFloat(pref)
    assert.equal(positionOf(html), '', `不给 left/top: ${JSON.stringify(pref)}`)
    assert.match(html, /role="complementary"/, '卡片仍然渲染')
  }
})

test('缩放比退化(0 或 NaN)按未缩放处理', () => {
  // 退化值会让坐标变成 Infinity/NaN 而把卡片整个弄丢: 守卫删掉这两条就红
  for (const scale of [0, Number.NaN, -1]) {
    const placed = clampFloatPlacement({ ...card, viewport, scale, x: 5000, y: 5000 })
    assert.deepEqual({ ...placed }, { x: 984, y: 682 }, `scale=${scale} 与未缩放同值`)
  }
})
