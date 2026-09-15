import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import assertLoose from 'node:assert'

// 引擎单文件行数守卫上限
const LINE_LIMIT = 200

const source = await readFile(new URL('../engine/flow-exec.js', import.meta.url), 'utf8')
const wrapped = new vm.Script(`(async () => {\n${source}\n})()`, { filename: 'flow-exec.vm.js' })

// 构造裸 vm context,注入桩 globals;parallel 桩即 Promise.all,并发为真实并行
const makeStub = (handler, calls) => {
  const observed = { agentCalls: [], parallelBatches: [] }
  const context = vm.createContext({
    args: { calls },
    phase: () => {},
    log: () => {},
    parallel: (dispatches) => {
      observed.parallelBatches.push(dispatches)
      return Promise.all(dispatches)
    },
    agent: (prompt, options) => {
      observed.agentCalls.push({ prompt, options })
      return Promise.resolve(handler(prompt, options, observed.agentCalls.length - 1))
    },
  })
  const run = async () => ({ observed, result: await wrapped.runInContext(context) })
  return { observed, run }
}

test('Given 两 call 桩 agent 均返回 outputs When 执行 Then results 两项 ok:true 且与 calls 同序且 outputs 原样', async () => {
  const calls = [
    { callId: 'call-1', prompt: 'p1', label: 'l1' },
    { callId: 'call-2', prompt: 'p2', label: 'l2' },
  ]
  const outputsList = [{ title: 'a' }, { items: ['x', 'y'] }]
  const { observed, run } = makeStub((prompt, options, index) => outputsList[index], calls)
  const { result } = await run()
  // 脚本产出来自 vm realm,deepStrictEqual 的原型比对必失败,跨 realm 结构比对用宽松 deepEqual
  assertLoose.deepEqual(result, {
    results: [
      { callId: 'call-1', ok: true, outputs: { title: 'a' } },
      { callId: 'call-2', ok: true, outputs: { items: ['x', 'y'] } },
    ],
  })
  assert.equal(observed.agentCalls.length, calls.length)
})

test('Given agent 返回 null When 执行 Then 该项 ok:false 且 error 含未提交结构化产出且其余项不受影响', async () => {
  const calls = [
    { callId: 'call-1', prompt: 'p1', label: 'l1' },
    { callId: 'call-2', prompt: 'p2', label: 'l2' },
    { callId: 'call-3', prompt: 'p3', label: 'l3' },
  ]
  const { run } = makeStub(
    (prompt, options, index) => (index === 1 ? null : { v: index }),
    calls,
  )
  const { result } = await run()
  assertLoose.deepEqual(result.results, [
    { callId: 'call-1', ok: true, outputs: { v: 0 } },
    { callId: 'call-2', ok: false, error: '子代理未提交结构化产出' },
    { callId: 'call-3', ok: true, outputs: { v: 2 } },
  ])
})

test('Given agent 抛错 When 执行 Then 该项 ok:false 且 error 为错误消息原文且其余项不受影响', async () => {
  const calls = [
    { callId: 'call-1', prompt: 'p1', label: 'l1' },
    { callId: 'call-2', prompt: 'p2', label: 'l2' },
    { callId: 'call-3', prompt: 'p3', label: 'l3' },
  ]
  const { run } = makeStub(
    (prompt, options, index) => (index === 2 ? Promise.reject(new Error('模型调用超时')) : { v: index }),
    calls,
  )
  const { result } = await run()
  assertLoose.deepEqual(result.results, [
    { callId: 'call-1', ok: true, outputs: { v: 0 } },
    { callId: 'call-2', ok: true, outputs: { v: 1 } },
    { callId: 'call-3', ok: false, error: '模型调用超时' },
  ])
})

test('Given call 带 schema/provider/model When 执行 Then 桩 agent 收到的 options 原样透传', async () => {
  const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }
  const calls = [{
    callId: 'call-1',
    prompt: '拟定标题',
    label: '撰写位',
    schema,
    provider: 'deepseek-official',
    model: 'deepseek-chat',
  }]
  const { observed, run } = makeStub(() => ({ title: 't' }), calls)
  await run()
  assertLoose.deepEqual(observed.agentCalls, [{
    prompt: '拟定标题',
    options: {
      label: '撰写位',
      phase: '若水批次',
      schema,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    },
  }])
})

test('Given 4 calls When 执行 Then parallel 收到的数组长度与 calls 一致且结果同序不截断', async () => {
  const CALLS_IN_BATCH = 4
  const calls = Array.from({ length: CALLS_IN_BATCH }, (unused, index) => ({
    callId: `call-${index + 1}`,
    prompt: `p${index}`,
    label: `l${index}`,
  }))
  const { observed, run } = makeStub((prompt, options, index) => ({ v: index }), calls)
  const { result } = await run()
  assert.equal(observed.parallelBatches.length, 1)
  assert.equal(observed.parallelBatches[0].length, CALLS_IN_BATCH)
  assert.deepEqual(result.results.map((item) => item.callId), calls.map((call) => call.callId))
  assert.ok(result.results.every((item) => item.ok))
})

test('Given 文件文本 When 静态断言 Then 无模块语法字样且行数不超上限', () => {
  for (const banned of ['import', 'require', 'export']) {
    assert.ok(!source.includes(banned), `脚本体不得出现 ${banned}`)
  }
  assert.ok(source.split('\n').length <= LINE_LIMIT)
})
