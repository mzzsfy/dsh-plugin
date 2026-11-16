// 请求缝隐藏 pwsh(BDD):preset 自带的官方 pwsh 工具在会话作用域注册,工具层
// 遮蔽不了(own 注册优先于同名全局继承),只能在模型请求上剔除。
// - Given 请求 tools 含 pwsh 与 shell,When 经过请求缝,Then pwsh 消失、其余原引用保留;
// - Given 请求里没有 pwsh,Then 原引用透传(零拷贝);
// - Given 请求里只有 pwsh、没有 shell(子代理工具允许集仅保留 pwsh),Then 原样
//   透传——没有替代终端时剔除 pwsh 等于让模型无终端可用;
// - Given 另一个包已 patch 同一原型,When 本包再装,Then 两层改写链式叠加互不覆盖;
// - Given 行卸载/执行器未挂载(isActive false),Then 请求原样透传。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachRequestHiding, hideShadowedPwsh } from '../src/request-hide.mjs'

const toolsOf = (...names) => names.map((name) => ({ name }))

function stubLlm() {
  // 每个用例独立类:原型级 patch 是进程内共享状态,复用同一类会跨用例串扰
  class Adapter {
    async stream(options) {
      return options
    }
  }
  const adapter = new Adapter()
  return { adapter, llm: { adapters: new Map([['fake', { adapter }]]) } }
}

test('请求含 pwsh 与 shell:剔除 pwsh 并保留其余工具', async () => {
  const { adapter, llm } = stubLlm()
  assert.equal(attachRequestHiding(llm), 1)
  const read = { name: 'read' }
  const shell = { name: 'shell' }
  const out = await adapter.stream({ tools: [read, { name: 'pwsh' }, shell] })
  assert.deepEqual(out.tools.map((tool) => tool.name), ['read', 'shell'])
  assert.equal(out.tools[0], read)
  assert.equal(out.tools[1], shell)
})

test('请求不含 pwsh:原引用透传', async () => {
  const { adapter, llm } = stubLlm()
  attachRequestHiding(llm)
  const tools = toolsOf('read', 'shell')
  const out = await adapter.stream({ tools })
  assert.equal(out.tools, tools)
})

// S16:活性开 + 本次无命中时不得无条件克隆请求对象(每请求一次的热路径)
test('活性开但无 pwsh 命中:请求对象本身零拷贝', async () => {
  const { adapter, llm } = stubLlm()
  attachRequestHiding(llm, () => true)
  const options = { tools: toolsOf('read', 'shell'), temperature: 0.2 }
  const out = await adapter.stream(options)
  assert.equal(out, options, '无命中必须原对象透传')
})

test('请求只有 pwsh、没有 shell:原引用透传(唯一终端不得被剔除)', async () => {
  const { adapter, llm } = stubLlm()
  attachRequestHiding(llm)
  const tools = toolsOf('read', 'pwsh')
  const out = await adapter.stream({ tools })
  assert.equal(out.tools, tools)
  assert.deepEqual(out.tools.map((tool) => tool.name), ['read', 'pwsh'])
})

test('与已装改写链式叠加,互不覆盖', async () => {
  // Given 另一个包先装自己的改写(模拟 tool-gate 的折叠)
  const { adapter, llm } = stubLlm()
  const proto = Object.getPrototypeOf(adapter)
  const base = proto.stream
  proto.stream = function (options, snapshot) {
    return base.call(this, { ...options, marked: true }, snapshot)
  }
  // When 本包装上
  assert.equal(attachRequestHiding(llm), 1)
  // Then 两层都生效
  const out = await adapter.stream({ tools: toolsOf('read', 'pwsh', 'shell') })
  assert.equal(out.marked, true)
  assert.deepEqual(out.tools.map((tool) => tool.name), ['read', 'shell'])
})

test('行卸载后透传,不再剔除', async () => {
  const { adapter, llm } = stubLlm()
  let active = true
  attachRequestHiding(llm, () => active)
  active = false
  const out = await adapter.stream({ tools: toolsOf('read', 'pwsh', 'shell') })
  assert.deepEqual(out.tools.map((tool) => tool.name), ['read', 'pwsh', 'shell'])
})

test('llm 形态缺失或 adapter 无该能力:零动作', () => {
  assert.equal(attachRequestHiding(undefined), 0)
  assert.equal(attachRequestHiding({}), 0)
  assert.equal(attachRequestHiding({ adapters: new Map([['x', { adapter: {} }]]) }), 0)
})

test('hideShadowedPwsh:空表与非数组原样返回;缺 shell 不改写', () => {
  assert.deepEqual(hideShadowedPwsh([]), [])
  assert.equal(hideShadowedPwsh(undefined), undefined)
  const noShell = toolsOf('pwsh')
  assert.equal(hideShadowedPwsh(noShell), noShell)
  const withShell = toolsOf('pwsh', 'shell')
  assert.deepEqual(hideShadowedPwsh(withShell).map((tool) => tool.name), ['shell'])
})

test('pi-ai 形态:prepared call 直接调 streamWithSnapshot 也被剔除', async () => {
  // pi-ai 的 PreparedCall.stream 闭包直接调 this.streamWithSnapshot,不经过
  // adapter.stream;只包公开入口会漏掉这条路径。
  class Adapter {
    async stream(options) {
      return this.streamWithSnapshot(options)
    }

    async streamWithSnapshot(options) {
      return options
    }
  }
  const adapter = new Adapter()
  attachRequestHiding({ adapters: new Map([['pi', { adapter }]]) })
  const direct = await adapter.streamWithSnapshot({ tools: toolsOf('read', 'pwsh', 'shell') })
  assert.deepEqual(direct.tools.map((tool) => tool.name), ['read', 'shell'])
  const viaStream = await adapter.stream({ tools: toolsOf('read', 'pwsh', 'shell') })
  assert.deepEqual(viaStream.tools.map((tool) => tool.name), ['read', 'shell'])
})
