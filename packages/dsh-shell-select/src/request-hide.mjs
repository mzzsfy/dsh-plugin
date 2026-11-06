// 模型请求缝:被 shell 取代的官方 pwsh 工具在会话作用域注册,工具层的可见性
// 规则遮蔽不了它(own 注册优先于同名全局继承),只能在模型请求上剔除。
// adapter 的公开请求方法是 `stream(options)`,pi-ai 与原生 adapter 都实现它;
// 剔除挂在它上面,不依赖 pi-ai 私有的 streamWithSnapshot。
// 默认生效,行卸载后透传;与其它同样改写该方法的包链式叠加——读当前方法作
// original,不假定自己是最外层。同一原型只包一层,重装只更新活性。

const PATCHED = new WeakMap()

export const SHADOWED_TOOL_NAME = 'pwsh'

/**
 * 从请求 tools 剔除 pwsh。
 * @param {Array<{name: string}>|undefined} tools
 * @returns {Array<{name: string}>|undefined} 无命中时返回原引用
 */
export function hideShadowedPwsh(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools
  if (!tools.some((tool) => tool?.name === SHADOWED_TOOL_NAME)) return tools
  return tools.filter((tool) => tool?.name !== SHADOWED_TOOL_NAME)
}

/**
 * 给 llm 服务已注册 adapter 装请求改写;同一方法所有者只包一层。
 * @param {object|undefined} llm 宿主 llm 服务(adapters Map 内部面)
 * @param {() => boolean} [isActive] 改写活性;false 时原样透传
 * @returns {number} 本轮新装的方法所有者数(已装过的不计)
 */
export function attachRequestHiding(llm, isActive = () => true) {
  if (!(llm?.adapters instanceof Map)) return 0
  let attached = 0
  for (const entry of llm.adapters.values()) {
    const adapter = entry?.adapter
    if (adapter === null || typeof adapter !== 'object') continue
    // 类方法在原型上;实例自有 stream 属特例,以实例为准
    const owner = Object.prototype.hasOwnProperty.call(adapter, 'stream') ? adapter : Object.getPrototypeOf(adapter)
    if (owner === null || typeof owner !== 'object') continue
    const existing = PATCHED.get(owner)
    if (existing !== undefined) {
      existing.isActive = isActive
      continue
    }
    const original = owner.stream
    if (typeof original !== 'function') continue
    const state = { isActive }
    owner.stream = function (options) {
      if (!state.isActive()) return original.call(this, options)
      return original.call(this, { ...options, tools: hideShadowedPwsh(options?.tools) })
    }
    PATCHED.set(owner, state)
    attached += 1
  }
  return attached
}
