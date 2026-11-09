// tool-gate 主行入口(apply 型):白名单 → 全部工具层 deferLoading 声明式收敛,
// 外加降级折叠(BDD INV-10):官方 llm-pi-ai 行 adapter 原型缝上,把 deferred
// 工具从请求 tools 中剔除(不支持 defer_loading 的路由宿主会剥标全量注入,
// 折叠在缝上自实现;capable 路由见标透传,deepseek 原生行不 patch)。
//
// 折叠入口工具 tool_search 经 defineTool 注册于全局层(effect 注销),收敛视
// 其为隐式白名单成员(INV-12);模型经它检索定义文本后直接调用,宿主按名
// 执行,与请求 tools 列表无关。
//
// 收敛面 = 全局层 + 全部 per-agent scope 层(宿主 0.2 模型可见工具多注册在
// agent 面,全局层近乎恒空,真机实证);scoped 层随 agent 动态生灭,每轮
// 收敛现读层清单,新层的首收敛由其注册触发的 tools/change 驱动。
//
// 收敛触发三点:apply 落定 / loader/volatile-update(白名单热改,现读
// volatile ref)/ tools/change(注册、注销、重注册)。每次全量重算决策,
// 只动与目标态有差异的名(幂等)。改动前记 undo journal(definition 引用 →
// 原字段形态),行退场按 journal 逐条还原(层表换代不失联,INV-2);层已随
// agent 销毁时 definition 引用仍在,改无人观察的对象,无害。
//
// 宿主代际门:层条目形态非 registration、或 tools 服务缺 definitions 投影面
// (0.2.2 前)时零动作禁用,不留监听与装饰器。
//
// enabled=false 收敛为「按 journal 全量还原并停止打标」,等效临时停用。

import { toolLayersOf } from './registry.mjs'
import { planConvergence } from './converge.mjs'
import { resolveConfigStrict, unwrapConfig } from './config.mjs'
import { TOOL_SEARCH_NAME, planRequestTools } from './fallback.mjs'
import { buildSearchTool } from './tool-search.mjs'
import { sweepCollapseAdapters } from './decorator.mjs'

export const name = 'tool-gate'

// inject 声明式门控:行 fiber 等 tools 服务在场才 apply(ctx.get 即时解析在
// 行挂载时刻早于服务可达,真机实证 undefined → 误判干净禁用;宿主行模块
// inject 同 web-routes 先例,服务缺失即保持未激活,即干净禁用)
export const inject = ['tools']

// settings 节注册面:宿主按行模块的 Config 导出注册 tool-gate 节
export { Config } from './config.mjs'

/**
 * 主行 apply。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object|undefined} config 行 Config(allowlist/enabled/collapse,volatile ref 容器)
 */
