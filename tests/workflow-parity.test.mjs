// rs-workflow parity: slot 键集合在 lib schema / slots.json5 / SKILL.md 三处镜像,
// 任一侧增删键而无同步, 本测试必失败(仓库规约: 双实现同源需 parity 覆盖)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'packages', 'dsh-rs-workflow')

test('slot 键集合三处镜像一致(lib schema / slots.json5 / SKILL.md)', async () => {
  const lib = await import('../packages/dsh-rs-workflow/lib/index.js')
  // 1) lib Config schema 的 slots 键(经 buildSlots 实例化后读取)
  const cfg = lib.Config({ role: 'tool' })
  const libKeys = Object.keys(cfg.slots).sort()
  // 2) slots.json5 的 slots 键(用户后备配置文件, 键行形如 `planner:` 或 `"planner-triage":`)
  const slotsSrc = readFileSync(join(PKG, 'preset', 'rs-workflow', 'skills', 'rs-workflow', 'slots.json5'), 'utf8')
  const slotsSection = slotsSrc.slice(slotsSrc.indexOf('slots: {'), slotsSrc.lastIndexOf('}'))
  const json5Keys = [...slotsSection.matchAll(/^\s{4}"?([a-z-]+)"?:/gm)].map((m) => m[1]).sort()
  // 3) SKILL.md §5 表格行的工作位列(`| `planner-triage` | ...`,键带反引号;
  //    表格含 13 细分位,3 基础位在表格上方的散文行)
  const skillSrc = readFileSync(join(PKG, 'preset', 'rs-workflow', 'skills', 'rs-workflow', 'SKILL.md'), 'utf8')
  const tableStart = skillSrc.indexOf('| 细分位 |')
  const tableSlice = skillSrc.slice(tableStart, tableStart + 2000)
  const skillSub = [...tableSlice.matchAll(/^\|\s*`([a-z-]+)`/gm)].map((m) => m[1]).sort()
  const baseLine = skillSrc.indexOf('3 基础位：`planner` / `executor` / `reviewer`')
  assert.ok(baseLine >= 0, 'SKILL.md §5 应含 3 基础位散文行')
  const skillKeys = [...skillSub, ...['planner', 'executor', 'reviewer']].sort()
  assert.ok(libKeys.length >= 16, 'lib slots 应有 16 键, 实得 ' + libKeys.length)
  assert.deepEqual(json5Keys, libKeys, 'slots.json5 键集合与 lib 不一致')
  assert.deepEqual(skillKeys, libKeys, 'SKILL.md 工作位清单与 lib 不一致')
})

test('lib 导出常量可从包外消费(发布物边界)', async () => {
  const lib = await import('../packages/dsh-rs-workflow/lib/index.js')
  for (const key of ['BUDGET_DEFAULTS', 'BUDGET_MIN', 'BUDGET_MAX', 'MAX_TASKS_DEFAULT', 'MAX_TASKS_MIN', 'MAX_TASKS_MAX', 'SETTINGS_SCHEMA', 'Config', 'syncPreset', 'presetDest', 'removePreset']) {
    assert.ok(lib[key] !== undefined, 'lib 应导出 ' + key)
  }
  // 模块级 inject 已废除(tool 角色改 apply 内嵌套 inject,settings/preset-sync 不再被连坐)
  assert.equal(lib.inject, undefined, 'inject 不应再从模块导出')
})

test('tool 输出 schema 工作位键集与 Config schema 同源', async () => {
  const lib = await import('../packages/dsh-rs-workflow/lib/index.js')
  let tool = null
  const nestingCtx = {
    inject(deps, cb) {
      assert.deepEqual(deps, ['tools'], 'tool 角色应嵌套声明 tools 依赖')
      cb({ tools: { register(t) { tool = t } }, get: () => undefined })
    },
  }
  lib.apply(nestingCtx, { role: 'tool' })
  assert.ok(tool, 'apply 应注册工具')
  const schemaSlotKeys = Object.keys(tool.output.schema.properties.slots.properties).sort()
  const cfg = lib.Config({ role: 'tool' })
  assert.deepEqual(schemaSlotKeys, Object.keys(cfg.slots).sort(), '工具宣告的 slots 形状与可配集合脱节')
  assert.deepEqual(tool.output.schema.properties.workflow.properties.defaultTemplate.enum, lib.TEMPLATES)
})
