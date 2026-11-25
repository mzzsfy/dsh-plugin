// 第五轮深审 R5-stock: C4(本地偏好写失败/跨页同步)、C5(图表脚本超时与全局校验)、P1(undici 依赖)。
// 与 review-fixes 同一套 vm+真 React 加载器, 额外提供 localStorage/Event 以便直接验证偏好封装。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

async function loadPlugin() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const clock = createTestClock()
  const listeners = new Map()
  const dispatched = []
  const window = {
    __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]) },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)) },
    dispatchEvent(event) { dispatched.push(event.type); for (const fn of [...(listeners.get(event.type) || [])]) fn(event); return true },
  }
  const store = new Map()
  const localStorage = {
    fail: false,
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { if (localStorage.fail) throw new Error('quota'); store.set(key, value) },
  }
  class FakeEvent { constructor(type) { this.type = type } }
  vm.runInNewContext(source, {
    window, console, AbortController, URLSearchParams, crypto: globalThis.crypto,
    fetch: globalThis.fetch, localStorage, Event: FakeEvent,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  })
  return { plugin, clock, window, listeners, dispatched, store, localStorage }
}

// 与 client-edge 同款测试时钟: 只推进显式 advance, 超时用例不真等 10s
function createTestClock() {
  let now = 0, seq = 0
  const pending = new Map()
  const set = kind => (fn, ms = 0, ...rest) => {
    if (ms === 0) return setImmediate(() => fn(...rest))
    const id = ++seq
    pending.set(id, { kind, fn, at: now + ms, ms, rest })
    return id
  }
  const clear = id => pending.delete(id)
  const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)) }
  async function advance(step) {
    now += step
    for (;;) {
      await drain()
      const due = [...pending].filter(([, timer]) => timer.at <= now).sort((a, b) => (a[1].at - b[1].at) || (a[0] - b[0]))
      if (!due.length) return
      for (const [id, timer] of due) {
        if (!pending.has(id)) continue
        pending.delete(id)
        timer.fn(...timer.rest)
      }
    }
  }
  return { setTimeout: set('timeout'), clearTimeout: clear, setInterval: set('interval'), clearInterval: clear, advance }
}

const fakeDoc = () => {
  const doc = {
    scripts: [],
    querySelector() { return this.scripts.find(script => script.dataset.lwc) || null },
    createElement() {
      const script = { dataset: {}, onload: null, onerror: null, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }, remove() { doc.scripts = doc.scripts.filter(other => other !== script) } }
      return script
    },
    head: { appendChild(script) { doc.scripts.push(script) } },
  }
  return doc
}
const fire = (window, type, props = {}) => window.dispatchEvent(Object.assign({ type }, props))

const pageState = () => ({ view: { view: 'list', query: '', selectedId: null, sort: 'manual', focusId: null, menuOpen: false, overlay: null, notice: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', errorKey: '', dataError: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {}, providers: [], routes: [] }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: true } })
const pageRuntime = state => ({ getSnapshot: () => state, subscribe: () => () => {}, updateView() {}, refresh() {}, clearError() {}, clearDataError() {}, mutate: async () => {}, loadBrowse: async () => {}, search() {}, setPaused() {} })

// C4: setItem 抛错(隐私模式/配额满)时不能广播"已生效", 且必须有可见提示
test('C4 本地偏好写失败不广播, 页面横幅可见, 恢复后可写', async () => {
  const { plugin, localStorage, dispatched } = await loadPlugin()
  localStorage.fail = true
  assert.equal(plugin.__testing.writePref('ssb-guides', { ma: true }), false, '失败必须如实返回')
  assert.deepEqual(dispatched, [], '写失败不得广播成功事件')
  assert.equal(plugin.__testing.readPref('ssb-guides', { ma: false }).ma, false, '失败时内存/存储都不得出现新值')
  const failed = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: pageRuntime(pageState()), layout: {} }))
  assert.match(failed, /浏览器本地存储不可用，显示偏好未能保存/, '失败必须让用户看见')
  localStorage.fail = false
  assert.equal(plugin.__testing.writePref('ssb-guides', { ma: false }), true)
  assert.deepEqual(dispatched, ['ssb:ssb-guides'], '成功才广播')
  const recovered = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: pageRuntime(pageState()), layout: {} }))
  assert.doesNotMatch(recovered, /浏览器本地存储不可用/)
})

