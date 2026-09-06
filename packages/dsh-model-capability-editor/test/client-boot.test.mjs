// client 注入契约 BDD:remote.settings 面的存在性由 cordis 注入门控保证
// (点分 inject 声明使 fiber 等 namespace 挂载完成后才激活,官方插件同构),
// apply 内不做面缺失探测——面在 apply 期必然就绪,直接消费。
// require 桩采用宿主语义:未知模块名 throw(宿主 client-modules 对种子表外
// 键直接抛错),使顶层硬依赖与可选消费的降级路径都被真实执行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 宿主种子表桩:react / react-dom/client 为一级键(dsh-web-frontend 种子表同形);
// extra 模拟可选依赖(@mzzsfy/dsh-toast/client)在/不在表中的两种宿主形态
const SEED = {
  react: {
    useState: () => [null, () => {}],
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    memo: (component) => component,
  },
  'react-dom/client': { createRoot: () => ({ render() {}, unmount() {} }) },
}
function requireOf(extra = {}) {
  const table = { ...SEED, ...extra }
  return (name) => {
    const mod = table[name]
    if (mod === undefined) throw new Error('client-modules: require("' + name + '") missed the module table')
    return mod
  }
}

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

test('注入契约:inject 声明 remote 基座与 remote.settings 点分面', async () => {
  const factory = await loadFactory()
  const entry = factory(requireOf())
  assert.deepEqual(entry.inject, ['remote', 'remote.settings'])
})

test('禁用分支清偿:client.js 不再含面缺失探测告警(时序竞态已由门控消除)', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(!source.includes('缺少 remote.settings'), '残留面缺失探测告警分支')
})

test('顶层硬依赖:种子表缺 react-dom/client 时 factory 抛错,不静默降级', async () => {
  const factory = await loadFactory()
  // spread 后显式置 undefined 模拟该键不在种子表
  assert.throws(
    () => factory(requireOf({ 'react-dom/client': undefined })),
    /react-dom\/client/,
    '缺 react-dom/client 必须显式抛错',
  )
})

test('顶层硬依赖:种子表缺 react 时 factory 抛错(第一个顶层 require)', async () => {
  const factory = await loadFactory()
  assert.throws(
    () => factory(requireOf({ react: undefined })),
    /require\("react"\)/,
    '缺 react 必须显式抛错',
  )
})

test('toast 可选消费:模块表有 toast 走 show,缺失降级 console.warn', async () => {
  const factory = await loadFactory()
  // 源码契约:factory 顶层对 toast 用 try/catch 可选消费,catch 后 notify 降级 console
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(/try \{\s*\n\s*toast = require\('@mzzsfy\/dsh-toast\/client'\)\.show\s*\n\s*\} catch \{/.test(source), 'toast 必须经 try/catch 可选消费')
  assert.ok(source.includes("console.warn('[dsh-model-capability-editor] ' + text)"), '降级分支必须走 console.warn')
  // 两种宿主形态下 factory 均不抛(降级在 notify 调用时发生,不在装载期)
  const withToast = factory(requireOf({ '@mzzsfy/dsh-toast/client': { show: () => {} } }))
  const withoutToast = factory(requireOf())
  assert.equal(typeof withToast.apply, 'function')
  assert.equal(typeof withoutToast.apply, 'function')
})

test('apply 期面已就绪:settings 面直接消费,注册注入 effect', async () => {
  const effects = []
  const factory = await loadFactory()
  const entry = factory(requireOf())
  const result = entry.apply({
    remote: { settings: { describe() {}, mutate() {} } },
    effect: (fn, name) => effects.push(name),
  })
  assert.equal(result, undefined)
  assert.deepEqual(effects, ['model-capability-editor: models-page injector'])
})
