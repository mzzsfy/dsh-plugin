// 全链路集成测试:加载真实 client.js 模块,注入 broken / 正常 localStorage,
// 走 pollOnce 完整链路(清理段 → 认领 → 发声),验证降级接线与每事件去重。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

class FakeStorage {
  constructor(seed) { this.map = new Map(Object.entries(seed || {})) }
  get length() { return this.map.size }
  key(index) { return Array.from(this.map.keys())[index] ?? null }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
}

class BrokenStorage {
  get length() { throw new Error('blocked') }
  key() { throw new Error('blocked') }
  getItem() { throw new Error('blocked') }
  setItem() { throw new Error('blocked') }
  removeItem() { throw new Error('blocked') }
}

// 以注入的 stub 加载真实 src/client.js,返回捕获的模块对象、页内通知捕获表与 window 桩。
function loadClient({ storage, payload, onFetch, fetchImpl, document: documentOverride }) {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
  const shown = []
  const windowStub = {
    __ModuleLoader__: { load: (module) => { modules.push(module) } },
    addEventListener: () => {},
    localStorage: storage,
  }
  const documentStub = {
    hasFocus: () => true,
    title: 'dsh',
    createElement: () => ({ style: {}, remove() {} }),
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
    ...documentOverride,
  }
  const reactStub = { useState: (value) => [value, () => {}], useEffect: () => {}, useSyncExternalStore: () => [] }
  const requireStub = (name) => {
    // 页内通知通道出口:公共依赖 @mzzsfy/dsh-toast 的捕获桩
    if (name === '@mzzsfy/dsh-toast/client') {
      return { show: (text, opts) => { shown.push({ text, opts }); return shown.length } }
    }
    return reactStub
  }
  const defaultFetch = async (path) => {
    if (onFetch) onFetch(path)
    return { ok: true, json: async () => payload }
  }
  const factory = new Function(
    'window', 'require', 'document', 'MutationObserver', 'fetch', 'Notification',
    source + '\n;return null',
  )
  factory(
    windowStub,
    requireStub,
    documentStub,
    class { observe() {} disconnect() {} },
    fetchImpl || defaultFetch,
    undefined,
  )
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  // load({id, factory}) 结构:再调 factory(require) 得到真正的模块对象
  return { mod: modules[0].factory(requireStub), shown, window: windowStub }
}

const units = [
  { id: 'u1', category: 'completed', text: '[dsh] 任务完成: t1' },
  { id: 'u2', category: 'error', text: '[dsh] 任务出错: t2' },
]

test('broken localStorage:清理段不抛,降级发声恰好一次,第二轮不再发声', async () => {
  const { mod, shown } = loadClient({ storage: new BrokenStorage(), payload: { units, soundMapping: {}, version: 1 } })
  const { poll, storageState } = mod.__test
  await poll()
  assert.equal(storageState.broken, true)
  // 两事件各发声一次,清理段未抛出控制流到达 claimEvent
  assert.equal(shown.length, units.length)
  await poll()
  // 投影窗口内第二轮 poll 同事件不再发声
  assert.equal(shown.length, units.length)
})

test('正常 localStorage:唯一发声,完成标记写入,残留锁被清理', async () => {
  const storage = new FakeStorage({ 'turn-notify:lock:stale': '{"wid":"w9","at":1}' })
  const { mod, shown } = loadClient({ storage, payload: { units, soundMapping: {}, version: 1 } })
  const { poll } = mod.__test
  await poll()
  assert.equal(shown.length, units.length)
  assert.equal(storage.getItem('turn-notify:lock:stale'), null)
  assert.notEqual(storage.getItem('turn-notify:done:u1'), null)
  assert.notEqual(storage.getItem('turn-notify:done:u2'), null)
  await poll()
  // 完成标记生效,第二轮不重复发声
  assert.equal(shown.length, units.length)
})

