// 凭据解析链(官方 resolveApiKey 同构):credentials 服务在场即唯一来源
// (未命中即 MISSING_CREDENTIAL,不回落启动环境,防已删除凭据被过期环境变量
// 静默复活),服务缺席才走启动环境。缺失即 MISSING_CREDENTIAL(GatewayError
// 携 failure 信封,经宿主错误边界保真归因,不用裸 Error 丢码为 UNKNOWN)。
// apiKeyEnv 引用名合法性在配置解析期校验(config.mjs isCredentialRefName,
// 官方配置期拒绝同构),非法名到不了本模块。

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { GatewayError } from './errors.mjs'

/**
 * 构造路由凭据解析器(官方 resolveApiKey 同构)。
 * @param {object} ctx 插件上下文(可选读取 credentials 服务)
 * @returns {(provider: string, ref?: string) => Promise<string|undefined>} 未配置引用返回 undefined,配置而缺失抛 MISSING_CREDENTIAL
 */
export function createCredentialResolver(ctx) {
  return async (provider, ref) => {
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const value = credentials !== undefined
      ? (await credentials.resolve(credentialRef(ref)))?.value
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (value !== undefined && value.length > 0) {
      return assertUsableApiKey(value, 'llm-pi-gateway', ref)
    }
    throw new GatewayError(
      `llm-pi-gateway: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the web Models page writes it) or export it`,
      'MISSING_CREDENTIAL',
    )
  }
}
