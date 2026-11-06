// dsh-boss-simulator — 公司管理模拟器任务控制室。行角色分发,业务在 lib/ 各模块。
// 宿主服务缺失时干净禁用:不注册任何服务/UI,由装载层报告等待或失败;
// 公共总线 @mzzsfy/dsh-common-tools 为硬依赖(manifest dependencies 承载)。
import z from '@deepseek-ai/schemastery'
import { setupCommonTools, createChangeNotifier } from '@mzzsfy/dsh-common-tools/host'
import { getControlRuntime, registerControl } from './control.mjs'
import { registerToolRow } from './tools-row.mjs'

export const name = 'boss-simulator'
// 公共总线需要 webServer 的 upgrade 注册面;控制室路由亦要求同一服务
export const inject = ['webServer']

export const Config = z.object({
  role: z.union(['control', 'tools-row', 'persona-row']).required(),
})

export function apply(ctx, config) {
  const cfg = Config(config || {})
  // 受管角色组合行:在 agent realm 内注册业务工具行;控制室未启动(无运行时)即干净禁用
  if (cfg.role === 'tools-row') {
    const runtime = getControlRuntime()
    if (!runtime) {
      console.warn('[boss-simulator] tools-row without control runtime, skipped')
      return
    }
    console.warn('[boss-simulator] tools-row row activating')
    ctx.inject(['tools'], (scope) => {
      console.warn('[boss-simulator] tools-row inject fired, register start')
      // 同 rs-workflow orchestrator 形态:effect 包 register 调用本体,行销毁即注销
      scope.effect(() => registerToolRow(scope, runtime), 'boss-simulator tools-row')
      console.warn('[boss-simulator] tools-row register done')
    })
    return
  }
  if (cfg.role !== 'control') return
  // 看板失效广播:写成功后经公共总线只发失效通知;合并节流由 notifier 承担,
  // 客户端单飞刷新并由 onReset 全量对账
  const tools = setupCommonTools(ctx)
  const changes = createChangeNotifier(() => tools.publish())
  ctx.effect(() => () => changes.dispose(), 'boss-simulator change notifier')
  registerControl(ctx, { onChange: changes.refresh })
}