// C4: 跨标签页靠 storage 事件回读同一份本地真源, 同页仍走自定义事件
test('C4 storage 事件按 key 跨页同步, 卸载时摘监听', async () => {
  const { plugin, window, listeners, store } = await loadPlugin()
  const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(client, /React\.useEffect\(\(\) => subscribePref\(key, window,/, 'usePref 必须真的订阅 storage, 不能只导出辅助函数')
  const seen = []
  const off = plugin.__testing.subscribePref('ssb-guides', window, () => seen.push(plugin.__testing.readPref('ssb-guides', { ma: false }).ma))
  store.set('ssb-guides', JSON.stringify({ ma: true }))
  fire(window, 'ssb:ssb-guides')
  fire(window, 'storage', { key: 'ssb-guides' })
  fire(window, 'storage', { key: 'ssb-other' })
  assert.deepEqual(seen, [true, true], '同页事件与同 key 的 storage 事件都要回读真源, 别的 key 不触发')
  assert.equal((listeners.get('storage') || []).length, 1)
  off()
  assert.equal((listeners.get('storage') || []).length, 0, '卸载必须摘掉 storage 监听')
  assert.equal((listeners.get('ssb:ssb-guides') || []).length, 0)
})

// C5: load 悬挂不能永久 pending; 超时要移除脚本并清单例, 下一次详情能重建
test('C5 图表脚本加载超时后清单例并移除脚本, 下一次可重试', async () => {
  const { plugin, clock, window } = await loadPlugin()
  const doc = fakeDoc()
  const first = plugin.__testing.ensureLwc(doc)
  const rejection = assert.rejects(first, /图表组件加载超时/)
  assert.equal(doc.scripts.length, 1)
  await clock.advance(plugin.__testing.LWC_LOAD_TIMEOUT_MS)
  await rejection
  assert.equal(doc.scripts.length, 0, '超时脚本必须移除, 不能留坏脚本继续等事件')
  const second = plugin.__testing.ensureLwc(doc)
  assert.equal(doc.scripts.length, 1, '单例已清空, 第二次必须重建脚本')
  window.LightweightCharts = { createChart() {} }
  doc.scripts[0].onload()
  assert.equal(await second, window.LightweightCharts)
})

// C5: onload 只证明脚本执行完, 必须校验全局真的可用; 否则会把 undefined 缓存成成功
test('C5 onload 后校验全局, 缺失时失败并可重建', async () => {
  const { plugin, window } = await loadPlugin()
  const doc = fakeDoc()
  const first = plugin.__testing.ensureLwc(doc)
  const rejection = assert.rejects(first, /图表组件不可用/)
  doc.scripts[0].onload()
  await rejection
  assert.equal(doc.scripts.length, 0, '加载完却没有全局, 脚本必须移除')
  const second = plugin.__testing.ensureLwc(doc)
  assert.equal(doc.scripts.length, 1, '不得缓存 resolved-undefined')
  window.LightweightCharts = { createChart() {} }
  doc.scripts[0].onload()
  assert.equal(await second, window.LightweightCharts)
})

// C5: 只重拉数据不会重建空白图座, 重试必须同时重跑建图 effect
test('C5 建图失败后的重试会重跑建图 effect', async () => {
  const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(client, /setChartError\(null\); if \(!chartRef\.current\) setChartAttempt\(n => n \+ 1\)/, '重试按钮先清错误, 没有图实例时递增建图计数')
  assert.match(client, /\}, \[chartAttempt\]\)/, '建图 effect 依赖建图计数')
})

// P1: application 动态 import undici 做代理出口, 包必须声明依赖, 否则隔离安装会静默直连
test('P1 undici 作为运行依赖声明, 代理出口可解析', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies.undici, '^8.12.3', '缺依赖时 import(undici) 失败, 代理会静默降级直连')
  const application = await readFile(new URL('../src/application.mjs', import.meta.url), 'utf8')
  assert.match(application, /await import\('undici'\)/, '代理工厂仍按需加载 undici')
  await assert.doesNotReject(import('undici'), '当前工作树必须能解析到 undici')
})
