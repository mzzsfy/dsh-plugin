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
// - 缓存记录 wrapper 身份,命中时核对;被外部替换则按当前方法重包,注入不得静默失效
// - 无活跃 owner 的调用直通原始方法,不复制 snapshot、不建 Models facade

import { OFFICIAL_ROW_ID } from './config.mjs'
import { createLru } from './lru.mjs'
import { DEFAULT_MARKER_PREFIX, deriveMarker } from './marker.mjs'

const ANTHROPIC_API = 'anthropic-messages'
const CHAT_API = 'openai-completions'
const CHAT_SESSION_HEADERS = ['session_id', 'x-client-request-id']
const prototypePatches = new WeakMap()

// 会话标记缓存与缺 sessionId 告警去重的容量上限:超限按最近最少使用淘汰,
// 长进程累积大量会话/模型时不无界增长
export const MARKER_CACHE_LIMIT = 1024
export const WARNED_CACHE_LIMIT = 256

// 缺省活性判定提为模块级常量:省略 isActive 的重复 patch 按同一引用去重,
// 显式传入不同函数仍分别登记(多代 owner 并存语义)
const ALWAYS_ACTIVE = () => true

// 标记缓存键含 prefix:配置热更后同一会话按新前缀重算,不沿用旧键;长度前缀避免拼接歧义
const markerCacheKey = (prefix, sessionId) => `${prefix.length}:${prefix}${sessionId}`

/**
 * 按实际协议不可变注入会话键;缺 sessionId 按模型去重告警,Anthropic 标记按
 * (prefix, 会话) 缓存(上限内 LRU),prefix 热更后同会话按新前缀重算。
 * @param {() => {enabled: boolean, prefix: string}} getConfig 配置快照读取器(节写热更)
 * @param {(model: string, message: string) => void} [onWarn] 去重告警出口
 * @returns {((options: object, model: object) => object) & {readonly markerCacheSize: number}}
 *   返回函数的 markerCacheSize 为当前缓存条目数(诊断与有界性断言用)
 */
