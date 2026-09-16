// store BDD(v5;契约源 docs/rsww-v5/data-design.md 存储布局与 run 记录)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, defaultDataDir } from '../lib/store.mjs'

const fresh = () => mkdtempSync(join(tmpdir(), 'rsww-store-'))
const readRun = (dir, runId) => JSON.parse(readFileSync(join(dir, 'runs', `${runId}.json`), 'utf8'))
const LONG = 'x'.repeat(5000)

test('Given 三步链式 run 全程落账 When 读 runs/<runId>.json Then 全文零截断', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-full', sessionId: 's1', workspace: 'w1', request: '需求原文', templateId: 'default', inputs: {} })
  store.step({ runId: 'r-full', stepId: 'triage', event: 'dispatch', body: { prompt: LONG, callLabel: '需求评估' } })
  store.step({ runId: 'r-full', stepId: 'triage', event: 'submit', body: { outputs: { brief: LONG } } })
  store.finish({ runId: 'r-full', status: 'completed', summary: LONG })
  const file = readRun(dir, 'r-full')
  assert.equal(file.stepsTrace.triage['-'][0].prompt, LONG)
  assert.equal(file.stepsTrace.triage['-'][1].outputs.brief, LONG)
  assert.equal(file.summary, LONG)
  assert.equal(store.get('r-full').status, 'completed')
})

test('Given control 事件含裁决来源 When step 落账 Then 进 controls 数组(by/reason 入账)不进 stepsTrace', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-ctl' })
  store.step({ runId: 'r-ctl', event: 'control', body: { kind: 'message', text: '你好', inject: false } })
  store.step({ runId: 'r-ctl', event: 'control', body: { kind: 'approve', by: 'main-agent', reason: '口径达标' } })
  const file = readRun(dir, 'r-ctl')
  assert.equal(file.controls.length, 2)
  assert.equal(file.controls[1].kind, 'approve')
  assert.equal(file.controls[1].by, 'main-agent')
  assert.equal(file.controls[1].reason, '口径达标')
  assert.deepEqual(file.stepsTrace, {})
})

test('Given 超容量完结 run When 再完结溢出个 Then 最旧完结被删且 running 恒在', () => {
  const dir = fresh()
  const store = createStore({ dir, keepRuns: 5 })
  store.start({ runId: 'r-live' })
  for (let i = 0; i < 6; i++) {
    const id = `r-old-${i}`
    store.start({ runId: id })
    store.finish({ runId: id, status: 'completed', summary: '' })
  }
  assert.equal(existsSync(join(dir, 'runs', 'r-old-0.json')), false)
  assert.equal(existsSync(join(dir, 'runs', 'r-old-5.json')), true)
  assert.equal(existsSync(join(dir, 'runs', 'r-live.json')), true)
  const rows = store.list()
  assert.equal(rows.filter((r) => r.status === 'completed').length, 5)
  assert.equal(rows.find((r) => r.runId === 'r-live').status, 'running')
})

test('Given list 按 workspace 过滤 When 多工作区 Then 仅返回该工作区且不含事件流', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-a', workspace: 'wa' })
  store.start({ runId: 'r-b', workspace: 'wb' })
  store.step({ runId: 'r-a', stepId: 's', event: 'submit', body: { outputs: { o: '全文' } } })
  const rows = store.list({ workspace: 'wa' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].runId, 'r-a')
  assert.equal('steps' in rows[0], false)
  assert.equal('controls' in rows[0], false)
})

test('Given 进程重启遗留 running/paused When store 首次加载 Then 孤儿收敛为 cancelled 带标记', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-orphan', status: undefined })
  store.update({ runId: 'r-orphan', status: 'paused' })
  const store2 = createStore({ dir })
  const rec = store2.get('r-orphan')
  assert.equal(rec.status, 'cancelled')
  assert.ok(rec.summary.includes('进程重启'))
  assert.ok(rec.controls.some((c) => c.text.includes('进程重启')))
  const row = store2.list().find((e) => e.runId === 'r-orphan')
  assert.equal(row.status, 'cancelled')
})

