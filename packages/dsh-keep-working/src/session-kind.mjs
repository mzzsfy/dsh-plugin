// 子 agent 会话判定:origin 权威;无 origin 的旧记录按 parentSession +
// delegationDepth(普通 fork 的 depth 为 0,不算)
export function isDerivedSessionHeader(header) {
  if (!header) return false
  if (header.origin === 'subagent') return true
  return header.parentSession !== undefined && (header.delegationDepth ?? 0) >= 1
}
