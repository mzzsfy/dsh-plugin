// browser 半区路由:'/api/tool-gate/*',形态照 shell-select web 行(具名
// exact 路由 + 方法/跨源守卫 + 业务异常归一 400)。faces 由 settings/tools
// 服务构成:读 = settings describe + 全层工具 defer 态投影;写 =
// settings.replace 落盘行条目,收敛由主行 volatile-update 监听承担(BDD
// INV-9 零桥)。webServer 缺席(headless)时行不激活,不影响收敛本体。

import { cleanAllowlist, mountRoutes } from './api.mjs'
import { resolveConfig, unwrapConfig } from './config.mjs'
import { toolLayersOf } from './registry.mjs'
import { TOOL_SEARCH_NAME } from './fallback.mjs'

export const name = 'tool-gate/web'

export const inject = ['webServer', 'settings', 'tools']

// 设置节命名空间 = 本包主行在组合树中的条目 id(cordis.patch.yml insert id)
export const SECTION_NS = 'tool-gate'

/** 从 settings describe 投影当前节:解箱 volatile 字段并补齐 schema 默认,
 * 目标 ns 缺失时同样得到出厂值,读路径不崩。 */
function readSection(settings) {
  const found = (typeof settings.describe === 'function' ? settings.describe() : [])
    .find((descriptor) => descriptor.ns === SECTION_NS)
  const raw = found?.value
  const plain = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? unwrapConfig(raw) : {}
  const resolved = resolveConfig(plain)
  return {
    allowlist: cleanAllowlist(resolved.allowlist),
    enabled: resolved.enabled,
    collapse: resolved.collapse,
  }
}

/** 参数骨架投影:顶层参数名/类型/必填/说明(前端展开详情用,不复制整份 schema)。 */
function projectParams(definition) {
  const parameters = definition?.parameters
  const properties = parameters !== null && typeof parameters === 'object' ? parameters.properties : undefined
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return []
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: typeof schema?.type === 'string'
      ? schema.type
      : (Array.isArray(schema?.type) ? schema.type.filter((item) => typeof item === 'string').join(' | ') : ''),
    required: required.has(name),
    description: typeof schema?.description === 'string' ? schema.description : '',
  }))
}

/** 全层工具清单按名聚合(SC-11):deferred = 任一层带 defer 标;详情取首个有描述的层。 */
function projectTools(store) {
  const byName = new Map()
  for (const layer of store.layers()) {
    for (const name of layer.names()) {
      const definition = layer.definitionOf(name)
      const entry = byName.get(name) ?? {
        name,
        layers: 0,
        deferredLayers: 0,
        layerLabels: [],
        description: '',
        params: [],
      }
      entry.layers += 1
      entry.layerLabels.push(layer.label)
      if (entry.description === '' && typeof definition?.description === 'string') {
        entry.description = definition.description.trim()
        entry.params = projectParams(definition)
      }
      if (definition?.deferLoading === true) entry.deferredLayers += 1
      byName.set(name, entry)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** faces 构造(settings/tools 服务的适配,路由层无自有状态)。 */
export function buildFaces(settings, toolsStore) {
  const readState = () => {
    const section = readSection(settings)
    const tools = projectTools(toolsStore)
    const registered = new Set(tools.map((tool) => tool.name))
    const allowlist = section.allowlist ?? []
    return {
      enabled: section.enabled ?? true,
      collapse: section.collapse ?? true,
      allowlist,
      unknownAllowlisted: allowlist.filter((name) => !registered.has(name)),
      tools: tools.map((tool) => ({
        ...tool,
        inAllowlist: allowlist.includes(tool.name),
        implicit: tool.name === TOOL_SEARCH_NAME,
      })),
    }
  }
  return {
    readState,
    async updateAllowlist(list) {
      const current = readSection(settings)
      await settings.replace(SECTION_NS, { ...current, allowlist: list })
      return readState()
    },
    async updateEnabled(enabled) {
      const current = readSection(settings)
      await settings.replace(SECTION_NS, { ...current, enabled })
      return readState()
    },
    async updateCollapse(collapse) {
      const current = readSection(settings)
      await settings.replace(SECTION_NS, { ...current, collapse })
      return readState()
    },
  }
}

/** 行入口:webServer/settings/tools 已由 inject 门控就绪。 */
export function apply(ctx) {
  // tools 服务经 registry 投影成层读取器(裸服务无 layers 面,直接传即
  // readState 每调必抛 → 路由 400)
  const store = toolLayersOf(ctx.get('tools'))
  if (store === undefined) {
    ctx.logger?.warn?.('tool-gate/web: ctx.tools 层结构与已知形态不符,状态路由跳过(收敛不受影响)')
    return
  }
  mountRoutes(ctx, buildFaces(ctx.get('settings'), store))
}

