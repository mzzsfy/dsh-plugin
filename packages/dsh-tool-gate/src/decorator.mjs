// adapter 装饰器(llm-pi-gateway decorator.mjs 同构简化):官方 llm-pi-ai 行
// adapter 类原型的 streamWithSnapshot 入口改写 options。tools 在 dsh 层
// options 上,无需下沉 snapshot.models;owner 限定授权实例,同原型非授权
// 实例透传(SC-20)。无卸载路径:isActive=false 即全量透传,行退场自愈。

const prototypePatches = new WeakMap()

// 官方 llm-pi-ai 行 settingsNs(llm.directory entry 过滤键,gateway 同款)
export const PI_AI_ROW_ID = 'llm-pi-ai'

const addOwner = (patch, adapter, rewrite, isActive) => {
  patch.owners = patch.owners.filter((existing) => existing.isActive())
  if (patch.owners.some((existing) => existing.adapter === adapter)) return
  patch.owners.push({ adapter, rewrite, isActive })
}

/**
 * 在 adapter 原型上 shadow streamWithSnapshot,入口经授权 owner 的 rewrite
 * 改写 options。原型方法缺失或不可写(宿主版本漂移)返回 false。
 * @param {object} adapter 授权 adapter 实例
 * @param {(options: object) => object} rewrite 请求改写(须不可变构造)
 * @param {() => boolean} [isActive] 改写活性;false 透传
 * @returns {boolean}
 */
export function patchAdapterPrototype(adapter, rewrite, isActive = () => true) {
  const proto = Object.getPrototypeOf(adapter)
  if (proto === null || typeof proto !== 'object') return false
  const original = proto.streamWithSnapshot
  if (typeof original !== 'function') return false
  let patch = prototypePatches.get(proto)
  if (patch) {
    addOwner(patch, adapter, rewrite, isActive)
    return true
  }
  patch = { owners: [{ adapter, rewrite, isActive }] }
  const wrapper = function (options, snapshot) {
    const owner = patch.owners.find((candidate) => candidate.adapter === this && candidate.isActive())
    return original.call(this, owner ? owner.rewrite(options) : options, snapshot)
  }
  try {
    proto.streamWithSnapshot = wrapper
    if (proto.streamWithSnapshot !== wrapper) return false
  } catch {
    return false
  }
  prototypePatches.set(proto, patch)
  return true
}

/**
 * sweep 官方 llm-pi-ai 行注册的 adapter 并确保其类原型已 patch(gateway
 * sweepRegisteredAdapters 同构)。deepseek 原生行 settingsNs 不命中,天然
 * 不在折叠面(BDD INV-10)。
 * @param {object} llm 宿主 llm 服务(adapters/directory Map 内部面,形态漂移返回 0)
 * @param {(options: object) => object} rewrite
 * @param {() => boolean} [isActive]
 * @returns {number} 已确保覆盖的注册 adapter 数
 */
export function sweepCollapseAdapters(llm, rewrite, isActive = () => true) {
  if (!(llm?.adapters instanceof Map) || !(llm.directory instanceof Map)) return 0
  const providers = new Set([...llm.directory.values()]
    .filter((entry) => entry?.settingsNs === PI_AI_ROW_ID)
    .map((entry) => entry.provider))
  let count = 0
  for (const provider of providers) {
    const entry = llm.adapters.get(provider)
    if (entry === undefined || entry.provider?.id !== provider) continue
    if (patchAdapterPrototype(entry.adapter, rewrite, isActive)) count += 1
  }
  return count
}
