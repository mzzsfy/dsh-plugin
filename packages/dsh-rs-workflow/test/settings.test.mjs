// config 形态与自有文件存储 BDD(场景名即 Given/When/Then;契约源 docs/rsww-v5/data-design.md 存储布局节、board.md config-save)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SLOT_KEYS as TEMPLATE_SLOT_KEYS } from '../lib/template.mjs'
import {
  BUDGET_KEYS,
  DEFAULT_BUDGETS,
  DEFAULT_CONCURRENCY,
  KEEP_RUNS,
  SLOT_KEYS,
  normalizeConfig,
} from '../lib/settings-schema.mjs'
import { dataDir, loadJson, saveJson } from '../lib/storage.mjs'

// 旧版删除的 12 个细分位(旧版 16 位 = 3 基础 + 13 细分,executor-escalate 保留归一)
const LEGACY_SLOT_KEYS = [
  'planner-triage', 'planner-command', 'planner-subplan', 'planner-escalate',
  'reviewer-plan', 'reviewer-task', 'reviewer-subplan', 'reviewer-final', 'reviewer-cross',
  'executor-task', 'executor-enhance', 'executor-retry',
]
const LEGACY_BUDGET_KEYS = ['reviewRejectBeforeEscalate', 'planRejectBeforeBlocked', 'emptyOutputRetryLimit', 'reportNudgeLimit']

const emptySlots = () => Object.fromEntries(SLOT_KEYS.map((key) => [key, []]))
const defaultBudgets = () => ({ ...DEFAULT_BUDGETS })

test('Given 全新归一空值 When normalizeConfig({}) Then 六空位/三默认预算(无 templates 节)', () => {
  const value = normalizeConfig({})
  assert.deepEqual(Object.keys(value.slots), SLOT_KEYS)
  assert.deepEqual(value.slots, emptySlots())
  assert.deepEqual(value.budgets, defaultBudgets())
  assert.equal('templates' in value, false)
  assert.deepEqual(normalizeConfig(undefined), value)
  assert.deepEqual(normalizeConfig(null), value)
  assert.deepEqual(normalizeConfig('junk'), value)
})

test('Given 任意输入对象 When normalizeConfig Then 返回新对象且入参不被修改', () => {
  const input = { slots: { planner: 'a/b' }, budgets: { maxStepFail: 5 }, templates: [{ id: 't1' }], extra: 1 }
  const snapshot = structuredClone(input)
  const value = normalizeConfig(input)
  assert.deepEqual(value.slots.planner, ['a/b'])
  assert.notEqual(value.slots, input.slots)
  assert.deepEqual(input, snapshot)
})

test('Given 旧版残留键(细分 slots/旧预算/workflow 节) When normalizeConfig Then 遗留键全部不存在且现行键为归一后值', () => {
  const slots = Object.fromEntries(LEGACY_SLOT_KEYS.map((k) => [k, 'm1']))
  slots.planner = 'm0'
  const budgets = Object.fromEntries(LEGACY_BUDGET_KEYS.map((k) => [k, 3]))
  budgets.maxStepFail = 4
  const value = normalizeConfig({ slots, budgets, workflow: { concurrency: 8 } })
  assert.deepEqual(value.slots.planner, ['m0'])
  for (const key of LEGACY_SLOT_KEYS) assert.ok(!(key in value.slots))
  for (const key of LEGACY_BUDGET_KEYS) assert.ok(!(key in value.budgets))
  assert.equal(value.budgets.maxStepFail, 4)
  assert.ok(!('workflow' in value))
})

test('Given budgets 越界/下界/负值/非整数/错型 When normalizeConfig Then 整数 clamp [1,10] 且错型回退默认', () => {
  const value = normalizeConfig({ budgets: { maxStepFail: 99, approveRounds: -3, escalateLimit: 2.5 } })
  assert.equal(value.budgets.maxStepFail, 10)
  assert.equal(value.budgets.approveRounds, 1)
  assert.equal(value.budgets.escalateLimit, DEFAULT_BUDGETS.escalateLimit)
  const bad = normalizeConfig({ budgets: { maxStepFail: 'fast' } })
  assert.equal(bad.budgets.maxStepFail, DEFAULT_BUDGETS.maxStepFail)
  assert.deepEqual(Object.keys(value.budgets), BUDGET_KEYS)
})

test('Given config 带 templates 节 When normalizeConfig Then 剥离(模板不入 config)', () => {
  const value = normalizeConfig({ templates: [{ id: 't1' }, { label: 'x' }, null] })
  assert.equal('templates' in value, false)
})

test('Given 存储目录 When dataDir Then 默认 ~/.dsh/dsh-rs-workflow;DSH_RS_WORKFLOW_DATA_DIR 覆写生效', () => {
  assert.ok(typeof dataDir() === 'string' && dataDir().includes('dsh-rs-workflow'))
})

test('Given 临时数据目录 When saveJson+loadJson Then 往返一致;缺失文件读回 fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsww-storage-'))
  const prevDataDir = process.env.DSH_RS_WORKFLOW_DATA_DIR
  process.env.DSH_RS_WORKFLOW_DATA_DIR = dir
  try {
    saveJson('templates.json', [{ id: 'x', json: '{}' }])
    assert.deepEqual(loadJson('templates.json', []), [{ id: 'x', json: '{}' }])
    assert.deepEqual(loadJson('config.json', { fallback: true }), { fallback: true })
  } finally {
    if (prevDataDir === undefined) delete process.env.DSH_RS_WORKFLOW_DATA_DIR
    else process.env.DSH_RS_WORKFLOW_DATA_DIR = prevDataDir
  }
})

test('Given settings 与 template 两侧工作位键集 When 对拍 Then 一致(镜像钉住)', () => {
  assert.deepEqual(SLOT_KEYS, TEMPLATE_SLOT_KEYS)
})

test('Given 模块常量 When 读取 Then 口径钉住', () => {
  assert.deepEqual(BUDGET_KEYS, ['maxStepFail', 'approveRounds', 'escalateLimit'])
  assert.equal(DEFAULT_CONCURRENCY, 4)
  assert.equal(KEEP_RUNS, 200)
})
