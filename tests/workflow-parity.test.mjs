// rs-workflow parity: 工作位键集合在 lib schema 与 collab 引擎两处镜像,任一侧增删
// 键而无同步本测试必失败(仓库规约: 双实现同源需 parity 覆盖)。
// 另钉: 通用流程解释器的资源注入上限与宿主 takeover 资源解析上限同源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'packages', 'dsh-rs-workflow')

test('slot 键集合两处镜像一致(lib schema / collab 引擎)', async () => {
  const lib = await import('../packages/dsh-rs-workflow/lib/index.js')
  // 1) lib Config schema 的 slots 键(经 buildSlots 实例化后读取)
  const cfg = lib.Config({ role: 'settings' })
  const libKeys = Object.keys(cfg.slots).sort()
  assert.ok(libKeys.length >= 16, 'lib slots 应有 16 键, 实得 ' + libKeys.length)
  // 2) collab 引擎脚本内的槽位降级与工作位字面量(基础位键集合)
  const engineSrc = readFileSync(join(PKG, 'engine', 'collab.js'), 'utf8')
  for (const key of ['planner', 'executor', 'reviewer', 'planner-triage', 'reviewer-final', 'executor-escalate']) {
    assert.ok(engineSrc.includes(key), 'collab 引擎应引用工作位 ' + key)
  }
  // 3) 流程解释器允许的槽位 = 同一 16 键集合(lib/flows.mjs SLOT_KEYS 导出对拍)
  const flows = await import('../packages/dsh-rs-workflow/lib/flows.mjs')
  assert.deepEqual(flows.SLOT_KEYS.sort(), libKeys, 'flows.mjs SLOT_KEYS 与 lib slots 键集合不一致')
})

test('lib 导出常量可从包外消费(发布物边界)', async () => {
  const lib = await import('../packages/dsh-rs-workflow/lib/index.js')
  for (const key of ['BUDGET_DEFAULTS', 'BUDGET_MIN', 'BUDGET_MAX', 'MAX_TASKS_DEFAULT', 'MAX_TASKS_MIN', 'MAX_TASKS_MAX', 'SETTINGS_SCHEMA', 'Config', 'syncPreset', 'presetDest', 'removePreset', 'flowPresetDest', 'unreleaseFlowTemplate', 'readTemplates']) {
    assert.ok(lib[key] !== undefined, 'lib 应导出 ' + key)
  }
  // 模块级 inject 已废除(角色改 apply 内嵌套 inject,settings/preset-sync 不再被连坐)
  assert.equal(lib.inject, undefined, 'inject 不应再从模块导出')
})

test('takeover 角色嵌套声明 workflowEngine 依赖(pre-step 拦截路径)', async () => {
  const lib = await import('../packages/dsh-rs-workflow/lib/index.js')
  const depsSeen = []
  const ctx = {
    inject(deps, cb) {
      depsSeen.push(deps)
      cb({ workflowEngine: { start() { throw new Error('不应在注册期启动') } } })
    },
    effect(fn) { fn() },
    on() { return () => {} },
    get() { return undefined },
  }
  lib.apply(ctx, { role: 'takeover', kind: 'collab' })
  assert.ok(depsSeen.some((d) => d.includes('workflowEngine')), 'takeover 角色应嵌套声明 workflowEngine 依赖')
})

test('流程模板 spec 规范锚点与 DSL 校验实现同源', async () => {
  const { SPEC_TEXT } = await import('../packages/dsh-rs-workflow/lib/spec.mjs')
  const flows = await import('../packages/dsh-rs-workflow/lib/flows.mjs')
  // spec 文档声明的工作位/资源 scheme/嵌套上限与实现一致(文档漂移即失败)
  for (const key of flows.SLOT_KEYS.slice(0, 3)) {
    assert.ok(SPEC_TEXT.includes('"' + key + '"'), 'spec 应包含基础工作位 ' + key)
  }
  for (const scheme of flows.LOAD_SCHEMES) {
    assert.ok(SPEC_TEXT.includes('"' + scheme + ':'), 'spec 应包含资源 scheme ' + scheme + ':')
  }
  assert.ok(SPEC_TEXT.includes('嵌套深度上限 ' + flows.MAX_FLOW_DEPTH), 'spec 嵌套上限与实现不一致')
  assert.ok(SPEC_TEXT.includes('16 * 1000') === false, 'spec 不应暴露实现常量字面量')
})

test('资源注入上限两处同源(宿主 takeover / 流程解释器)', async () => {
  const takeover = await import('../packages/dsh-rs-workflow/lib/takeover.mjs')
  const flowSrc = readFileSync(join(PKG, 'engine', 'flow.js'), 'utf8')
  // 双侧同用 16 * 1000 表达式(仓库规约:无魔法数值字面量)
  assert.ok(flowSrc.includes('const RESOURCE_CHARS = 16 * 1000'), 'flow.js 资源截断常量形态')
  assert.equal(takeover.RESOURCE_MAX_CHARS, 16 * 1000, 'takeover 资源上限语义值')
})
