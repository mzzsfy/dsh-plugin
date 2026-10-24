// adapter 装饰器:官方 llm-pi-ai 行保持启用,gateway 在官方 adapter 类的
// streamWithSnapshot 原型上注入,并对入参 snapshot.models.streamSimple 做
// 实例级 shadow,在 pi-ai options 进入传输前补协议对应的会话键。
// 关键约束(0.2.0-rc.2 实测):
// - ctx.llm 服务代理只读,服务对象不可 shadow → sweep + llm/adapters-updated 事件
// - streamWithSnapshot 白名单构造 pi-ai options,dsh 层 metadata 到不了 pi-ai
//   → 入口缝只用于触达 snapshot,真正注入点在 Models.streamSimple 的实参上
// - pi-ai GenerateOptions.sessionId 由官方显式传入,是标记派生源
// - Anthropic 消费 metadata.user_id;Chat 通过 headers 补会话键;Responses 原样透传
// - options 深冻结,注入必须不可变构造

import { OFFICIAL_ROW_ID } from './config.mjs'
import { deriveMarker } from './marker.mjs'

const ANTHROPIC_API = 'anthropic-messages'
const CHAT_API = 'openai-completions'
const CHAT_SESSION_HEADERS = ['session_id', 'x-client-request-id']
const prototypePatches = new WeakMap()

/**
 * 按实际协议不可变注入会话键;缺 sessionId 按模型去重告警,Anthropic 标记按会话缓存。
 * @param {() => {enabled: boolean, prefix: string}} getConfig 配置快照读取器(节写热更)
 * @param {(model: string, message: string) => void} [onWarn] 去重告警出口
 * @returns {(options: object, model: object) => object}
 */
export function createMarkerInject(getConfig, onWarn = () => {}) {
  const markers = new Map()
  const warned = new Set()
  return (options, model) => {
    if (model?.api !== ANTHROPIC_API && model?.api !== CHAT_API) return options
    if (options === null || typeof options !== 'object' || !getConfig().enabled) return options
    if (model.api === CHAT_API && options.cacheRetention === 'none') return options
    const { sessionId } = options
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      const key = String(model.id ?? options.model?.id ?? options.model ?? 'unknown')
      if (!warned.has(key)) {
        warned.add(key)
        onWarn(key, `llm-pi-gateway: model "${key}" 请求缺 sessionId,本请求不注入会话键(宿主版本漂移防御)`)
      }
      return options
    }
    if (model.api === CHAT_API) {
      const explicit = new Set([...Object.keys(model.headers ?? {}), ...Object.keys(options.headers ?? {})]
        .map((name) => name.toLowerCase()))
      const missing = CHAT_SESSION_HEADERS.filter((name) => !explicit.has(name))
      if (missing.length === 0) return options
      return { ...options, headers: { ...options.headers, ...Object.fromEntries(missing.map((name) => [name, sessionId])) } }
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

// streamWithSnapshot 为每次调用构造绑定来源 adapter 实例的 Models facade。
const decorateModels = (models, sourcePatch, adapter) => {
  if (models === null || typeof models !== 'object') return models
  const streamSimple = models.streamSimple
  if (typeof streamSimple !== 'function') return models
  return new Proxy(models, {
    get(target, property) {
      if (property === 'streamSimple') {
        return (model, context, options) => {
          const owners = sourcePatch.owners.filter((owner) => owner.adapter === adapter && owner.isActive())
          const owner = owners.at(-1)
          const nextOptions = owner ? owner.inject(options, model) : options
          return streamSimple.call(target, model, context, nextOptions)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const addOwner = (patch, adapter, owner) => {
  patch.owners = patch.owners.filter((existing) => existing.isActive())
  if (patch.owners.some((existing) => existing.adapter === adapter && existing.inject === owner.inject && existing.isActive === owner.isActive)) return
  patch.owners.push({ adapter, ...owner })
}

/**
 * 在 adapter 原型上 shadow streamWithSnapshot,但注入 owner 限定于登记授权的实例。
 * 对入参 snapshot.models 就地装饰。原型方法缺失或不可写(版本漂移)返回 false。
 * @param {object} adapter 官方注册的 adapter 实例
 * @param {(options: object, model: object) => object} inject 标记注入
 * @param {() => boolean} [isActive] 注入活性;还原后透传
 * @returns {boolean}
 */
export function patchAdapterPrototype(adapter, inject, isActive = () => true) {
  const proto = Object.getPrototypeOf(adapter)
  if (proto === null || typeof proto !== 'object') return false
  const original = proto.streamWithSnapshot
  if (typeof original !== 'function') return false
  let patch = prototypePatches.get(proto)
  if (patch) {
    addOwner(patch, adapter, { inject, isActive })
    return true
  }
  patch = { owners: [{ adapter, inject, isActive }] }
  const wrapper = function (options, snapshot) {
    const callSnapshot = { ...snapshot, models: decorateModels(snapshot?.models, patch, this) }
    return original.call(this, options, callSnapshot)
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
 * 扫描注册表存量 adapter 并确保其类原型已 patch。
 * @param {object} llm 宿主 llm 服务实例(adapters Map 为运行时内部形态)
 * @param {(options: object, model: object) => object} inject
 * @param {() => boolean} [isActive]
 * @returns {number} 已确保覆盖的注册 adapter 数(含既往已覆盖)
 */
export function sweepRegisteredAdapters(llm, inject, isActive = () => true) {
  if (!(llm?.adapters instanceof Map) || !(llm.directory instanceof Map)) return 0
  const officialRoutes = new Set([...llm.directory.values()]
    .filter((entry) => entry?.settingsNs === OFFICIAL_ROW_ID)
    .map((entry) => entry.provider))
  let count = 0
  for (const provider of officialRoutes) {
    const entry = llm.adapters.get(provider)
    if (entry === undefined || entry.provider?.id !== provider) continue
    if (patchAdapterPrototype(entry.adapter, inject, isActive)) count += 1
  }
  return count
}
