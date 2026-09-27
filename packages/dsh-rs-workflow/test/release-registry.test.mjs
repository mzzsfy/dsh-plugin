// release-registry BDD(node --test):注册形态(rc.1+ agentPresets.register)纯桩测试,不触真实宿主
// 设计依据:.compat/计划-rs-workflow-preset-rc1.md;目录形态行为归 release.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  disposeAllRegistered,
  markReleased,
  registryFormAvailable,
  releaseTemplateVia,
  replayReleased,
  unreleaseTemplateVia,
} from '../lib/release-registry.mjs'
import { loadJson, saveJson } from '../lib/storage.mjs'

const ENTRY = {
  id: 'novel',
  label: '小说',
  description: '小说创作流程\n从大纲到成稿的编排',
  json: JSON.stringify({ id: 'novel', label: '小说', description: '小说创作流程', steps: [{ id: 'a', prompt: '{request}', outputs: { o: 'o' } }] }),
}

const rowsOf = (flowId) => [
  { id: 'persona', name: '@deepseek-ai/dsh-persona' },
  { id: 'rs-workflow-orchestrator', name: '@mzzsfy/dsh-rs-workflow', config: { role: 'orchestrator', templateId: flowId } },
]

function stubRegistry() {
  const records = []
  const service = {
    register: async (definition) => {
      if (records.some((r) => r.definition.id === definition.id && r.disposed !== true)) {
        throw new Error(`Duplicate agent preset: ${definition.id}`)
      }
      const record = { definition, disposed: false }
      records.push(record)
      return async () => { record.disposed = true }
    },
    list: async () => records.filter((r) => r.disposed !== true).map((r) => ({ id: r.definition.id })),
  }
  return { service, records }
}

const liveOf = (records) => records.filter((r) => r.disposed !== true)

const tempHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rsww-release-registry-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

test('Given 注册形态在场判据 When 探测 Then register 为函数判真,目录读取服务与缺席判假', () => {
  assert.equal(registryFormAvailable(stubRegistry().service), true)
  assert.equal(registryFormAvailable({ list: async () => [] }), false)
  assert.equal(registryFormAvailable(undefined), false)
})

test('Given 合法模板 When releaseTemplateVia Then created 且定义含 id/order/name/plugins 改写', async () => {
  const { service, records } = stubRegistry()
  const result = await releaseTemplateVia(service, ENTRY, rowsOf)
  assert.deepEqual(result, { form: 'registry', outcome: 'created', presetId: 'rs-novel' })
  assert.equal(records.length, 1)
  const definition = records[0].definition
  assert.equal(definition.id, 'rs-novel')
  assert.equal(definition.order, 100)
  assert.equal(definition.name, '若水·小说')
  assert.equal(definition.description, '小说创作流程 从大纲到成稿的编排')
  const orchestrator = definition.plugins.find((row) => row.id === 'rs-workflow-orchestrator')
  assert.equal(orchestrator.config.templateId, 'novel')
})

test('Given 已注册 When 同模板再 release Then 旧定义先注销再注册且结果 updated', async () => {
  const { service, records } = stubRegistry()
  await releaseTemplateVia(service, ENTRY, rowsOf)
  const changed = { ...ENTRY, label: '小说家' }
  const result = await releaseTemplateVia(service, changed, rowsOf)
  assert.equal(result.outcome, 'updated')
  assert.deepEqual(liveOf(records).map((r) => r.definition.name), ['若水·小说家'])
  assert.equal(records.length, 2)
  assert.equal(records[0].disposed, true)
})

test('Given 已注册 When unrelease Then removed 且注销;再 unrelease Then missing;非法 id 拒绝', async (t) => {
  const { service, records } = stubRegistry()
  await releaseTemplateVia(service, ENTRY, rowsOf)
  const removed = await unreleaseTemplateVia(service, 'novel')
  assert.deepEqual(removed, { form: 'registry', outcome: 'removed', presetId: 'rs-novel' })
  assert.equal(records[0].disposed, true)
  const missing = await unreleaseTemplateVia(service, 'novel')
  assert.equal(missing.outcome, 'missing')
  await assert.rejects(unreleaseTemplateVia(service, 'Bad_Id'), /流程 id 非法/)
})

