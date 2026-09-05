// store 行为测试:入栈/裁剪/自动消失/常驻/守卫/快照稳定性。
// 加载真实 src/client.js(stub 注入),直接驱动 factory 层 store,不涉渲染。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mock } from 'node:test'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 全文件冻结 setTimeout:show 的自动消失计时不拖住测试进程,
// 「自动消失」用例经 mock.timers.tick 手动推进
test.beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }) })
test.afterEach(() => { mock.timers.reset() })

const reactStub = {
  useSyncExternalStore: () => [],
  createElement: () => null,
}
const createRootStub = () => ({ render() {} })
const requireStub = (name) => (name === 'react-dom/client' ? { createRoot: createRootStub } : reactStub)

// 加载 client.js 并执行 factory,返回模块导出(含 __test 钩子)
function loadModule() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) } }
  const factory = new Function('window', 'require', 'document', source + '\n;return null')
  factory(windowStub, requireStub, makeDocument())
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  return modules[0].factory(requireStub)
}

function makeDocument(state) {
  const ids = state || { byId: new Map() }
  return {
    getElementById: (id) => ids.byId.get(id) ?? null,
    createElement: (tag) => ({ tag, id: '', style: {}, remove() { ids.byId.delete(this.id) } }),
    head: { appendChild: () => {} },
    body: {
      appendChild: (node) => ids.byId.set(node.id, node),
    },
  }
}

test('show:多条并存,id 单调,快照按序', () => {
  const mod = loadModule()
  const first = mod.__test.show('第一条')
  const second = mod.__test.show('第二条', { kind: 'ok' })
  assert.equal(typeof first, 'number')
  assert.equal(second, first + 1)
  const items = mod.__test.getItems()
  assert.deepEqual(items.map((item) => item.text), ['第一条', '第二条'])
  assert.deepEqual(items.map((item) => item.kind), ['info', 'ok'])
  assert.deepEqual(items.map((item) => item.sticky), [false, false])
})

test('show:栈上限裁最旧,新条目保留', () => {
  const mod = loadModule()
  for (let index = 1; index <= 4; index += 1) mod.__test.show('条目' + index)
  const newest = mod.__test.show('条目5')
  const items = mod.__test.getItems()
  assert.equal(items.length, 4)
  assert.equal(items[0].text, '条目2', '最旧条目被裁剪')
  assert.equal(items[items.length - 1].id, newest)
})

test('show:非法入参守卫,text 忽略返回 null', () => {
  const mod = loadModule()
  assert.equal(mod.__test.show(''), null)
  assert.equal(mod.__test.show(null), null)
  assert.equal(mod.__test.show(42), null)
  assert.equal(mod.__test.getItems().length, 0)
})

test('show:kind 非法归 info,sticky 按 truthy 判定', () => {
  const mod = loadModule()
  mod.__test.show('a', { kind: 'bogus' })
  mod.__test.show('b', { sticky: 'yes' })
  mod.__test.show('c', { sticky: 0 })
  const items = mod.__test.getItems()
  assert.deepEqual(items.map((item) => item.kind), ['info', 'info', 'info'])
  assert.deepEqual(items.map((item) => item.sticky), [false, true, false])
})

test('dismiss:命中移除,未命中幂等不动快照', () => {
  const mod = loadModule()
  const id = mod.__test.show('可移除')
  const snapshot = mod.__test.source.getSnapshot()
  mod.__test.dismiss(99999)
  assert.equal(mod.__test.source.getSnapshot(), snapshot, '未命中不产生新快照')
  mod.__test.dismiss(id)
  assert.equal(mod.__test.getItems().length, 0)
  assert.notEqual(mod.__test.source.getSnapshot(), snapshot, '命中产生新快照')
})

test('自动消失:默认展示期后移除,sticky 不计时,dismiss 即消失', () => {
  const mod = loadModule()
  mod.__test.show('自动')
  mod.__test.show('常驻', { kind: 'error', sticky: true })
  assert.equal(mod.__test.getItems().length, 2)
  mock.timers.tick(mod.__test.resolveHoldMs(null))
  const items = mod.__test.getItems()
  assert.deepEqual(items.map((item) => item.text), ['常驻'], '非 sticky 已消失,sticky 保留')
  mod.__test.dismiss(items[0].id)
  assert.equal(mod.__test.getItems().length, 0)
})

test('自动消失:holdMs 正值生效,非法回落默认', () => {
  const mod = loadModule()
  mod.__test.show('快闪', { holdMs: 500 })
  mod.__test.show('默认')
  mock.timers.tick(500)
  assert.deepEqual(mod.__test.getItems().map((item) => item.text), ['默认'])
  mock.timers.tick(mod.__test.resolveHoldMs({ holdMs: -1 }))
  assert.equal(mod.__test.getItems().length, 0)
})

test('subscribe:入栈与移除均通知订阅者', () => {
  const mod = loadModule()
  let calls = 0
  const unsubscribe = mod.__test.source.subscribe(() => { calls += 1 })
  const id = mod.__test.show('通知')
  mod.__test.dismiss(id)
  assert.equal(calls, 2)
  unsubscribe()
  mod.__test.show('不再通知')
  assert.equal(calls, 2)
})
