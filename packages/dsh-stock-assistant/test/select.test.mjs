import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 只测渲染与纯函数, 不推进定时器: 真实定时器就够
async function load() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return plugin
}
const rect = (left, top, width = 80, height = 32) => ({ left, top, bottom: top + height, width, height })

test('下拉定位: 下方空间足够时向下弹', async () => {
  const { dropdownPlacement } = (await load()).__testing
  const place = dropdownPlacement(rect(120, 200), { width: 1200, height: 800 }, 4)
  assert.equal(place.left, 120)
  assert.equal(place.top, 236)
  assert.equal(place.minWidth, 80)
  assert.equal(place.maxHeight, 4 * 28 + 8)
})

test('下拉定位: 下方不足且上方更宽裕时向上弹', async () => {
  const { dropdownPlacement } = (await load()).__testing
  const place = dropdownPlacement(rect(120, 740), { width: 1200, height: 800 }, 6)
  assert.equal(place.top, 740 - 4 - 176)
  assert.equal(place.maxHeight, 176)
})

test('下拉定位: 左右贴边时夹在视口内', async () => {
  const { dropdownPlacement } = (await load()).__testing
  assert.equal(dropdownPlacement(rect(560, 100), { width: 600, height: 800 }, 3).left, 600 - 80 - 8)
  assert.equal(dropdownPlacement(rect(-20, 100), { width: 600, height: 800 }, 3).left, 8)
})

test('下拉结构: combobox 关联 listbox, 选项常驻 DOM 且只标当前值', async () => {
  const { Select } = (await load()).__testing
  const html = renderToStaticMarkup(React.createElement(Select, { value: 5, label: '悬浮盯盘刷新', options: [3, 5, 10, 30].map(n => ({ value: n, label: `${n}秒` })), onChange: () => {} }))
  assert.match(html, /role="combobox"/)
  assert.match(html, /aria-haspopup="listbox"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /aria-controls="[^"]+"/)
  assert.match(html, /role="listbox"/)
  assert.match(html, /hidden=""/, '未打开时菜单隐藏')
  for (const n of [3, 5, 10, 30]) assert.ok(html.includes(`>${n}秒</div>`), `含 ${n} 秒选项`)
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, '仅当前值选中')
  assert.match(html, />5秒<\/span>/, '触发器显示当前值')
})

test('下拉结构: 禁用时触发器 disabled', async () => {
  const { Select } = (await load()).__testing
  const html = renderToStaticMarkup(React.createElement(Select, { value: 'a', disabled: true, label: '适配器', options: [{ value: 'a', label: 'A' }], onChange: () => {} }))
  assert.match(html, /<button[^>]*disabled=""/)
})
