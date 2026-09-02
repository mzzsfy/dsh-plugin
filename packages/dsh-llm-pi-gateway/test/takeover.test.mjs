// 零感知接管 BDD:gateway 接管官方 llm-pi-ai 节(官方 schema 消费),
// 路由表 = 官方节 ∪ gateway 节(同名 gateway 节整体优先);目录条目按
// 来源节寻址;官方 Config 经本包 resolveRoute 全字段兼容。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeProviderSections } from '../src/config.mjs'

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

test('目录条目 settingsNs 按来源节寻址', () => {
  const merged = mergeProviderSections({ newapi: OFFICIAL_ROUTE }, { 'new-api': OFFICIAL_ROUTE })
  const entries = [...merged.entries()].map(([provider, route]) => ({
    provider,
    settingsNs: route.source,
  }))
  const nsOf = Object.fromEntries(entries.map((entry) => [entry.provider, entry.settingsNs]))
  assert.equal(nsOf.newapi, 'llm-pi-ai')
  assert.equal(nsOf['new-api'], 'llm-pi-gateway')
})

test('官方 Config schema 消费官方节形状(真实官方导出)', async () => {
  const official = await import('@deepseek-ai/dsh-llm-pi-ai')
  const parsed = official.Config({ providers: { newapi: OFFICIAL_ROUTE } })
  assert.equal(parsed.providers.newapi.baseURL, 'https://newapi.it.jze100.com/')
  assert.equal(parsed.providers.newapi.models[0].id, 'auto')
  return parsed
})

test('官方 schema 规范化产物(modelOverrides/input 补全)经 resolveRoutes 不被拒绝', async () => {
  const { resolveRoutes } = await import('../src/config.mjs')
  const official = await import('@deepseek-ai/dsh-llm-pi-ai')
  const parsed = official.Config({ providers: { newapi: OFFICIAL_ROUTE } })
  const routes = resolveRoutes(parsed.providers, undefined)
  assert.equal(routes.get('newapi').api, 'anthropic-messages')
  assert.equal(routes.get('newapi').source, 'llm-pi-ai')
  assert.equal(routes.get('newapi').models.size, 1)
  assert.ok(routes.get('newapi').models.has('auto'))
})
