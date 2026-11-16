// 有界 LRU 缓存 BDD:容量上限、按最近使用淘汰、命中重排。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLru } from '../src/lru.mjs'

const LIMIT = 3

test('写入超上限淘汰最久未用键,容量不增长', () => {
  const lru = createLru(LIMIT)
  for (const key of ['a', 'b', 'c']) lru.set(key, key)
  assert.equal(lru.size, LIMIT)
  lru.set('d', 'd')
  assert.equal(lru.size, LIMIT)
  assert.equal(lru.get('a'), undefined)
  assert.equal(lru.get('d'), 'd')
})

test('读取命中重排最近使用序,最久未读者先被淘汰', () => {
  const lru = createLru(LIMIT)
  for (const key of ['a', 'b', 'c']) lru.set(key, key)
  assert.equal(lru.get('a'), 'a')
  lru.set('d', 'd')
  assert.equal(lru.get('b'), undefined)
  assert.equal(lru.get('a'), 'a')
  assert.equal(lru.get('c'), 'c')
})

test('同键覆盖不占额外容量且取最新值', () => {
  const lru = createLru(LIMIT)
  lru.set('a', 1)
  lru.set('b', 2)
  assert.equal(lru.set('a', 3), 3)
  assert.equal(lru.size, 2)
  assert.equal(lru.get('a'), 3)
})

test('缺键读取返回 undefined 且不改变容量', () => {
  const lru = createLru(LIMIT)
  lru.set('a', 1)
  assert.equal(lru.get('missing'), undefined)
  assert.equal(lru.size, 1)
})
