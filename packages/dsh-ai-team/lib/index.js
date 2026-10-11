// dsh-ai-team — AI 团队任务控制室。行角色分发,业务在 lib/ 各模块。
// 依赖缺失时干净禁用:不注册任何服务/UI,打日志说明原因即返回(DEVELOPMENT/dsh-api-alignment)。
import z from '@deepseek-ai/schemastery'
import { getControlRuntime, registerControl } from './control.mjs'
import { registerToolRow } from './tools-row.mjs'

export const name = 'ai-team'

export const Config = z.object({
  role: z.union(['control', 'tools-row', 'persona-row']).required(),
})

export function apply(ctx, config) {
  const cfg = Config(config || {})
  // 受管角色组合行:在 agent realm 内注册业务工具行;控制室未启动(无运行时)即干净禁用
  if (cfg.role === 'tools-row') {
    const runtime = getControlRuntime()
    if (!runtime) {
      console.warn('[ai-team] tools-row without control runtime, skipped')
      return
    }
    console.warn('[ai-team] tools-row row activating')
    ctx.inject(['tools'], (scope) => {
      console.warn('[ai-team] tools-row inject fired, register start')
      // 同 rs-workflow orchestrator 形态:effect 包 register 调用本体,行销毁即注销
      scope.effect(() => registerToolRow(scope, { store: runtime.store, now: () => Date.now() }), 'ai-team tools-row')
      console.warn('[ai-team] tools-row register done')
    })
    return
  }
  if (cfg.role !== 'control') return
  registerControl(ctx)
}
