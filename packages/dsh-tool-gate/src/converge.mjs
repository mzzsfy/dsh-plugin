// 收敛决策(纯函数):白名单 → 单个工具层的目标 defer 态。
// 白名单是唯一事实源:白名单内清标(覆盖插件作者自带声明,用户意图优先),
// 白名单外打标;与现状相同的名不出现在决策里(幂等,只动差异)。
// 全局层与各 per-agent scope 层同规则逐层收敛,调用方组合。

/**
 * 计算一层的收敛决策。
 * @param {string[]} names 层内当前工具名清单
 * @param {(name: string) => object|undefined} definitionOf 名 → definition
 * @param {Set<string>} allowed 白名单集合
 * @returns {{ toDefer: string[], toClear: string[] }}
 */
export function planLayer(names, definitionOf, allowed) {
  const toDefer = []
  const toClear = []
  for (const name of names) {
    const deferred = definitionOf(name)?.deferLoading === true
    if (allowed.has(name)) {
      if (deferred) toClear.push(name)
    } else if (!deferred) {
      toDefer.push(name)
    }
  }
  return { toDefer, toClear }
}

/**
 * 全层决策汇总:逐层 planLayer,附白名单未知名(以全部层名字并集为注册全集)。
 * @param {{ key: string, names: Function, definitionOf: Function }[]} layers
 * @param {string[]} allowlist 白名单
 * @param {string[]} [implicitAllow] 隐式白名单(如 tool_search,INV-12),并入 allowed 判定
 * @returns {{ perLayer: { key: string, toDefer: string[], toClear: string[] }[], unknownAllowlisted: string[] }}
 */
export function planConvergence(layers, allowlist, implicitAllow = []) {
  const allowed = new Set(allowlist)
  for (const name of implicitAllow) allowed.add(name)
  const registered = new Set()
  for (const layer of layers) for (const name of layer.names()) registered.add(name)
  const perLayer = layers.map((layer) => ({ key: layer.key, ...planLayer(layer.names(), layer.definitionOf, allowed) }))
  return { perLayer, unknownAllowlisted: allowlist.filter((name) => !registered.has(name)) }
}
