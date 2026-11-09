// 测试宿主形态门:工具门支持两种层条目形态——0.2.2+ 的 registration 包装
// ({ definition, when })与更早代际的裸 definition;未知形态才判漂移(干净
// 禁用)。形态探测读真宿主层条目,不看版本号(未来内部面再变时同一条门继续
// 成立)。

import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

async function detectHostForm() {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  root.tools.register(defineTool({
    name: 'probe',
    description: 'probe fixture',
    parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    async execute() { return {} },
  }))
  const entry = root.tools.layers.global.tools.data.get('probe')
  const form = entry?.definition?.name === 'probe'
    ? 'registration'
    : entry?.name === 'probe' ? 'bare' : 'unknown'
  const hasResolve = typeof root.tools.resolve === 'function'
  await root.registry.delete(ToolRuntime)
  await root.registry.delete(SystemPrompt)
  return { form, hasResolve }
}

const { form, hasResolve } = await detectHostForm()

/** 宿主层条目形态:registration | bare | unknown。 */
export const HOST_FORM = form
/** 宿主是否提供 resolve()(本步 toolSet 准入面,0.2.2+);旧代际只有注册视图。 */
export const HOST_TOOLSET = hasResolve
/** false = 宿主形态满足;字符串 = node:test 的跳过原因。 */
export const HOST_SKIP = form === 'unknown'
  ? '宿主层条目为未知形态:工具门按漂移干净禁用,功能面不适用'
  : false
/** 准入面(toolSet)能力门:旧代际无 resolve,准入面测试不适用。 */
export const TOOLSET_SKIP = hasResolve
  ? false
  : '宿主无 resolve()(0.2.2 前):本步 toolSet 准入面不适用'
