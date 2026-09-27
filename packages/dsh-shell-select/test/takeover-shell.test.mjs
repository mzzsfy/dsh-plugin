// 官方 pwsh 链生命周期探测与运行时接管 BDD(场景编号见 运行时接管-BDD.md):
// 双行快照 → 四态决策(接管/等待退场/让位/运行时禁用)→ 接线序列(禁用/
// 退场等待/挂载/回滚)。接管空间判定与 gateway 不同:官方两行带平台表达式,
// 且真机实证 options.disabled 原始值是 !!js 表达式包装对象(非求值布尔)——
// 启用中判定必须走 entry.disabled getter 求值结果;宿主默认启用态与用户显式
// 启用在行树不可区分,行级 false 不作为让位信号——凡求值非 true 即接管空间,
// 用户意图通道 = 禁用本包。getter 抛错仍让位安全向。禁用只更新启用中的行
// (0.1.7 混合态常态)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXIT_POLL_INTERVAL_MS,
  awaitOfficialExit,
  officialChainState,
  officialRowState,
  rollbackDisabledRows,
  runtimeDisableRows,
  takeoverDecision,
} from '../src/takeover.mjs'
import { OFFICIAL_ROW_IDS } from '../src/guard-state.mjs'
import { ShellSelectExecutor } from '../src/executor.mjs'
import { apply as mainApply } from '../src/index.js'

const [TOOL_PWSH, PWSH_SANDBOX] = OFFICIAL_ROW_IDS

function loaderOf(entries) {
  const map = new Map(entries.map((entry) => [entry.__id, entry]))
  return {
    resolve: (id) => {
      const bare = [...map.keys()].find((key) => id.endsWith(key))
      if (bare) return map.get(bare)
      throw new Error(`cannot resolve entry ${id}`)
    },
  }
}

// rawDisabled:options.disabled 原始值(默认 undefined);disabled:entry.disabled
// getter 求值结果;updateLog:entry.update 调用记录(禁用/回滚断言点);
// exitOnDisable:update(disabled:true) 时模拟宿主「禁用 → fiber 撤清」;
// updateThrows:update 抛错形态(接线层回滚场景)
function entryOf(id, { disabled = false, running = false, disabledThrows = false, rawDisabled, updateLog, updateThrows = false, exitOnDisable = true } = {}) {
  const entry = {
    __id: id,
    options: { disabled: rawDisabled },
    get disabled() {
      if (disabledThrows) throw new Error('bad !!js expression')
      return entry.options.disabled === true
    },
    fiber: running ? { uid: 1 } : undefined,
    update: async (patch, quiet, force) => {
      if (updateThrows) throw new Error('update rejected')
      updateLog?.push({ id, patch, quiet, force })
      if (patch?.disabled === true) {
        entry.options.disabled = true
        if (exitOnDisable) entry.fiber = undefined
      }
      if (patch?.disabled === false) entry.options.disabled = false
      return undefined
    },
  }
  return entry
}

// ── 探测层 ────────────────────────────────────────────────────────────────

test('探测: loader 缺失或行不存在,按缺席处理(rawDisabled 归一为已禁)', () => {
  const state = officialRowState(undefined, TOOL_PWSH)
  assert.equal(state.present, false)
  assert.equal(state.rawDisabled, true)
  const chain = officialChainState({ resolve: () => { throw new Error('gone') } })
  assert.deepEqual(Object.keys(chain), OFFICIAL_ROW_IDS)
  assert.ok(Object.values(chain).every((row) => row.present === false))
})

test('探测: 三字段映射(disabled 读宿主 getter,rawDisabled 读 options 原值)', () => {
  const chain = officialChainState(loaderOf([entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })]))
  assert.equal(chain[TOOL_PWSH].disabled, true)
  assert.equal(chain[TOOL_PWSH].rawDisabled, true)
  assert.equal(chain[PWSH_SANDBOX].present, false)
})

