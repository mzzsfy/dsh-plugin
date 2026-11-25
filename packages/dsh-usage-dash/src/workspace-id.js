// 非工作区目录的统计分组标识。路径编码进 id,不依赖宿主工作区注册表;
// 统计层只读,创建这些 id 不会改动 DSH 的工作区数据。
export const SYNTHETIC_WORKSPACE_PREFIX = '(workspace-cwd):'

// 工作区路径比较键:宿主注册表存 realpath 原文,会话头 cwd 可能来自不同盘符
// 拼写;Windows 大小写和分隔符不敏感,其他平台保持原文避免误归并。
export function workspacePathKey(value) {
  if (typeof value !== 'string' || value === '') return ''
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isSyntheticWorkspaceId(value) {
  return typeof value === 'string' && value.startsWith(SYNTHETIC_WORKSPACE_PREFIX)
}

// 同一目录稳定生成同一分组 id;路径统一为比较键后再编码,避免盘符大小写拆分。
export function syntheticWorkspaceId(cwd) {
  const key = workspacePathKey(cwd)
  return key === '' ? undefined : `${SYNTHETIC_WORKSPACE_PREFIX}${encodeURIComponent(key)}`
}

export function syntheticWorkspacePath(workspaceId) {
  if (!isSyntheticWorkspaceId(workspaceId)) return ''
  try {
    return decodeURIComponent(workspaceId.slice(SYNTHETIC_WORKSPACE_PREFIX.length))
  } catch {
    return ''
  }
}

// 目录末尾分隔符已由 workspacePathKey 去掉;取最后一段作为面板显示名。
export function syntheticWorkspaceTitle(workspaceId) {
  const path = syntheticWorkspacePath(workspaceId)
  if (path === '') return ''
  const cut = path.lastIndexOf('/')
  return cut >= 0 ? path.slice(cut + 1) : path
}
