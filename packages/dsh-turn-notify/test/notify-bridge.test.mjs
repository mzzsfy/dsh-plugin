import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 跨插件通知入口: 外部插件(股票盯盘)借用本插件的通道。
// 场景:
//   Given 通知插件已激活且窗口聚焦
//   When 外部插件请求一条提醒
//   Then 只发页内通知并回执 toast, 不越权弹系统通知或出声(专注静默仍生效)
//   Given 窗口失焦且系统通知已授权
//   When 外部插件请求提醒
//   Then 页内通知、声音、系统通知都按本机开关放行
//   Given 未授权
//   Then 降级为标题闪烁
class FakeStorage {
  constructor(seed) { this.map = new Map(Object.entries(seed || {})) }
  get length() { return this.map.size }
  key(index) { return Array.from(this.map.keys())[index] ?? null }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
}

function loadClient({ storage = new FakeStorage(), focused = true, permission = 'granted', notificationFail = false } = {}) {
  const raw = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  // 把标题闪烁压到毫秒级: 只改节奏常量, 分支与硬顶逻辑保持真实
  const source = raw.replace('const BLINK_MS = 1 * 1000', 'const BLINK_MS = 5').replace('const BLINK_MAX_MS = 30 * 1000', 'const BLINK_MAX_MS = 60')
  const modules = [], toasts = [], systems = []
  function Notification(title, options) {
    if (notificationFail) throw new Error('blocked')
    systems.push({ title, options })
  }
  Notification.permission = permission
  Notification.requestPermission = () => Promise.resolve('granted')
  const windowStub = { __ModuleLoader__: { load: module => modules.push(module) }, localStorage: storage, addEventListener() {}, removeEventListener() {} }
  const documentStub = {
    hasFocus: () => focused,
    hidden: !focused,
    title: 'dsh',
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
    body: { appendChild() {} },
    head: { appendChild() {} },
    documentElement: { dataset: {} },
  }
  const requireStub = name => {
    if (name === '@mzzsfy/dsh-common-tools/client') {
      return {
        createSnapshotRefresh: refresh => ({ refresh, dispose() {} }),
        toast: { show: (text, opts) => { toasts.push({ text, opts }); return toasts.length } },
        setupCommonTools: () => ({ subscribe: () => () => {}, publish() {} }),
      }
    }
    return { useState: value => [value, () => {}], useEffect() {}, useRef: value => ({ current: value }), useSyncExternalStore: () => [] }
  }
  const factory = new Function(
    'window', 'require', 'document', 'MutationObserver', 'fetch', 'Notification', 'requestAnimationFrame', 'cancelAnimationFrame', 'AbortSignal', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date',
    source + '\n;return null',
  )
  factory(windowStub, requireStub, documentStub, class { observe() {} disconnect() {} }, async () => ({ ok: true, json: async () => ({}) }), Notification, fn => setTimeout(fn, 0), id => clearTimeout(id), AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, Date)
  assert.equal(modules.length, 1, 'client.js 未被捕获')
  const mod = modules[0].factory(requireStub)
  return { mod, windowStub, documentStub, toasts, systems }
}

// 只执行桥接安装/撤销的 effect: 完整启动会拉起投影轮询与音频, 与本契约无关
function applyBridge(mod, windowStub) {
  const cleanups = []
  const ctx = {
    get: () => undefined,
    inject: () => {},
    slots: { inject: () => {} },
    effect(fn, label) { if (label === 'turn-notify external bridge') cleanups.push(fn()); return () => {} },
  }
  mod.apply(ctx)
  return () => { for (const stop of cleanups.reverse()) stop?.() }
}

test('桥接随插件生命周期挂载与撤销', () => {
  const { mod, windowStub } = loadClient()
  assert.equal(windowStub.__dshNotify, undefined, '未 apply 前不暴露')
  const release = applyBridge(mod, windowStub)
  assert.equal(windowStub.__dshNotify?.version, 1, 'apply 后暴露代数契约')
  assert.equal(typeof windowStub.__dshNotify.notify, 'function')
  release()
  assert.equal(windowStub.__dshNotify, undefined, '撤销后入口消失, 外部调用方据此退回降级线路')
})

