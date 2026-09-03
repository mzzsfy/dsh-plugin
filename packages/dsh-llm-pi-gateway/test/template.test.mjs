// metadata 模板 BDD:占位符替换 / 非字符串透传 / {marker} 引用判定。
// 标记注入走 injectSessionMarker(marker.test)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTemplate, templateUsesMarker } from '../src/template.mjs'

const VARS = { sessionId: 'session-a', marker: 'dsh:deadbeef' }

test('字符串占位符替换', () => {
  assert.equal(
    renderTemplate('{"session":"{sessionId}","mark":"{marker}"}', VARS),
    '{"session":"session-a","mark":"dsh:deadbeef"}',
  )
})

test('非字符串值原样透传,对象与数组递归', () => {
  assert.equal(renderTemplate(7, VARS), 7)
  assert.equal(renderTemplate(null, VARS), null)
  assert.deepEqual(renderTemplate({ a: ['{sessionId}', 1] }, VARS), { a: ['session-a', 1] })
})

test('深嵌套对象递归渲染;undefined 值原样', () => {
  const template = { a: { b: { c: ['{marker}', { d: '{sessionId}' }] } }, e: undefined }
  const rendered = renderTemplate(template, VARS)
  assert.deepEqual(rendered.a.b.c[1], { d: 'session-a' })
  assert.equal(rendered.a.b.c[0], 'dsh:deadbeef')
  assert.equal('e' in rendered, true)
})

test('templateUsesMarker:字符串包含即引用,递归覆盖数组与对象', () => {
  assert.equal(templateUsesMarker('plain'), false)
  assert.equal(templateUsesMarker('{marker}'), true)
  assert.equal(templateUsesMarker(['x', { y: '{sessionId}' }]), false)
  assert.equal(templateUsesMarker({ a: [{ b: 'prefix-{marker}-suffix' }] }), true)
  assert.equal(templateUsesMarker(null), false)
})

