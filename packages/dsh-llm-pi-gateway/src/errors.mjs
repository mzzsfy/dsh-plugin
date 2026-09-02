// 错误边界:跨包副本靠 own code / failure 数据属性被 dsh-llm 识别
// (adapter-failure 的 ownFailureSnapshot / ownErrorCode 协议),无需继承 LlmError。

/** 携带 harness 语义错误码的网关错误。 */
export class GatewayError extends Error {
  /**
   * @param {string} message 错误信息
   * @param {string} code harness 错误码,如 UNKNOWN_MODEL / MISSING_CREDENTIAL
   */
  constructor(message, code) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.failure = Object.freeze({ message, code })
  }
}
