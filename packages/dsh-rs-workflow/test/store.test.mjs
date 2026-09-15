// store BDD(契约源 docs/rsww-v4/feat/store.md 验收点)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.mjs'

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
  assert.equal(file.steps.triage['-'][0].prompt, LONG)
  assert.equal(file.steps.triage['-'][1].outputs.brief, LONG)
  assert.equal(file.summary, LONG)
  assert.equal(store.get('r-full').status, 'completed')
})

test('Given control 事件 When step 落账 Then 进 controls 数组不进 steps', () => {
  const dir = fresh()
  const store = createStore({ dir })
  store.start({ runId: 'r-ctl' })
  store.step({ runId: 'r-ctl', event: 'control', body: { kind: 'message', text: '你好', inject: false } })
  const file = readRun(dir, 'r-ctl')
  assert.equal(file.controls.length, 1)
  assert.equal(file.controls[0].kind, 'message')
  assert.deepEqual(file.steps, {})
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

test('Given v3 遗留 runs.json When store 首次加载 Then 改名归档且 v4 空表起步', () => {
  const dir = fresh()
  mkdirSync(join(dir, 'runs'), { recursive: true })
  writeFileSync(join(dir, 'runs.json'), '[{"legacy":true}]', 'utf8')
  const store = createStore({ dir })
  assert.equal(store.list().length, 0)
  assert.equal(existsSync(join(dir, 'runs.json')), false)
  const archiveName = readdirSync(dir).find((n) => n.startsWith('runs.json.archived-'))
  assert.ok(archiveName)
  assert.equal(readFileSync(join(dir, archiveName), 'utf8'), '[{"legacy":true}]')
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
