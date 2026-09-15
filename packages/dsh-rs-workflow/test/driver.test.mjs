// driver 纯函数单测:scheduler/approve/prompts BDD
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextBatch, escalateOnlyIds, effectiveDeps } from '../lib/driver/scheduler.mjs'
import { applyApproveResult } from '../lib/driver/approve.mjs'
import { buildPrompt, schemaOf, resolvePlaceholders } from '../lib/driver/prompts.mjs'

const init = (template, { request = '需求', inputs = {} } = {}) => {
  const state = { status: 'running', request, inputs, steps: {}, approvals: {}, escalations: 0, queued: [], batchSeq: 0, slotCursor: {} }
  for (const step of template.steps) state.steps[step.id] = { status: 'pending', outputs: null, failCount: 0, instances: [] }
  return state
}

const CHAIN = {
  id: 't', label: 't',
  steps: [
    { id: 'a', prompt: 'P {request}', outputs: { o: '产出' } },
    { id: 'b', after: ['a'], prompt: 'Q {a.o}', outputs: { o: '产出' } },
    { id: 'c', prompt: 'R', outputs: { o: '产出' } },
  ],
}

test('Given 三步链式 When 首批 Then 仅 a 就绪;When a done Then b 就绪;Then 缺省链 c 在 b 后', () => {
  const state = init(CHAIN)
  const b1 = nextBatch(state, CHAIN)
  assert.deepEqual(b1.calls.map((c) => c.stepId), ['a'])
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A' }
  const b2 = nextBatch(state, CHAIN)
  assert.deepEqual(b2.calls.map((c) => c.stepId), ['b'])
  state.steps.b.status = 'done'
  state.steps.b.outputs = { o: 'B' }
  const b3 = nextBatch(state, CHAIN)
  assert.deepEqual(b3.calls.map((c) => c.stepId), ['c'])
  state.steps.c.status = 'done'
  state.steps.c.outputs = { o: 'C' }
  const b4 = nextBatch(state, CHAIN)
  assert.equal(b4.kind, 'terminal')
})

test('Given 显式无依赖六步 When 首批 Then 同批并行且并发上限 4', () => {
  const tpl = {
    id: 't', label: 't',
    steps: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, prompt: 'P', outputs: { o: 'o' }, after: [] })),
  }
  const state = init(tpl)
  const batch = nextBatch(state, tpl)
  assert.equal(batch.calls.length, 4)
})

test('Given for_each sequential When 数据源 3 项 Then 首批仅实例1,完成后实例2 携带 carry', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'src', prompt: 'P', outputs: { items: '列表' }, listOutputs: ['items'] },
      { id: 'work', for_each: 'src.items', mode: 'sequential', prompt: '{item} 上一个:{work.r}', outputs: { r: '结果' } },
    ],
  }
  const state = init(tpl)
  state.steps.src.status = 'done'
  state.steps.src.outputs = { items: ['甲', '乙', '丙'] }
  const b1 = nextBatch(state, tpl)
  assert.deepEqual(b1.calls.map((c) => c.instance.key), ['#1'])
  const inst1 = state.steps.work.instances[0]
  inst1.status = 'done'
  inst1.outputs = { r: 'R1' }
  const b2 = nextBatch(state, tpl)
  assert.deepEqual(b2.calls.map((c) => c.instance.key), ['#2'])
  assert.deepEqual(b2.calls[0].instance.carry, { r: 'R1' })
})

test('Given for_each 数据源空 When 展开 Then 该步 skipped', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'src', prompt: 'P', outputs: { items: '列表' }, listOutputs: ['items'] },
      { id: 'work', for_each: 'src.items', mode: 'parallel', prompt: '{item}', outputs: { r: '结果' } },
    ],
  }
  const state = init(tpl)
  state.steps.src.status = 'done'
  state.steps.src.outputs = { items: [] }
  nextBatch(state, tpl)
  assert.equal(state.steps.work.status, 'skipped')
})

test('Given 依赖失败 When 下一步判定 Then skipped 沿缺省链传播', () => {
  const state = init(CHAIN)
  state.steps.a.status = 'failed'
  nextBatch(state, CHAIN)
  assert.equal(state.steps.b.status, 'skipped')
  assert.equal(state.steps.c.status, 'skipped')
})

