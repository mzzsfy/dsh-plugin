// apply 生命周期旗标:guard 据此识别本行功能性停摆。
// pending = apply 进行中或中途崩溃;active = 全部装配落定;inactive = 声明式早退。
// 中途崩溃停留 pending,guard 对 pending 保守不代挂(不越权重启他人)。
// takeoverTrace 记录运行时接管序列的事件轨迹(guard-status 只读暴露,排障用),
// append 式:决策/禁用/退场/挂载/回滚各节点一行,每次 apply 重置。

let state = 'pending'
let takeoverTrace = []

export function beginShellSelectApply() {
  state = 'pending'
  takeoverTrace = []
}

export function endShellSelectApplyActive() {
  state = 'active'
}

export function endShellSelectApplyInactive() {
  state = 'inactive'
}

export function shellSelectApplyState() {
  return state
}

export function recordTakeover(event) {
  takeoverTrace = [...takeoverTrace, { at: new Date().toISOString(), ...event }]
  if (takeoverTrace.length > 32) takeoverTrace = takeoverTrace.slice(-32)
}

export function shellSelectTakeoverTrace() {
  return takeoverTrace
}
