// 用量统计面板 Host 半区:采集 session/event 落 usage_stats 域,经 webServer
// 暴露 /api/usage-dash/* 供浏览器半区消费。S2 已落存储域(store.js)与 settings
// 注册;采集(collector)随 S3、查询与路由随 S4 接入。

import schemastery from '@deepseek-ai/schemastery'

import { DEFAULT_MINUTE_RETENTION_DAYS, sharedStore } from './store.js'

// 顶层 inject 仅声明 web profile 必然存在的四个服务;settings 在 apply 内
// 嵌套 inject(通道级静默不激活),构成干净禁用。
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'storageDomain']

export const name = 'dsh-usage-dash'

const SETTINGS_NAMESPACE = 'usage-dash'

const SETTINGS_SCHEMA = schemastery.object({
  minuteRetentionDays: schemastery.number().min(0).step(1).default(DEFAULT_MINUTE_RETENTION_DAYS)
    .description('分钟桶保留天数,0 表示禁用分钟桶'),
})

export function apply(ctx, config) {
  const store = sharedStore(ctx.storageDomain)
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, SETTINGS_SCHEMA, { base: config })
    // 每日本地日首次写入时按保留值清理分钟桶;启动回扫前的触发在 S3 回扫入口接线
    store.retentionDays = () =>
      settingsCtx.settings.get(SETTINGS_NAMESPACE)?.minuteRetentionDays ?? DEFAULT_MINUTE_RETENTION_DAYS
  })
}
