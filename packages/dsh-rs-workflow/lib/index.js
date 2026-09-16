// dsh-rs-workflow — 若水工作流设置面:流程模板管理与工作位/预算配置。
// 本包当前仅保留设置页能力(模板编辑/校验/配置读写);编排运行时按 v5 设计另行实现。
// 配置/模板存自有文件(~/.dsh/dsh-rs-workflow/v5/),不经宿主 settings 服务,不写 settings.yaml。
// 本文件只做行角色分发,业务在 lib/ 各模块。
import z from '@deepseek-ai/schemastery'
import { registerBoardRoutes } from './board.mjs'
import { SPEC_TEXT } from './spec.mjs'

export const name = 'rs-workflow'
export { SPEC_TEXT }

// 组合行 config schema(行分发字段 role 必填)
export const Config = z.object({
  role: z.union(['board']).required(),
})

export function apply(ctx, config) {
  const cfg = Config(config || {})
  if (cfg.role === 'board') {
    registerBoardRoutes(ctx)
  }
}
