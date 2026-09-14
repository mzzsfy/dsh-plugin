// rs-workflow 通用流程解释器(flow.js)验收测试(强流程语义)
// 驱动方式与 engine.test.mjs 同构: new Function 包成 async 函数体, 注入 agent/parallel/phase/log 钩子
// BDD 场景: 步骤链式推进 / 产出契约教学重问 / 失败重试与 blocked / for_each 串行循环携带 /
//           并行就绪发车 / 嵌套子流程动态路由(分诊) / 资源注入 / 占位符引用不可用中止
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'dsh-rs-workflow', 'engine', 'flow.js')
const FLOW_SRC = readFileSync(FLOW_PATH, 'utf8')

// ── 响应构造器(自由文本 + 产出块) ────────────────────────────────────────────
function outs(map, prose = '工作叙述') {
  const blocks = Object.entries(map).map(([name, body]) => `<output name="${name}">${body}</output>`)
  return prose + '\n' + blocks.join('\n')
}

// 剧本式 harness:queue 项为响应文本 或 {fail:次数后成功} 或函数(args 检查)
async function runFlowScript(args, script) {
  const calls = []
  const phases = []
  const logs = []
  const queue = script.slice()
  async function agent(prompt, opts) {
    calls.push({ prompt: String(prompt), opts: opts || {} })
    if (!queue.length) throw new Error('响应剧本耗尽: ' + (opts && opts.label))
    const item = queue.shift()
    if (typeof item === 'function') return item({ prompt, opts })
    if (item && typeof item === 'object' && typeof item.fail === 'number') {
      const seq = item._seq = (item._seq || 0) + 1
      if (seq <= item.fail) throw new Error('模拟调用失败#' + seq)
      return item.then
    }
    return typeof item === 'string' ? item : JSON.stringify(item)
  }
  async function parallel(thunks) {
    return Promise.all(thunks.map((thunk) => thunk().catch(() => null)))
  }
  const body = new Function('args', 'agent', 'parallel', 'phase', 'log', `"use strict";\nreturn (async () => {\n${FLOW_SRC}\n})()`)
  const result = await body(args, agent, parallel, (t) => phases.push(t), (m) => logs.push(m))
  return { result, calls, phases, logs }
}

const BUDGETS = { reviewRejectBeforeEscalate: 2, emptyOutputRetryLimit: 3 }

// ── 场景 ────────────────────────────────────────────────────────────────────

test('Given 三步链式流程, When 逐步产出达标, Then 按序推进并返回全部产出', async () => {
  const flow = {
    id: 'chain', label: '链式', description: '三步链',
    steps: [
      { id: 'a', prompt: '做A', outputs: { x: 'A产出' } },
      { id: 'b', prompt: '做B, 引用:{a.x}', outputs: { y: 'B产出' } },
      { id: 'c', prompt: '做C, 引用:{b.y}', outputs: { z: 'C产出' } },
    ],
  }
  const { result, calls } = await runFlowScript({ flow, request: 'R', budgets: BUDGETS }, [
    outs({ x: 'XA' }), outs({ y: 'YB, 上游=XA' }), outs({ z: 'ZC' }),
  ])
  assert.equal(result.ok, true)
  assert.deepEqual(result.steps.map((s) => s.status), ['done', 'done', 'done'])
  assert.equal(result.steps[2].outputs.z, 'ZC')
  // 上游产出注入: b 的指令带 [a 产出] 节
  assert.match(calls[1].prompt, /\[a 产出\]/)
  assert.match(calls[1].prompt, /XA/)
})

test('Given 产出块缺失, When 教学重问预算内补交, Then 重问轮附格式示例且不烧失败账', async () => {
  const flow = {
    id: 'reask', label: '重问', description: '教学重问',
    steps: [{ id: 'a', prompt: '做A', outputs: { x: 'A产出' } }],
  }
  const { result, calls } = await runFlowScript({ flow, request: 'R', budgets: BUDGETS }, [
    '只写叙述不写块',
    outs({ x: '补交' }),
  ])
  assert.equal(result.ok, true)
  assert.match(calls[1].prompt, /【产出格式重申】/)
  assert.match(calls[1].prompt, /<output name="x">/)
  assert.equal(result.steps[0].status, 'done')
})

test('Given 产出块持续缺失, When 重问预算耗尽, Then 流程 blocked 并带原因', async () => {
  const flow = {
    id: 'stuck', label: '卡死', description: '预算耗尽',
    steps: [{ id: 'a', prompt: '做A', outputs: { x: 'A产出' } }],
  }
  const budgets = { reviewRejectBeforeEscalate: 2, emptyOutputRetryLimit: 1 }
  const { result } = await runFlowScript({ flow, request: 'R', budgets }, ['没有块', '还是没有块', '依旧没有块'])
  assert.equal(result.ok, false)
  assert.ok(result.blocked)
  assert.equal(result.steps[0].status, 'failed')
})

