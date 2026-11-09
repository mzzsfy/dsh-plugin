// 层投影与特性检测(纯函数):从 ctx.tools 投影全局层与全部 per-agent scope
// 层。宿主 0.2 起模型可见工具多注册在 agent scope 层(presets 把工具搬到
// agent 面),全局层近乎恒空,收敛面必须覆盖两层。layers.global.tools 与
// layers.scoped 均为 ToolRuntime 内部面,宿主升级重构该面即特性检测失败 →
// 干净禁用,不做兼容层。
//
// 层条目两形态并存:0.2.2 起为 registration 包装({ definition, when }),模型面
// 投影与 defer 打标读 registration.definition;更早代际条目是裸 definition,
// 投影直接读 definition.deferLoading。读取一律先解包再打标,写入目标恒为
// definition;未知条目形态(既非包装也无 name)判漂移。

/**
 * 层条目 → definition:registration 取内层,裸 definition 取自身;未知返回
 * undefined(特性检测据此判定内部面漂移)。
 */
function definitionOfEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const inner = entry.definition
  if (inner !== null && typeof inner === 'object' && typeof inner.name === 'string') return inner
  return typeof entry.name === 'string' ? entry : undefined
}

/**
 * 判断一层是否为已知条目形态(registration 或裸 definition);空表无从判断按
 * 符合处理(注册后由 apply 自检 tool_search 条目兜底),非空表逐条校验,混合
 * 形态同样判漂移。
 */
function isKnownLayer(data) {
  for (const entry of data.values()) if (definitionOfEntry(entry) === undefined) return false
  return true
}

/**
 * 特性检测并投影工具层:返回层清单读取器,结构不符返回 undefined。
 * scoped Map 内容动态(新 agent 即新增层),global 表也会被宿主 NamedEntries
 * 在清空时换代;两者均由 layers() 每次现读,不缓存表引用。
 * key = 当轮层数据表引用(同轮内稳定,供 plan 匹配层);label 仅展示用
 * (scope 键是对象,禁止 String 化作标识,真机实证全部坍缩 '[object Object]'
 * 导致层间 lookup 串层)。
 * @param {object|undefined} tools 宿主 tools 服务(ToolRuntime)
 * @returns {undefined|{
 *   layers: () => { key: object, label: string, names: () => string[], definitionOf: (name: string) => object|undefined }[],
 * }}
 */
export function toolLayersOf(tools) {
  const store = tools?.layers
  const globalData = () => store?.global?.tools?.data
  const scopedData = () => (store?.scoped instanceof Map
    ? [...store.scoped.values()].map((layer) => layer?.tools?.data).filter((data) => data instanceof Map)
    : [])
  const dataOf = () => {
    const global = globalData()
    return global instanceof Map ? [global, ...scopedData()] : undefined
  }
  const initial = dataOf()
  if (initial === undefined || !initial.every(isKnownLayer)) return undefined
  const layerOf = (key, label, data) => ({
    key,
    label,
    names: () => [...data.keys()],
    definitionOf: (name) => definitionOfEntry(data.get(name)),
  })
  return {
    layers: () => {
      const data = dataOf()
      if (data === undefined) return []
      const [global, ...scoped] = data
      const layers = [layerOf(global, 'global', global)]
      let index = 0
      for (const entry of scoped) layers.push(layerOf(entry, `agent#${index += 1}`, entry))
      return layers
    },
  }
}
