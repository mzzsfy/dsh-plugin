// 用量统计面板 Host 半区骨架:订阅 session/event 采集三粒度用量落 usage_stats
// 存储域,经 webServer 暴露 /api/usage-dash/* 供浏览器半区消费。
// S1 仅装配声明,采集/存储/路由随 S2-S4 落地。

// 顶层 inject 仅声明 web profile 必然存在的四个服务;settings 在 apply 内
// 嵌套 inject(通道级静默不激活),构成干净禁用。
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'storageDomain']

export const name = 'dsh-usage-dash'

export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    // settings 注册与 minuteRetentionDays 消费在 S2 落地
    void settingsCtx
  })
}
