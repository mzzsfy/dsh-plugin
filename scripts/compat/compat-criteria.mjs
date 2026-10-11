// 兼容性判定链的匹配常量:run.mjs / browser-probe.mjs 同源引用,
// tests/compat-judges.test.mjs 断言其非平凡性(串漂移/恒真变异的秒级自检)。
export const WORKSPACE_TEXT = /工作区|Workspace/
export const FAIL_BANNER = 'Failed to load plugins'
export const IMPORT_FAIL_RE = /failed to import|did not activate/
export const TOKEN_RE = /token=([A-Za-z0-9_-]{8,})/g
export const UPSTREAM_PATHS = ['/chat/completions', '/messages']
export const PLATFORM_GATED_BUNDLES = ['@mzzsfy/dsh-shell-select']
// Fixture 用户消息供 DOM roundtrip 判定；simulator 在 echo-enabled隔离 profile 中回显。
export const COMPAT_CHAT_MESSAGE = '回复:ok'
export const COMPAT_ANTHROPIC_MESSAGE = '回复:anth'
