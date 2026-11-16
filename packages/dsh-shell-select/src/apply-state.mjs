// apply 生命周期旗标:guard 据此识别本行功能性停摆。
// pending = apply 进行中或中途崩溃;active = 全部装配落定;inactive = 声明式早退。
// 中途崩溃停留 pending,guard 对 pending 保守不代挂(不越权重启他人)。
// takeoverTrace 记录运行时接管序列的事件轨迹(guard-status 只读暴露,排障用),
// append 式:决策/禁用/退场/挂载/回滚各节点一行,每次 apply 重置。
//
// 代际 token:apply 的异步接管链(runtimeTakeover)可能在主行重挂/HMR 之后才
// 落定。模块级旗标是跨代共享状态,旧链无条件写会把新代的 active/seam 改成
// 旧代结论(新一代刚挂好执行器,旧链回滚写完 seam=false → 请求里的 pwsh 又
// 被剔掉)。begin 递增代际并返回 token,所有跨 await 的写入口核对 token。

let state = 'pending'
let generation = 0
let takeoverTrace = []
let requestSeamActive = false

/** 开新一代 apply;返回本代 token(异步链必须持有并透传到写入口)。 */
export function beginShellSelectApply() {
  generation += 1
  state = 'pending'
  takeoverTrace = []
  requestSeamActive = false
  return generation
}

/** 当前代际(排障面/接线层核对用)。 */
export function shellSelectApplyGeneration() {
  return generation
}

// 写入口一律要求 token:缺失即视为旧代丢弃(没有合法的不带代际调用方)
const isCurrentGeneration = (token) => token === generation

/** 落定为 active;旧代 token 的迟到写被丢弃(返回 false)。 */
export function endShellSelectApplyActive(token) {
  if (!isCurrentGeneration(token)) return false
  state = 'active'
  return true
}

/** 落定为 inactive;旧代 token 的迟到写被丢弃(返回 false)。 */
export function endShellSelectApplyInactive(token) {
  if (!isCurrentGeneration(token)) return false
  state = 'inactive'
  return true
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

// 主行执行器 fiber 句柄:mountExecutor 挂载成功后回填,执行器 fiber 退役时自清。
// guard 用它识别"主行 active 但接管链断裂"(句柄缺失超宽限即代挂官方链),
// 不再用于官方行翻回让位——写事务中撤执行器会让 ctx.shell 真空。
// 执行器不在场(guard 代挂态/挂载失败/apply 进行中)恒 undefined。
// 模块级单例,主行 fiber 生命周期内有效。
export const shellSelectExecutorFiber = { current: undefined }

/**
 * 退役执行器句柄:清空记账并返回退役前的句柄(无句柄返回 undefined)。
 * 唯一清空路径是执行器 fiber 自身卸载(主行被禁/卸载),不再供 guard 让位调用。
 */
export function retireShellSelectExecutorFiber() {
  const fiber = shellSelectExecutorFiber.current
  shellSelectExecutorFiber.current = undefined
  return fiber
}

// 请求缝活性(执行器在场标志):pwsh 剔除与"不要调用 pwsh"描述改写的硬前提是
// 本包执行器真的接管了终端——只看行是否加载会把 yield/回滚/挂载失败(官方 pwsh
// 仍在服务、本包无 shell)也算成活,请求里被剔掉唯一终端。挂载成功置位,挂载
// 失败/回滚/执行器 fiber 退役一律复位。代际 token 防旧链改写新代活性。
export function setShellRequestSeam(active, token) {
  if (!isCurrentGeneration(token)) return false
  requestSeamActive = active === true
  return true
}

export function shellRequestSeamActive() {
  return requestSeamActive
}
