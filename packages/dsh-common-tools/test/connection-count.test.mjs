import test from 'node:test'
import assert from 'node:assert/strict'
import { setupCommonTools } from '../src/host.js'
import { fixture, until } from './_ws-fixture.mjs'

test('Given 多插件反复启停 When 空闲与组件退订 Then WS峰值一且实例卸载后归零', async t => {
  const f = await fixture(t)
  const plugins = ['tunnel', 'cron', 'notify', 'usage', 'workflow', 'tunnel', 'cron', 'extra'].map(name => '@mzzsfy/' + name)
  for (const plugin of new Set(plugins)) setupCommonTools(f.context(plugin))
  for (let round = 0; round < 5; round++) {
    const resets = [], contexts = plugins.map(plugin => f.context(plugin))
    const buses = contexts.map(ctx => f.load().setupCommonTools(ctx))
    const stops = buses.map((bus, i) => bus.subscribe(() => {}, { onReset: () => resets.push(i) }))
    await until(() => resets.length === plugins.length)
    assert.equal(f.sockets.size, 1)
    assert.equal(f.stats().total, round + 1)
    for (let request = 0; request < 8; request++) assert.equal((await fetch(f.base + '/snapshot')).status, 200)
    assert.equal(f.stats().total, round + 1)
    for (const stop of stops) { stop(); stop() }
    assert.equal(f.sockets.size, 1, '退订不释放插件实例的发送连接')
    for (const ctx of contexts) ctx.dispose()
    await until(() => f.sockets.size === 0)
  }
  assert.equal(f.stats().peak, 1)
})
