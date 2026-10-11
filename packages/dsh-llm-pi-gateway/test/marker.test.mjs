// 标记器 BDD:派生稳定性 / 隔离性 / 格式。请求体注入 helper 已随接管形态退役。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMarker, DEFAULT_MARKER_PREFIX } from '../src/marker.mjs'

const HEX = /^[0-9a-f]+$/

test('同 id 派生恒定,异 id 派生不同', () => {
  const a = deriveMarker('session-a')
  assert.equal(a, deriveMarker('session-a'))
  assert.notEqual(a, deriveMarker('session-b'))
})

test('标记格式为 dsh:<40 位 hex>,不含原始会话 id', () => {
  const marker = deriveMarker('secret-session-id')
  const [prefix, hash] = marker.split(':')
  assert.equal(prefix, 'dsh')
  assert.equal(hash.length, 40)
  assert.match(hash, HEX)
  assert.ok(!marker.includes('secret-session-id'))
})

test('前缀可配,默认前缀导出稳定', () => {
  assert.ok(deriveMarker('s', 'rstui').startsWith('rstui:'))
  assert.equal(DEFAULT_MARKER_PREFIX, 'dsh')
})
