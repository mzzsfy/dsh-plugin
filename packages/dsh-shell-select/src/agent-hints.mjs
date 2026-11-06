// preset 自带的官方 pwsh 在会话作用域注册,own 优先覆盖本包全局注册的同名工具,
// 描述提示对模型不可见。agent/created 给到 agent 作用域后直接改定义对象:
// 只改 description,不动执行与注册;标记挂在定义上保证幂等。

export const PWSH_REDIRECT_DESCRIPTION = 'Do not call; use `shell`.'

const MARK = Symbol('shell-select/directive')

/**
 * 把会话作用域解析到的 pwsh 定义描述换成改用 shell 的提示。
 * @param {object|undefined} agent 宿主 agent(需 ctx 与 ctx.tools.get)
 * @returns {boolean} 是否本次完成改写
 */
export function describePwshDirective(agent) {
  const tools = agent?.ctx?.tools
  if (tools === undefined || typeof tools.get !== 'function') return false
  const definition = tools.get('pwsh', agent.ctx)
  if (definition === undefined || definition === null || typeof definition !== 'object') return false
  if (definition[MARK] === true) return false
  try {
    Object.defineProperty(definition, MARK, { value: true, configurable: true })
    definition.description = PWSH_REDIRECT_DESCRIPTION
  } catch {
    return false
  }
  return true
}