test('探测: disabled getter 抛错 → disabledUnreliable(rawDisabled 落 undefined 不误判)', () => {
  const state = officialRowState(loaderOf([entryOf(TOOL_PWSH, { disabledThrows: true })]), TOOL_PWSH)
  assert.equal(state.disabled, false)
  assert.equal(state.disabledUnreliable, true)
})

// ── 决策层(S-1 ~ S-8)───────────────────────────────────────────────────

test('S-1 双行全禁停稳 → takeover', () => {
  const chain = officialChainState(loaderOf([
    entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true }),
    entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true }),
  ]))
  assert.deepEqual(takeoverDecision(chain), { decision: 'takeover', targets: [] })
})

test('S-2 禁用但仍在退场 → await-exit(单行/双行)', () => {
  const chain = officialChainState(loaderOf([
    entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true }),
    entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, running: true }),
  ]))
  assert.deepEqual(takeoverDecision(chain), { decision: 'await-exit', targets: [] })
  const chain2 = officialChainState(loaderOf([
    entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, running: true }),
    entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, running: true }),
  ]))
  assert.equal(takeoverDecision(chain2).decision, 'await-exit')
})

test('S-3 平台默认 false(宿主启用态)与 undefined 同为接管空间:runtime-disable', () => {
  // dsh-base 平台表达式在 win32 求值 false,与用户显式启用不可区分,
  // 不作为让位信号(gateway 官方行无 disabled 声明,shell-select 官方行有)
  const tool = entryOf(TOOL_PWSH, { rawDisabled: false })
  const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: false })
  const chain = officialChainState(loaderOf([tool, sandbox]))
  const { decision, targets } = takeoverDecision(chain)
  assert.equal(decision, 'runtime-disable')
  assert.deepEqual(targets, [tool, sandbox])
})

test('S-4 双行默认启用 → runtime-disable 双目标', () => {
  const tool = entryOf(TOOL_PWSH)
  const sandbox = entryOf(PWSH_SANDBOX)
  const chain = officialChainState(loaderOf([tool, sandbox]))
  const { decision, targets } = takeoverDecision(chain)
  assert.equal(decision, 'runtime-disable')
  assert.deepEqual(targets, [tool, sandbox])
})

test('S-5 混合态(0.1.7 常态:tool-pwsh 宿主已禁 + pwsh-sandbox 默认)→ runtime-disable 仅 sandbox', () => {
  const sandbox = entryOf(PWSH_SANDBOX)
  const chain = officialChainState(loaderOf([
    entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true }),
    sandbox,
  ]))
  const { decision, targets } = takeoverDecision(chain)
  assert.equal(decision, 'runtime-disable')
  assert.deepEqual(targets, [sandbox])
})

test('S-6 任一行 getter 抛错 → yield(双行/混合/显式 false 均让位)', () => {
  for (const broken of [TOOL_PWSH, PWSH_SANDBOX]) {
    const other = broken === TOOL_PWSH ? PWSH_SANDBOX : TOOL_PWSH
    const chain = officialChainState(loaderOf([
      entryOf(broken, { disabledThrows: true }),
      entryOf(other),
    ]))
    assert.equal(takeoverDecision(chain).decision, 'yield')
  }
})

test('S-7 缺席行视为已禁;全缺席 → takeover;缺席+默认 → 仅禁在场行', () => {
  const absentChain = officialChainState({ resolve: () => { throw new Error('gone') } })
  assert.deepEqual(takeoverDecision(absentChain), { decision: 'takeover', targets: [] })
  const sandbox = entryOf(PWSH_SANDBOX)
  const mixed = officialChainState(loaderOf([sandbox]))
  const { decision, targets } = takeoverDecision(mixed)
  assert.equal(decision, 'runtime-disable')
  assert.deepEqual(targets, [sandbox])
})