test('Given 子代理连续调用失败, When 达失败重试上限, Then 流程 blocked', async () => {
  const flow = {
    id: 'failpath', label: '失败', description: '调用失败',
    steps: [{ id: 'a', prompt: '做A', outputs: { x: 'A产出' } }],
  }
  const { result, calls } = await runFlowScript({ flow, request: 'R', budgets: BUDGETS }, [
    { fail: 99, then: outs({ x: 'X' }) },
  ])
  assert.equal(result.ok, false)
  assert.ok(result.blocked)
  // 预算 reviewRejectBeforeEscalate=2: 初次+重试=3 次调用
  assert.equal(calls.length, 3)
})

test('Given for_each 串行循环, When 逐章产出梗概, Then 实例按序展开且上一实例产出可见', async () => {
  const flow = {
    id: 'novel', label: '小说', description: '循环携带',
    steps: [
      { id: 'outline', prompt: '定大纲', outputs: { chapters: '章节大纲' }, listOutputs: ['chapters'] },
      { id: 'write', prompt: '写第{item.index}章:{item} 前文:{write.summary}', outputs: { summary: '本章梗概' }, for_each: 'outline.chapters' },
    ],
  }
  const { result, calls } = await runFlowScript({ flow, request: '修仙小说', budgets: BUDGETS }, [
    outs({ chapters: '1. 拜师\n2. 下山\n3. 决战' }),
    outs({ summary: '章1梗概' }),
    outs({ summary: '章2梗概' }),
    outs({ summary: '章3梗概' }),
  ])
  assert.equal(result.ok, true)
  assert.equal(calls.length, 4)
  assert.match(calls[1].prompt, /第1章:拜师/)
  assert.equal(calls[1].prompt.match(/前文:(\S*)/)[1], '', '首实例自引用解析为空串')
  assert.match(calls[2].prompt, /第2章:下山/)
  assert.match(calls[2].prompt, /前文:章1梗概/, '循环携带上一实例产出')
  assert.match(calls[3].prompt, /第3章:决战/)
})

test('Given 无依赖两步, When 首步就绪, Then 并行发车(parallel 钩子并发)', async () => {
  const flow = {
    id: 'par', label: '并行', description: '并行汇合',
    steps: [
      { id: 'root', prompt: '起点', outputs: { base: '基线' } },
      { id: 'l', prompt: '左路 {root.base}', after: ['root'], outputs: { left: '左产出' } },
      { id: 'r', prompt: '右路 {root.base}', after: ['root'], outputs: { right: '右产出' } },
      { id: 'join', prompt: '汇合 {l.left} + {r.right}', after: ['l', 'r'], outputs: { all: '总产出' } },
    ],
  }
  let parallelBatches = 0
  const harnessParallel = async (thunks) => {
    if (thunks.length > 1) parallelBatches++
    return Promise.all(thunks.map((thunk) => thunk()))
  }
  const body = new Function('args', 'agent', 'parallel', 'phase', 'log', `"use strict";\nreturn (async () => {\n${FLOW_SRC}\n})()`)
  const calls = []
  const queue = [outs({ base: 'B' }), outs({ left: 'L' }), outs({ right: 'R' }), outs({ all: 'A' })]
  const result = await body({ flow, request: 'R', budgets: BUDGETS }, async (prompt) => {
    calls.push(prompt)
    return queue.shift()
  }, harnessParallel, () => {}, () => {})
  assert.equal(result.ok, true)
  assert.equal(parallelBatches, 1, 'l/r 应在同一就绪轮并行')
})

test('Given 分诊步骤动态路由, When route 指向子流程, Then 嵌套执行且产出扁平挂载', async () => {
  const sub = {
    id: 'news', label: '新闻', description: '子流程',
    steps: [{ id: 'write', prompt: '写稿, 简报:{input.brief}', outputs: { article: '稿件' } }],
  }
  const main = {
    id: 'tria', label: '分诊', description: '动态路由',
    steps: [
      { id: 'triage', prompt: '选流程', outputs: { route: '流程id', brief: '简报' } },
      { id: 'run', type: 'flow', flow: '{triage.route}', input: { brief: '{triage.brief}' } },
      { id: 'after', prompt: '收尾 {run.write.article}', outputs: { done: '收尾' } },
    ],
  }
  const { result, calls } = await runFlowScript({
    flow: main, flows: { news: sub }, request: 'R', budgets: BUDGETS,
  }, [
    outs({ route: 'news', brief: '科技简报' }),
    outs({ article: '稿件全文' }),
    outs({ done: 'OK' }),
  ])
  assert.equal(result.ok, true)
  assert.match(calls[1].prompt, /简报:科技简报/, 'input 显式传参进入子流程指令')
  assert.match(calls[2].prompt, /稿件全文/, '下游引用扁平产出')
  assert.equal(result.steps[1].outputs['write.article'], '稿件全文')
})

