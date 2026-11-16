// preset 自带的官方 pwsh 在会话作用域注册,own 优先覆盖本包全局注册的同名工具,
// 描述提示对模型不可见。agent/created 给到 agent 作用域后直接改定义对象:
// 只改 description,不动执行与注册;标记挂在定义上保证幂等。
//
// 作用域键是 agent 对象本身:宿主 createScope(loopCtx, agent) 以 agent 为注册
// 作用域键,agent/created 的投递载体同键;dsh-tools 的 get/view 把入参直接当
// layers 键(不归一化)——传 agent.ctx 只会命中全局视图,改的是本包全局 pwsh
// 镜像,官方会话定义原样,子作用域 deny shell 的限制同样被绕过。
//
// 只改 agent 自有层:preset 行在 preset 作用域注册(tool-pwsh 属 preset 层,
// 全 preset 的 agent 共享同一 definition),全局层同样是共享对象。改写继承来的
// definition 会把"不要调用 pwsh"泄漏给同 preset 的其它 agent 与 deny shell 的
// 子作用域——那里没有 shell 可换。归属判定用父作用域的解析结果做身份比对:
// 自有层只遮蔽继承层,不会解析到同一对象。
//
// 前提与请求缝同条件:该 agent 作用域能看到 `shell`。只保留 pwsh 的会话
// (如子代理工具允许集)看不到 shell,把描述改成"不要调用"等于抹掉唯一终端。

import { scopeParentOf } from '@deepseek-ai/dsh-scope'

export const PWSH_REDIRECT_DESCRIPTION = 'Do not call; use `shell`.'

// 被提示替代的官方工具名与替代者
const PWSH_TOOL_NAME = 'pwsh'
const SHELL_TOOL_NAME = 'shell'
// tools 服务名:走无注入要求的 ctx.get 读——cordis 属性访问在服务未注入或上下文
// 停用时直接抛错,而 agent/created 是 serial 事件,监听器抛错会打断会话创建
const TOOLS_SERVICE = 'tools'

const MARK = Symbol('shell-select/directive')

/**
 * 把 agent 自有作用域注册的 pwsh 定义描述换成改用 shell 的提示。
 * @param {object|undefined} agent 宿主 agent(需 ctx;tools 服务经 ctx.get 读)
 * @returns {boolean} 是否本次完成改写(继承/全局层恒零动作)
 */
export function describePwshDirective(agent) {
  const ctx = agent?.ctx
  if (typeof ctx?.get !== 'function') return false
  const tools = ctx.get(TOOLS_SERVICE)
  if (tools === undefined || tools === null || typeof tools.get !== 'function') return false
  // scope 形参恒传 agent 本身(真实作用域键),不传 ctx
  if (tools.get(SHELL_TOOL_NAME, agent) === undefined) return false
  const definition = tools.get(PWSH_TOOL_NAME, agent)
  if (definition === undefined || definition === null || typeof definition !== 'object') return false
  // 继承层(父作用域链的 preset / 全局)解析到同一对象即非自有注册:共享定义零动作
  if (tools.get(PWSH_TOOL_NAME, scopeParentOf(agent)) === definition) return false
  if (definition[MARK] === true) return false
  try {
    Object.defineProperty(definition, MARK, { value: true, configurable: true })
    definition.description = PWSH_REDIRECT_DESCRIPTION
  } catch {
    return false
  }
  return true
}