test('Given 全部失败 When 判定 Then terminal(failed 由终态判定处理)', () => {
  const state = init(CHAIN)
  state.steps.a.status = 'failed'
  state.steps.b.status = 'skipped'
  state.steps.c.status = 'skipped'
  assert.equal(nextBatch(state, CHAIN).kind, 'terminal')
})

test('Given 死锁(pending 依赖已 skipped 链中断) When 判定 Then blocked', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'a', prompt: 'P', outputs: { o: 'o' }, after: ['ghost'] },
    ],
  }
  const state = init(tpl)
  const batch = nextBatch(state, tpl)
  assert.equal(batch.kind, 'blocked')
})

test('Given escalate-only 模板 When 常规判定 Then 升级步永不就绪(未触发)', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'a', prompt: 'P', outputs: { o: 'o' } },
      { id: 'esc', prompt: 'E', outputs: { o: 'o' } },
      { id: 'rev', type: 'approve', target: 'a', onExhausted: 'esc', prompt: 'R' },
    ],
  }
  const state = init(tpl)
  assert.deepEqual([...escalateOnlyIds(tpl)], ['esc'])
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A' }
  const batch = nextBatch(state, tpl)
  assert.equal(batch.kind, 'approve')
})

test('Given 有效依赖 When escalate-only 步 Then 无缺省文档序依赖', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'a', prompt: 'P', outputs: { o: 'o' } },
      { id: 'esc', prompt: 'E', outputs: { o: 'o' } },
      { id: 'rev', type: 'approve', target: 'a', onExhausted: 'esc', prompt: 'R' },
    ],
  }
  const deps = effectiveDeps(tpl, escalateOnlyIds(tpl))
  assert.deepEqual(deps.get('esc'), [])
  assert.deepEqual(deps.get('rev'), ['a'])
})

const APPROVE_TPL = {
  id: 't', label: 't',
  steps: [
    { id: 'a', prompt: 'P', outputs: { o: 'o' } },
    { id: 'down', after: ['a'], prompt: 'D', outputs: { o: 'o' } },
    { id: 'rev', type: 'approve', target: 'a', rounds: 2, onExhausted: 'esc', prompt: 'R' },
    { id: 'esc', prompt: 'E', outputs: { o: 'o' } },
  ],
}

test('Given approve REJECTED 未耗尽 When 路由 Then target 回 pending,approve 回 pending,rounds=1', () => {
  const state = init(APPROVE_TPL)
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A1' }
  state.steps.rev.status = 'done'
  const route = applyApproveResult(state, APPROVE_TPL, APPROVE_TPL.steps[2], { outputs: { verdict: 'REJECTED', comments: '改' } }, { approveRounds: 2, escalateLimit: 2 })
  assert.equal(route.verdict, 'REJECTED')
  assert.equal(route.exhausted, false)
  assert.equal(state.approvals.rev.rounds, 1)
  assert.equal(state.steps.rev.status, 'pending')
  assert.equal(state.steps.a.status, 'pending')
  assert.equal(state.steps.a.outputs, null)
  assert.equal(state.steps.a.failCount, 0)
  assert.equal(route.prevOutputs.includes('A1'), true)
})

test('Given approve 连拒耗尽 When 路由 Then approve done,target 与未完成下游 skipped,done 下游保留,升级步 escalateReady', () => {
  const state = init(APPROVE_TPL)
  state.approvals.rev = { rounds: 1 }
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A2' }
  state.steps.down.status = 'done'
  state.steps.down.outputs = { o: 'D' }
  state.steps.rev.status = 'done'
  const route = applyApproveResult(state, APPROVE_TPL, APPROVE_TPL.steps[2], { outputs: { verdict: 'REJECTED', comments: '仍不过' } }, { approveRounds: 2, escalateLimit: 2 })
  assert.equal(route.exhausted, true)
  assert.equal(route.routedTo, 'esc')
  assert.equal(state.steps.rev.status, 'done')
  assert.equal(state.steps.a.status, 'skipped')
  assert.equal(state.steps.a.skipReason.includes('升级'), true)
  assert.equal(state.steps.down.status, 'done')
  assert.equal(state.steps.down.outputs.o, 'D')
  assert.equal(state.steps.esc.escalateReady, true)
})

