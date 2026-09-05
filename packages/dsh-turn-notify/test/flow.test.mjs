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

// 以注入的 stub 加载真实 src/client.js,返回捕获的模块对象(含 __test 钩子)。
function loadClient({ storage, payload, onFetch }) {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
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
  }
  const reactStub = { useState: (value) => [value, () => {}], useEffect: () => {}, useSyncExternalStore: () => [] }
  const requireStub = (name) => (name === 'react-dom' ? { createPortal: () => null } : reactStub)
  const fetchStub = async (path) => {
    if (onFetch) onFetch(path)
    return { json: async () => payload }
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
    fetchStub,
    undefined,
  )
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  // load({id, factory}) 结构:再调 factory(require) 得到真正的模块对象
  return modules[0].factory(() => reactStub)
}

const units = [
  { id: 'u1', category: 'completed', text: '[dsh] 任务完成: t1' },
  { id: 'u2', category: 'error', text: '[dsh] 任务出错: t2' },
]

test('broken localStorage:清理段不抛,降级发声恰好一次,第二轮不再发声', async () => {
  const mod = loadClient({ storage: new BrokenStorage(), payload: { units, soundMapping: {} } })
  const { poll, storageState, toastStack } = mod.__test
  await poll()
  assert.equal(storageState.broken, true)
  // 两事件各发声一次,清理段未抛出控制流到达 claimEvent
  assert.equal(toastStack().length, units.length)
  await poll()
  // 投影窗口内第二轮 poll 同事件不再发声
  assert.equal(toastStack().length, units.length)
})

test('正常 localStorage:唯一发声,完成标记写入,残留锁被清理', async () => {
  const storage = new FakeStorage({ 'turn-notify:lock:stale': '{"wid":"w9","at":1}' })
  const mod = loadClient({ storage, payload: { units, soundMapping: {} } })
  const { poll, toastStack } = mod.__test
  await poll()
  assert.equal(toastStack().length, units.length)
  assert.equal(storage.getItem('turn-notify:lock:stale'), null)
  assert.notEqual(storage.getItem('turn-notify:done:u1'), null)
  assert.notEqual(storage.getItem('turn-notify:done:u2'), null)
  await poll()
  // 完成标记生效,第二轮不重复发声
  assert.equal(toastStack().length, units.length)
})

test('announcedIds 去重窗口按 TTL 过期清理', async () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const factory = new Function(section + '; return { announcedOnce, announcedIds, ANNOUNCED_TTL_MS }')
  const { announcedOnce, announcedIds, ANNOUNCED_TTL_MS } = factory()
  assert.equal(announcedOnce('a', 1000), true)
  assert.equal(announcedOnce('a', 1000 + ANNOUNCED_TTL_MS - 1), false)
  // 窗口过期后可再次发声,且过期条目被清理
  assert.equal(announcedOnce('a', 1000 + ANNOUNCED_TTL_MS + 1), true)
  assert.equal(announcedIds.size, 1)
})

test('激活即启动轮询:apply 注册设置分区与通知栈且 start 已执行', async () => {
  const fetched = []
  const mod = loadClient({
    storage: new FakeStorage(),
    payload: { units: [], soundMapping: {} },
    onFetch: (path) => { fetched.push(path) },
  })
  const injected = []
  const effects = []
  mod.apply({
    slots: { inject: (name, fn) => { injected.push([name, fn]) } },
    effect: (fn) => { effects.push(fn()) },
  })
  assert.equal(effects.length, 1, '文档级样式未挂载')
  assert.equal(injected.length, 2)
  assert.deepEqual(injected.map(([name]) => name), ['settings.section', 'shell.overlay'])
  // start 已执行:音效清单被首拉;轮询定时器 unref,不阻止测试进程退出
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.ok(fetched.indexOf('/api/turn-notify/sounds') >= 0)
})

test('页内提示通道独立开关:关闭后投影事件不再弹页内提示', async () => {
  const storage = new FakeStorage({ 'turn-notify:toast': '0' })
  const mod = loadClient({ storage, payload: { units, soundMapping: {} } })
  const { poll, toastStack } = mod.__test
  await poll()
  assert.equal(toastStack().length, 0)
  // 完成标记已写:事件被认领消费,仅通道被关
  assert.notEqual(storage.getItem('turn-notify:done:u1'), null)
})

test('分类通知开关串行提交:连点按序入队,host 终值为最后一次点击', async () => {
  const calls = []
  const mod = loadClient({ storage: new FakeStorage(), payload: { units: [], soundMapping: {} } })
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
  const mod = loadClient({ storage: new FakeStorage(), payload: { units: [], soundMapping: {} } })
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