test('S-8 options.disabled 为 !!js 表达式包装对象(真机形态)→ 按 getter 求值决策,不误让位', () => {
  const expr = { __jsExpr: "process.platform !== 'win32'" }
  const tool = entryOf(TOOL_PWSH, { rawDisabled: expr })
  const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: expr })
  const chain = officialChainState(loaderOf([tool, sandbox]))
  const { decision, targets } = takeoverDecision(chain)
  assert.equal(decision, 'runtime-disable')
  assert.deepEqual(targets, [tool, sandbox])
})

// ── 原语层 ────────────────────────────────────────────────────────────────

test('runtimeDisableRows:逐行 force update;单行失败不中止其余行', async () => {
  const log = []
  const good = entryOf(TOOL_PWSH, { updateLog: log })
  const bad = entryOf(PWSH_SANDBOX, { updateLog: log, updateThrows: true })
  const { disabled, failed } = await runtimeDisableRows([good, bad])
  assert.deepEqual(disabled, [good])
  assert.deepEqual(failed, [bad])
  assert.deepEqual(log.map((call) => call.id), [TOOL_PWSH])
  assert.deepEqual(log[0].patch, { disabled: true })
  assert.equal(log[0].quiet, false)
  assert.equal(log[0].force, true)
})

test('rollbackDisabledRows:update {disabled:false} quiet,失败吞掉不抛', async () => {
  const log = []
  const good = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, updateLog: log })
  const bad = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, updateThrows: true })
  await rollbackDisabledRows([good, bad])
  assert.deepEqual(log, [{ id: TOOL_PWSH, patch: { disabled: false }, quiet: true, force: true }])
})

test('awaitOfficialExit:双行全退场(含收尾间隔)→ true;退场卡死 → false', async () => {
  const delays = []
  const slowDelay = async (ms) => { delays.push(ms) }
  const exited = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
  const exited2 = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
  assert.equal(await awaitOfficialExit([exited, exited2], { delay: slowDelay }), true)
  assert.deepEqual(delays, [EXIT_POLL_INTERVAL_MS])
  const stuck = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, running: true })
  assert.equal(await awaitOfficialExit([stuck], { rounds: 3, delay: slowDelay }), false)
  assert.equal(delays.length, 4)
})

// ── 接线层(W-1 ~ W-7):主行 apply 桩测 ─────────────────────────────────

function stubCtxOf(entries, { updateThrows = false, pluginError } = {}) {
  const log = { warns: [], errors: [], infos: [], plugins: [], listeners: [] }
  const ctx = {
    loader: loaderOf(entries),
    logger: {
      info: (msg) => log.infos.push(msg),
      warn: (msg) => log.warns.push(msg),
      error: (msg) => log.errors.push(msg),
    },
    plugin: async (module, config) => {
      if (pluginError) throw pluginError
      log.plugins.push({ module, config })
      // state=2 对齐宿主 cordis 激活态(挂载校验据它判定激活成功)
      return { dispose: async () => {}, state: 2 }
    },
    on: (event, listener) => {
      log.listeners.push({ event, listener })
      return () => {}
    },
    effect: (fn) => fn(),
  }
  return { ctx, log }
}

