// 脱敏占位符回存:配得上就还原旧密钥,配不上必须拒绝落盘(不能把 [已隐藏] 当凭据)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { __test } from '../src/index.js'

const { redactAccount, restoreHeaders, restoreBody, findRedacted, assertRestored, REDACTED } = __test

const SECRET_HEADER = 'Bearer sk-secret'
const SECRET_TOKEN = 'token-secret'
const account = {
  id: 'a1',
  apiKey: '',
  custom: {
    headers: { Authorization: SECRET_HEADER },
    body: JSON.stringify({ auth: { token: SECRET_TOKEN }, model: 'x' }, null, 2),
  },
}

test('脱敏输出只留占位符,不回传明文', () => {
  const redacted = redactAccount(account)
  assert.equal(redacted.custom.headers.Authorization, REDACTED)
  assert.doesNotMatch(redacted.custom.body, /token-secret/)
})

test('原样回存:按字段路径还原真值', () => {
  const headers = restoreHeaders({ Authorization: REDACTED }, account.custom.headers)
  assert.equal(headers.Authorization, SECRET_HEADER)
  const body = restoreBody(JSON.stringify(JSON.parse(account.custom.body), null, 2), account.custom.body)
  assert.match(body, /token-secret/)
  assert.equal(findRedacted(JSON.parse(body)), undefined)
})

test('改键名导致配不上:findRedacted 定位后拒绝保存', () => {
  const headers = restoreHeaders({ AuthorizationX: REDACTED }, account.custom.headers)
  assert.equal(findRedacted(headers, 'headers'), 'headers.AuthorizationX')
  assert.throws(() => assertRestored({ headers, body: account.custom.body }), /无法还原/)
})

test('数组内占位符按位次还原旧值', () => {
  const existing = JSON.stringify([{ token: SECRET_TOKEN }, { token: 'other' }])
  const submitted = JSON.stringify([{ token: REDACTED }, { token: 'other' }])
  const body = restoreBody(submitted, existing)
  assert.doesNotThrow(() => assertRestored({ headers: {}, body }))
  assert.match(body, /token-secret/)
})

test('请求体 JSON 被改坏且含占位符:拒绝保存', () => {
  assert.throws(() => assertRestored({ headers: {}, body: '{"auth": {"token": "[已隐藏]"' }), /JSON 已改动/)
})

test('全新字段没有占位符:不误判', () => {
  assert.doesNotThrow(() => assertRestored({ headers: { 'X-Trace': 'plain' }, body: '{"model":"x"}' }))
})