export function createMarkerInject(getConfig, onWarn = () => {}) {
  const markers = createLru(MARKER_CACHE_LIMIT)
  const warned = createLru(WARNED_CACHE_LIMIT)
  const inject = (options, model) => {
    if (model?.api !== ANTHROPIC_API && model?.api !== CHAT_API) return options
    if (options === null || typeof options !== 'object') return options
    const config = getConfig()
    if (!config?.enabled) return options
    if (model.api === CHAT_API && options.cacheRetention === 'none') return options
    const { sessionId } = options
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      const key = String(model.id ?? options.model?.id ?? options.model ?? 'unknown')
      if (warned.get(key) === undefined) {
        warned.set(key, true)
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
    const prefix = typeof config.prefix === 'string' ? config.prefix : DEFAULT_MARKER_PREFIX
    const key = markerCacheKey(prefix, sessionId)
    let marker = markers.get(key)
    if (marker === undefined) marker = markers.set(key, deriveMarker(sessionId, prefix))
    return {
      ...options,
      metadata: { ...options.metadata, user_id: marker },
    }
  }
  Object.defineProperty(inject, 'markerCacheSize', { get: () => markers.size })
  return inject
}

// 按 adapter 实例兑换活跃 owner:同一原型上的未授权实例没有 owner,不予注入
const activeOwnerFor = (patch, adapter) => patch.owners.findLast((owner) => owner.adapter === adapter && owner.isActive())

// streamWithSnapshot 每次调用构造绑定来源 adapter 的 Models facade;facade 的
// streamSimple 每次重新解析活跃 owner,已保存的 facade 在 dispose 后旁路、reapply 后跟随新 owner
const decorateModels = (models, patch, adapter) => {
  if (models === null || typeof models !== 'object') return models
  const streamSimple = models.streamSimple
  if (typeof streamSimple !== 'function') return models
  return new Proxy(models, {
    get(target, property) {
      if (property === 'streamSimple') {
        return (model, context, options) => {
          const owner = activeOwnerFor(patch, adapter)
          const nextOptions = owner === undefined ? options : owner.inject(options, model)
          return streamSimple.call(target, model, context, nextOptions)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// 去重键 = adapter + inject + isActive 引用;缺省 isActive 是模块级常量,省略参数的重复 patch 幂等
const addOwner = (patch, adapter, owner) => {
  patch.owners = patch.owners.filter((existing) => existing.isActive())
  if (patch.owners.some((existing) => existing.adapter === adapter && existing.inject === owner.inject && existing.isActive === owner.isActive)) return
  patch.owners.push({ adapter, ...owner })
}

/**
 * 在 adapter 原型上 shadow streamWithSnapshot,但注入 owner 限定于登记授权的实例。
 * 有活跃 owner 时对入参 snapshot.models 就地装饰;无活跃 owner 时直通原始方法。
 * adapter 为 null/非对象、原型方法缺失或不可写(版本漂移)返回 false;
 * 缓存命中时核对当前方法仍是本 wrapper,被外部替换则按当前方法重新包装,避免注入静默失效。
 * @param {object} adapter 官方注册的 adapter 实例
 * @param {(options: object, model: object) => object} inject 标记注入
 * @param {() => boolean} [isActive] 注入活性;还原后透传,缺省共用模块级常量
 * @returns {boolean}
 */
export function patchAdapterPrototype(adapter, inject, isActive = ALWAYS_ACTIVE) {
  if (adapter === null || typeof adapter !== 'object') return false
  const proto = Object.getPrototypeOf(adapter)
  if (proto === null || typeof proto !== 'object') return false
  let patch = prototypePatches.get(proto)
  if (patch !== undefined && patch.wrapper === proto.streamWithSnapshot) {
    addOwner(patch, adapter, { inject, isActive })
    return true
  }
  const original = proto.streamWithSnapshot
  if (typeof original !== 'function') return false
  patch ??= { owners: [] }
  const wrapper = function (options, snapshot) {
    if (activeOwnerFor(patch, this) === undefined) return original.call(this, options, snapshot)
    return original.call(this, options, { ...snapshot, models: decorateModels(snapshot?.models, patch, this) })
  }
  try {
    proto.streamWithSnapshot = wrapper
    if (proto.streamWithSnapshot !== wrapper) return false
  } catch {
    return false
  }
  addOwner(patch, adapter, { inject, isActive })
  patch.wrapper = wrapper
  prototypePatches.set(proto, patch)
  return true
}

/**
 * 原型上已登记的 owner 数(诊断与幂等断言用);未装饰返回零。
 * @param {object} adapter
 * @returns {number}
 */
export function ownerCount(adapter) {
  if (adapter === null || typeof adapter !== 'object') return 0
  const proto = Object.getPrototypeOf(adapter)
  if (proto === null || typeof proto !== 'object') return 0
  return prototypePatches.get(proto)?.owners.length ?? 0
}

/**
 * 扫描注册表存量 adapter 并确保其类原型已 patch。
 * @param {object} llm 宿主 llm 服务实例(adapters Map 为运行时内部形态)
 * @param {(options: object, model: object) => object} inject
 * @param {() => boolean} [isActive] 缺省共用模块级常量,与直接 patch 的缺省 owner 同引用
 * @returns {number} 已确保覆盖的注册 adapter 数(含既往已覆盖)
 */
export function sweepRegisteredAdapters(llm, inject, isActive = ALWAYS_ACTIVE) {
  if (!(llm?.adapters instanceof Map) || !(llm.directory instanceof Map)) return 0
  const officialRoutes = new Set([...llm.directory.values()]
    .filter((entry) => entry?.settingsNs === OFFICIAL_ROW_ID)
    .map((entry) => entry.provider))
  let count = 0
  for (const provider of officialRoutes) {
    const entry = llm.adapters.get(provider)
    if (entry === null || typeof entry !== 'object') continue
    if (entry.provider?.id !== provider) continue
    const adapter = entry.adapter
    if (adapter === null || typeof adapter !== 'object') continue
    if (patchAdapterPrototype(adapter, inject, isActive)) count += 1
  }
  return count
}
