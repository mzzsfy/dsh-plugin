// 降级折叠决策(纯函数):缝上请求 tools → 目标 tools(BDD INV-10/11)。
// 三重透传门:空表原样;任一工具带 deferLoading 标(capable 路由原生投影
// 产物,见标即透传)→ 原样;与 deferred 名集无交集 → 原引用零拷贝。
// 命中时折叠为名字+参数骨架占位而非剔除:生成端(API tools 列表)必须可见
// 名字与参数骨架,模型才能产生正确调用名并填对参数,宿主按名执行 registry
// 完整定义;剔除会让模型把调用意图收敛到语义最近的白名单工具(真机实证:
// web_fetch → web_search),空 schema 会让模型发空参数(真机实证:带参数
// 工具全部参数校验失败,无参数工具全部成功)。
// 占位不带 deferLoading 键,投影幂等(值等价)。tool_search 永不入 deferred
// 名集(隐式白名单由收敛与 deferredNames 读取端共同保证)。

// 折叠入口工具名:隐式白名单成员(收敛不打标,deferred 名集读取端跳过)
export const TOOL_SEARCH_NAME = 'tool_search'

// 占位描述常量:值逐请求稳定(prompt cache 友好),引导先检索再调用
export const DEFERRED_PLACEHOLDER_DESCRIPTION = '延迟加载工具:调用前先用 tool_search 以本工具名作正则检索完整定义与参数说明,再按检索到的 schema 调用。'

/**
 * 深剥离 schema 说明(description 键),保留参数骨架(键名/类型/required)。
 * properties 下键名是参数名而非说明字段(真机实证:subagent 的参数
 * description 被按键名误剥 → 模型端 schema 缺该参数 → 空缺报错),特判
 * 保留键名、仅对参数定义递归。
 */
function stripDescriptions(node) {
  if (Array.isArray(node)) return node.map(stripDescriptions)
  if (node === null || typeof node !== 'object') return node
  const result = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') continue
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, definition]) => [name, stripDescriptions(definition)]))
      continue
    }
    result[key] = stripDescriptions(value)
  }
  return result
}

/** dsh ToolSchema 占位形态(pi-ai 消费 name/description/parameters);参数骨架保留,生成端才填得出参数。 */
function placeholderOf(tool) {
  const parameters = tool?.parameters && typeof tool.parameters === 'object'
    ? stripDescriptions(tool.parameters)
    : { type: 'object', properties: {} }
  return { name: tool.name, description: DEFERRED_PLACEHOLDER_DESCRIPTION, parameters }
}

/**
 * @param {Array<{name: string, deferLoading?: true}>|undefined} tools 缝上请求 tools(dsh ToolSchema 形态)
 * @param {Set<string>} deferredNames registry 现读 deferred 名集
 * @returns {{ tools: unknown, folded: string[], native: boolean }}
 *   native = 检测到 deferLoading 标(原生 toolUpdate 流程在管),调用方透传。
 */
export function planRequestTools(tools, deferredNames) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, folded: [], native: false }
  if (tools.some((tool) => tool?.deferLoading === true)) return { tools, folded: [], native: true }
  const folded = tools.filter((tool) => deferredNames.has(tool?.name)).map((tool) => tool.name)
  if (folded.length === 0) return { tools, folded, native: false }
  const foldedSet = new Set(folded)
  return { tools: tools.map((tool) => (foldedSet.has(tool?.name) ? placeholderOf(tool) : tool)), folded, native: false }
}
