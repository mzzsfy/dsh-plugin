// metadata 模板 BDD:占位符替换 / 非字符串透传。标记注入走 injectSessionMarker(marker.test)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTemplate } from '../src/template.mjs'

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

