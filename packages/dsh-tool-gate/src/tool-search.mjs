// tool_search 折叠入口工具(BDD INV-12/SC-21/SC-22):正则搜全层 registry,
// 返回命中工具的完整定义文本(name/description/parameters),模型据文本直接
// 调用(宿主按名执行,与请求 tools 列表无关)。执行只读 registry,与宿主
// 执行管线零耦合;隐式白名单成员,收敛永不打标。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { TOOL_SEARCH_NAME } from './fallback.mjs'

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 50

/** 无效正则防御:返回 RegExp 或 undefined(空/非法均 undefined)。 */
function compilePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') return undefined
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return undefined
  }
}

function clampLimit(value) {
  if (!Number.isInteger(value)) return DEFAULT_LIMIT
  return Math.min(Math.max(value, 1), MAX_LIMIT)
}

/**
 * 格式化命中清单(SC-21):一条一节,含 parameters JSON。
 * @param {{ name: string, description: string, parameters: unknown }[]} matches
 * @returns {string}
 */
export function formatMatches(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return '没有匹配的工具。请换更宽的模式(如工具名前缀)。'
  }
  return matches.map((match) => {
    let parameters = '{}'
    try {
      parameters = JSON.stringify(match.parameters ?? {})
    } catch {
      parameters = '{}'
    }
    return [`### ${match.name}`, (match.description ?? '').trim(), `parameters JSON Schema: ${parameters}`].join('\n')
  }).join('\n\n')
}

/** 全层定义收集(按名去重,先层优先),跳过 tool_search 自身。 */
function collectDefinitions(layers) {
  const byName = new Map()
  for (const layer of layers) {
    for (const name of layer.names()) {
      if (name === TOOL_SEARCH_NAME || byName.has(name)) continue
      const definition = layer.definitionOf(name)
      if (definition === null || typeof definition !== 'object') continue
      byName.set(name, definition)
    }
  }
  return byName
}

/**
 * 构造 tool_search 定义(defineTool 产物,含编译 schema 与执行体)。
 * @param {() => Array<{ names: () => string[], definitionOf: (name: string) => unknown|undefined }>} layersOf 层读取器(现读)
 * @returns {object} ToolRuntime.register 直收的定义
 */
export function buildSearchTool(layersOf) {
  return defineTool({
    name: TOOL_SEARCH_NAME,
    description: '按需检索延迟加载的工具:输入正则模式(不区分大小写,匹配工具名与描述),返回命中工具的完整定义。需要当前工具列表中没有的能力时调用,拿到定义后即可直接调用该工具。',
    parameters: {
      pattern: { type: 'string', required: true, description: '正则模式,匹配工具名与描述' },
      limit: { type: 'integer', description: `最多返回条数(默认 ${DEFAULT_LIMIT},上限 ${MAX_LIMIT})` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const regex = compilePattern(args?.pattern)
      if (regex === undefined) return { text: `无效模式:${String(args?.pattern ?? '')}。请输入合法正则表达式。` }
      const limit = clampLimit(args?.limit)
      const matches = []
      for (const [name, definition] of collectDefinitions(layersOf())) {
        if (matches.length >= limit) break
        const description = typeof definition.description === 'string' ? definition.description : ''
        if (regex.test(name) || regex.test(description)) {
          matches.push({ name, description, parameters: definition.parameters })
        }
      }
      return { text: formatMatches(matches), count: matches.length }
    },
  })
}
