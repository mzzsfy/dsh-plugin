import test from 'node:test'
import assert from 'node:assert/strict'
import { formatMatches, buildSearchTool } from '../src/tool-search.mjs'
import { TOOL_SEARCH_NAME } from '../src/fallback.mjs'

// 层夹具:global + 两个 scoped 层,definitionOf 现读 Map
function layersOfFixture() {
  const globalData = new Map([
    ['read', { name: 'read', description: '读取文件内容', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    ['shell', { name: 'shell', description: '执行 shell 命令', parameters: { type: 'object' } }],
    [TOOL_SEARCH_NAME, { name: TOOL_SEARCH_NAME, description: '折叠入口自身', parameters: {} }],
  ])
  const agentData = new Map([
    ['web_search', { name: 'web_search', description: 'web 搜索,聚合多引擎', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
  ])
  const layerOf = (data) => ({ names: () => [...data.keys()], definitionOf: (name) => data.get(name) })
  return () => [layerOf(globalData), layerOf(agentData)]
}

function matchNames(result) {
  return result.text.match(/^### (.+)$/gm)?.map((line) => line.slice(4)) ?? []
}

test('SC-21 正则命中工具名:返回定义文本含 parameters JSON', async () => {
  const tool = buildSearchTool(layersOfFixture())
  const result = await tool.execute({ pattern: '^web' })
  assert.deepEqual(matchNames(result), ['web_search'])
  assert.equal(result.count, 1)
  assert.ok(result.text.includes('parameters JSON Schema'))
  assert.ok(result.text.includes('"query"'))
  assert.ok(result.text.includes('web 搜索'))
})

test('SC-21 命中 description 子串与跨层去重', async () => {
  const tool = buildSearchTool(layersOfFixture())
  const result = await tool.execute({ pattern: '搜索' })
  assert.deepEqual(matchNames(result), ['web_search'])
  // 多命中
  const both = await tool.execute({ pattern: 'search|读取' })
  assert.deepEqual([...matchNames(both)].sort(), ['read', 'web_search'])
})

test('SC-21 无命中返回空态文本;tool_search 自身不出现', async () => {
  const tool = buildSearchTool(layersOfFixture())
  const none = await tool.execute({ pattern: 'zzz_no_such' })
  assert.ok(none.text.includes('没有匹配的工具'))
  const self = await tool.execute({ pattern: 'tool_search' })
  assert.ok(self.text.includes('没有匹配的工具'))
})

test('SC-21 无效正则返回错误文本不抛', async () => {
  const tool = buildSearchTool(layersOfFixture())
  const result = await tool.execute({ pattern: '([' })
  assert.ok(result.text.includes('无效模式'))
  const empty = await tool.execute({ pattern: '  ' })
  assert.ok(empty.text.includes('无效模式'))
})

test('SC-21 limit 钳制:默认 8,超上限收口,非整数参数宿主校验抛错', async () => {
  const many = []
  for (let index = 0; index < 55; index += 1) many.push([`tool_${index}`, { name: `tool_${index}`, description: `desc ${index}`, parameters: {} }])
  const layerOf = () => [{ names: () => many.map(([name]) => name), definitionOf: (name) => many.find(([key]) => key === name)?.[1] }]
  const tool = buildSearchTool(layerOf)
  assert.equal((await tool.execute({ pattern: 'tool_' })).count, 8)
  assert.equal((await tool.execute({ pattern: 'tool_', limit: 3 })).count, 3)
  assert.equal((await tool.execute({ pattern: 'tool_', limit: 999 })).count, 50)
  await assert.rejects(() => tool.execute({ pattern: 'tool_', limit: 'x' }), /integer/)
})

test('formatMatches 空清单空态文案', () => {
  assert.ok(formatMatches([]).includes('没有匹配的工具'))
})

test('SC-22 产物形态:defineTool 定义带 name/description/parameters/execute', () => {
  const tool = buildSearchTool(layersOfFixture())
  assert.equal(tool.name, TOOL_SEARCH_NAME)
  assert.equal(typeof tool.description, 'string')
  assert.equal(typeof tool.execute, 'function')
  assert.ok(tool.parameters)
  assert.equal(typeof tool.output.render, 'function')
  const blocks = tool.output.render({}, { text: 'hi' })
  assert.deepEqual(blocks, [{ type: 'text', text: 'hi' }])
})
