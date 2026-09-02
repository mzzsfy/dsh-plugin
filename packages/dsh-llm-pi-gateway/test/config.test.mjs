// 路由配置 BDD:compat 全控校验(字段名单 + 空值拒绝)/ 模型级覆盖 / 模型解析 /
// 凭据链(官方同构,无凭据服务时回落启动环境)/ 会话标记默认开启与逐路由关闭。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoute, modelOf, mergeCompat, validateCompat } from '../src/config.mjs'
import { createCredentialResolver } from '../src/credentials.mjs'

const NO_SERVICES = { get: () => undefined }
const resolveApiKey = createCredentialResolver(NO_SERVICES)

const BASE_PROFILE = {
  api: 'anthropic-messages',
  baseURL: 'https://gw.example.com',
  models: [{ id: 'auto', contextWindow: 200000 }],
}

function codeOf(fn) {
  try {
    fn()
    return undefined
  } catch (error) {
    return error.code
  }
}

test('合法路由解析:标记默认开启,模型按 id 索引', () => {
  const route = resolveRoute('new-api', BASE_PROFILE)
  assert.equal(route.sessionMarker.enabled, true)
  assert.equal(route.models.get('auto').id, 'auto')
  assert.deepEqual(route.models.get('auto').compat, {})
})

test('compat 未知字段拒绝(按协议名单)', () => {
  assert.equal(validateCompat('anthropic-messages', { sendSessionAffinityHeaders: true }, 'w').sendSessionAffinityHeaders, true)
  assert.equal(codeOf(() => validateCompat('anthropic-messages', { supportsStore: true }, 'w')), 'INVALID_CONFIG')
  assert.equal(validateCompat('openai-completions', { supportsStore: true }, 'w').supportsStore, true)
  assert.equal(validateCompat('openai-responses', { supportsToolSearch: true }, 'w').supportsToolSearch, true)
})

test('compat 值为 null/undefined 拒绝', () => {
  assert.equal(codeOf(() => validateCompat('anthropic-messages', { allowEmptySignature: null }, 'w')), 'INVALID_CONFIG')
})

test('未知协议与空 baseURL 拒绝', () => {
  assert.equal(codeOf(() => resolveRoute('p', { ...BASE_PROFILE, api: 'gemini' })), 'INVALID_CONFIG')
  assert.equal(codeOf(() => resolveRoute('p', { ...BASE_PROFILE, baseURL: '' })), 'INVALID_CONFIG')
})

test('compat 浅合并:模型级字段优先', () => {
  assert.deepEqual(
    mergeCompat({ a: 1, b: 2 }, { b: 3 }),
    { a: 1, b: 3 },
  )
  const route = resolveRoute('new-api', {
    ...BASE_PROFILE,
    compat: { sendSessionAffinityHeaders: true },
    models: [
      { id: 'auto', contextWindow: 200000 },
      { id: 'gpt-4o', contextWindow: 128000, compat: { sendSessionAffinityHeaders: false } },
    ],
  })
  assert.equal(route.models.get('auto').compat.sendSessionAffinityHeaders, true)
  assert.equal(route.models.get('gpt-4o').compat.sendSessionAffinityHeaders, false)
})

test('未知模型返回 UNKNOWN_MODEL', () => {
  const route = resolveRoute('new-api', BASE_PROFILE)
  assert.equal(codeOf(() => modelOf(route, 'nope')), 'UNKNOWN_MODEL')
})

test('models 缺失或重复 id 拒绝', () => {
  assert.equal(codeOf(() => resolveRoute('p', { api: 'anthropic-messages', baseURL: 'x' })), 'INVALID_CONFIG')
  assert.equal(codeOf(() => resolveRoute('p', {
    ...BASE_PROFILE,
    models: [{ id: 'a' }, { id: 'a' }],
  })), 'INVALID_CONFIG')
})

test('凭据链:未配置 undefined,配置而缺失 MISSING_CREDENTIAL,命中返回修剪后密钥', async () => {
  assert.equal(await resolveApiKey('p', undefined), undefined)
  const missing = resolveApiKey('p', 'DEFINITELY_UNSET_ENV_4711')
  await assert.rejects(missing, (error) => error.code === 'MISSING_CREDENTIAL')
  process.env.DEFINITELY_UNSET_ENV_4711 = '  sk-test  '
  assert.equal(await resolveApiKey('p', 'DEFINITELY_UNSET_ENV_4711'), 'sk-test')
  delete process.env.DEFINITELY_UNSET_ENV_4711
})

test('凭据链:空白密钥与不可入头字符拒绝(INVALID_CREDENTIAL)', async () => {
  process.env.CRED_TEST_BLANK_1 = '   '
  await assert.rejects(
    resolveApiKey('p', 'CRED_TEST_BLANK_1'),
    (error) => error.code === 'INVALID_CREDENTIAL',
  )
  delete process.env.CRED_TEST_BLANK_1
  process.env.CRED_TEST_NEWLINE_1 = 'sk-\ntest'
  await assert.rejects(
    resolveApiKey('p', 'CRED_TEST_NEWLINE_1'),
    (error) => error.code === 'INVALID_CREDENTIAL',
  )
  delete process.env.CRED_TEST_NEWLINE_1
})

test('sessionMarker.enabled false 关闭路由标记', () => {
  const route = resolveRoute('p', {
    ...BASE_PROFILE,
    sessionMarker: { enabled: false },
  })
  assert.equal(route.sessionMarker.enabled, false)
})

test('metadata 模板原样保存在路由上', () => {
  const template = { user_id: '{"session":"{sessionId}"}' }
  assert.deepEqual(resolveRoute('p', { ...BASE_PROFILE, metadata: template }).metadata, template)
})
