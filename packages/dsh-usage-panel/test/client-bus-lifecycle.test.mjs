import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function fixture() {
  let definition
  const window = {
    __ModuleLoader__: { load: value => { definition = value } },
    localStorage: { length: 0, getItem: () => null },
  }
  const subscriptions = new Set(), requests = [], shown = []
  const tools = {
    createSnapshotRefresh: refresh => ({ refresh, dispose() {} }),
    toast: { show: (...args) => shown.push(args) },
    setupCommonTools(ctx) {
      assert.equal(ctx.fiber.entry.options.name, '@mzzsfy/dsh-usage-panel')
      return { subscribe(onMessage, { onReset } = {}) {
        const item = { onMessage, onReset }
        subscriptions.add(item)
        return () => subscriptions.delete(item)
      } }
    },
  }
  const fetch = (path, options) => new Promise(resolve => requests.push({ path, options, resolve }))
  new Function('window', 'fetch', source)(window, fetch)
  const instantiate = () => {
    const effects = [], cleanups = []
    const mod = definition.factory(name => name === 'react' ? {} : tools)
    const ctx = {
      fiber: { entry: { options: { name: '@mzzsfy/dsh-usage-panel' } } },
      effect(fn) { effects.push(fn) },
      slots: { inject() {}, register() {} },
    }
    return { apply() { mod.apply(ctx); for (const effect of effects) { const off = effect(); if (typeof off === 'function') cleanups.push(off) } },
      dispose() { for (const off of cleanups.reverse()) off() } }
  }
  return { window, subscriptions, requests, shown, instantiate,
    emit() { for (const item of subscriptions) item.onReset?.() } }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('Given 尚未激活的 client When factory 物化 Then 不订阅或拉取通知快照', () => {
  const f = fixture()
  f.instantiate()
  assert.equal(f.subscriptions.size, 0)
  assert.equal(f.requests.length, 0)
})

test('Given ctx 已激活且快照在途 When 卸载 Then 退订并中止请求且不呈现迟到快照', async () => {
  const f = fixture(), plugin = f.instantiate()
  plugin.apply()
  assert.equal(f.subscriptions.size, 1)
  f.emit()
  assert.equal(f.requests.length, 1)
  const request = f.requests[0]
  plugin.dispose()
  assert.equal(f.subscriptions.size, 0)
  assert.equal(request.options.signal.aborted, true)
  f.emit()
  assert.equal(f.requests.length, 1)
  request.resolve({ ok: true, json: async () => ({ version: 1, units: [{ id: 'late', text: '旧代通知' }] }) })
  await flush()
  assert.equal(f.shown.length, 0)
  assert.equal(Object.hasOwn(f.window, 'usage-panel:notify-poll'), false)
  assert.equal(Object.hasOwn(f.window, 'usage-panel:notify-poll:dispose'), false)
})

test('Given 旧代激活 When 新代 apply Then 仅保留新代订阅且旧代卸载不清新代令牌', () => {
  const f = fixture(), old = f.instantiate()
  old.apply(); f.emit()
  const current = f.instantiate()
  current.apply()
  assert.equal(f.requests[0].options.signal.aborted, true)
  assert.equal(f.subscriptions.size, 1)
  const token = f.window['usage-panel:notify-poll']
  old.dispose()
  assert.equal(f.window['usage-panel:notify-poll'], token)
  current.dispose()
  assert.equal(f.subscriptions.size, 0)
})
