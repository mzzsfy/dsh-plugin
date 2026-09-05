// client 注入契约 BDD:remote.settings 面的存在性由 cordis 注入门控保证
// (点分 inject 声明使 fiber 等 namespace 挂载完成后才激活,官方插件同构),
// apply 内不做面缺失探测——面在 apply 期必然就绪,直接消费。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
  const entry = factory((name) => ({ react: {} })[name])
  assert.deepEqual(entry.inject, ['remote', 'remote.settings'])
})

test('禁用分支清偿:client.js 不再含面缺失探测告警(时序竞态已由门控消除)', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(!source.includes('缺少 remote.settings'), '残留面缺失探测告警分支')
})

test('apply 期面已就绪:settings 面直接消费,注册注入 effect', async () => {
  const effects = []
  const result = await (async () => {
    const factory = await loadFactory()
    const entry = factory((name) => ({ react: {} })[name])
    return entry.apply({
      remote: { settings: { describe() {}, mutate() {} } },
      effect: (fn, name) => effects.push(name),
    })
  })()
  assert.equal(result, undefined)
  assert.deepEqual(effects, ['model-capability-editor: models-page injector'])
})
