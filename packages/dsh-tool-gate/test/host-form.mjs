// 测试宿主代际门:工具门只对 0.2.2+ 的 registration 层条目({definition, when})
// 生效。测试环境本地/CI 可能解析旧根桥(裸 definition),此时真宿主功能面
// 跳过,由 SC-25 断言「干净禁用」这一基线口径。形态探测读真宿主层条目,
// 不看版本号(未来内部面再变时同一条门继续成立)。

import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

async function hostHasRegistrationLayers() {
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
  const supported = entry?.definition?.name === 'probe'
  await root.registry.delete(ToolRuntime)
  await root.registry.delete(SystemPrompt)
  return supported
}

/** false = 宿主形态满足;字符串 = node:test 的跳过原因。 */
export const HOST_SKIP = (await hostHasRegistrationLayers())
  ? false
  : '宿主层为裸 definition(0.2.2 前):工具门干净禁用,功能面不适用'
