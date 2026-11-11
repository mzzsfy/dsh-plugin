// 悬浮定位纯函数:指针锚定(偏移 14px、越界翻侧、夹取、无箭头)与元素锚定(键盘聚焦兜底)、
// 箭头贴边夹取。与 client.js 同源求值,不依赖 DOM。
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const VIEWPORT = { left: 0, top: 0, right: 1200, bottom: 800 }
const TIP = { width: 200, height: 100 }

test('上方空间充足:提示放元素上方,水平居中对齐', () => {
  const anchor = { left: 500, top: 400, width: 80, height: 40 }
  const out = core.tipPlacement(anchor, TIP, VIEWPORT)
  assert.equal(out.side, 'top')
  assert.equal(out.left, 440)
  assert.equal(out.top, 400 - 8 - 100)
  assert.equal(out.arrowX, 100)
})

test('上方空间不足:翻到元素下方', () => {
  const anchor = { left: 500, top: 40, width: 80, height: 40 }
  const out = core.tipPlacement(anchor, TIP, VIEWPORT)
  assert.equal(out.side, 'bottom')
  assert.equal(out.top, 40 + 40 + 8)
})

test('下方空间不足且上方充足:偏好下方时仍上翻', () => {
  const anchor = { left: 500, top: 700, width: 80, height: 40 }
  const out = core.tipPlacement(anchor, TIP, VIEWPORT, { prefer: 'bottom' })
  assert.equal(out.side, 'top')
})

test('两侧都放不下:取空间大的一侧并夹取到边界内', () => {
  const tall = { width: 200, height: 700 }
  const anchor = { left: 100, top: 60, width: 80, height: 40 }
  const out = core.tipPlacement(anchor, tall, VIEWPORT)
  assert.equal(out.side, 'bottom')
  assert.ok(out.top >= 8 && out.top + tall.height <= 800 - 8 + 0.001)
})

test('水平越界:左缘夹取,箭头贴到圆角内侧', () => {
  const anchor = { left: 4, top: 400, width: 40, height: 20 }
  const out = core.tipPlacement(anchor, TIP, VIEWPORT)
  assert.equal(out.left, 8)
  assert.equal(out.arrowX, 16)
})

test('水平越界:右缘夹取,箭头贴到右圆角内侧', () => {
  const anchor = { left: 1180, top: 400, width: 20, height: 20 }
  const out = core.tipPlacement(anchor, TIP, VIEWPORT)
  assert.equal(out.left, 1200 - 8 - 200)
  assert.equal(out.arrowX, 188)
})

test('锚点或尺寸缺失/零值时返回 null', () => {
  assert.equal(core.tipPlacement(null, TIP, VIEWPORT), null)
  assert.equal(core.tipPlacement({ left: 0, top: 0, width: 0, height: 0 }, TIP, VIEWPORT), null)
  assert.equal(core.tipPlacement({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 }, VIEWPORT), null)
})

test('tipAnchorRect:取目标元素矩形,不用指针坐标', () => {
  const rect = { left: 100, top: 200, width: 60, height: 30 }
  const event = {
    clientX: 999,
    clientY: 888,
    currentTarget: { getBoundingClientRect: () => rect },
  }
  assert.deepEqual(core.tipAnchorRect(event), rect)
})

test('tipAnchorRect:无元素时返回 null,焦点事件同样可用', () => {
  assert.equal(core.tipAnchorRect(null), null)
  const rect = { left: 10, top: 20, width: 30, height: 40 }
  const focusEvent = { currentTarget: { getBoundingClientRect: () => rect } }
  assert.deepEqual(core.tipAnchorRect(focusEvent), rect)
})

test('指针锚点:右下空位充足时放在指针右下方并偏移', () => {
  const out = core.tipPlacement({ kind: 'point', x: 100, y: 200 }, TIP, VIEWPORT)
  assert.equal(out.side, 'bottom')
  assert.equal(out.left, 100 + 14)
  assert.equal(out.top, 200 + 14)
  assert.equal(out.arrowX, null)
})

test('指针锚点:右侧放不下翻到左侧', () => {
  const out = core.tipPlacement({ kind: 'point', x: 1100, y: 200 }, TIP, VIEWPORT)
  assert.equal(out.left, 1100 - 14 - 200)
  assert.ok(out.left >= 8)
})

test('指针锚点:下方放不下翻到上方', () => {
  const out = core.tipPlacement({ kind: 'point', x: 100, y: 750 }, TIP, VIEWPORT)
  assert.equal(out.side, 'top')
  assert.equal(out.top, 750 - 14 - 100)
})

test('指针锚点:右下双越界时两轴都翻转', () => {
  const out = core.tipPlacement({ kind: 'point', x: 1180, y: 780 }, TIP, VIEWPORT)
  assert.equal(out.side, 'top')
  assert.equal(out.left, 1180 - 14 - 200)
  assert.equal(out.top, 780 - 14 - 100)
})

test('指针锚点:右侧放不下且左侧放得下时翻到左侧', () => {
  const narrow = { left: 0, top: 0, right: 300, bottom: 800 }
  const out = core.tipPlacement({ kind: 'point', x: 280, y: 100 }, TIP, narrow)
  assert.equal(out.left, 280 - 14 - 200)
  assert.ok(out.left >= 8 && out.left + 200 <= 300 - 8)
})

test('tipAnchor:鼠标事件取指针坐标,键盘事件回落元素矩形', () => {
  const mouse = { clientX: 120, clientY: 340, currentTarget: { getBoundingClientRect: () => ({ left: 1, top: 2, width: 3, height: 4 }) } }
  assert.deepEqual(core.tipAnchor(mouse), { kind: 'point', x: 120, y: 340 })
  const keyboard = { currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 30, height: 40 }) } }
  assert.deepEqual(core.tipAnchor(keyboard), { kind: 'rect', left: 10, top: 20, width: 30, height: 40 })
  assert.equal(core.tipAnchor(null), null)
})