test('页内通知经公共组件:文案与展示期随事件传入', async () => {
  const { mod, shown } = loadClient({ storage: new FakeStorage(), payload: { units, soundMapping: {}, version: 1 } })
  await mod.__test.poll()
  assert.deepEqual(shown.map((call) => call.text), units.map((unit) => unit.text))
  assert.ok(shown.every((call) => call.opts && call.opts.holdMs === 6 * 1000))
})

// ---- 会话行高亮:认领后按投影 session 字段在侧边栏定位行并挂类 ----

// 最小侧边栏 DOM:列表容器(多标题)→ 多会话行(各单标题),classList 记录变更,click listener 捕获;
// className 与 classList 双向同步(对齐真 DOM 语义:任一写入对方可见)
function makeSidebarDom(rows) {
  const listeners = {}
  const rowEls = rows.map((spec) => {
    const rowClassList = { set: new Set() }
    rowClassList.contains = (c) => rowClassList.set.has(c)
    rowClassList.add = (...cs) => cs.forEach((c) => rowClassList.set.add(c))
    rowClassList.remove = (...cs) => cs.forEach((c) => rowClassList.set.delete(c))
    const sync = function (value) {
      rowClassList.set.clear()
      String(value).split(' ').filter(Boolean).forEach((c) => rowClassList.set.add(c))
    }
    const leaf = { className: 'a_title', textContent: spec.leafText, querySelectorAll: () => [] }
    const row = {
      leafText: spec.leafText,
      textContent: spec.rowText || spec.leafText,
      querySelector: (sel) => (sel.indexOf('_title') >= 0 ? leaf : null),
      querySelectorAll: (sel) => (sel.indexOf('_title') >= 0 ? [leaf] : []),
      children: [], classList: rowClassList,
    }
    Object.defineProperty(row, 'className', {
      get: () => [...rowClassList.set].join(' '),
      set: sync,
    })
    sync('x_row')
    return row
  })
  const leaves = rows.map((spec, index) => rowEls[index].querySelector('[class*="_title"]'))
  const listEl = {
    className: 'x_list',
    // 容器探测要求子树含多个标题,单行场景补哑叶满足
    querySelectorAll: (sel) => (sel.indexOf('_title') >= 0 ? leaves.concat([{ className: 'a_title', textContent: '哑叶', querySelectorAll: () => [] }]) : []),
    children: rowEls,
  }
  const dom = {
    querySelectorAll: (sel) => (sel.indexOf('_list') >= 0 ? [listEl] : []),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn) },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn) },
    listeners,
    rows: rowEls,
  }
  return dom
}

const clickEventOn = (row) => ({ target: { closest: (sel) => (sel === '.tn-sess-hl' ? row : null) } })

test('Given 通知带 session 标题 When 认领 Then 会话行挂上高亮类', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-hl', category: 'completed', text: '[dsh] 任务完成: 会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: { title: '会话乙 — DeepSeek Harness', ...dom },
  })
  await mod.__test.poll()
  assert.ok(dom.rows[0].classList.set.has('tn-sess-hl'), '会话行未挂高亮类')
  assert.ok(dom.rows[0].classList.set.has('tn-sess-hl--completed'), '高亮类缺少分类色')
})

test('Given 通知的是当前查看的会话 When 认领 Then 不挂高亮', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-cur', category: 'completed', text: '[dsh] 任务完成: 会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: { title: '会话甲 — DeepSeek Harness', ...dom },
  })
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '当前查看的会话不应闪烁')
})

test('Given 当前会话判定不受标题闪烁前缀干扰 When 认领 Then 仍不挂高亮', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const hlUnits = [
    { id: 'u-blink', category: 'error', text: '[dsh] 任务出错: 会话甲', session: '会话甲' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: { title: '⏳ 会话甲 — DeepSeek Harness', ...dom },
  })
  await mod.__test.poll()
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '闪烁前缀不应破坏当前会话判定')
})

