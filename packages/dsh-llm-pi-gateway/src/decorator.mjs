// adapter 装饰器:官方 llm-pi-ai 行保持启用,gateway 在官方 adapter 类的
// streamWithSnapshot 原型上注入,并对入参 snapshot.models.streamSimple 做
// 实例级 shadow,在 pi-ai GenerateOptions 进入传输前补 metadata.user_id。
// 关键约束(0.2.0-rc.2 实测):
// - ctx.llm 服务代理只读,服务对象不可 shadow → sweep + llm/adapters-updated 事件
// - streamWithSnapshot 白名单构造 pi-ai options,dsh 层 metadata 到不了 pi-ai
//   → 入口缝只用于触达 snapshot,真正注入点在 Models.streamSimple 的实参上
// - pi-ai GenerateOptions.sessionId 由官方显式传入,是标记派生源
// - anthropic 传输原生消费 metadata.user_id;openai 系忽略未知键,仍按协议门控
// - options 深冻结,注入必须不可变构造

import { deriveMarker } from './marker.mjs'

const PATCHED = Symbol('llm-pi-gateway.patched')
const ANTHROPIC_API = 'anthropic-messages'

/**
 * 构造标记注入:GenerateOptions.sessionId → metadata.user_id
 * (不可变构造;sessionId 缺失按 model 去重 warn 并透传,同会话标记缓存)。
 * @param {() => {enabled: boolean, prefix: string}} getConfig 配置快照读取器(节写热更)
 * @param {(model: string, message: string) => void} [onWarn] 去重告警出口
 * @returns {(options: object) => object}
 */
export function createMarkerInject(getConfig, onWarn = () => {}) {
  const markers = new Map()
  const warned = new Set()
  return (options) => {
    if (options === null || typeof options !== 'object' || !getConfig().enabled) return options
    const { sessionId } = options
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      const key = String(options.model?.id ?? options.model ?? 'unknown')
      if (!warned.has(key)) {
        warned.add(key)
        onWarn(key, `llm-pi-gateway: model "${key}" 请求缺 sessionId,本请求不注入标记(宿主版本漂移防御)`)
      }
      return options
    }
    let marker = markers.get(sessionId)
    if (marker === undefined) {
      marker = deriveMarker(sessionId, getConfig().prefix)
      markers.set(sessionId, marker)
    }
    return {
      ...options,
      metadata: { ...options.metadata, user_id: marker },
    }
  }
}

// 对单个 Models 实例的 streamSimple 做一次性 shadow(幂等),覆盖 anthropic
// GenerateOptions;其余协议原样透传
const decorateModels = (inject, isActive) => (models) => {
  if (models === null || typeof models !== 'object' || models[PATCHED]) return
  const original = models.streamSimple
  if (typeof original !== 'function') return
  models[PATCHED] = true
  models.streamSimple = (model, context, options) =>
    original.call(models, model, context, model?.api === ANTHROPIC_API && isActive() ? inject(options) : options)
}

/**
 * 在 adapter 原型上 shadow streamWithSnapshot(全部实例共享一个原型,一次覆盖
 * 存量与未来实例),并对入参 snapshot.models 就地装饰。原型方法缺失或不可写
 * (版本漂移)返回 false,调用方干净禁用。
 * @param {object} adapter 官方注册的 adapter 实例
 * @param {(options: object) => object} inject 标记注入
 * @param {() => boolean} [isActive] 注入活性;还原后透传
 * @returns {boolean}
 */
export function patchAdapterPrototype(adapter, inject, isActive = () => true) {
  const proto = Object.getPrototypeOf(adapter)
  if (proto === null || typeof proto !== 'object') return false
  if (proto[PATCHED]) return true
  const original = proto.streamWithSnapshot
  if (typeof original !== 'function') return false
  const decorate = decorateModels(inject, isActive)
  const wrapper = function (options, snapshot) {
    try {
      decorate(snapshot?.models)
    } catch {
      // 装饰失败不阻断模型请求
    }
    return original.call(this, options, snapshot)
  }
  try {
    proto.streamWithSnapshot = wrapper
    if (proto.streamWithSnapshot !== wrapper) return false
  } catch {
    return false
  }
  proto[PATCHED] = true
  return true
}

/**
 * 扫描注册表存量 adapter 并确保其类原型已 patch。
 * @param {object} llm 宿主 llm 服务实例(adapters Map 为运行时内部形态)
 * @param {(options: object) => object} inject
 * @param {() => boolean} [isActive]
 * @returns {number} 已确保覆盖的注册 adapter 数(含既往已覆盖)
 */
export function sweepRegisteredAdapters(llm, inject, isActive = () => true) {
  const entries = llm?.adapters instanceof Map ? [...llm.adapters.values()] : []
  let count = 0
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object' && patchAdapterPrototype(entry.adapter, inject, isActive)) {
      count += 1
    }
  }
  return count
}
