// Toast 接线源码级测试:加载真实 src/client.js,以捕获桩驱动 apply 的归档差分,
// 锁定 external require specifier 与通知出口接线(specifier 拼错当场暴露)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mock } from 'node:test'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 加载 client.js 并执行 apply(mock 最小服务面),返回捕获的 toast 调用与控制器
function loadClient() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
  const required = []
  const shown = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = { useState: (value) => [value, () => {}], useEffect: () => {}, useSyncExternalStore: () => [], createElement: () => null }
  const requireStub = (name) => {
    required.push(name)
    // 通知出口:公共依赖 @mzzsfy/dsh-toast 的捕获桩
    if (name === '@mzzsfy/dsh-toast/client') {
      return { show: (text, opts) => { shown.push({ text, opts }); return shown.length } }
    }
    return reactStub
  }
  const factory = new Function('window', 'require', 'document', source + '\n;return null')
  factory(
    windowStub,
    requireStub,
    { createElement: () => ({ style: {}, remove() {} }), head: { appendChild: () => {} }, body: { appendChild: () => {} } },
  )
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  const mod = modules[0].factory(requireStub)

  // 差分快照序列由测试手动推进
  let listener = null
  let snapshot = undefined
  const workspaces = {
    list: {
      subscribe: (cb) => { listener = cb; return () => { listener = null } },
      getSnapshot: () => snapshot,
    },
  }
  const effects = []
  const ctx = {
    get: (name) => (name === 'workspaces' ? workspaces : {}),
    effect: (fn, tag) => effects.push(tag),
    slots: { inject: () => {}, register: () => {} },
  }
  mod.apply(ctx)
  return {
    shown,
    required,
    emit(next) { snapshot = next; if (listener !== null) listener() },
    effects,
  }
}

const READY = (ids) => ({ phase: 'ready', archivedSessionIds: ids })

test('apply:external require specifier 锁定为 @mzzsfy/dsh-toast/client', () => {
  const client = loadClient()
  assert.ok(client.required.includes('@mzzsfy/dsh-toast/client'),
    'client.js 未按约定 specifier require 公共通知依赖: ' + client.required.join(', '))
})

test('apply:归档差分经 toast 出口,连续 ready 才计新增', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const client = loadClient()
    assert.deepEqual(client.shown, [], 'apply 本身不发通知')
    client.emit(READY(['a', 'b']))
    assert.deepEqual(client.shown, [], '首帧基线(存量归档)不通知')
    client.emit(READY(['a', 'b', 'c', 'd']))
    assert.deepEqual(client.shown.map((call) => call.text), ['有 2 个会话已归档'])
    assert.deepEqual(client.shown.map((call) => call.opts), [undefined])
    client.emit(READY(['a', 'b', 'c', 'd']))
    assert.equal(client.shown.length, 1, '无新增不重复通知')
  } finally {
    mock.timers.reset()
  }
})

test('apply:effect 挂样式与差分退订两个副作用', () => {
  const client = loadClient()
  assert.deepEqual(client.effects, ['session-manager styles', 'session-manager archived diff'])
})
