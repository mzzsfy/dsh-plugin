import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'
import { memoryStorage } from './helpers.mjs'
test('H01/H02 缺依赖干净禁用，异步域迟到时卸载不注册路由', async () => {
  assert.doesNotThrow(() => apply({ effect() {}, logger: { warn() {} } }))
  const storage = memoryStorage(), disposers = [], paths = []
  let release
  const ctx = { storageDomain: { open: () => new Promise(resolve => { release = async () => resolve(await storage.open()) }) }, webServer: { register: r => { paths.push(r.path); return () => {} }, registerUpgrade() {} }, effect: fn => { disposers.push(fn()); return () => {} }, logger: { warn() {} }, fiber: { entry: { options: { name: '@mzzsfy/dsh-stock-sidebar' } } } }
  const starting = apply(ctx)
  assert.equal(typeof release, 'function')
  for (const stop of disposers) await stop?.()
  await release(); await starting
  assert.equal(storage.closed, true)
  assert.equal(paths.length, 0)
})
