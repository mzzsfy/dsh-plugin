// llm-pi-gateway Host 半区:注册 settings 命名空间 llm-pi-gateway,按其路由表
// 经 ctx.llm 注册网关 adapter。配置只在启动解析一次,修改需重启生效。

import z from '@deepseek-ai/schemastery'
import { resolveRoute } from './config.mjs'
import { createGatewayAdapter } from './adapter.mjs'

export const name = 'llm-pi-gateway'

const NS = 'llm-pi-gateway'

export const inject = ['llm', 'settings']

const modelEntry = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number(),
  reasoning: z.boolean(),
  input: z.array(z.union(['text', 'image'])),
  compat: z.dict(z.any()),
})

const providerEntry = z.object({
  api: z.union(['anthropic-messages', 'openai-completions', 'openai-responses']),
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  sessionMarker: z.object({
    enabled: z.boolean().default(true),
    prefix: z.string(),
  }),
  metadata: z.dict(z.any()),
  compat: z.dict(z.any()),
  headers: z.dict(z.string()),
  cacheRetention: z.union(['none', 'short', 'long']),
  contextWindow: z.number(),
  models: z.array(modelEntry),
})

export const Config = z.object({
  providers: z.dict(providerEntry).default({}),
})

/** 启动时一次性解析路由表;任一路由不可服务即加载失败(fail loud)。 */
function resolveRoutes(providers) {
  const routes = new Map()
  for (const [provider, profile] of Object.entries(providers ?? {})) {
    routes.set(provider, resolveRoute(provider, profile))
  }
  return routes
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  ctx.inject(['settings'], (sctx) => {
    const { resolved } = sctx.settings.register(NS, Config, { base: config })
    const routes = resolveRoutes(resolved?.providers)
    if (routes.size === 0) return
    const adapter = createGatewayAdapter(routes)
    ctx.effect(
      () => ctx.llm.registerAdapter([...routes.keys()], adapter),
      'llm-pi-gateway adapter routes',
    )
  })
}