export function apply(ctx, config) {
  // inject ['tools'] 已门控服务在场;全局层内部面(ToolRuntime 升级即可能
  // 变化)仍须显式特性检测,不符即干净禁用,零动作不崩
  const store = toolLayersOf(ctx.get('tools'))
  if (store === undefined) {
    ctx.logger?.warn?.('tool-gate: ctx.tools 层结构与已知形态不符,干净禁用(零动作)')
    return
  }

  /**
   * undo journal:definition 引用 → 首次改变前原状 { hadField, value }。
   * 键用 definition 而非层数据表:宿主层表清空时会换代(NamedEntries),
   * 层键随之失联;definition 跨层共享且身份稳定,同名换对象时新对象另记一条。
   */
  const journal = new Map()

  const readConfig = () => resolveConfigStrict(unwrapConfig(config ?? {}))

  function restoreAll() {
    for (const [definition, record] of journal) {
      if (record.hadField) definition.deferLoading = record.value
      else delete definition.deferLoading
    }
    journal.clear()
  }

  /** 取该 definition 的原状记录(仅记录首次改变时的现场)。 */
  function journalEntry(definition) {
    const recorded = journal.get(definition)
    if (recorded !== undefined) return recorded
    const fresh = { hadField: 'deferLoading' in definition, value: definition.deferLoading }
    journal.set(definition, fresh)
    return fresh
  }

  /** 一轮声明式收敛:白名单是唯一事实源,逐层只动与目标态有差异的名。 */
  function converge() {
    const { allowlist, enabled } = readConfig()
    if (!enabled) {
      if (journal.size > 0) {
        restoreAll()
        ctx.logger?.info?.('tool-gate: enabled=false,已还原全部原状并停止打标')
      }
      return
    }
    const layers = store.layers()
    const { perLayer, unknownAllowlisted } = planConvergence(layers, allowlist, [TOOL_SEARCH_NAME])
    let deferred = 0
    let cleared = 0
    let skipped = 0
    for (const plan of perLayer) {
      const layer = layers.find((candidate) => candidate.key === plan.key)
      for (const name of plan.toDefer) {
        const definition = layer.definitionOf(name)
        if (definition === undefined) { skipped += 1; continue }
        journalEntry(definition)
        definition.deferLoading = true
        deferred += 1
      }
      for (const name of plan.toClear) {
        const definition = layer.definitionOf(name)
        if (definition === undefined) { skipped += 1; continue }
        journalEntry(definition)
        delete definition.deferLoading
        cleared += 1
      }
    }
    if (skipped > 0) {
      ctx.logger?.warn?.(`tool-gate: 层内 ${skipped} 个条目无 definition(形态漂移),已跳过`)
    }
    if (unknownAllowlisted.length > 0) {
      ctx.logger?.warn?.(`tool-gate: 白名单未知名(全部层未注册,拼错?): ${unknownAllowlisted.join(', ')}`)
    }
    if (deferred > 0 || cleared > 0) {
      ctx.logger?.info?.(`tool-gate: 收敛 defer+${deferred} clear-${cleared} 层 ${layers.length} 白名单 ${allowlist.length} 项`)
    }
  }

  // tool_search 注册(折叠入口,隐式白名单 INV-12):行退场随 effect 注销,
  // 系统回到「没装本包」的世界;register/definitions 面缺失或注册条目形态
  // 不符 → 宿主代际漂移,注销并干净禁用(零动作)。检索面 = 模型本步准入面
  // (definitions(scope, toolSet),宿主已解析 when/restrict;无 toolSet 即注册视图)。
  const toolsService = ctx.get('tools')
  if (typeof toolsService?.register === 'function' && typeof toolsService?.definitions === 'function') {
    const searchTool = buildSearchTool((exec) => new Map(
      toolsService.definitions(exec?.agent, exec?.toolSet).map((definition) => [definition.name, definition]),
    ))
    const disposeSearch = ctx.effect(() => toolsService.register(searchTool), 'tool-gate tool_search')
    // 注册后自检宿主把条目包成 registration:apply 时层可能为空(空表无从判定),
    // 注册后这一条在层内即校验;形态不符 = 宿主代际漂移 → 注销并零动作。
    // 层内查不到(假宿主不入层)无从判定,放行。
    const registered = toolsService.layers?.global?.tools?.data?.get?.(TOOL_SEARCH_NAME)
    if (registered !== undefined && registered?.definition !== searchTool) {
      disposeSearch?.()
      ctx.logger?.warn?.('tool-gate: 宿主层条目未经 registration 包装,内部面形态与已知契约不符,干净禁用(零动作)')
      return
    }
  } else {
    // definitions 面是宿主 0.2.2+ 的投影读取面;缺失即宿主代际不符。
    // apply 时层可能为空(形态不可判定),这里直接零动作,不留监听/装饰器
    ctx.logger?.warn?.('tool-gate: tools.register/definitions 面缺失,宿主代际不符,干净禁用(零动作)')
    return
  }
  // ---- 降级折叠(INV-10):llm 服务软依赖,缺失 = 只打标不折叠 ----

  /** registry 现读 deferred 名集(层 definition.deferLoading === true)。 */
  function deferredNames() {
    const names = new Set()
    for (const layer of store.layers()) {
      for (const name of layer.names()) {
        if (name === TOOL_SEARCH_NAME) continue
        if (layer.definitionOf(name)?.deferLoading === true) names.add(name)
      }
    }
    return names
  }

  // 折叠日志按折叠名集签名去重(逐请求常量名集只记一次)
  let lastFoldedKey = ''
  const rewrite = (options) => {
    const { enabled, collapse } = readConfig()
    if (!enabled || !collapse) return options
    const plan = planRequestTools(options?.tools, deferredNames())
    if (plan.folded.length === 0) return options
    const signature = plan.folded.join(',')
    if (signature !== lastFoldedKey) {
      lastFoldedKey = signature
      ctx.logger?.info?.(`tool-gate: 降级折叠为占位 ${plan.folded.length} 工具(${signature})`)
    }
    return { ...options, tools: plan.tools }
  }

  void ctx.inject(['llm'], (lctx) => {
    const llm = lctx.llm
    if (!(llm?.adapters instanceof Map) || !(llm.directory instanceof Map)) {
      ctx.logger?.warn?.('tool-gate: 宿主 llm 服务形态不符,降级折叠禁用(打标收敛不受影响)')
      return
    }
    // owner 活性 = 配置开关 且 本行 fiber 存活:行卸载/HMR 后旧 owner isActive 恒假,
    // 装饰器透传,原型上残留的 owner 记录由 addOwner 的惰性清扫回收(F16:
    // 只看配置曾让卸载行的旧 owner 恒真,新行同 adapter 注册被去重拒绝)
    let disposed = false
    ctx.effect(() => () => { disposed = true }, 'tool-gate collapse owner lifetime')
    const isActive = () => {
      if (disposed) return false
      const current = readConfig()
      return current.enabled && current.collapse
    }
    const sweep = () => sweepCollapseAdapters(llm, rewrite, isActive)
    const swept = sweep()
    if (swept === 0) ctx.logger?.warn?.('tool-gate: apply 时无 pi-ai adapter(等 llm/adapters-updated 兜底)')
    else ctx.logger?.info?.(`tool-gate: 降级折叠就绪(adapter ${swept})`)
    lctx.on('llm/adapters-updated', sweep, { global: true })
  })

  // 白名单热改:volatile-only 变更宿主换 ref 不重挂行,本行 fiber 自身 emit
  // 的事件现读 ref 重收敛(shell-select volatile 补偿同构)
  ctx.on('loader/volatile-update', converge)
  // 工具注册/注销/重注册(含 scoped 层新注册):新对象 defer 态回原状,
  // 下一轮收敛重新归位
  ctx.on('tools/change', converge, { global: true })

  // settings 服务动态声明(BDD INV-9):仅用于抑制原生 schemastery 设置节
  // (auto:false,配置唯一入口 = GUI 卡片);服务缺失只影响节抑制,不影响
  // 收敛本体。收敛先落定再抑制,避免节注册与抑制交错
  void ctx.inject(['settings'], (sctx) => {
    try {
      sctx.settings.configure({ auto: false }, ctx.fiber)
    } catch (error) {
      ctx.logger?.warn?.(`tool-gate: 原生设置节抑制失败(GUI 与原生节并存): ${error?.message ?? error}`)
    }
  })

  converge()
  // 行退场(禁用/卸载/重载)还原原状:系统回到「没装本包」的世界
  ctx.effect(() => () => restoreAll())
}
