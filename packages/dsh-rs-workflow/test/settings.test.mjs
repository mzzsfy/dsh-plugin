// settings-schema 与内置模板加载 BDD(场景名即 Given/When/Then;契约源 docs/rsww-v4/feat/settings.md、board.md config-save)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { SLOT_KEYS as TEMPLATE_V4_SLOT_KEYS } from '../lib/template-v4.mjs'
import { builtinTemplates, defaultTemplatesDir } from '../lib/builtin-templates.mjs'
import {
  BUDGET_KEYS,
  DEFAULT_BUDGETS,
  DEFAULT_CONCURRENCY,
  KEEP_RUNS,
  NAMESPACE,
  SETTINGS_SCHEMA,
  SLOT_KEYS,
  baseOf,
  normalizeConfig,
} from '../lib/settings-schema.mjs'

// v3 删除的 12 个细分位(v3 16 位 = 3 基础 + 13 细分,其中 executor-escalate 被 v4 重定义保留)
const LEGACY_SLOT_KEYS = [
  'planner-triage', 'planner-command', 'planner-subplan', 'planner-escalate',
  'reviewer-plan', 'reviewer-task', 'reviewer-subplan', 'reviewer-final', 'reviewer-cross',
  'executor-task', 'executor-enhance', 'executor-retry',
]
const LEGACY_BUDGET_KEYS = ['reviewRejectBeforeEscalate', 'planRejectBeforeBlocked', 'emptyOutputRetryLimit', 'reportNudgeLimit']

const emptySlots = () => Object.fromEntries(SLOT_KEYS.map((key) => [key, []]))
const defaultBudgets = () => ({ ...DEFAULT_BUDGETS })

test('Given 全新归一空值 When normalizeConfig({}) Then 六空位/三默认预算/templates 空数组', () => {
  const value = normalizeConfig({})
  assert.deepEqual(Object.keys(value.slots), SLOT_KEYS)
  assert.deepEqual(value.slots, emptySlots())
  assert.deepEqual(value.budgets, defaultBudgets())
  assert.deepEqual(value.templates, [])
  assert.deepEqual(normalizeConfig(undefined), value)
  assert.deepEqual(normalizeConfig(null), value)
  assert.deepEqual(normalizeConfig('junk'), value)
})

test('Given 任意输入对象 When normalizeConfig Then 返回新对象且入参不被修改', () => {
  const input = { slots: { planner: 'a/b' }, budgets: { maxStepFail: 5 }, templates: [{ id: 't1' }], extra: 1 }
  const snapshot = structuredClone(input)
  const value = normalizeConfig(input)
  assert.notEqual(value, input)
  assert.notEqual(value.slots, input.slots)
  assert.notEqual(value.budgets, input.budgets)
  assert.notEqual(value.templates, input.templates)
  assert.deepEqual(input, snapshot)
})

test('Given v3 残留键(16 位 slots/旧预算/workflow 节) When normalizeConfig Then v3 键全部不存在且 v4 键为归一后值', () => {
  const v3Slots = { planner: 'p/m', executor: 'e/m', reviewer: 'r/m', 'executor-escalate': 'x/m' }
  for (const key of LEGACY_SLOT_KEYS) v3Slots[key] = 'legacy/m'
  const value = normalizeConfig({
    slots: v3Slots,
    budgets: { maxStepFail: 4, approveRounds: 5, escalateLimit: 6, reviewRejectBeforeEscalate: 2, emptyOutputRetryLimit: 3 },
    workflow: { defaultTemplate: 'auto', maxTasks: 8 },
  })
  assert.deepEqual(Object.keys(value.slots), SLOT_KEYS)
  assert.deepEqual(value.slots, { ...emptySlots(), planner: ['p/m'], executor: ['e/m'], reviewer: ['r/m'], 'executor-escalate': ['x/m'] })
  for (const key of LEGACY_SLOT_KEYS) assert.ok(!(key in value.slots), key)
  assert.deepEqual(Object.keys(value.budgets), BUDGET_KEYS)
  assert.deepEqual(value.budgets, { maxStepFail: 4, approveRounds: 5, escalateLimit: 6 })
  for (const key of LEGACY_BUDGET_KEYS) assert.ok(!(key in value.budgets), key)
  assert.ok(!('workflow' in value))
})

test('Given budgets 越界/下界/负值/非整数/错型 When normalizeConfig Then 整数 clamp [1,10] 且错型回退默认', () => {
  const cases = [
    [99, 10],
    [0, 1],
    [-3, 1],
    ['fast', DEFAULT_BUDGETS.maxStepFail],
    [2.5, DEFAULT_BUDGETS.maxStepFail],
  ]
  for (const [input, expected] of cases) {
    const value = normalizeConfig({ budgets: { maxStepFail: input } })
    assert.equal(value.budgets.maxStepFail, expected, `maxStepFail=${input}`)
  }
})