test('Given 路由解析为空, When 分诊未选中目标, Then 子流程步按完成处理(合法出口)', async () => {
  const main = {
    id: 'tria2', label: '分诊', description: '空路由',
    steps: [
      { id: 'triage', prompt: '选流程', outputs: { route: '流程id' } },
      { id: 'run', type: 'flow', flow: '{triage.route}' },
      { id: 'end', prompt: '结束', outputs: { done: '完' } },
    ],
  }
  const { result } = await runFlowScript({ flow: main, flows: {}, request: 'R', budgets: BUDGETS }, [
    outs({ route: '' }),
    outs({ done: '完' }),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.steps[1].status, 'done')
})

test('Given load 资源, When 步骤执行, Then 资源全文注入 [参考资料] 节', async () => {
  const flow = {
    id: 'res', label: '资源', description: '加载',
    steps: [{ id: 'a', prompt: '按资料做', load: ['doc:docs/spec.md'], outputs: { out: '产出' } }],
  }
  const { calls } = await runFlowScript({
    flow, request: 'R', budgets: BUDGETS, resources: { 'doc:docs/spec.md': '规范全文ABC' },
  }, [outs({ out: 'O' })])
  assert.match(calls[0].prompt, /\[参考资料: doc:docs\/spec\.md\]/)
  assert.match(calls[0].prompt, /规范全文ABC/)
})

test('Given 上游被跳过(依赖失败), When 后继步骤依赖它, Then 后继不再执行', async () => {
  const flow = {
    id: 'skip', label: '跳过', description: '失败传播',
    steps: [
      { id: 'a', prompt: '会失败', outputs: { x: 'X' } },
      { id: 'b', prompt: '后继 {a.x}', outputs: { y: 'Y' } },
    ],
  }
  const { result, calls } = await runFlowScript({ flow, request: 'R', budgets: { reviewRejectBeforeEscalate: 1, emptyOutputRetryLimit: 1 } }, [
    '没有块', '还是没有', '仍然没有',
  ])
  assert.equal(result.ok, false)
  assert.equal(result.steps[0].status, 'failed')
  assert.equal(result.steps[1].status, 'skipped')
  // 预算 maxFail=clamp(reviewReject=1)=1: 初次+重试=2 次调用,后继步骤不再发起调用
  assert.equal(calls.length, 2)
})

test('Given slots 候选数组, When 步骤失败重试, Then 换下一候选模型', async () => {
  const flow = {
    id: 'rot', label: '轮换', description: '候选轮换',
    steps: [{ id: 'a', prompt: '做A', outputs: { x: 'X' } }],
  }
  const { calls } = await runFlowScript({
    flow, request: 'R', budgets: BUDGETS,
    slots: { executor: { rotation: ['p1/m1', 'p2/m2'] } },
  }, [
    { fail: 1, then: outs({ x: 'X' }) },
  ])
  assert.equal(calls[0].opts.provider, 'p1')
  assert.equal(calls[0].opts.model, 'm1')
  assert.equal(calls[1].opts.provider, 'p2')
  assert.equal(calls[1].opts.model, 'm2')
})

test('Given 流程环与深度超限, When 递归执行, Then 自保拒绝', async () => {
  const a = { id: 'a', label: 'A', description: '', steps: [{ id: 'go', type: 'flow', flow: 'b' }] }
  const b = { id: 'b', label: 'B', description: '', steps: [{ id: 'go', type: 'flow', flow: 'a' }] }
  const { result } = await runFlowScript({ flow: a, flows: { a, b }, request: 'R', budgets: BUDGETS }, [])
  assert.equal(result.ok, false)
  assert.match(result.blocked.reason, /流程环调用/)

  // 纯 flow 链: d1(深度1) → d2(2) → d3(3) → d4(4 超限被拒,原因逐层上传)
  const d1 = { id: 'd1', label: 'D1', description: '', steps: [{ id: 'go', type: 'flow', flow: 'd2' }] }
  const d2 = { id: 'd2', label: 'D2', description: '', steps: [{ id: 'go', type: 'flow', flow: 'd3' }] }
  const d3 = { id: 'd3', label: 'D3', description: '', steps: [{ id: 'go', type: 'flow', flow: 'd4' }] }
  const d4 = { id: 'd4', label: 'D4', description: '', steps: [{ id: 'leaf', prompt: '到底', outputs: { x: 'X' } }] }
  const { result: deepResult } = await runFlowScript({
    flow: d1, flows: { d2, d3, d4 }, request: 'R', budgets: BUDGETS,
  }, [])
  assert.equal(deepResult.ok, false)
  assert.match(deepResult.blocked.reason || '', /嵌套深度超过上限/)
})

test('Given for_each 数据源列表为空, When 展开, Then 步骤 blocked', async () => {
  const flow = {
    id: 'empty', label: '空源', description: '',
    steps: [
      { id: 'src', prompt: '列清单', outputs: { items: '清单' }, listOutputs: ['items'] },
      { id: 'each', prompt: '逐项 {item}', for_each: 'src.items', outputs: { done: '完成' } },
    ],
  }
  const { result } = await runFlowScript({ flow, request: 'R', budgets: BUDGETS }, [
    outs({ items: '(无)' }),
  ])
  assert.equal(result.ok, false)
  assert.equal(result.steps[1].status, 'blocked')
})