// 异步接管序列的落定等待:序列内含退场收尾真实 setTimeout(20ms 级),
// 轮询至断言条件成立或上界(防序列异常时测试挂死)
async function untilSettled(probe, rounds = 50) {
  for (let round = 0; round < rounds; round += 1) {
    if (probe()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return probe()
}

test('W-7 POSIX 早退:inactive 旗标,零 update 零挂载', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    const tool = entryOf(TOOL_PWSH)
    const sandbox = entryOf(PWSH_SANDBOX)
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, {})
    assert.equal(log.plugins.length, 0)
    assert.equal(tool.options.disabled, undefined)
    assert.equal(sandbox.options.disabled, undefined)
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('W-1 runtime-disable 全链:落定后双行禁用(quiet=false,force=true)→ 退场 → 挂执行器', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const updateLog = []
    const tool = entryOf(TOOL_PWSH, { updateLog })
    const sandbox = entryOf(PWSH_SANDBOX, { updateLog })
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, { shells: [] })
    await untilSettled(() => log.plugins.length > 0)
    assert.deepEqual(updateLog.map((call) => [call.id, call.patch.disabled, call.force]), [
      [TOOL_PWSH, true, true],
      [PWSH_SANDBOX, true, true],
    ])
    assert.equal(log.plugins.length, 1)
    assert.equal(log.plugins[0].module, ShellSelectExecutor)
    assert.ok(log.warns.some((msg) => msg.includes('接管')))
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('W-2 update 失败:回滚已禁行,不挂载,官方保持服务', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const updateLog = []
    const good = entryOf(TOOL_PWSH, { updateLog })
    const bad = entryOf(PWSH_SANDBOX, { updateLog, updateThrows: true })
    const { ctx, log } = stubCtxOf([good, bad])
    await mainApply(ctx, {})
    await untilSettled(() => updateLog.some((call) => call.id === TOOL_PWSH && call.patch.disabled === false))
    // good 已禁成功 → 回滚启用;bad 未动
    const rollback = updateLog.find((call) => call.id === TOOL_PWSH && call.patch.disabled === false)
    assert.ok(rollback, '回滚调用缺失')
    assert.equal(rollback.quiet, true)
    assert.equal(good.options.disabled, false)
    assert.equal(log.plugins.length, 0)
    assert.ok(log.warns.some((msg) => msg.includes('禁用失败')))
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('W-4 挂载失败:官方已退场,回滚启用两行令官方复活', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const updateLog = []
    const tool = entryOf(TOOL_PWSH, { updateLog })
    const sandbox = entryOf(PWSH_SANDBOX, { updateLog })
    const { ctx, log } = stubCtxOf([tool, sandbox], { pluginError: new Error('service shell conflict') })
    await mainApply(ctx, {})
    await untilSettled(() => log.errors.length > 0)
    const rollbacks = updateLog.filter((call) => call.patch.disabled === false)
    assert.deepEqual(rollbacks.map((call) => call.id).sort(), [PWSH_SANDBOX, TOOL_PWSH].sort())
    assert.equal(tool.options.disabled, false)
    assert.equal(sandbox.options.disabled, false)
    assert.equal(log.plugins.length, 0)
    assert.ok(log.errors.some((msg) => msg.includes('回滚')))
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('W-5 getter 抛错 → yield 零动作零挂载(安全向,官方全量服务)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const tool = entryOf(TOOL_PWSH, { disabledThrows: true })
    const sandbox = entryOf(PWSH_SANDBOX)
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, {})
    await untilSettled(() => log.infos.length > 0)
    assert.equal(log.plugins.length, 0)
    assert.equal(tool.options.disabled, undefined)
    assert.equal(sandbox.options.disabled, undefined)
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('W-6 takeover 直挂:官方已禁停稳,不经 update 直接挂载', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const updateLog = []
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, updateLog })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, updateLog })
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(updateLog.length, 0)
    assert.equal(log.plugins.length, 1)
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('W-6 await-exit:禁用行退场完成后挂载(真实 setTimeout 微延迟)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    // 退场在 30ms 后:首轮探测仍 running,轮询兜住
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, running: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    setTimeout(() => { tool.fiber = undefined }, 30)
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, {})
    assert.equal(log.plugins.length, 1)
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// ── volatile 陈旧问题:执行面刷新收口在 web 写路径(updateConfig 直调
// ctx.shell.refresh),主行不监听宿主事件(真实链路 volatile-only 不重挂行、
// 事件不达本包,投机监听已移除;挂载路径零监听即正确形态)──

test('apply 挂载路径零宿主事件监听(refresh 收口在 web 写路径)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, {})
    assert.equal(log.plugins.length, 1)
    assert.equal(log.listeners.length, 0)
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// runtime 序列的退场超时形态(放弃挂载+告警降级)由 awaitOfficialExit 的 false
// 分支单测与 await-exit 超时路径共同锁定:接线层超时场景需真实耗尽 50×20ms
// 轮询上界,不在套件内重复真实等待。
