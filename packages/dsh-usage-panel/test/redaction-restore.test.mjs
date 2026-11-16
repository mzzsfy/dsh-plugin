// 脱敏占位符回存:配得上就还原旧密钥,配不上必须拒绝落盘(不能把 [已隐藏] 当凭据)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { __test } from '../src/index.js'

const {
  redactAccount,
  redactUrl,
  redactTextSecrets,
  restoreHeaders,
  restoreBody,
  restoreUrl,
  findRedacted,
  assertRestored,
  assertRestoredUrl,
  REDACTED,
} = __test

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

// P3:URL query token 与上游错误体同样属凭据面,响应侧必须脱敏
test('custom.url 的敏感查询参数脱敏,回存按参数名还原', () => {
  const url = 'https://user:pw123@example.test/usage?token=query-secret&model=x'
  const redacted = redactUrl(url)
  assert.equal(redacted.includes('query-secret'), false)
  assert.equal(decodeURIComponent(redacted).includes(REDACTED), true)
  const restored = restoreUrl(redacted, url)
  assert.equal(restored.includes('query-secret'), true)
  assert.doesNotThrow(() => assertRestoredUrl(restored))
  // 参数名被改后占位无法还原:拒绝落盘
  const broken = redacted.replace('token=', 'tokenx=')
  assert.throws(() => assertRestoredUrl(broken), /无法还原/)
})

test('上游错误体中的账号 Key 与常见 token 形态响应侧脱敏', () => {
  const text = 'HTTP 401: {"error":"bad key sk-live-abcdefgh","echo":"Bearer sk-other-123456"}'
  const redacted = redactTextSecrets(text, ['sk-live-abcdefgh'])
  assert.equal(redacted.includes('sk-live-abcdefgh'), false)
  assert.equal(redacted.includes('sk-other-123456'), false)
  assert.match(redacted, /HTTP 401/)
})
