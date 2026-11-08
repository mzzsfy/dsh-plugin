// 模型请求缝:被 shell 取代的官方 pwsh 工具在会话作用域注册,工具层的可见性
// 规则遮蔽不了它(own 注册优先于同名全局继承),只能在模型请求上剔除。
//
// 两个入口都要挂:adapter 的公开 `stream(options)` 是直接派发点;pi-ai 的
// PreparedCall.stream 闭包直接调 `this.streamWithSnapshot`,绕过公开入口。
// 只包其中一个会漏掉对应路径(实测 pi-ai 走 prepared call)。
// 默认生效,行卸载后透传;与其它同样改写该方法的包链式叠加——读当前方法作
// original,不假定自己是最外层。同一原型只包一层,重装只更新活性。

const PATCHED = new WeakMap()

const ENTRY_METHODS = ['stream', 'streamWithSnapshot']

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

function patchEntry(owner, name, state) {
  const original = owner[name]
  if (typeof original !== 'function') return false
  owner[name] = function (...args) {
    const options = args[0]
    if (!state.isActive() || options === null || typeof options !== 'object') return original.apply(this, args)
    args[0] = { ...options, tools: hideShadowedPwsh(options.tools) }
    return original.apply(this, args)
  }
  return true
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
    // 类方法在原型上;实例自有实现(特例)以实例为准
    const owner = ENTRY_METHODS.some((name) => Object.prototype.hasOwnProperty.call(adapter, name))
      ? adapter
      : Object.getPrototypeOf(adapter)
    if (owner === null || typeof owner !== 'object') continue
    const existing = PATCHED.get(owner)
    if (existing !== undefined) {
      existing.isActive = isActive
      continue
    }
    const state = { isActive }
    const patched = ENTRY_METHODS.filter((name) => patchEntry(owner, name, state)).length
    if (patched === 0) continue
    PATCHED.set(owner, state)
    attached += 1
  }
  return attached
}
