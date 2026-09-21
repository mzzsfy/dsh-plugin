// apply 生命周期旗标:guard 据此识别本行功能性停摆。
// pending = apply 进行中或中途崩溃;active = 全部装配落定;inactive = 声明式早退。
// 中途崩溃停留 pending,guard 对 pending 保守不代挂(不越权重启他人)。

let state = 'pending'

export function beginShellSelectApply() {
  state = 'pending'
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
