// 商店展示目标包清单:catalog 收录、图标映射、分类映射共用此单一事实源。
// 仅收录已发布 npm 的生产包;格式 1 条目需可安装的精确版本。
export const CATALOG_PACKAGES = [
  'dsh-auto-trust-all', 'dsh-boss-simulator', 'dsh-context-manager', 'dsh-cron-board',
  'dsh-llm-pi-gateway', 'dsh-maintain', 'dsh-rs-workflow', 'dsh-session-manager',
  'dsh-settings-nav-icons', 'dsh-shared-terminal', 'dsh-shell-select', 'dsh-think-expand',
  'dsh-tool-gate', 'dsh-tunnel', 'dsh-turn-notify', 'dsh-usage-dash', 'dsh-usage-panel',
]

// 图标映射:glyph 名与 nav-icons 声明一致;tunnel 商店面取 zap 避免与 llm-pi-gateway 撞形。
export const ICON_MAP = {
  'dsh-auto-trust-all': 'shield',
  'dsh-boss-simulator': 'plan',
  'dsh-common-tools': 'cube',
  'dsh-context-manager': 'git',
  'dsh-cron-board': 'plan',
  'dsh-llm-pi-gateway': 'globe',
  'dsh-maintain': 'wrench',
  'dsh-rs-workflow': 'flow',
  'dsh-session-manager': 'archive',
  'dsh-settings-nav-icons': 'tune',
  'dsh-shared-terminal': 'cards',
  'dsh-shell-select': 'term',
  'dsh-stock-assistant': 'chart',
  'dsh-think-expand': 'spark',
  'dsh-tool-gate': 'layers',
  'dsh-tunnel': 'zap',
  'dsh-turn-notify': 'bell',
  'dsh-usage-dash': 'gauge',
  'dsh-usage-panel': 'wallet',
}

// 分类沿用官方目录的既有分类 id,自建索引自带标题声明
export const CATEGORY_MAP = {
  'dsh-auto-trust-all': 'remote',
  'dsh-boss-simulator': 'workflow',
  'dsh-context-manager': 'ui',
  'dsh-cron-board': 'workflow',
  'dsh-llm-pi-gateway': 'model',
  'dsh-maintain': 'dev',
  'dsh-rs-workflow': 'workflow',
  'dsh-session-manager': 'session',
  'dsh-settings-nav-icons': 'ui',
  'dsh-shared-terminal': 'dev',
  'dsh-shell-select': 'dev',
  'dsh-think-expand': 'ui',
  'dsh-tool-gate': 'security',
  'dsh-tunnel': 'remote',
  'dsh-turn-notify': 'notify',
  'dsh-usage-dash': 'usage',
  'dsh-usage-panel': 'usage',
}

export const CATEGORY_TITLES = {
  ui: { en: 'UI Enhancements', zh: 'UI 增强' },
  usage: { en: 'Usage & Billing', zh: '用量与计费' },
  model: { en: 'Models & Providers', zh: '模型与账号接入' },
  session: { en: 'Sessions & Messages', zh: '会话与消息' },
  workflow: { en: 'Workflow & Automation', zh: '工作流与自动化' },
  notify: { en: 'Notifications & Integrations', zh: '通知与集成' },
  dev: { en: 'Development & Runtime', zh: '开发与运行时' },
  security: { en: 'Security & Permissions', zh: '安全与权限' },
  remote: { en: 'Remote & Mobile', zh: '远程与移动端' },
}

// dsh-stock-assistant 未发布 npm,发布后加入 CATALOG_PACKAGES 即入列
