// report-store 单元测试:CRUD / 归一 / 容量收敛 / 原子落盘 / 异常路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, resolveDataDir } from '../lib/report-store.mjs'

async function makeStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rsww-store-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { dir, store: createStore({ dir }) }
}

test('数据目录:env 覆盖优先,缺省落在 ~/.dsh/dsh-rs-workflow', () => {
  const original = process.env.DSH_RS_WORKFLOW_DATA_DIR
  try {
    process.env.DSH_RS_WORKFLOW_DATA_DIR = '  C:/tmp/rsww  '
    assert.equal(resolveDataDir(), 'C:/tmp/rsww')
    delete process.env.DSH_RS_WORKFLOW_DATA_DIR
    assert.ok(resolveDataDir().includes(join('.dsh', 'dsh-rs-workflow')))
  } finally {
    if (original === undefined) delete process.env.DSH_RS_WORKFLOW_DATA_DIR
    else process.env.DSH_RS_WORKFLOW_DATA_DIR = original
  }
})

test('start 生成 runId 并落盘;list 新到旧;get 按 id 取', async (t) => {
  const { dir, store } = await makeStore(t)
  const first = await store.start({ request: '需求一', workspace: 'C:/ws/a' })
  assert.ok(first.runId.startsWith('r-'), 'runId 自动生成')
  assert.equal(first.status, 'running')
  const second = await store.start({ request: '需求二', workspace: 'C:/ws/a' })
  const list = await store.list()
  assert.deepEqual(list.map((r) => r.runId), [second.runId, first.runId], '新到旧')
  // 列表不携带重量级 body
  assert.equal(list[0].result, undefined)
  assert.equal(list[0].updates, undefined)
  const full = await store.get(first.runId)
  assert.equal(full.request, '需求一')
  // 落盘验证:重开实例读到同数据
  const reopened = createStore({ dir })
  assert.equal((await reopened.get(second.runId)).request, '需求二')
})

test('appendNode 追加节点上报并截断超限历史', async (t) => {
  const { store } = await makeStore(t)
  const run = await store.start({ request: '需求' })
  for (let i = 0; i < 45; i++) {
    await store.appendNode({ runId: run.runId, nodeId: 't' + i, status: 'done', summary: '第' + i + '步' })
  }
  const full = await store.get(run.runId)
  assert.ok(full.updates.length <= 40, '上报历史上限收敛')
  assert.equal(full.updates[full.updates.length - 1].nodeId, 't44', '保留最新')
})

test('finish 落定状态与统计;result 超限折为截断标记', async (t) => {
  const { store } = await makeStore(t)
  const run = await store.start({ request: '需求' })
  const result = { templateId: 'step-review', ok: true, tasks: [{ id: 't1' }], reviews: [{ id: 'r1' }], changedFiles: ['a.js'], escalations: 1 }
  const done = await store.finish({ runId: run.runId, ok: true, result, summary: '全部通过' })
  assert.equal(done.status, 'done')
  assert.equal(done.templateId, 'step-review')
  assert.deepEqual(done.stats, { tasks: 1, reviews: 1, changedFiles: 1, escalations: 1 })
  assert.equal(done.finishedAt > 0, true)
  const big = await store.start({ request: '大结果' })
  const huge = { templateId: 'lite', blob: 'x'.repeat(80 * 1024) }
  const blocked = await store.finish({ runId: big.runId, ok: false, result: huge, blocked: { nodeId: 't1', reason: '上限', detail: '' } })
  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(blocked.result, { truncated: true, templateId: 'lite' }, '超限 result 只留截断标记')
  assert.deepEqual(blocked.blocked, { nodeId: 't1', reason: '上限', detail: '' })
})

test('异常路径:node/finish 未知 runId 抛业务错误;remove 删单条与清空', async (t) => {
  const { store } = await makeStore(t)
  await assert.rejects(() => store.appendNode({ runId: 'missing', status: 'done' }), /运行记录不存在/)
  await assert.rejects(() => store.finish({ runId: 'missing', ok: true }), /运行记录不存在/)
  const a = await store.start({ request: 'A' })
  await store.start({ request: 'B' })
  assert.equal(await store.remove(a.runId), true)
  assert.equal(await store.get(a.runId), null)
  assert.equal(await store.remove(), true, '无参清空')
  assert.deepEqual(await store.list(), [])
})

test('损坏文件从空表起步,不阻塞写入', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rsww-broken-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, 'runs.json'), '{not json', 'utf8')
  const store = createStore({ dir })
  const run = await store.start({ request: '损坏后重启' })
  assert.equal(run.request, '损坏后重启')
  const raw = JSON.parse(await readFile(join(dir, 'runs.json'), 'utf8'))
  assert.equal(raw.runs.length, 1)
})