test('聚焦时只走页内通知, 不越权出声或弹系统通知', () => {
  const { mod, toasts, systems } = loadClient({ focused: true })
  const result = mod.__test.notifyExternal({ key: 'XSHG:equity:600519|m1', title: '行情提醒 · 贵州茅台', body: '现价 1428.00，达到卖价 1400.00' })
  assert.deepEqual(result.delivered, ['toast'], '专注静默下只发页内通知')
  assert.match(toasts.at(-1).text, /行情提醒/)
  assert.match(toasts.at(-1).text, /达到卖价/, '正文随第二条呈现')
  assert.equal(systems.length, 0, '聚焦时不弹系统通知')
})

test('失焦且已授权时页内、声音与系统通知都放行', () => {
  const { mod, toasts, systems } = loadClient({ focused: false, permission: 'granted' })
  const result = mod.__test.notifyExternal({ key: 'k1', title: '行情提醒', body: '跌破成本 10.00' })
  assert.deepEqual(result.delivered, ['toast', 'sound', 'system'])
  assert.equal(toasts.length, 1)
  assert.equal(systems.length, 1)
  assert.equal(systems[0].title, '行情提醒')
  assert.equal(systems[0].options.body, '跌破成本 10.00')
})

test('未授权时降级标题闪烁', async () => {
  const { mod, documentStub } = loadClient({ focused: false, permission: 'default' })
  const result = mod.__test.notifyExternal({ key: 'k-blink', title: '行情提醒' })
  assert.ok(result.delivered.includes('blink'), '未授权走标题闪烁')
  assert.ok(!result.delivered.includes('system'))
  // 闪烁是交替前缀: 固定时刻取一次会撞上恢复的那半拍, 要在窗口内看到过前缀
  let seen = false
  for (let i = 0; i < 20 && !seen; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 3))
    seen = documentStub.title.startsWith('⏳ ')
  }
  assert.ok(seen, '标题真的开始闪烁')
  mod.__test.stopTitleBlink()
})

test('本机开关照旧约束外部提醒', () => {
  const quietStorage = new FakeStorage({ 'turn-notify:sound': '0', 'turn-notify:toast': '0' })
  const { mod, systems, toasts } = loadClient({ focused: false, permission: 'granted', storage: quietStorage })
  const result = mod.__test.notifyExternal({ key: 'k-off', title: '行情提醒' })
  assert.ok(!result.delivered.includes('sound'), '声音关掉就不出声')
  assert.ok(!result.delivered.includes('toast'), '页内通知关掉就不展示')
  assert.ok(result.delivered.includes('system'), '系统通知仍有自己的开关')
  assert.equal(toasts.length, 0)
  assert.equal(systems.length, 1)
})

test('关掉备用标题闪烁后, 未授权的外部提醒不再闪', async () => {
  const storage = new FakeStorage({ 'turn-notify:degrade-hint': '0' })
  const { mod, documentStub } = loadClient({ focused: false, permission: 'default', storage })
  const result = mod.__test.notifyExternal({ key: 'k-noblink', title: '行情提醒' })
  assert.ok(!result.delivered.includes('blink'), '用户关掉的通道不能被外部提醒绕过')
  assert.equal(documentStub.title, 'dsh', '标题不应被改写')
})

test('同键短时重入只认一次, 空标题不投递', () => {
  const { mod, toasts } = loadClient()
  assert.deepEqual(mod.__test.notifyExternal({ key: 'dup', title: '第一次' }).delivered, ['toast'])
  const second = mod.__test.notifyExternal({ key: 'dup', title: '第二次' })
  assert.deepEqual(second.delivered, [], '同键 2 秒内不重复')
  assert.equal(second.duplicate, true)
  assert.deepEqual(mod.__test.notifyExternal({ title: '   ' }).delivered, [], '空标题不产生通知')
  assert.equal(toasts.length, 1)
})
