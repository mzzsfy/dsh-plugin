// 兼容性判定链的匹配常量:run.mjs / browser-probe.mjs 同源引用,
// tests/compat-judges.test.mjs 断言其非平凡性(串漂移/恒真变异的秒级自检)。
// 浏览器渲染门槛文案(工作区/Workspace 双语防 locale 假阴性)
export const WORKSPACE_TEXT = /工作区|Workspace/
// 行级加载失败横幅(browser-probe 探测 + 判定取反)
export const FAIL_BANNER = 'Failed to load plugins'
// boot.log 行级加载失败字样(run.mjs importFailures 正则;0.1.7-rc.1 false-pass 教训)
export const IMPORT_FAIL_RE = /failed to import|did not activate/
// boot 日志 token 提取
export const TOKEN_RE = /token=([A-Za-z0-9_-]{8,})/g
// 上游请求判定路径前缀:模拟器留档中命中其一才算真发话(ambient GET /models 不算)
export const UPSTREAM_PATHS = ['/chat/completions', '/messages']
// 平台门控豁免:包内 patch 行全量 win32 门禁(cordis.patch.yml disabled 平台表达式,
// index.js 平台早退),POSIX 上按设计不 live——liveAll 期望集必须剔除,否则 POSIX
// 主测恒红(shell-select linux 全家桶实测)
export const PLATFORM_GATED_BUNDLES = ['@mzzsfy/dsh-shell-select']
