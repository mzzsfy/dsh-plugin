// llm-pi-gateway Host 半区:注册 settings 命名空间 llm-pi-gateway,按其路由表
// 经 ctx.llm 注册网关 adapter。配置经 settings onChange 热更新,解析失败保旧。

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { Config as OfficialConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { mergeProviderSections, resolveRoutes, OFFICIAL_SETTINGS_NS, SETTINGS_NS, THINKING_LEVELS } from './config.mjs'
import { createGatewayAdapter } from './adapter.mjs'
import { createCredentialResolver } from './credentials.mjs'
import { createRouteManager } from './manager.mjs'
import { discoverModels } from './discovery.mjs'

export const name = 'llm-pi-gateway'

const NS = SETTINGS_NS
const OFFICIAL_NS = OFFICIAL_SETTINGS_NS

export const inject = ['llm', 'settings']

const reasoningEfforts = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))

const modelEntry = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number(),
  input: z.array(z.union(['text', 'image'])),
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  compat: z.dict(z.any()),
})

const providerEntry = z.object({
  api: z.union(['anthropic-messages', 'openai-completions', 'openai-responses']),
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string(),
  reasoning: z.union(THINKING_LEVELS),
  thinkingBudgets: z.dict(z.any()),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  cacheRetention: z.union(['none', 'short', 'long']),
  defaultContextWindow: z.number(),
  defaultMaxTokens: z.number(),
  defaultInput: z.array(z.union(['text', 'image'])),
  maxRequestImageBytes: z.number(),
  requestImagePixelBudget: z.number(),
  requestImageMaxBytes: z.number(),
  retryPolicy: RetryPolicySchema,
  sessionMarker: z.object({
    enabled: z.boolean().default(true),
    prefix: z.string(),
  }),
  metadata: z.dict(z.any()),
  compat: z.dict(z.any()),
  headers: z.dict(z.string()),
  models: z.array(modelEntry),
})

export const Config = z.object({
  providers: z.dict(providerEntry).default({}),
})

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  // 两节来源:官方节(官方 schema 消费,零感知接管)+ 本包节(独立/增强)。
  // 合并路由表按原始快照恒等记忆;任一节解析即抛,记忆保持旧值,
  // 调用方捕获后沿用上一份好配置(官方同款)。
  let readOfficial = () => undefined
  let readGateway = () => config
  let lastSnapshot
  let memoized
  const snapshot = () => [readOfficial(), readGateway()]
  const profiles = () => {
    const current = snapshot()
    if (lastSnapshot !== undefined
      && current[0] === lastSnapshot[0] && current[1] === lastSnapshot[1]) return memoized
    const next = resolveRoutes(current[0]?.providers, current[1]?.providers)
    lastSnapshot = current
    memoized = next
    return next
  }
  // 凭据解析器无状态,单例闭包复用(adapter 注册与模型发现共用)
  const resolveCredential = createCredentialResolver(ctx)
  const adapter = createGatewayAdapter(profiles, undefined, resolveCredential, () => ctx.get('attachments'), (reason) => {
    ctx.logger.warn('llm-pi-gateway: replay 降级为 provider 中性历史: ' + reason)
  }, (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref))
  const manager = createRouteManager({
    routes: profiles,
    adapter,
    registerAdapter: (providers, registered) => ctx.llm.registerAdapter(providers, registered),
    registerDirectory: (entries) => ctx.llm.registerConfigurableProviders(entries),
  })
  ctx.llm.registerModelDiscovery(NS, (request) => discoverModels(request, () => resolveCredential(request.provider, profiles().get(request.provider)?.apiKeyEnv)))
  const onSectionChange = () => {
    try {
      manager.ensureRegistration()
    } catch (error) {
      ctx.logger.error('llm-pi-gateway: 拒绝的更新后保留先前注册的路由')
      ctx.logger.error(error)
    }
    try {
      manager.ensureDirectory()
    } catch (error) {
      ctx.logger.error('llm-pi-gateway: 拒绝的更新后保留先前的可配置目录')
      ctx.logger.error(error)
    }
  }
  // 官方节接管:官方插件被本包 patch 禁用后,其 settings 节由本包以官方
  // schema 注册。若注册冲突(patch 失效、官方仍在),降级为只服务本包节。
  // validate 拒绝组合后不可解析的官方节,防坏配置穿透 profiles 快照记忆。
  try {
    ctx.settings.installSection(ctx, OFFICIAL_NS, OfficialConfig, undefined, {
      validate: (section) => resolveRoutes(section.providers, readGateway()?.providers),
      setSource: (source) => {
        readOfficial = source
      },
      onChange: () => onSectionChange(),
    })
  } catch (error) {
    ctx.logger.error('llm-pi-gateway: 官方 llm-pi-ai 节接管失败(官方插件仍在?),降级为只服务 llm-pi-gateway 节')
    ctx.logger.error(error)
  }
  ctx.settings.installSection(ctx, NS, Config, config, {
    validate: (section) => resolveRoutes(readOfficial()?.providers, section.providers),
    setSource: (source) => {
      readGateway = source
    },
    onChange: () => onSectionChange(),
  })
  // 启动 fail loud:组合后不可服务的配置在加载期失败(与官方一致)
  profiles()
  onSectionChange()
}
