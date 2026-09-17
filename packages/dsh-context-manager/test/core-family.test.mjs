import test from 'node:test'
import assert from 'node:assert/strict'

import {
  forkFailureText,
  forkRetryText,
  sessionFamilyMap,
  familyRing,
} from '../src/core.mjs'

// ── fork 锚点解析 ──

test('Given 插件注入消息, When forkRetryText, Then 返回 null', () => {
  assert.equal(forkRetryText({ source: { kind: 'plugin' }, content: [{ type: 'text', text: 'hi' }] }), null)
})

test('Given 纯图或空白 user 消息, When forkRetryText, Then 返回 null', () => {
  assert.equal(forkRetryText({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] }), null)
  assert.equal(forkRetryText({ source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] }), null)
})

test('Given undefined 或畸形 data, When forkRetryText, Then 返回 null', () => {
  assert.equal(forkRetryText(undefined), null)
  assert.equal(forkRetryText({}), null)
  assert.equal(forkRetryText({ source: { kind: 'user' } }), null)
})

test('Given 多文本块 user 消息, When forkRetryText, Then 按行拼接且跳过图块', () => {
  const text = forkRetryText({
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '第一行' },
      { type: 'image', attachment: {} },
      { type: 'text', text: '第二行' },
    ],
  })
  assert.equal(text, '第一行\n第二行')
})

test('Given user 消息先于 turn/start(无门), When forkRetryText, Then 照常提取', () => {
  assert.equal(forkRetryText({ source: { kind: 'user' }, content: [{ type: 'text', text: '首问' }] }), '首问')
})

// ── 家族谱系投影 ──

test('Given 空/畸形输入, When sessionFamilyMap, Then 返回空 Map', () => {
  assert.equal(sessionFamilyMap(undefined).size, 0)
  assert.equal(sessionFamilyMap([]).size, 0)
  assert.equal(sessionFamilyMap([null, {}, { sessionId: '' }]).size, 0)
})

test('Given 直链家族 根→A→B, When sessionFamilyMap, Then 各成员链正确且同根', () => {
  const items = [
    { sessionId: 'root', updatedAt: 3 },
    { sessionId: 'a', parentSessionId: 'root', updatedAt: 1 },
    { sessionId: 'b', parentSessionId: 'a', updatedAt: 2 },
  ]
  const chains = sessionFamilyMap(items)
  assert.deepEqual(chains.get('b').chain, ['root', 'a', 'b'])
  assert.equal(chains.get('b').root, 'root')
  assert.equal(chains.get('a').root, 'root')
  assert.equal(chains.get('root').root, 'root')
})

test('Given parentSessionId 指向不存在的会话(孤儿), When sessionFamilyMap, Then 视为独立根', () => {
  const chains = sessionFamilyMap([{ sessionId: 'x', parentSessionId: 'ghost' }])
  assert.equal(chains.get('x').root, 'x')
  assert.deepEqual(chains.get('x').chain, ['x'])
})

test('Given 循环引用, When sessionFamilyMap, Then 不死循环', () => {
  const chains = sessionFamilyMap([
    { sessionId: 'p', parentSessionId: 'q' },
    { sessionId: 'q', parentSessionId: 'p' },
  ])
  assert.ok(chains.get('p').chain.length <= 2)
})

// ── 家族环计数 ──

test('Given 家族 3 成员, When familyRing(中间 updatedAt), Then index=2 total=3 members 按 updatedAt 升序', () => {
  const chains = sessionFamilyMap([
    { sessionId: 'root', updatedAt: 30 },
    { sessionId: 'a', parentSessionId: 'root', updatedAt: 10 },
    { sessionId: 'b', parentSessionId: 'root', updatedAt: 20 },
  ])
  const ring = familyRing(chains, 'b')
  assert.deepEqual(ring, { index: 2, total: 3, members: ['a', 'b', 'root'] })
})

test('Given 单成员家族, When familyRing, Then 返回 null', () => {
  const chains = sessionFamilyMap([{ sessionId: 'only' }])
  assert.equal(familyRing(chains, 'only'), null)
})

test('Given 目标不在投影内, When familyRing, Then 返回 null', () => {
  assert.equal(familyRing(new Map(), 'nope'), null)
  assert.equal(familyRing(undefined, 'nope'), null)
})

test('Given fork 错误码, When forkFailureText, Then 已知码映射中文未知码透出', () => {
  assert.equal(forkFailureText('session/fork-unavailable'), '该轮尚未完成,不可分叉')
  assert.equal(forkFailureText('session/workspace-attach-failed'), '分叉成功,但挂载到工作区失败')
  assert.equal(forkFailureText('gateway/internal'), '分叉失败: gateway/internal')
  assert.equal(forkFailureText(undefined), '分叉失败: 未知错误')
})
