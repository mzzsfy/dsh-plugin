import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function fixture() {
  let definition
  const window = { __ModuleLoader__: { load: value => { definition = value } } }
  const subscriptions = new Set(), timers = new Map()
  let timerId = 0, callbacks = 0
  const tools = { setupCommonTools(ctx) {
    assert.equal(ctx.fiber.entry.options.name, '@mzzsfy/dsh-rs-workflow')
    return { subscribe(onMessage, { onReset } = {}) {
      const item = { onMessage, onReset }
      subscriptions.add(item)
      return () => subscriptions.delete(item)
    } }
  } }
  const react = { useState: value => [value, () => {}], useEffect() {}, useCallback: fn => fn }
  new Function('window', 'setTimeout', 'clearTimeout', source)(window,
    fn => { const id = ++timerId; timers.set(id, fn); return id }, id => timers.delete(id))
  const instantiate = () => {
    const effects = [], cleanups = []
    const mod = definition.factory(name => name === 'react' ? react : tools)
    const ctx = { fiber: { entry: { options: { name: '@mzzsfy/dsh-rs-workflow' } } },
      effect(fn, tag) { effects.push({ fn, tag }) }, slots: { inject() {}, register() {} } }
    return { apply() { mod.apply(ctx); for (const { fn, tag } of effects) {
      if (tag === 'rs-workflow: session-aware flow view') continue
      const off = fn(); if (typeof off === 'function') cleanups.push(off)
    } }, dispose() { for (const off of cleanups.reverse()) off() } }
  }
  return { window, subscriptions, timers, instantiate,
    emit() { for (const item of subscriptions) item.onMessage(null) },
    flush() { for (const [id, fn] of [...timers]) { timers.delete(id); callbacks++; fn() } },
    get callbacks() { return callbacks } }
}

test('Given 尚未激活的 client When factory 物化 Then 不占总线订阅', () => {
  const f = fixture(); f.instantiate()
  assert.equal(f.subscriptions.size, 0)
})

test('Given 已激活且合并通知待发 When ctx 卸载 Then 退订且取消待发广播', () => {
  const f = fixture(), plugin = f.instantiate()
  plugin.apply(); f.emit()
  assert.equal(f.subscriptions.size, 1)
  assert.equal(f.timers.size, 1)
  plugin.dispose()
  assert.equal(f.subscriptions.size, 0)
  assert.equal(f.timers.size, 0)
  f.emit(); f.flush()
  assert.equal(f.callbacks, 0)
  assert.equal(Object.hasOwn(f.window, 'rsww:changes-poll'), false)
})

test('Given 旧代待广播 When 新代 apply Then 清旧代计时器且旧代卸载不删除新代令牌', () => {
  const f = fixture(), old = f.instantiate()
  old.apply(); f.emit()
  const current = f.instantiate(); current.apply()
  assert.equal(f.subscriptions.size, 1)
  assert.equal(f.timers.size, 0)
  const token = f.window['rsww:changes-poll']
  old.dispose()
  assert.equal(f.window['rsww:changes-poll'], token)
  current.dispose()
})
