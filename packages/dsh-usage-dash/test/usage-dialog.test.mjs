import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'
const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

function fixture() {
  const label = { nodeValue: '缓存命中 80%' }
  const other = { nodeValue: '5.5K tok' }
  const value = { nodeValue: '80%' }
  const button = { aria: '5.5K tok · 缓存命中 80%', expanded: 'false', getAttribute(name) { return name === 'aria-expanded' ? this.expanded : this.aria }, setAttribute(name, v) { this.aria = v } }
  const pill = { querySelector: () => button, texts: [other, label] }
  const dock = { querySelector: () => pill }
  const anchor = { closest: () => dock }
  const dd = { texts: [value] }
  const dialog = { querySelector: () => dd }
  let dialogs = []
  let callback
  let disconnected = false
  let pending = []
  const document = { body: {}, contains: (node) => !node.detached, querySelectorAll: () => dialogs, createTreeWalker(node) { let i = 0; return { nextNode: () => node.texts[i++] ?? null } } }
  class Observer { constructor(cb) { callback = cb } observe() {} takeRecords() { const records = pending; pending = []; return records } disconnect() { disconnected = true } }
  return { label, other, value, button, anchor, dialog, document, Observer, notify: (records = []) => callback(records), setDialogs: (v) => { dialogs = v }, setPending: (v) => { pending = v }, disconnected: () => disconnected }
}

test('Given 官方命中率 When 精度增强 Then 原位替换文本及 aria，关闭时还原，不增加精度行', () => {
  const f = fixture(), seen = []
  const stop = core.observeUsageDialog(f.anchor, f.document, f.Observer, (v) => seen.push(v), '80.00')
  assert.equal(f.label.nodeValue, '缓存命中 80.00%')
  assert.equal(f.button.aria, '5.5K tok · 缓存命中 80.00%')
  assert.equal(f.other.nodeValue, '5.5K tok')
  f.button.expanded = 'true'; f.setDialogs([f.dialog]); f.notify([{ type: 'attributes', attributeName: 'aria-expanded', target: f.button }])
  assert.equal(f.value.nodeValue, '80.00%')
  f.notify()
  assert.deepEqual(seen, [null, f.dialog])
  stop()
  assert.equal(f.disconnected(), true)
  assert.equal(f.label.nodeValue, '缓存命中 80%')
  assert.equal(f.button.aria, '5.5K tok · 缓存命中 80%')
  assert.equal(f.value.nodeValue, '80%')
})

test('Given 官方重渲染和重建弹窗 When 观察变更 Then 更新读数且清理不覆盖官方新值', () => {
  const f = fixture(), seen = []
  const stop = core.observeUsageDialog(f.anchor, f.document, f.Observer, (v) => seen.push(v), '80.00')
  f.label.nodeValue = 'Cache hit 81%'; f.button.aria = '5.5K tok · Cache hit 81%'; f.notify()
  assert.equal(f.label.nodeValue, 'Cache hit 80.00%')
  f.label.nodeValue = 'Cache hit 82%'
  f.button.expanded = 'true'; f.setDialogs([f.dialog]); f.notify()
  f.setDialogs([]); f.notify()
  f.setDialogs([f.dialog]); f.notify()
  assert.deepEqual(seen, [null, f.dialog, null, f.dialog])
  f.label.nodeValue = 'Cache hit 83%'
  stop()
  assert.equal(f.label.nodeValue, 'Cache hit 83%')
  assert.equal(f.button.aria, '5.5K tok · Cache hit 81%')
})

test('Given 另一窗格用量弹窗已打开 When 本胶囊未展开 Then 不注入也不修改别窗格读数', () => {
  const f = fixture(), seen = []
  f.setDialogs([f.dialog])
  const stop = core.observeUsageDialog(f.anchor, f.document, f.Observer, (v) => seen.push(v), '80.00')
  assert.deepEqual(seen, [null])
  assert.equal(f.value.nodeValue, '80%')
  f.button.expanded = 'true'; f.setDialogs([f.dialog, {}]); f.notify()
  assert.deepEqual(seen, [null])
  stop()
})

test('Given 官方更新恰好等于增强值 When 关闭增强 Then 保留官方新值', () => {
  const f = fixture()
  f.label.nodeValue = 'Cache hit 99.999%'
  const stop = core.observeUsageDialog(f.anchor, f.document, f.Observer, () => {}, '99.99')
  f.label.nodeValue = 'Cache hit 99.99%'
  f.notify([{ type: 'characterData', target: f.label }])
  stop()
  assert.equal(f.label.nodeValue, 'Cache hit 99.99%')
})

test('Given 弹窗节点已脱离文档 When 后续更新 Then 清理不再持有或还原旧节点', () => {
  const f = fixture()
  f.button.expanded = 'true'; f.setDialogs([f.dialog])
  const stop = core.observeUsageDialog(f.anchor, f.document, f.Observer, () => {}, '80.00')
  f.value.detached = true; f.setDialogs([]); f.notify()
  stop()
  assert.equal(f.value.nodeValue, '80.00%')
})

test('Given 官方更新记录尚未投递 When 立即卸载 Then 不恢复过期值', () => {
  const f = fixture()
  f.label.nodeValue = 'Cache hit 99.999%'
  const stop = core.observeUsageDialog(f.anchor, f.document, f.Observer, () => {}, '99.99')
  f.label.nodeValue = 'Cache hit 99.99%'
  f.setPending([{ type: 'characterData', target: f.label }])
  stop()
  assert.equal(f.label.nodeValue, 'Cache hit 99.99%')
})

test('Given 精度关闭 When 弹窗出现 Then 原始读数不变但仍可定位追加合计项', () => {
  const f = fixture(), seen = []
  f.button.expanded = 'true'; f.setDialogs([f.dialog])
  const stop = core.observeUsageDialog(f.anchor, f.document, f.Observer, (v) => seen.push(v), null)
  assert.equal(f.label.nodeValue, '缓存命中 80%')
  assert.equal(f.value.nodeValue, '80%')
  assert.deepEqual(seen, [f.dialog])
  stop()
})
