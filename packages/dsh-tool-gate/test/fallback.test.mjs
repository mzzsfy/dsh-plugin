import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFERRED_PLACEHOLDER_DESCRIPTION, TOOL_SEARCH_NAME, planRequestTools } from '../src/fallback.mjs'

test('SC-16 降级折叠投影:deferred 折叠为名字+参数骨架占位,白名单原引用,不可变构造', () => {
  const read = { name: 'read' }
  const shell = { name: 'shell' }
  const webFetch = {
    name: 'web_fetch',
    description: '抓取网页',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '目标 URL' } },
      required: ['url'],
    },
  }
  const tools = [read, shell, webFetch]
  const deferred = new Set(['shell', 'web_fetch'])
  const plan = planRequestTools(tools, deferred)
  // 名字全保留(生成端可见,模型才能产生正确调用名)
  assert.deepEqual(plan.tools.map((tool) => tool.name), ['read', 'shell', 'web_fetch'])
  // 白名单工具原引用透传
  assert.equal(plan.tools[0], read)
  // deferred 折叠为占位:引导文案 + 参数骨架(键名/类型/required 保留,description 剥离)+ 无 deferLoading 键
  assert.deepEqual(plan.tools[1], { name: 'shell', description: DEFERRED_PLACEHOLDER_DESCRIPTION, parameters: { type: 'object', properties: {} } })
  assert.equal('deferLoading' in plan.tools[2], false)
  assert.equal(plan.tools[2].description, DEFERRED_PLACEHOLDER_DESCRIPTION)
  assert.deepEqual(plan.tools[2].parameters, {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  })
  assert.deepEqual(plan.folded, ['shell', 'web_fetch'])
  assert.equal(plan.native, false)
  // 输入不变异(嵌套 description 未被剥离)
  assert.equal(tools.length, 3)
  assert.equal(tools[2].parameters.properties.url.description, '目标 URL')
})

test('SC-16b 参数名为 description 不被误剥:properties 键名是参数名,非 schema 说明', () => {
  const subagent = {
    name: 'subagent',
    description: '委派子代理',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '任务短描述' },
        prompt: { type: 'string', description: '完整任务' },
      },
      required: ['description', 'prompt'],
    },
  }
  const plan = planRequestTools([subagent], new Set(['subagent']))
  // 参数键名保留,只剥参数定义内部的说明
  assert.deepEqual(plan.tools[0].parameters, {
    type: 'object',
    properties: {
      description: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['description', 'prompt'],
  })
})

test('SC-16a 折叠幂等:占位输入再投影值等价', () => {
  const tools = [{ name: 'web_fetch', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }]
  const first = planRequestTools(tools, new Set(['web_fetch']))
  const second = planRequestTools(first.tools, new Set(['web_fetch']))
  assert.deepEqual(second.tools, first.tools)
  assert.deepEqual(second.folded, first.folded)
})

test('SC-17 缝上见 deferLoading 标即原生透传(capable 路由)', () => {
  const tools = [{ name: 'read' }, { name: 'shell', deferLoading: true }]
  const plan = planRequestTools(tools, new Set(['shell']))
  assert.equal(plan.tools, tools)
  assert.deepEqual(plan.folded, [])
  assert.equal(plan.native, true)
})

test('SC-18 零命中零拷贝:原引用透传', () => {
  const tools = [{ name: 'read' }, { name: 'edit' }]
  const plan = planRequestTools(tools, new Set(['web_search']))
  assert.equal(plan.tools, tools)
  assert.deepEqual(plan.folded, [])
  assert.equal(plan.native, false)
})

test('空表与 undefined tools 原样', () => {
  assert.deepEqual(planRequestTools([], new Set(['a'])), { tools: [], folded: [], native: false })
  const plan = planRequestTools(undefined, new Set(["a"]))
  assert.equal(plan.tools, undefined)
})

test('TOOL_SEARCH_NAME 契约:折叠入口名固定', () => {
  assert.equal(TOOL_SEARCH_NAME, 'tool_search')
})
