// client boot 自检 BDD:remote.settings 服务面缺失(旧本体)时插件整体禁用,
// 不触达 react-dom 等任何宿主资源;服务面存在时不进禁用分支,正常注册注入 effect。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'

// client.js 顶层即引用 window(client-modules 自注册格式),node 侧先补桩;
// 模块只导入一次,factory 捕获后跨用例复用(重复 import 走缓存不再触发 load)
let factoryPromise = null
function loadFactory() {
  globalThis.window ??= {}
  if (factoryPromise === null) {
    const loader = { factory: null }
    globalThis.window.__ModuleLoader__ = { load: (spec) => { loader.factory = spec.factory } }
    factoryPromise = import('../src/client.js').then(() => loader.factory)
  }
  return factoryPromise
}

async function boot(ctx) {
  const factory = await loadFactory()
  // factory 顶层 require('react') 取 hooks;boot 探测路径不触达渲染,空对象够用
  const entry = factory((name) => ({ react: {} })[name])
  return entry.apply(ctx)
}

test('boot 自检:remote.settings 面缺失时仅 warn 即返回 undefined,不触达 react-dom', async () => {
  for (const remote of [undefined, {}]) {
    const warns = []
    const restore = mock.method(console, 'warn', (...args) => warns.push(args.join(' ')))
    try {
      const result = await boot({ remote })
      assert.equal(result, undefined)
      assert.equal(warns.length, 1)
      assert.match(warns[0], /缺少 remote\.settings 服务面/)
    } finally {
      restore.mock.restore()
    }
  }
})

test('boot 自检:remote.settings 存在时不进禁用分支,注册注入 effect', async () => {
  const warns = []
  const restore = mock.method(console, 'warn', (...args) => warns.push(args.join(' ')))
  try {
    const effects = []
    const result = await boot({
      remote: { settings: { describe() {}, mutate() {} } },
      effect: (fn, name) => effects.push(name),
    })
    assert.equal(result, undefined)
    assert.deepEqual(effects, ['model-capability-editor: models-page injector'])
    assert.equal(warns.filter((line) => line.includes('缺少 remote.settings')).length, 0)
  } finally {
    restore.mock.restore()
  }
})