test('Given approve REJECTED 未耗尽 When 路由 Then done 下游亦重置(target 产出改变)', () => {
  const state = init(APPROVE_TPL)
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A1' }
  state.steps.down.status = 'done'
  state.steps.down.outputs = { o: 'D' }
  state.steps.rev.status = 'done'
  applyApproveResult(state, APPROVE_TPL, APPROVE_TPL.steps[2], { outputs: { verdict: 'REJECTED', comments: '改' } }, { approveRounds: 2, escalateLimit: 2 })
  assert.equal(state.steps.down.status, 'pending')
  assert.equal(state.steps.down.outputs, null)
  assert.equal(state.steps.down.instances.length, 0)
})

test('Given 升级后升级步完成 When 全落定 Then allSettled 走 terminal', () => {
  const state = init(APPROVE_TPL)
  state.steps.a.status = 'skipped'
  state.steps.down.status = 'skipped'
  state.steps.rev.status = 'done'
  state.steps.esc.status = 'done'
  state.steps.esc.outputs = { o: 'F' }
  assert.equal(nextBatch(state, APPROVE_TPL).kind, 'terminal')
})

test('Given onExhausted=blocked When 耗尽 Then terminalBlocked 置位', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'a', prompt: 'P', outputs: { o: 'o' } },
      { id: 'rev', type: 'approve', target: 'a', onExhausted: 'blocked', prompt: 'R' },
    ],
  }
  const state = init(tpl)
  state.approvals.rev = { rounds: 3 }
  state.steps.rev.status = 'done'
  const route = applyApproveResult(state, tpl, tpl.steps[1], { outputs: { verdict: 'REJECTED', comments: '' } }, { approveRounds: 2, escalateLimit: 2 })
  assert.equal(route.routedTo, 'blocked')
  assert.equal(state.terminalBlocked.includes('耗尽'), true)
})

test('Given upgrades 达 escalateLimit When 耗尽升级 Then escalateLimitReached', () => {
  const state = init(APPROVE_TPL)
  state.escalations = 1
  state.approvals.rev = { rounds: 9 }
  state.steps.rev.status = 'done'
  const route = applyApproveResult(state, APPROVE_TPL, APPROVE_TPL.steps[2], { outputs: { verdict: 'REJECTED', comments: '' } }, { approveRounds: 1, escalateLimit: 2 })
  assert.equal(state.escalations, 2)
  assert.equal(route.escalateLimitReached, true)
})

test('Given 占位符 When 解析 Then request/input/step 输出/item/自引用空串', () => {
  const state = { steps: { a: { status: 'done', outputs: { o: 'OUT', list: ['x', 'y'] } } } }
  const ctx = { state, request: 'REQ', inputs: { topic: 'T' } }
  assert.equal(resolvePlaceholders('需求:{request} 主题:{input.topic} 产出:{a.o} 列表:{a.list}', ctx), '需求:REQ 主题:T 产出:OUT 列表:x\ny')
  assert.equal(resolvePlaceholders('自引:{b.o}', { ...ctx, selfId: 'b', carry: null }), '自引:')
  assert.equal(resolvePlaceholders('项:{item} 序:{item.index}', { ...ctx, item: '甲', index: 2 }), '项:甲 序:2')
})

test('Given 指令组装 When 各节存在 Then 节顺序固定', () => {
  const step = { id: 'a', prompt: '做:{request}', outputs: { o: '产出说明' }, load: ['skill:web-search'] }
  const prompt = buildPrompt({
    state: { steps: {} }, request: 'R', inputs: {}, step,
    queuedMessages: ['排队消息'], injectMessages: ['注入消息'], redo: { comments: '改好点', prevOutputs: '旧产出' },
  })
  const order = ['[任务]', '[产出要求]', '[参考资料]', '[用户补充]', '[运行中用户消息]', '[重做说明]']
  const idx = order.map((s) => prompt.indexOf(s))
  assert.ok(idx.every((v) => v >= 0))
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b))
  assert.ok(prompt.includes('structured_output'))
  assert.ok(prompt.includes('web-search'))
  assert.ok(prompt.includes('改好点'))
})

test('Given approve 步 When schemaOf Then 固定裁决契约', () => {
  const schema = schemaOf({ type: 'approve' })
  assert.deepEqual(schema.required, ['verdict', 'comments'])
})