test('Given 通知标题字段缺失 When 认领 Then 不挂高亮类且链路不抛', async () => {
  const dom = makeSidebarDom([{ leafText: '会话甲' }])
  const bareUnits = [
    { id: 'u-bare', category: 'completed', text: '[dsh] 任务完成: 无标题' },
  ]
  const { mod, shown } = loadClient({
    storage: new FakeStorage(),
    payload: { units: bareUnits, soundMapping: {}, version: 1 },
    document: dom,
  })
  await mod.__test.poll()
  assert.equal(shown.length, 1)
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false)
})

test('Given 短标题先于长前缀行匹配 When 挂类 Then 短标题精确命中自身行', async () => {
  // 长标题行在前,短标题是长标题的子串:短标题通知必须挂到全等行,不得被子串误吸
  const dom = makeSidebarDom([
    { leafText: '修复通知插件长轮询问题' },
    { leafText: '通知插件' },
  ])
  const hlUnits = [
    { id: 'u-long', category: 'completed', text: '[dsh] 任务完成: 长标题', session: '修复通知插件长轮询问题' },
    { id: 'u-short', category: 'ask', text: '[dsh] AI 提问: 短标题', session: '通知插件' },
  ]
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: dom,
  })
  await mod.__test.poll()
  assert.ok(dom.rows[0].classList.set.has('tn-sess-hl--completed'), '长标题行未挂类')
  assert.ok(dom.rows[1].classList.set.has('tn-sess-hl--ask'), '短标题行未挂到自身行')
  assert.equal(dom.rows[1].classList.set.has('tn-sess-hl--completed'), false, '长标题类误挂到短标题行')
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl--ask'), false, '短标题类误挂到长标题行')
})

test('Given 两行各自高亮 When 点击其中一行 Then 仅该行清除且另一行不受影响', async () => {
  const dom = makeSidebarDom([
    { leafText: '修复通知插件长轮询问题' },
    { leafText: '通知插件' },
  ])
  const hlUnits = [
    { id: 'u-long', category: 'completed', text: '[dsh] 任务完成: 长标题', session: '修复通知插件长轮询问题' },
    { id: 'u-short', category: 'ask', text: '[dsh] AI 提问: 短标题', session: '通知插件' },
  ]
  const { mod, window: winStub } = loadClient({
    storage: new FakeStorage(),
    payload: { units: hlUnits, soundMapping: {}, version: 1 },
    document: dom,
  })
  await mod.__test.poll()
  mod.__test.start()
  const clickListeners = dom.listeners.click || []
  assert.ok(clickListeners.length > 0, 'click listener 未挂载')
  for (const fn of clickListeners) fn(clickEventOn(dom.rows[0]))
  assert.equal(dom.rows[0].classList.set.has('tn-sess-hl'), false, '点击行未清除')
  assert.equal(dom.rows[1].classList.set.has('tn-sess-hl'), true, '另一行被误清除')
  winStub['turn-notify:polling'].abort()
})

test('announcedIds 去重窗口按 TTL 过期清理', () => {
  const { announcedOnce, announcedIds, ANNOUNCED_TTL_MS } = loadLogic({})
  assert.equal(announcedOnce('a', 1000), true)
  assert.equal(announcedOnce('a', 1000 + ANNOUNCED_TTL_MS - 1), false)
  // 窗口过期后可再次发声,且过期条目被清理
  assert.equal(announcedOnce('a', 1000 + ANNOUNCED_TTL_MS + 1), true)
  assert.equal(announcedIds.size, 1)
})

// ---- 页内提示音场景映射:未配置沿用通知映射,显式覆盖独立生效 ----

function loadLogic(storageSeed) {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const windowStub = { localStorage: new FakeStorage(storageSeed) }
  const factory = new Function('window', section + '; return { readPageMapping, mergeMapping, resolveSound, DEFAULT_TONES, announcedOnce, announcedIds, ANNOUNCED_TTL_MS }')
  return factory(windowStub)
}

test('Given 页内映射未配置 When 解析页内音色 Then 与通知映射解析一致', () => {
  const logic = loadLogic({})
  const notifyMapping = { completed: 'bell', ask: 'snd-x' }
  const merged = logic.mergeMapping(notifyMapping, logic.readPageMapping())
  assert.deepEqual(logic.resolveSound('completed', merged, ['snd-x']), { kind: 'builtin', name: 'bell' })
  assert.deepEqual(logic.resolveSound('ask', merged, ['snd-x']), { kind: 'custom', id: 'snd-x' })
})

