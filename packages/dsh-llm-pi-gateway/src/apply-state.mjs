// gateway 主行 apply 生命周期旗标:guard 据此识别"行活着但功能性未接管"
// (旧宿主缺必备导出,apply 干净早退的假活形态)。经 globalThis 符号键承载,
// 防同包多实例模块图读不到状态。

const KEY = Symbol.for('@mzzsfy/dsh-llm-pi-gateway.applyState')

// apply 开始清除旧态:运行中不可判,guard 保守不代挂
export function beginGatewayApply() {
  delete globalThis[KEY]
}

// apply 走到服务注册完成:本行有效接管
export function endGatewayApplyActive() {
  globalThis[KEY] = 'active'
}

// apply 因宿主能力缺失干净早退:行活着但不提供任何服务
export function endGatewayApplyInactive() {
  globalThis[KEY] = 'inactive'
}

/** @returns {'active'|'inactive'|undefined} undefined = 未运行/运行中/中途崩溃 */
export function gatewayApplyState() {
  return globalThis[KEY]
}
