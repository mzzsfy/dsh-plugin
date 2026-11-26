import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsSymbols } from '../src/us-symbols.mjs'

const entry = at => ({ mktNum: '105', jys: 'OQ', at })

test('上限按写入序淘汰最早的映射', () => {
  let now = 0
  const symbols = createUsSymbols({ now: () => now, limit: 3, ttl: 1000 })
  for (const code of ['A', 'B', 'C', 'D']) symbols.set(`US:${code}`, entry(now))
  assert.deepEqual([...symbols.keys()], ['US:B', 'US:C', 'US:D'], '只留最近三条')
})

test('重复写入不占两份名额, 也不是下一个被淘汰的', () => {
  let now = 0
  const symbols = createUsSymbols({ now: () => now, limit: 3, ttl: 1000 })
  symbols.set('US:A', entry(now)); symbols.set('US:B', entry(now)); symbols.set('US:C', entry(now))
  // 最活跃的 A 重新写入后应排到尾部: 否则它停在头部, 先于真正的冷数据被淘汰
  symbols.set('US:A', entry(now))
  symbols.set('US:D', entry(now))
  assert.deepEqual([...symbols.keys()], ['US:C', 'US:A', 'US:D'])
  assert.equal(symbols.size, 3)
})

test('过期映射读到即失效, 并顺便清掉', () => {
  let now = 0
  const symbols = createUsSymbols({ now: () => now, limit: 10, ttl: 1000 })
  symbols.set('US:A', entry(now))
  now = 999
  assert.equal(symbols.get('US:A').jys, 'OQ', '未过期照常命中')
  now = 1001
  assert.equal(symbols.get('US:A'), undefined, '过期视为没有')
  assert.equal(symbols.has('US:A'), false, '读到过期即删除, 不留在表里')
})

test('容器仍是 Map: 适配器可以原样使用', () => {
  const symbols = createUsSymbols()
  assert.equal(symbols instanceof Map, true)
  symbols.set('US:AAPL', entry(0))
  assert.deepEqual([...symbols.entries()].map(([key]) => key), ['US:AAPL'])
  assert.equal(symbols.size, 1)
})