test('Given 模板条目缺 enabled 与 id 非字符串条目 When normalizeConfig Then enabled 补 true 且坏条目剔除', () => {
  const value = normalizeConfig({
    templates: [{ id: 't1', label: '甲', json5: 'a' }, { id: 42, label: '乙' }, null, { id: 't2', enabled: false }],
  })
  assert.deepEqual(value.templates, [
    { id: 't1', label: '甲', description: '', enabled: true, json5: 'a' },
    { id: 't2', label: '', description: '', enabled: false, json5: '' },
  ])
})

test('Given 临时目录内两合法与一残缺 json5 When builtinTemplates Then 返回两条且残缺跳过 enabled 恒 true', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsww-builtin-'))
  try {
    const alphaText = JSON.stringify({ id: 'alpha', label: '甲', description: '适用场景', steps: [] })
    const betaText = "{ id: 'beta', steps: [] }"
    writeFileSync(join(dir, 'alpha.json5'), alphaText)
    writeFileSync(join(dir, 'beta.json5'), betaText)
    writeFileSync(join(dir, 'broken.json5'), '{ id: ')
    writeFileSync(join(dir, 'plain.txt'), JSON.stringify({ id: 'gamma' }))
    const items = builtinTemplates(dir)
    assert.deepEqual(items.map((item) => item.id), ['alpha', 'beta'])
    assert.ok(items.every((item) => item.enabled === true))
    assert.equal(items[0].label, '甲')
    assert.equal(items[0].description, '适用场景')
    assert.equal(items[0].json5, alphaText)
    assert.equal(items[1].label, 'beta')
    assert.equal(items[1].description, '')
    assert.equal(items[1].json5, betaText)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Given 目录不存在 When builtinTemplates Then 返回空数组', () => {
  const parent = mkdtempSync(join(tmpdir(), 'rsww-missing-'))
  const missing = join(parent, 'absent')
  rmSync(parent, { recursive: true, force: true })
  assert.deepEqual(builtinTemplates(missing), [])
})

test('Given defaultTemplatesDir When 调用 Then 返回包内 flows 目录绝对路径', () => {
  const dir = defaultTemplatesDir()
  assert.ok(isAbsolute(dir))
  assert.equal(basename(dir), 'flows')
})

test('Given 组合行 config 缺三节 When baseOf Then 三节补默认且 templates 取内置模板集', () => {
  const base = baseOf({ role: 'settings' })
  assert.deepEqual(Object.keys(base), ['slots', 'budgets', 'templates'])
  assert.deepEqual(base.slots, emptySlots())
  assert.deepEqual(base.budgets, defaultBudgets())
  assert.deepEqual(base.templates, builtinTemplates(defaultTemplatesDir()))
})

test('Given 行 config 带三节 When baseOf Then 输出为归一后三节', () => {
  const base = baseOf({
    slots: { planner: ['a', 1, 'b'], 'planner-triage': 'legacy' },
    budgets: { maxStepFail: 99, approveRounds: 2 },
    templates: [{ id: 't1', enabled: false }],
  })
  assert.deepEqual(base.slots.planner, ['a', 'b'])
  assert.ok(!('planner-triage' in base.slots))
  assert.equal(base.budgets.maxStepFail, 10)
  assert.deepEqual(base.templates, [{ id: 't1', label: '', description: '', enabled: false, json5: '' }])
})

test('Given SETTINGS_SCHEMA When 解析部分配置 Then 缺省补全且键集与常量同源', () => {
  assert.ok(SETTINGS_SCHEMA && (typeof SETTINGS_SCHEMA === 'function' || typeof SETTINGS_SCHEMA === 'object'))
  assert.equal(NAMESPACE, 'rs-workflow')
  assert.equal(DEFAULT_CONCURRENCY, 4)
  assert.equal(KEEP_RUNS, 200)
  const parsed = SETTINGS_SCHEMA({ slots: { planner: 'a/b' }, budgets: { maxStepFail: 7 } })
  assert.equal(parsed.budgets.maxStepFail, 7)
  assert.equal(parsed.budgets.approveRounds, DEFAULT_BUDGETS.approveRounds)
  assert.deepEqual(Object.keys(parsed.slots), SLOT_KEYS)
  assert.deepEqual(parsed.slots.executor, [])
  assert.ok(Array.isArray(parsed.templates))
})

test('Given settings 与 template-v4 两侧工作位键集 When 对拍 Then 一致(镜像钉住)', () => {
  assert.deepEqual(SLOT_KEYS, TEMPLATE_V4_SLOT_KEYS)
})
