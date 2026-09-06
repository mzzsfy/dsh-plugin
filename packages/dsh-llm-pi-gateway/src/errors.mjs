// 错误边界:跨包副本靠 own code / failure 数据属性被 dsh-llm 识别
// (adapter-failure 的 ownFailureSnapshot / ownErrorCode 协议),无需继承 LlmError。

/** 携带 harness 语义错误码的网关错误。 */
export class GatewayError extends Error {
  /**
   * @param {string} message 错误信息
   * @param {string} code harness 错误码,如 UNKNOWN_MODEL / MISSING_CREDENTIAL
   * @param {ErrorOptions} [options] 标准 ErrorOptions,cause 透传底层根因
   */
  constructor(message, code, options) {
    super(message, options)
    this.name = 'GatewayError'
    this.code = code
    this.failure = Object.freeze({ message, code })
  }
}

/**
 * 接管失败日志选文:settings 命名空间注册冲突(patch 失效、官方插件仍在)与
 * 其他接管失败区分,消除「官方插件仍在?」对非冲突场景的误导归因。
 * @param {unknown} error 捕获到的错误
 */
export function takeoverFailureText(error) {
  const conflict = error instanceof Error &&
    /^settings namespace "[^"]+" is already registered$/.test(error.message)
  return conflict
    ? 'llm-pi-gateway: 官方 llm-pi-ai 节注册冲突:官方 llm-pi-ai 插件仍在(patch 失效),降级为只服务 llm-pi-gateway 节'
    : 'llm-pi-gateway: 官方 llm-pi-ai 节接管失败,降级为只服务 llm-pi-gateway 节'
}
