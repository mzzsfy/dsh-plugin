// dsh-rs-workflow — 若水工作流设置面:流程模板管理与工作位/预算配置。
// 本包当前仅保留设置页能力(模板编辑/校验/配置读写);编排运行时按 v5 设计另行实现。
// 本文件只做行角色分发,业务在 lib/ 各模块。
import z from '@deepseek-ai/schemastery'
import { SETTINGS_SCHEMA, NAMESPACE, baseOf } from './settings-schema.mjs'
import { builtinTemplates } from './builtin-templates.mjs'
import { registerBoardRoutes } from './board.mjs'
import { SPEC_TEXT } from './spec.mjs'

export const name = 'rs-workflow'
export { NAMESPACE, SETTINGS_SCHEMA, SPEC_TEXT }

// 组合行 config schema(行分发字段 role 必填)
export const Config = z.object({
  role: z.union(['settings', 'board']).required(),
  slots: z.object({}).description('settings base:六工作位绑定(透传 settings-schema)'),
  budgets: z.object({}).description('settings base:三预算'),
})

export function apply(ctx, config) {
  const cfg = Config(config || {})
  if (cfg.role === 'settings') {
    ctx.inject(['settings'], (sctx) => {
      sctx.settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: baseOf({ slots: cfg.slots, budgets: cfg.budgets }) })
    })
    return
  }
  if (cfg.role === 'board') {
    registerBoardRoutes(ctx)
    return
  }
}