test('Given 无 register 的宿主服务(0.1.2-0.1.5 形态)When release/unrelease Then 回落目录形态', async (t) => {
  const home = tempHome(t)
  const dirOnly = { list: async () => [] }
  const released = await releaseTemplateVia(dirOnly, ENTRY, rowsOf, { dshHome: home })
  assert.equal(released.form, 'dir')
  assert.equal(released.outcome, 'created')
  const unreleased = await unreleaseTemplateVia(dirOnly, 'novel', { dshHome: home })
  assert.equal(unreleased.form, 'dir')
  assert.equal(unreleased.outcome, 'removed')
})

test('Given 非法 id 或坏模板 When releaseTemplateVia Then 拒绝且注册表零残留', async () => {
  const { service, records } = stubRegistry()
  await assert.rejects(releaseTemplateVia(service, { ...ENTRY, id: 'Bad_Id' }, rowsOf), /流程 id 非法/)
  await assert.rejects(releaseTemplateVia(service, { ...ENTRY, json: '{ id:' }, rowsOf), /模板 JSON 解析失败/)
  const broken = JSON.stringify({ id: 'novel', label: '小说', steps: [{ id: 'a', prompt: '{request}' }] })
  await assert.rejects(releaseTemplateVia(service, { ...ENTRY, json: broken }, rowsOf), /模板校验失败/)
  assert.equal(records.length, 0)
})

test('Given 名单回读 broken When releaseTemplateVia Then created 但透出 broken 诊断', async () => {
  const { service } = stubRegistry()
  service.list = async () => [{ id: 'rs-novel', broken: 'row tool-x failed to import' }]
  const result = await releaseTemplateVia(service, ENTRY, rowsOf)
  assert.equal(result.outcome, 'created')
  assert.match(result.broken, /tool-x failed to import/)
})

test('Given 多条已释放模板 When replay Then 全部注册;清理后重放不抛 Duplicate', async () => {
  await disposeAllRegistered()
  const { service, records } = stubRegistry()
  const second = { ...ENTRY, id: 'collab', label: '协作' }
  const first = await replayReleased(service, [ENTRY, second], rowsOf)
  assert.deepEqual(first.map((r) => r.outcome), ['created', 'created'])
  assert.equal(liveOf(records).length, 2)
  assert.equal(await disposeAllRegistered(), 2)
  assert.equal(liveOf(records).length, 0)
  const again = await replayReleased(service, [ENTRY, second], rowsOf)
  assert.deepEqual(again.map((r) => r.outcome), ['created', 'created'])
  assert.equal(records.length, 4)
  assert.equal(liveOf(records).length, 2)
})

test('Given 单条重放失败 When replay Then 其余照常注册且失败项标 failed', async () => {
  await disposeAllRegistered()
  const { service } = stubRegistry()
  const bad = { ...ENTRY, id: 'Bad_Id' }
  const results = await replayReleased(service, [bad, ENTRY], rowsOf)
  assert.equal(results[0].outcome, 'failed')
  assert.match(results[0].broken, /流程 id 非法/)
  assert.equal(results[1].outcome, 'created')
})

test('Given 注册在案 When disposeAllRegistered Then 全部注销且计数正确,空表再清为零', async () => {
  await disposeAllRegistered()
  const { service, records } = stubRegistry()
  await releaseTemplateVia(service, ENTRY, rowsOf)
  assert.equal(await disposeAllRegistered(), 1)
  assert.equal(records[0].disposed, true)
  assert.equal(await disposeAllRegistered(), 0)
})

test('Given 临时数据目录 When markReleased Then 标志写读一致且模板缺失静默跳过', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rsww-registry-mark-'))
  process.env.DSH_RS_WORKFLOW_DATA_DIR = dataDir
  t.after(() => {
    delete process.env.DSH_RS_WORKFLOW_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
  })
  saveJson('templates.json', [{ id: 'novel', json: '{}' }])
  markReleased('novel', true)
  assert.equal(loadJson('templates.json', []).find((t) => t.id === 'novel')?.released, true)
  markReleased('novel', false)
  assert.equal(loadJson('templates.json', []).find((t) => t.id === 'novel')?.released, undefined)
  markReleased('ghost', true)
  assert.equal(loadJson('templates.json', []).length, 1)
})
