import test from 'node:test'
import assert from 'node:assert/strict'
import { createWaitSkipRegistry } from '../src/lib/wait-skip.mjs'

// Given 同键注册两个 wait,When skip 该键,Then 两个都被 abort 且注册表移除该键
test('skip 注册表_同键全部中断_键随即清空', () => {
  const registry = createWaitSkipRegistry()
  const first = new AbortController()
  const second = new AbortController()
  registry.register('session-a:term-a', first)
  registry.register('session-a:term-a', second)
  const skipped = registry.skip('session-a', 'term-a')
  assert.equal(skipped, 2)
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, true)
  assert.equal(registry.skip('session-a', 'term-a'), 0, '键已移除,重复 skip 幂等')
})

// Given 不同键,When skip 其中一键,Then 另一键不受影响
test('skip 注册表_跨键隔离', () => {
  const registry = createWaitSkipRegistry()
  const a = new AbortController()
  const b = new AbortController()
  registry.register('session-a:term-a', a)
  registry.register('session-a:term-b', b)
  assert.equal(registry.skip('session-a', 'term-a'), 1)
  assert.equal(b.signal.aborted, false)
})

// Given 注册后正常返回,When release,Then 仅移除自身
test('skip 注册表_release_仅移除自身', () => {
  const registry = createWaitSkipRegistry()
  const a = new AbortController()
  const b = new AbortController()
  registry.register('s:t', a)
  registry.register('s:t', b)
  registry.release('s:t', a)
  assert.equal(registry.skip('s', 't'), 1)
  assert.equal(b.signal.aborted, true)
})
