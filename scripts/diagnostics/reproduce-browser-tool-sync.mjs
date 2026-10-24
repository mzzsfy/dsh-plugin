// 只读已安装浏览器插件，在内存 ToolRuntime 中复现全局 lazy 工具注入。
// 默认记录已知行为；--assert-isolated 则断言会话隔离，当前版本预期失败。
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../../packages/dsh-tool-gate/src/index.js', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { ToolRuntime, defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')))
const { SystemPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')))
const { createScope } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope')))
const profileDir = process.env.DSH_PROFILE_DIR
assert.ok(profileDir, '需设置 DSH_PROFILE_DIR，指向待诊断插件的 profile')
const sourcePath = path.join(profileDir, 'node_modules/dsh-browser-cdp/lib/index.js')
const source = fs.readFileSync(sourcePath, 'utf8')
const section = (start, end) => {
  const begin = source.indexOf(start)
  const finish = source.indexOf(end, begin + start.length)
  assert.ok(begin >= 0 && finish > begin, `插件结构已变，无法提取 ${start}`)
  return source.slice(begin, finish)
}
const tiersCode = section('const CORE = [', '\n//#endregion')
const activityCode = section('let toolCallCount = 0;', '\nfunction castStatePath')
const pulseCode = section('const pulseActivity = () => {', '\n\t{')
const sandbox = vm.createContext({ Date, Set, Map })
vm.runInContext(`${tiersCode}\n${activityCode}\nglobalThis.api = {
  markEgoToolCall,
  mount(register) {
    let browserActive = false;
    let browseBatchDepth = 0;
    const tiers = createTierInjector({ register, policy: () => ({
      injection: 'lazy', toolBrowse: true, toolExtended: true, toolEscape: true,
      toolJudge: false, judgeConfigured: false, active: browserActive, batchDepth: browseBatchDepth
    }) });
    ${pulseCode}
    const unsubscribe = onEgoActivity(pulseActivity);
    for (const name of ['bcdp_status', 'bcdp_click', 'bcdp_screenshot', 'bcdp_wait']) tiers.offer({ name });
    return { pulse: pulseActivity, unsubscribe };
  }
}`, sandbox)

const root = new Context()
const scopes = []
const unregister = []
let mounted
try {
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  const agentA = {}, agentB = {}
  scopes.push(createScope(root, agentA), createScope(root, agentB))
  mounted = sandbox.api.mount(({ name }) => {
    const dispose = root.tools.register(defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
      execute: async () => ({}),
    }))
    unregister.push(dispose)
    return dispose
  })
  const names = (agent) => root.tools.schemas(agent).map(t => t.name)
  const beforeB = names(agentB)
  assert.deepEqual(beforeB, ['bcdp_status'])
  console.log('活动前 A/B:', names(agentA), names(agentB))
  const viaBroadcast = process.argv.includes('--broadcast')
  console.log('浏览器代码:', sourcePath)
  console.log('ToolRuntime:', require.resolve('@deepseek-ai/dsh-tools'))
  console.log('触发入口:', viaBroadcast ? 'markEgoToolCall 广播' : 'doctor/help/status 直接 pulse')
  assert.deepEqual(names(agentA), ['bcdp_status'])
  if (viaBroadcast) sandbox.api.markEgoToolCall('session-A')
  else mounted.pulse()
  assert.deepEqual(names(agentA), ['bcdp_status', 'bcdp_click'])
  console.log('A 活动后 A/B:', names(agentA), names(agentB))
  if (process.argv.includes('--assert-isolated')) {
    assert.deepEqual(names(agentB), beforeB, 'A 浏览器活动不应扩展 B 工具列表')
  } else {
    assert.deepEqual(names(agentB), ['bcdp_status', 'bcdp_click'])
    console.log('已复现：A 活动令 B 继承全局新增工具。未调用 tool_search，也未加载工具门。')
  }
} finally {
  mounted?.unsubscribe()
  for (const dispose of unregister.reverse()) dispose()
  for (const scope of scopes.reverse()) await scope.dispose()
  await root.registry.delete(ToolRuntime)
  await root.registry.delete(SystemPrompt)
}