test('Given 页内映射显式覆盖某分类 When 解析页内音色 Then 页内用覆盖值且通知映射不受影响', () => {
  const logic = loadLogic({ 'turn-notify:page-mapping': JSON.stringify({ completed: 'tick' }) })
  const notifyMapping = { completed: 'bell' }
  const merged = logic.mergeMapping(notifyMapping, logic.readPageMapping())
  assert.deepEqual(logic.resolveSound('completed', merged, []), { kind: 'builtin', name: 'tick' })
  // 通知场景解析仍用通知映射(不含页内覆盖)
  assert.deepEqual(logic.resolveSound('completed', notifyMapping, []), { kind: 'builtin', name: 'bell' })
})

test('Given 页内映射存储残留空串值 When 读取 Then 视同未配置沿用通知映射', () => {
  const logic = loadLogic({ 'turn-notify:page-mapping': JSON.stringify({ completed: '' }) })
  assert.deepEqual(logic.readPageMapping(), {})
  const merged = logic.mergeMapping({ completed: 'bell' }, logic.readPageMapping())
  assert.deepEqual(logic.resolveSound('completed', merged, []), { kind: 'builtin', name: 'bell' })
})

test('Given 页内映射存储损坏或死链 When 解析 Then 容错回落且死链值回落内置默认', () => {
  const logic = loadLogic({ 'turn-notify:page-mapping': '{broken' })
  assert.deepEqual(logic.readPageMapping(), {})
  const deadLogic = loadLogic({ 'turn-notify:page-mapping': JSON.stringify({ completed: 'snd-gone' }) })
  const merged = deadLogic.mergeMapping({ completed: 'bell' }, deadLogic.readPageMapping())
  assert.deepEqual(deadLogic.resolveSound('completed', merged, []), { kind: 'builtin', name: deadLogic.DEFAULT_TONES.completed })
})

test('激活即启动轮询:apply 注册设置分区且 start 已执行', async () => {
  const fetched = []
  const { mod } = loadClient({
    storage: new FakeStorage(),
    payload: { units: [], soundMapping: {}, version: 1 },
    onFetch: (path) => { fetched.push(path) },
  })
  const injected = []
  const effects = []
  mod.apply({
    slots: { inject: (name, fn) => { injected.push([name, fn]) } },
    effect: (fn) => { effects.push(fn()) },
  })
  assert.equal(effects.length, 1, '文档级样式未挂载')
  assert.deepEqual(injected.map(([name]) => name), ['settings.section'], '页内通知展示已移交 dsh-toast,不再注入 shell.overlay')
  // start 已执行:音效清单被首拉;轮询定时器 unref,不阻止测试进程退出
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.ok(fetched.indexOf('/api/turn-notify/sounds') >= 0)
})

test('页内提示通道独立开关:关闭后投影事件不再弹页内提示', async () => {
  const storage = new FakeStorage({ 'turn-notify:toast': '0' })
  const { mod, shown } = loadClient({ storage, payload: { units, soundMapping: {}, version: 1 } })
  const { poll } = mod.__test
  await poll()
  assert.equal(shown.length, 0)
  // 完成标记已写:事件被认领消费,仅通道被关
  assert.notEqual(storage.getItem('turn-notify:done:u1'), null)
})

