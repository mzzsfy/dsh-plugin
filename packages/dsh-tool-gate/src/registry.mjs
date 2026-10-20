// 层投影与特性检测(纯函数):从 ctx.tools 投影全局层与全部 per-agent scope
// 层。宿主 0.2 起模型可见工具多注册在 agent scope 层(presets 把工具搬到
// agent 面),全局层近乎恒空,收敛面必须覆盖两层。layers.global.tools 与
// layers.scoped 均为 ToolRuntime 内部面,宿主升级重构该面即特性检测失败 →
// 干净禁用,不做兼容层。

/**
 * 特性检测并投影工具层:返回层清单读取器,结构不符返回 undefined。
 * scoped Map 内容动态(新 agent 即新增层),layers() 每次现读。
 * key = 层数据表引用(NamedEntries.data,Map 实例,生命周期内稳定,供调用方
 * 做跨轮 journal 键);label 仅展示用(scope 键是对象,禁止 String 化作标识,
 * 真机实证全部坍缩 '[object Object]' 导致层间 lookup 串层)。
 * @param {object|undefined} tools 宿主 tools 服务(ToolRuntime)
 * @returns {undefined|{
 *   layers: () => { key: object, label: string, names: () => string[], definitionOf: (name: string) => object|undefined }[],
 * }}
 */
export function toolLayersOf(tools) {
  const store = tools?.layers
  const globalData = store?.global?.tools?.data
  if (!(globalData instanceof Map)) return undefined
  const layerOf = (key, label, data) => ({
    key,
    label,
    names: () => [...data.keys()],
    definitionOf: (name) => data.get(name),
  })
  return {
    layers: () => {
      const layers = [layerOf(globalData, 'global', globalData)]
      const scoped = store?.scoped
      if (scoped instanceof Map) {
        let index = 0
        for (const layer of scoped.values()) {
          const data = layer?.tools?.data
          if (data instanceof Map) layers.push(layerOf(data, `agent#${index += 1}`, data))
        }
      }
      return layers
    },
  }
}
