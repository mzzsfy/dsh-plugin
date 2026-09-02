// 凭据解析链(官方 resolveApiKey 同构):凭据 seam 引用优先,
// 启动环境兜底,缺失即 MISSING_CREDENTIAL,可用性经官方校验器。
// 服务经闭包注入,模块保持纯逻辑可测。

import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'

/**
 * 构造路由凭据解析器(官方 resolveApiKey 同构)。
 * @param {object} ctx 插件上下文(可选读取 credentials 服务)
 * @returns {(provider: string, ref?: string) => Promise<string|undefined>} 未配置引用返回 undefined,配置而缺失抛 MISSING_CREDENTIAL
 */
export function createCredentialResolver(ctx) {
  return async (provider, ref) => {
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined && isCredentialRefName(ref)
      ? (await credentials.resolve(credentialRef(ref)))?.value
      : undefined
    const value = hit !== undefined ? hit : launchEnvironmentOf(ctx).get(ref)?.value
    if (value !== undefined && value.length > 0) {
      return assertUsableApiKey(value, 'llm-pi-gateway', ref)
    }
    throw Object.assign(new Error(
      `llm-pi-gateway: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the web Models page writes it) or export it`,
    ), { code: 'MISSING_CREDENTIAL' })
  }
}