test('分类通知开关串行提交:连点按序入队,host 终值为最后一次点击', async () => {
  const calls = []
  const { mod } = loadClient({ storage: new FakeStorage(), payload: { units: [], soundMapping: {}, version: 1 } })
  const apiImpl = async (path, init) => {
    if (init.method === 'POST') {
      const checked = JSON.parse(init.body).enabled
      await new Promise((resolve) => { setTimeout(resolve, calls.length === 0 ? 30 : 0) })
      // 首个请求最慢:host 到达序即串行化证明,无队列时后发请求将先到
      calls.push(checked)
      return {}
    }
    return {}
  }
  const noop = () => {}
  mod.__test.submitCategoryToggle('completed', false, { apiImpl, onConfig: noop, onError: noop })
  mod.__test.submitCategoryToggle('completed', true, { apiImpl, onConfig: noop, onError: noop })
  mod.__test.submitCategoryToggle('completed', false, { apiImpl, onConfig: noop, onError: noop })
  await mod.__test.submitCategoryToggle('completed', true, { apiImpl, onConfig: noop, onError: noop })
  assert.deepEqual(calls, [
    { completed: false },
    { completed: true },
    { completed: false },
    { completed: true },
  ])
})

test('分类通知开关提交失败:报错并以权威配置纠偏', async () => {
  let failing = true
  const gets = []
  const errors = []
  const configs = []
  const apiImpl = async (path, init) => {
    if (init && init.method === 'POST') {
      if (failing) throw new Error('boom')
      return {}
    }
    gets.push(path)
    return { enabled: { completed: true } }
  }
  const { mod } = loadClient({ storage: new FakeStorage(), payload: { units: [], soundMapping: {}, version: 1 } })
  await mod.__test.submitCategoryToggle('completed', true, {
    apiImpl,
    onConfig: (res) => configs.push(res),
    onError: (text) => errors.push(text),
  })
  assert.equal(errors.length, 1)
  assert.ok(errors[0].indexOf('boom') >= 0)
  assert.deepEqual(gets, ['/api/turn-notify/config'])
  assert.deepEqual(configs, [{ enabled: { completed: true } }])
})

function activate(mod) {
  mod.apply({
    slots: { inject: () => {} },
    effect: (fn) => { fn() },
  })
}

test('长轮询代际中止:abort 后循环退出不再发起新请求', async () => {
  let calls = 0
  const { mod, window: windowStub } = loadClient({
    storage: new FakeStorage(),
    // 桩模拟真实 fetch 的中止语义:代际 signal 触发即 reject,释放循环;仅计投影请求
    fetchImpl: (path, init) => new Promise((resolve, reject) => {
      if (path.indexOf('/sounds') >= 0) {
        resolve({ ok: true, json: async () => ({ sounds: [] }) })
        return
      }
      calls += 1
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  })
  activate(mod)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.equal(calls, 1, '首拉已发出并挂起')
  windowStub['turn-notify:polling'].abort()
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.equal(calls, 1, '中止后不应再发起新请求')
})

test('长轮询失败:降级通告一次,退避期内不重试不通告第二次', async () => {
  const warns = []
  const original = console.warn
  console.warn = (message) => { warns.push(message) }
  let calls = 0
  try {
    const { mod } = loadClient({
      storage: new FakeStorage(),
      fetchImpl: async (path) => {
        if (path.indexOf('/sounds') >= 0) return { ok: true, json: async () => ({ sounds: [] }) }
        calls += 1
        throw new Error('down')
      },
    })
    activate(mod)
    // 退避起点远大于此等待窗:窗内恰好一次失败与一次通告
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  } finally { console.warn = original }
  assert.equal(calls, 1)
  assert.equal(warns.length, 1)
  assert.ok(warns[0].indexOf('通知降级') >= 0)
})

test('长轮询游标推进:带 version 响应推进 cursor,后续请求携带游标', async () => {
  const paths = []
  const { mod } = loadClient({
    storage: new FakeStorage(),
    fetchImpl: async (path) => {
      paths.push(path)
      return { ok: true, json: async () => ({ units: [], soundMapping: {}, version: 7 }) }
    },
  })
  const { poll } = mod.__test
  assert.equal(await poll(), true, '带 version 响应视为成功')
  assert.equal(await poll(new AbortController().signal), true)
  assert.ok(paths[0].indexOf('?cursor=') < 0, '首拉无游标')
  assert.ok(paths[1].indexOf('?cursor=7') >= 0, '游标随响应推进')
})