test('Given index.json 损坏 When 再次 list Then 自动扫描 runs/ 重建且结果一致', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-x1', workspace: 'w' })
  store.start({ runId: 'r-x2', workspace: 'w' })
  writeFileSync(join(dir, 'index.json'), '{broken', 'utf8')
  const store2 = createStore({ dir })
  const rows = store2.list()
  assert.deepEqual(rows.map((r) => r.runId).sort(), ['r-x1', 'r-x2'])
})

test('Given runId 含非法字符 When start/step/get Then 抛错且无文件触碰', () => {
  const dir = fresh()
  const store = createStore({ dir })
  assert.throws(() => store.start({ runId: '../evil' }), /runId 非法/)
  assert.throws(() => store.start({ runId: 'UPPER' }), /runId 非法/)
  assert.throws(() => store.get('../evil'), /runId 非法/)
  assert.equal(readdirSync(join(dir, 'runs')).length, 0)
})

test('Given 不存在 runId When step/get Then 抛「运行记录不存在」', () => {
  const dir = fresh()
  const store = createStore({ dir })
  assert.throws(() => store.get('r-none'), /运行记录不存在/)
  assert.throws(() => store.step({ runId: 'r-none', stepId: 's', event: 'submit', body: {} }), /运行记录不存在/)
})

test('Given runId 缺省 When start Then 生成 r-<epoch36>-<seq> 且匹配合法集', () => {
  const dir = fresh()
  const store = createStore({ dir })
  const rec = store.start({})
  assert.match(rec.runId, /^r-[a-z0-9]+-[1-9][0-9]*$/)
})

test('Given remove When 调用 Then 文件与索引行消失', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-del' })
  store.remove('r-del')
  assert.equal(existsSync(join(dir, 'runs', 'r-del.json')), false)
  assert.equal(store.list().length, 0)
})

test('Given update When 传 state Then 快照持久化且 seed 直读可用', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-state' })
  store.update({ runId: 'r-state', state: { status: 'running', steps: { a: { status: 'done' } }, batchSeq: 2 } })
  const store2 = createStore({ dir })
  assert.equal(store2.get('r-state').state.batchSeq, 2)
})

test('Given start 携带 plan/warnings When 落盘重读 Then 记录含 plan 与 warnings 字段', () => {
  const dir = fresh()
  const store = createStore({ dir })
  const plan = { source: 'model', brief: '口径', steps: [{ ref: 'a', note: 'n', done: 'd' }], deps: { a: [] } }
  const warnings = [{ target: 'steps', message: '耗尽兜底降级为 blocked' }]
  store.start({ runId: 'r-plan', plan, warnings })
  const file = readRun(dir, 'r-plan')
  assert.deepEqual(file.plan, plan)
  assert.deepEqual(file.warnings, warnings)
  const store2 = createStore({ dir })
  assert.equal(store2.get('r-plan').plan.source, 'model')
})

test('Given start 缺省 plan/warnings When 落盘 Then plan=null 与 warnings=[] 缺省', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-plain' })
  const file = readRun(dir, 'r-plain')
  assert.equal(file.plan, null)
  assert.deepEqual(file.warnings, [])
})

test('Given waiting_approval 遗留 When store 首次加载 Then 视为活跃孤儿收敛 cancelled', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-wait' })
  store.update({ runId: 'r-wait', status: 'waiting_approval' })
  const store2 = createStore({ dir })
  assert.equal(store2.get('r-wait').status, 'cancelled')
})

test('Given DSH_RS_WORKFLOW_DATA_DIR 覆写 When defaultDataDir Then 落 v5 子目录', () => {
  const prev = process.env.DSH_RS_WORKFLOW_DATA_DIR
  process.env.DSH_RS_WORKFLOW_DATA_DIR = fresh()
  try {
    const dir = defaultDataDir()
    assert.equal(dir, join(process.env.DSH_RS_WORKFLOW_DATA_DIR, 'v5'))
    const store = createStore()
    store.start({ runId: 'r-ns' })
    assert.equal(existsSync(join(dir, 'runs', 'r-ns.json')), true)
  } finally {
    if (prev === undefined) delete process.env.DSH_RS_WORKFLOW_DATA_DIR
    else process.env.DSH_RS_WORKFLOW_DATA_DIR = prev
  }
})
