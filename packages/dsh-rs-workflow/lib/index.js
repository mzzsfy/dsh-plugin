// dsh-rs-workflow — 若水工作流 v5:人机协作的强规则编排。
// 主循环(人机接口+规划者)+ 分段 continuable job 编排;配置/模板存自有文件(~/.dsh/dsh-rs-workflow/v5/),
// 不经宿主 settings 服务,不写 settings.yaml。本文件只做行角色分发,业务在 lib/ 各模块。
import z from '@deepseek-ai/schemastery'
import { registerBoardRoutes } from './board.mjs'
import { registerOrchestrator } from './orchestrator.mjs'
import { registerTemplateTool } from './template-tool.mjs'
import { SPEC_TEXT } from './spec.mjs'

export const name = 'rs-workflow'
export { SPEC_TEXT }

// 组合行 config schema(行分发字段 role 必填)
export const Config = z.object({
  role: z.union(['board', 'orchestrator', 'template-tool']).required(),
  templateId: z.string().description('orchestrator:本组合锚定的模板 id(释放生成器按组合名写入);orchestrator 角色必填'),
})

export function apply(ctx, config) {
  const cfg = Config(config || {})
  if (cfg.role === 'board') {
    registerBoardRoutes(ctx)
    return
  }
  if (cfg.role === 'orchestrator') {
    if (!cfg.templateId) throw new Error('orchestrator 行必须配置 templateId(组合锚定)')
    registerOrchestrator(ctx, { templateId: cfg.templateId })
    return
  }
  registerTemplateTool(ctx)
}
