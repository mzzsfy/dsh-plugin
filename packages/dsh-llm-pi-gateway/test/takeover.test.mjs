// 零感知接管 BDD:gateway 接管官方 llm-pi-ai 节(官方 schema 消费),
// 路由表 = 官方节 ∪ gateway 节(同名 gateway 节整体优先);目录条目按
// 来源节寻址;官方 Config 经本包 resolveRoute 全字段兼容。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeProviderSections, resolveRoutes } from '../src/config.mjs'

const OFFICIAL_ROUTE = {
  apiKeyEnv: 'NEWAPI_API_KEY',
  api: 'anthropic-messages',
  baseURL: 'https://newapi.it.jze100.com/',
  models: [{ id: 'auto' }],
}

test('官方节与 gateway 节路由并集,来源标记正确', () => {
  const merged = mergeProviderSections(
    { newapi: OFFICIAL_ROUTE },
    { 'new-api': { ...OFFICIAL_ROUTE, baseURL: 'https://newapi.it.jze100.com' } },
  )
  assert.equal(merged.size, 2)
  assert.equal(merged.get('newapi').source, 'llm-pi-ai')
  assert.equal(merged.get('new-api').source, 'llm-pi-gateway')
})

test('同名路由 gateway 节整体优先,官方条目弃用', () => {
  const merged = mergeProviderSections(
    { a: { ...OFFICIAL_ROUTE, apiKeyEnv: 'OFFICIAL_KEY' } },
    { a: { ...OFFICIAL_ROUTE, apiKeyEnv: 'GATEWAY_KEY' } },
  )
  assert.equal(merged.size, 1)
  assert.equal(merged.get('a').apiKeyEnv, 'GATEWAY_KEY')
  assert.equal(merged.get('a').source, 'llm-pi-gateway')
})

test('空官方节只有 gateway 节;两节全空为空表', () => {
  const onlyGateway = mergeProviderSections(undefined, { a: OFFICIAL_ROUTE })
  assert.equal(onlyGateway.size, 1)
  const empty = mergeProviderSections(undefined, undefined)
  assert.equal(empty.size, 0)
})

// 官方目录形态:仅凭据声明,无协议/端点/模型目录,仅官方节合法,gateway 节不豁免
const CATALOG_PROFILE = { apiKeyEnv: 'X_KEY' }

test('场景: 官方节为目录形态而 gateway 节正常,resolveRoutes 跳过目录路由并上报,返回表只含 gateway 路由', () => {
  const unserviceable = []
  const routes = resolveRoutes(
    { catalog: CATALOG_PROFILE },
    { 'new-api': OFFICIAL_ROUTE },
    (provider, reason) => unserviceable.push([provider, reason]),
  )
  assert.deepEqual(unserviceable.map(([provider]) => provider), ['catalog'])
  assert.match(unserviceable[0][1], /官方目录形态/)
  assert.equal(routes.has('catalog'), false)
  assert.ok(routes.has('new-api'), 'gateway 节路由不受目录路由跳过影响')
})

test('场景: 目录形态出现在 gateway 节,resolveRoutes 硬拒抛 INVALID_CONFIG(不允许 gateway 节 skip)', () => {
  assert.throws(
    () => resolveRoutes(undefined, { catalog: CATALOG_PROFILE }),
    (error) => error.code === 'INVALID_CONFIG',
  )
})

test('场景: 同一 provider 两节同名,gateway 节整体优先,resolveRoutes 产物来源为 gateway 节', () => {
  const routes = resolveRoutes(
    { a: { ...OFFICIAL_ROUTE, apiKeyEnv: 'OFFICIAL_KEY' } },
    { a: OFFICIAL_ROUTE },
  )
  assert.equal(routes.size, 1)
  assert.equal(routes.get('a').source, 'llm-pi-gateway')
  assert.equal(routes.get('a').apiKeyEnv, OFFICIAL_ROUTE.apiKeyEnv, '官方节条目整体弃用,取 gateway 节声明')
})

test('官方 Config schema 消费官方节形状(真实官方导出):baseURL/models 解析产物', async () => {
  const official = await import('@deepseek-ai/dsh-llm-pi-ai')
  const parsed = official.Config({ providers: { newapi: OFFICIAL_ROUTE } })
  assert.equal(parsed.providers.newapi.baseURL, 'https://newapi.it.jze100.com/')
  assert.equal(parsed.providers.newapi.models[0].id, 'auto')
  return parsed
})

test('官方 schema 规范化产物(含 modelOverrides 键与目录 compat)经 resolveRoutes 不被本包校验拒绝', async () => {
  const { resolveRoutes } = await import('../src/config.mjs')
  const official = await import('@deepseek-ai/dsh-llm-pi-ai')
  // 官方 schema 允许的 modelOverrides 键(空对象即官方对无目录路由的默认产物形态)
  const parsed = official.Config({ providers: { newapi: { ...OFFICIAL_ROUTE, modelOverrides: {} } } })
  const routes = resolveRoutes(parsed.providers, undefined)
  const route = routes.get('newapi')
  assert.equal(route.api, 'anthropic-messages')
  assert.equal(route.source, 'llm-pi-ai')
  assert.equal(route.models.size, 1)
  assert.ok(route.models.has('auto'))
  assert.equal('modelOverrides' in route, false, '本包路由对象不携带该键,但解析不得因它抛错')
})
