import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.js'
import { memoryStorage } from './helpers.mjs'
test('H01/H02 缺依赖干净禁用，异步域迟到时卸载不注册路由', async () => {
  assert.doesNotThrow(() => apply({ effect() {}, logger: { warn() {} } }))
  const storage = memoryStorage(), disposers = [], paths = []
  let release
  const pending = new Promise(resolve => { release = () => resolve() })
  // 打开是两次(控制域与缓存域), 迟到的门必须对两次都放行, 否则第二次永远挂着
  const ctx = { storageDomain: { open: () => pending.then(() => storage.open()) }, webServer: { register: r => { paths.push(r.path); return () => {} }, registerUpgrade() {} }, effect: fn => { disposers.push(fn()); return () => {} }, logger: { warn() {} }, fiber: { entry: { options: { name: '@mzzsfy/dsh-stock-assistant' } } } }
  const starting = apply(ctx)
  assert.equal(typeof release, 'function')
  for (const stop of disposers) await stop?.()
  await release(); await starting
  assert.equal(storage.closed, true)
  assert.equal(paths.length, 0)
})

// 数据域打开失败时只留一句"未激活"等于没有现场: 必须留下可定位的 code 与原因
test('H03 数据域打开失败时告警带失败原因', async () => {
  const warns = [], paths = []
  const failure = Object.assign(new Error("domain 'stock_assistant': stored record 'root' in table 'control' does not match its schema"), { code: 'invalid-record', detail: { table: 'control', key: 'root' } })
  const ctx = {
    storageDomain: { open: async () => { throw failure } },
    webServer: { register: r => { paths.push(r.path); return () => {} }, registerUpgrade() {} },
    effect: () => () => {},
    logger: { warn: message => warns.push(message) },
    fiber: { entry: { options: { name: '@mzzsfy/dsh-stock-assistant' } } },
  }
  await apply(ctx)
  assert.equal(paths.length, 0, '失败时不得注册任何路由')
  assert.equal(warns.length, 1)
  assert.match(warns[0], /invalid-record/)
  assert.match(warns[0], /does not match its schema/)
  assert.match(warns[0], /control\/root/, '坏记录位置进日志, 否则只有表名无从定位')
})
