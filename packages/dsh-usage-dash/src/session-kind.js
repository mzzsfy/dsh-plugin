// 会话派生判定:子 agent 会话由宿主在 SessionHeader 标注 origin='subagent';
// 旧格式派生子会话只留 parentSession + delegationDepth>0,而旧格式用户分支
// (fork)同样带 parentSession 但 delegationDepth=0,故 depth 必须参与判定。
// 字段缺失时不判派生:观测性优先,宁可多计也不误排除真实会话。

const ORIGIN_SUBAGENT = 'subagent'
const DELEGATION_DEPTH_MIN = 1

export function isDerivedSessionHeader(header) {
  if (header === undefined || header === null) return false
  if (header.origin === ORIGIN_SUBAGENT) return true
  return header.parentSession !== undefined && (header.delegationDepth ?? 0) >= DELEGATION_DEPTH_MIN
}
