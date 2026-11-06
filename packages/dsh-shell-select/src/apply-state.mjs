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

// 主行执行器 fiber 句柄(HOST-022 让位通道):mountExecutor 挂载成功后回填,
// guard 监视官方行翻回启用时经 retireShellSelectExecutorFiber 退役让位;
// 执行器不在场(guard 代挂态/挂载失败)恒 undefined,guard 零动作不与代挂官方
// 链抢权。模块级单例,主行 fiber 生命周期内有效。
export const shellSelectExecutorFiber = { current: undefined }

/**
 * 退役执行器句柄:清空记账并返回退役前的句柄(无句柄返回 undefined)。
 * 唯一清空路径——执行器 fiber 自卸载(主行被禁/卸载)与 guard 让位 dispose
 * 共用。已退役句柄残留会让 guard 把"执行器不在场"误判为在场,吞掉官方行
 * 翻回启用时的代挂让位(0.2.2 写事务 HOST-022 分支实证)。
 */
export function retireShellSelectExecutorFiber() {
  const fiber = shellSelectExecutorFiber.current
  shellSelectExecutorFiber.current = undefined
  return fiber
}
