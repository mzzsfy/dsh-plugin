// llm-pi-gateway Host 半区(装饰器形态):官方 llm-pi-ai 行保持启用并自服务,
// 本包在官方 adapter 类的 streamWithSnapshot 原型上注入派生会话标记。
// 不注册任何 adapter/directory/discovery,不接管官方 settings 节
// (0.1.7+ 宿主设置页模型新增因此原生完好)。

import z from '@deepseek-ai/schemastery'
import { SETTINGS_NS } from './config.mjs'
import { createMarkerInject, sweepRegisteredAdapters } from './decorator.mjs'

export const name = 'llm-pi-gateway'

const sessionMarkerSchema = z.object({
  enabled: z.boolean().default(true),
  prefix: z.string(),
})

export const Config = volatileWrap(z.object({
  sessionMarker: sessionMarkerSchema.default({ enabled: true, prefix: 'dsh' }),
}))

// 宿主 settings 写路径的 volatile 表单门槛(0.1.7 无 volatile 字段即拒整节写);
// 旧宿主 schemastery 无 volatile 方法,特性检测原样返回
function volatileWrap(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

// 0.1.7 volatile 形态:apply 入参 config 中 volatile 字段是响应式 ref(get 协议),
// 节写经 updateVolatile 就地换值广播 volatile-update,读值必须动态解包
const unwrapVolatile = (value) => (typeof value?.get === 'function' ? value.get() : value)

// 官方行注册 adapter 晚于本包 apply(装载序无保证),sweep + 事件是承载机制;
// inject 声明 llm 依赖,保证可用性与禁用顺序
export const inject = ['llm']

// llm 服务内部形态门槛(adapters 为 Map):版本漂移防御
const hostShadowable = (llm) => llm !== null && typeof llm === 'object' && llm.adapters instanceof Map

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 本节初始配置(volatile 字段为 ref,动态解包)
 */
export async function apply(ctx, config) {
  const llm = ctx.llm
  if (!hostShadowable(llm)) {
    ctx.logger?.warn?.('llm-pi-gateway: 宿主 llm 服务形态不符,插件禁用')
    return undefined
  }
  const readMarker = () => unwrapVolatile(unwrapVolatile(config)?.sessionMarker) ?? { enabled: true, prefix: 'dsh' }
  let markerConfig = readMarker()
  const warnOnce = (provider, message) => ctx.logger?.warn?.(message)
  const injectOptions = createMarkerInject(() => markerConfig, warnOnce)
  let active = true
  const isActive = () => active
  const sweep = () => {
    return sweepRegisteredAdapters(llm, injectOptions, isActive)
  }
  const swept = sweep()
  if (swept === 0) ctx.logger?.warn?.('llm-pi-gateway: apply 时无官方 adapter(等 llm/adapters-updated 兜底)')
  const offSweep = ctx.on('llm/adapters-updated', sweep, { global: true })
  const offUpdate = ctx.on('loader/volatile-update', () => { markerConfig = readMarker() })
  ctx.fiber.effect(() => () => {
    active = false
    offSweep?.()
    offUpdate?.()
  })
  ctx.logger?.info?.('llm-pi-gateway: 装饰器就绪(官方行自服务,anthropic 会话标记注入)')
  return undefined
}

export { SETTINGS_NS }
