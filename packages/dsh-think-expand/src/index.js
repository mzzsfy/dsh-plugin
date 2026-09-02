// Host 半区:仅注册 settings 命名空间,让插件出现在"插件配置"卡片目录;
// 开关值的权威存储在 Host settings 文档,浏览器半区经 settingsScope 读写。

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

export const name = 'dsh-think-expand'

export const NAMESPACE = settingsNamespace('think-expand')

// 注册即声明 GUI 设置表单,schema 默认值即生效默认值。
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(true).description('流式思考自动展开最新一条'),
})

export const inject = ['settings']

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA)
  })
}
