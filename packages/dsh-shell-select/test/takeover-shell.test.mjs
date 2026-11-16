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
  restoreRowStates,
  rollbackDisabledRows,
  runtimeDisableRows,
  snapshotRowStates,
  takeoverDecision,
} from '../src/takeover.mjs'
import { OFFICIAL_ROW_IDS, detectDeadState } from '../src/guard-state.mjs'
import {
  beginShellSelectApply,
  endShellSelectApplyActive,
  endShellSelectApplyInactive,
  setShellRequestSeam,
  shellRequestSeamActive,
  shellSelectApplyState,
  shellSelectExecutorFiber,
  shellSelectTakeoverTrace,
} from '../src/apply-state.mjs'
import { PWSH_REDIRECT_DESCRIPTION } from '../src/agent-hints.mjs'
import { ShellSelectExecutor } from '../src/executor.mjs'
import { installGuard } from '../src/guard.js'
import { apply as mainApply } from '../src/index.js'

const [TOOL_PWSH, PWSH_SANDBOX] = OFFICIAL_ROW_IDS
// guard 代挂的官方包名(行 id → npm 名)
const OFFICIAL_PACKAGES = ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-pwsh-sandbox']

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
// updateThrows:update 抛错形态(接线层回滚场景);updateThrowsAfterWrite:宿主
// 先落 options.disabled 再抛错(写事务收尾失败形态,G3-3 的失败行)。
// update 第二参按宿主真签名命名 create(Entry.update(options, create = false,
// force = false)):create 为真会把 options 整份替换,断言必须钉死它为 false。
function entryOf(id, { disabled = false, running = false, disabledThrows = false, rawDisabled, updateLog, updateThrows = false, updateThrowsAfterWrite = false, exitOnDisable = true } = {}) {
  const entry = {
    __id: id,
    options: { id, disabled: rawDisabled },
    get disabled() {
      if (disabledThrows) throw new Error('bad !!js expression')
      return entry.options.disabled === true
    },
    fiber: running ? { uid: 1 } : undefined,
    update: async (patch, create, force) => {
      if (updateThrows) throw new Error('update rejected')
      updateLog?.push({ id, patch, create, force })
      if (patch?.disabled === true) {
        entry.options.disabled = true
        if (exitOnDisable) entry.fiber = undefined
      }
      if (patch?.disabled === false) entry.options.disabled = false
      if (updateThrowsAfterWrite && patch?.disabled === true) throw new Error('after-write failure')
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
  assert.equal(log[0].create, false)
  assert.equal(log[0].force, true)
})

test('P1-5 rollbackDisabledRows:update {disabled:false} 第二参恒 create=false(宿主签名),失败返回清单', async () => {
  // Given 一行回滚成功、一行回滚失败
  const log = []
  const good = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, updateLog: log })
  const bad = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, updateThrows: true })
  const errors = []
  const failed = await rollbackDisabledRows([good, bad], { logger: { error: (msg) => errors.push(msg) } })
  // Then 成功行以 (options, create=false, force=true) 调用——create=true 会把
  // 官方行 options 整份替换成 {disabled:false},毁掉 id/name/config
  assert.deepEqual(log, [{ id: TOOL_PWSH, patch: { disabled: false }, create: false, force: true }])
  // Then 失败行进失败清单,并留 rollback-failed 轨迹与 error 日志(不吞成成功)
  assert.deepEqual(failed, [bad])
  const traces = shellSelectTakeoverTrace().map((entry) => entry.event)
  assert.ok(traces.includes('rollback-failed'), `缺少 rollback-failed 轨迹: ${traces.join(' | ')}`)
  assert.ok(errors.some((msg) => msg.includes('回滚启用失败')))
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

function stubCtxOf(entries, { pluginError, llm, settings } = {}) {
  const log = { warns: [], errors: [], infos: [], plugins: [], listeners: [], fibers: [], configure: [], effects: [] }
  const ctx = {
    loader: loaderOf(entries),
    logger: {
      info: (msg) => log.infos.push(msg),
      warn: (msg) => log.warns.push(msg),
      error: (msg) => log.errors.push(msg),
    },
    // 主行 fiber 标记:settings 抑制策略必须登记在它上面(宿主 describe 按
    // loader 行 fiber 查 autoGenerate),执行器子 fiber 上的键永不命中
    fiber: { uid: 'main-row-fiber' },
    plugin: async (module, config) => {
      if (pluginError) throw pluginError
      log.plugins.push({ module, config })
      // state=2 对齐宿主 cordis 激活态(挂载校验据它判定激活成功);
      // effect 同契约为 fiber 级 disposer 通道(句柄退役自清挂这里)
      const disposers = []
      const fiber = {
        state: 2,
        effect: (execute) => {
          const dispose = execute()
          disposers.push(dispose)
          return dispose
        },
        dispose: async () => {
          for (const dispose of disposers.splice(0).reverse()) await dispose?.()
        },
      }
      log.fibers.push(fiber)
      return fiber
    },
    on: (event, listener) => {
      log.listeners.push({ event, listener })
      return () => {}
    },
    inject: (services, callback) => {
      if (services.includes('settings')) {
        callback({
          settings: { configure: (presentation, owner) => log.configure.push({ presentation, owner }) },
          effect: (fn) => fn(),
        })
        return () => {}
      }
      // llm 服务缺席:请求缝隐藏按零动作跳过,不影响接管断言
      callback({ llm, on: () => () => {} })
      return () => {}
    },
    effect: (fn) => {
      const dispose = fn()
      log.effects.push(dispose)
      return dispose
    },
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

test('W-1 runtime-disable 全链:落定后双行禁用(create=false,force=true)→ 退场 → 挂执行器', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const updateLog = []
    const tool = entryOf(TOOL_PWSH, { updateLog })
    const sandbox = entryOf(PWSH_SANDBOX, { updateLog })
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, { shells: [] })
    await untilSettled(() => log.plugins.length > 0)
    assert.deepEqual(updateLog.map((call) => [call.id, call.patch.disabled, call.create, call.force]), [
      [TOOL_PWSH, true, false, true],
      [PWSH_SANDBOX, true, false, true],
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
    assert.equal(rollback.create, false)
    assert.equal(rollback.force, true)
    assert.equal(good.options.disabled, false)
    assert.equal(log.plugins.length, 0)
    assert.ok(log.warns.some((msg) => msg.includes('禁用失败')))
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('G3-3 restoreRowStates 按快照恢复原值(不假设"原本启用")', async () => {
  // Given 一行原本启用、一行原本已禁(快照值 false/true)
  const log = []
  const enabled = entryOf(TOOL_PWSH, { updateLog: log })
  const disabledRow = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, updateLog: log })
  const snapshot = snapshotRowStates([enabled, disabledRow])
  assert.deepEqual(snapshot.map((item) => item.disabled), [false, true])
  // When 按快照恢复;Then 逐行写回快照值(原本禁用的一行仍禁用),三参 create=false/force=true
  const failed = await restoreRowStates(snapshot, { logger: { error: () => {} } })
  assert.deepEqual(failed, [])
  assert.deepEqual(log.map((call) => [call.id, call.patch.disabled, call.create, call.force]), [
    [TOOL_PWSH, false, false, true],
    [PWSH_SANDBOX, true, false, true],
  ])
})

test('W-2 禁用写入后抛错:失败行也按快照恢复(不只回滚 disabled 清单)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const updateLog = []
    const good = entryOf(TOOL_PWSH, { updateLog })
    // 宿主已把 disabled 写成 true 再抛错:该行不在 disabled 清单里,却是禁用态
    const poisoned = entryOf(PWSH_SANDBOX, { updateLog, updateThrowsAfterWrite: true })
    const { ctx, log } = stubCtxOf([good, poisoned])
    await mainApply(ctx, {})
    await untilSettled(() => log.warns.some((msg) => msg.includes('禁用失败')))
    // Then 两行都恢复启用:永久禁用 shell 提供者的窗口不存在
    assert.equal(good.options.disabled, false)
    assert.equal(poisoned.options.disabled, false, '写入后抛错的失败行必须按快照恢复')
    assert.equal(log.plugins.length, 0)
    const restores = updateLog.filter((call) => call.patch.disabled === false)
    assert.deepEqual(restores.map((call) => [call.id, call.create, call.force]), [
      [TOOL_PWSH, false, true],
      [PWSH_SANDBOX, false, true],
    ])
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

// H2 支撑:执行器句柄随 fiber 退役自清——主行被禁后残留的已退役句柄会让
// guard 把"执行器不在场"误判为在场,吞掉官方行翻回启用时的代挂让位。
test('执行器句柄退役自清:主行 fiber 卸载后句柄清空(陈旧句柄不得残留)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, {})
    assert.equal(log.plugins.length, 1)
    const fiber = shellSelectExecutorFiber.current
    assert.equal(fiber, log.fibers[0], '挂载成功后句柄回填执行器 fiber')
    // 主行被禁/卸载 → 执行器 fiber 退役
    await fiber.dispose()
    assert.equal(shellSelectExecutorFiber.current, undefined, '退役后不得残留已退役句柄')
  } finally {
    shellSelectExecutorFiber.current = undefined
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// ── 原生设置节抑制(P2-36):宿主 describe 按 loader 行 fiber 查 autoGenerate,
// 策略必须挂在主行 fiber;挂在执行器子 fiber 上键永不命中 → 原生节照旧出现,
// 且原生写口不经本包 refresh 桥,执行面不换源(页面"已保存"行为不变)──

test('P2-36 原生设置节抑制登记在主行 fiber(执行器子 fiber 上无效)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx, log } = stubCtxOf([tool, sandbox])
    await mainApply(ctx, {})
    assert.equal(log.plugins.length, 1)
    assert.deepEqual(log.configure, [{ presentation: { auto: false }, owner: ctx.fiber }])
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// 执行面刷新收口在 web 写路径(updateConfig 直调执行器 refresh 桥):主行 apply
// 不监听 refresh 类宿主事件——宿主对 volatile-only 变更换 ref 不重挂行,事件也
// 不达本包。本文件其余用例已按需断言接线面(agent/created + llm/adapters-updated),
// 不再把"零监听"本身写成断言(旧写法把抑制缺陷锁成了正确形态)。

// llm 就绪后请求缝生效并留轨迹;agent 创建后改写会话作用域 pwsh 的定义。
test('请求缝与描述改写在 apply 接线层生效', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    class Adapter {
      async stream(options) { return options }

      async streamWithSnapshot(options) { return options }
    }
    const adapter = new Adapter()
    const llm = { adapters: new Map([['fake', { adapter }]]) }
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx, log } = stubCtxOf([tool, sandbox], { llm })
    await mainApply(ctx, {})
    const viaStream = await adapter.stream({ tools: [{ name: 'read' }, { name: 'pwsh' }, { name: 'shell' }] })
    assert.deepEqual(viaStream.tools.map((entry) => entry.name), ['read', 'shell'])
    const viaPrepared = await adapter.streamWithSnapshot({ tools: [{ name: 'pwsh' }, { name: 'shell' }] })
    assert.deepEqual(viaPrepared.tools, [{ name: 'shell' }])
    // apply 开头会重置轨迹,断言只看本次 apply 的全量
    const trace = shellSelectTakeoverTrace().map((entry) => entry.event)
    assert.ok(trace.some((event) => event.includes('request-hide attached=1')), `缺少请求缝轨迹: ${trace.join(' | ')}`)
    const created = log.listeners.find((entry) => entry.event === 'agent/created')
    assert.notEqual(created, undefined)
    const definition = { name: 'pwsh', description: 'Run PowerShell commands' }
    const shellDefinition = { name: 'shell' }
    // agent.ctx 形态按宿主契约:ctx.get('tools') 取服务(属性直读在服务未注入时抛),
    // 作用域键是 agent 对象本身;父作用域视图(undefined / 其它键)解析不到该定义
    // ——即该 pwsh 是 agent 自有层注册(G3-1 的改写前提)
    const agent = { id: 'a1' }
    const tools = {
      get: (name, scope) => {
        if (scope !== agent) return undefined
        return name === 'pwsh' ? definition : name === 'shell' ? shellDefinition : undefined
      },
    }
    agent.ctx = { get: (service) => service === 'tools' ? tools : undefined }
    created.listener({ agent })
    assert.equal(definition.description, PWSH_REDIRECT_DESCRIPTION)
    assert.ok(shellSelectTakeoverTrace().some((entry) => entry.event.includes('pwsh 描述')))
    // agent/created 是 serial 事件:ctx 读取抛错也不得打断会话创建(收敛成告警)
    assert.doesNotThrow(() => created.listener({
      agent: { id: 'a2', ctx: { get: () => { throw new Error('inactive context') } } },
    }))
    assert.ok(log.warns.some((msg) => msg.includes('描述改写失败')))
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// ── P1-6 请求缝活性:执行器已挂载 + 本次请求 tools 里确有 shell ────────────

function adaptersOf() {
  class Adapter {
    async stream(options) { return options }

    async streamWithSnapshot(options) { return options }
  }
  const adapter = new Adapter()
  return { adapter, llm: { adapters: new Map([['fake', { adapter }]]) } }
}

test('P1-6 BDD 请求只有 pwsh、没有 shell:原样透传(子代理工具集仅保留 pwsh 不得丢唯一终端)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const { adapter, llm } = adaptersOf()
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx } = stubCtxOf([tool, sandbox], { llm })
    await mainApply(ctx, {})
    const tools = [{ name: 'pwsh' }]
    const out = await adapter.stream({ tools })
    assert.equal(out.tools, tools, '无 shell 时必须是原引用透传')
    const prepared = await adapter.streamWithSnapshot({ tools })
    assert.equal(prepared.tools, tools)
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('P1-6 执行器挂载失败(回滚官方链):请求缝关闭,pwsh 原样透传', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const { adapter, llm } = adaptersOf()
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx } = stubCtxOf([tool, sandbox], { llm, pluginError: new Error('service shell conflict') })
    // P1 后直挂失败不再向上抛:apply 收敛为 inactive 并回滚官方链
    await mainApply(ctx, {})
    assert.equal(tool.options.disabled, false, '官方链必须回滚启用')
    assert.equal(sandbox.options.disabled, false)
    const tools = [{ name: 'pwsh' }, { name: 'shell' }]
    const out = await adapter.stream({ tools })
    assert.equal(out.tools, tools, '执行器未挂载时 shell 不存在,不得剔除 pwsh')
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('P1-6 yield(宿主状态异常):请求缝关闭,pwsh 原样透传', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const { adapter, llm } = adaptersOf()
    const tool = entryOf(TOOL_PWSH, { disabledThrows: true })
    const sandbox = entryOf(PWSH_SANDBOX)
    const { ctx } = stubCtxOf([tool, sandbox], { llm })
    await mainApply(ctx, {})
    const tools = [{ name: 'pwsh' }, { name: 'shell' }]
    const out = await adapter.stream({ tools })
    assert.equal(out.tools, tools, 'yield 时官方 pwsh 链独占,不得剔除')
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('P1-6 执行器 fiber 退役后请求缝关闭(残留活性会持续剔除官方 pwsh)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const { adapter, llm } = adaptersOf()
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx, log } = stubCtxOf([tool, sandbox], { llm })
    await mainApply(ctx, {})
    const withShell = [{ name: 'pwsh' }, { name: 'shell' }]
    assert.deepEqual((await adapter.stream({ tools: withShell })).tools.map((entry) => entry.name), ['shell'])
    await log.fibers[0].dispose()
    const after = await adapter.stream({ tools: withShell })
    assert.equal(after.tools, withShell, '执行器退役后必须原样透传')
  } finally {
    shellSelectExecutorFiber.current = undefined
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// runtime 序列的退场超时形态(放弃挂载+告警降级)由 awaitOfficialExit 的 false
// 分支单测与 await-exit 超时路径共同锁定:接线层超时场景需真实耗尽 50×20ms
// 轮询上界,不在套件内重复真实等待——「放弃后官方退场→guard 代挂」窗口复用
// S10 同一次等待,挂在同一用例末尾。

// ── S1 未激活 fiber 回收 ──────────────────────────────────────────────────

test('S1 执行器 fiber 未激活:先 dispose 再按挂载失败收敛(不留 pending fiber 事后抢 ctx.shell)', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx, log } = stubCtxOf([tool, sandbox])
    let disposed = 0
    ctx.plugin = async () => ({
      state: 1,
      inject: { tools: ['tools', 'shell'] },
      dispose: async () => { disposed += 1 },
    })
    // P1 后 apply 捕获挂载失败:落 inactive 并回滚,不再向调用方抛
    await mainApply(ctx, {})
    assert.equal(disposed, 1, '未激活 fiber 必须先回收')
    assert.equal(shellSelectApplyState(), 'inactive')
    assert.equal(tool.options.disabled, false, '回滚官方链')
    assert.equal(sandbox.options.disabled, false)
    assert.equal(log.plugins.length, 0)
    assert.equal(shellSelectExecutorFiber.current, undefined)
  } finally {
    shellSelectExecutorFiber.current = undefined
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// ── S6 代际 token:旧异步接管链不得改写新代旗标 ───────────────────────────

test('S6 代际 token:旧代 endActive/setSeam 迟到写被丢弃', () => {
  const gen1 = beginShellSelectApply()
  assert.equal(setShellRequestSeam(true, gen1), true)
  assert.equal(shellRequestSeamActive(), true)
  const gen2 = beginShellSelectApply()
  assert.equal(shellRequestSeamActive(), false, 'begin 新一代复位活性旗标')
  assert.equal(endShellSelectApplyActive(gen1), false, '旧代不得把新代落定为 active')
  assert.equal(shellSelectApplyState(), 'pending')
  assert.equal(setShellRequestSeam(true, gen1), false, '旧代不得重新打开请求缝')
  assert.equal(shellRequestSeamActive(), false)
  assert.equal(endShellSelectApplyInactive(gen2), true)
  assert.equal(shellSelectApplyState(), 'inactive')
})

test('S6 旧代接管链迟到挂载:回收执行器 fiber,不改写新代请求缝/句柄', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const tool = entryOf(TOOL_PWSH)
    const sandbox = entryOf(PWSH_SANDBOX)
    const { ctx } = stubCtxOf([tool, sandbox])
    let resolveMount
    ctx.plugin = () => new Promise((resolve) => { resolveMount = resolve })
    await mainApply(ctx, {})
    await untilSettled(() => typeof resolveMount === 'function')
    // 旧链还在等宿主挂载结果时,新一代 apply 落定(宿主状态异常 → yield 关缝)
    const next = stubCtxOf([entryOf(TOOL_PWSH, { disabledThrows: true }), entryOf(PWSH_SANDBOX)])
    await mainApply(next.ctx, {})
    assert.equal(shellRequestSeamActive(), false)
    // 旧代 fiber 此刻才落定:必须回收,且不得抢新代句柄/活性
    let disposed = 0
    resolveMount({ state: 2, effect: () => () => {}, dispose: async () => { disposed += 1 } })
    await untilSettled(() => disposed > 0)
    assert.equal(disposed, 1, '旧代执行器必须回收')
    assert.equal(shellSelectExecutorFiber.current, undefined)
    assert.equal(shellRequestSeamActive(), false, '旧代落定不得改写新代请求缝')
    assert.ok(shellSelectTakeoverTrace().some((entry) => entry.event === 'stale-generation 执行器已回收'))
  } finally {
    shellSelectExecutorFiber.current = undefined
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// ── S10 三关缝分支:await-exit 超时 / runtime 回滚(yield 已有 P1-6 用例)────

test('S10 await-exit 退场超时:放弃挂载落 inactive,官方退场后 guard 死态代挂', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let effects = []
  try {
    const { adapter, llm } = adaptersOf()
    // 行已禁但 fiber 永不退场:awaitOfficialExit 耗尽轮询后走放弃分支
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, running: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true })
    const { ctx, log } = stubCtxOf([tool, sandbox], { llm })
    effects = log.effects
    await mainApply(ctx, {})
    assert.equal(log.plugins.length, 0, '退场超时不得挂载执行器')
    assert.equal(shellRequestSeamActive(), false, '放弃接管必须关缝')
    // 放弃接管必须落 inactive:落 active 会让 guard 的 mainStalled 恒 false,
    // 官方行随后真退场后无人代挂(W-3)
    assert.equal(shellSelectApplyState(), 'inactive', '放弃接管必须落终态,不得宣称在服务')
    const tools = [{ name: 'pwsh' }, { name: 'shell' }]
    const out = await adapter.stream({ tools })
    assert.equal(out.tools, tools, '官方链仍在服务,不得剔除 pwsh')
    assert.ok(log.warns.some((msg) => msg.includes('退场超时')))
    assert.ok(shellSelectTakeoverTrace().some((entry) => entry.event.includes('退场超时')))

    // 放弃后官方行退场窗口(真机形态:官方 pwsh graceMs 晚于轮询上界):
    // 内存禁用残留的行随后 fiber 清空,此刻执行器与官方链都不在 → guard 死态
    // 判据成立并代挂官方两行,shell 服务回归
    tool.fiber = undefined
    assert.equal(detectDeadState(ctx.loader, { applyState: shellSelectApplyState }), true, '官方退场后必须进死态')
    await installGuard(ctx, {
      importOfficial: async (packageName) => ({ __name: packageName, apply() {} }),
      delay: async () => {},
      sweepIntervalMs: 3600 * 1000,
    })
    assert.deepEqual(log.plugins.map((entry) => entry.module.__name), OFFICIAL_PACKAGES, 'guard 必须代挂官方两行')
    assert.equal(shellRequestSeamActive(), false, '代挂不改变请求缝')
  } finally {
    for (const dispose of effects.splice(0)) await dispose?.()
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('S10 runtime 回滚(挂载失败):回滚官方两行、关请求缝,pwsh 原样透传', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const { adapter, llm } = adaptersOf()
    const updateLog = []
    const tool = entryOf(TOOL_PWSH, { updateLog })
    const sandbox = entryOf(PWSH_SANDBOX, { updateLog })
    const { ctx, log } = stubCtxOf([tool, sandbox], { llm, pluginError: new Error('service shell conflict') })
    await mainApply(ctx, {})
    await untilSettled(() => log.errors.some((msg) => msg.includes('回滚')))
    assert.equal(shellRequestSeamActive(), false, '回滚必须关缝')
    assert.equal(shellSelectApplyState(), 'inactive', 'runtime 挂载失败必须落终态')
    assert.equal(tool.options.disabled, false)
    assert.equal(sandbox.options.disabled, false)
    const tools = [{ name: 'pwsh' }, { name: 'shell' }]
    const out = await adapter.stream({ tools })
    assert.equal(out.tools, tools)
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

// ── P1 takeover/await-exit 直挂失败:回滚官方链并落终态 ─────────────────────

test('P1 takeover 直挂失败(未激活 fiber):回滚官方两行、落 inactive,官方恢复服务', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const updateLog = []
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, updateLog })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, updateLog })
    const { ctx, log } = stubCtxOf([tool, sandbox])
    let disposed = 0
    // sandboxPolicy 未就绪:ctx.plugin 返回 pending fiber(state=1),mountExecutor 拒挂
    ctx.plugin = async () => ({ state: 1, inject: { sandboxPolicy: true }, dispose: async () => { disposed += 1 } })
    await mainApply(ctx, {})
    assert.equal(disposed, 1, '未激活 fiber 必须回收')
    assert.equal(shellSelectApplyState(), 'inactive', '挂载失败必须落终态,不能永 pending')
    assert.deepEqual(updateLog.map((call) => call.patch.disabled), [false, false], '官方两行必须回滚启用')
    assert.equal(tool.options.disabled, false)
    assert.equal(sandbox.options.disabled, false)
    assert.equal(detectDeadState(ctx.loader, { applyState: shellSelectApplyState }), false, '官方已恢复服务,guard 无需代挂')
    assert.ok(log.errors.some((msg) => msg.includes('回滚')), '挂载失败必须有排障日志')
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('P1 await-exit 直挂失败:回滚官方两行并落 inactive', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const updateLog = []
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, running: true, updateLog })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, updateLog })
    const { ctx } = stubCtxOf([tool, sandbox])
    // 决策时双行已禁且 tool-pwsh 仍在退场 → await-exit;下一拍 fiber 撤清
    setTimeout(() => { tool.fiber = undefined }, 0)
    ctx.plugin = async () => ({ state: 1, inject: { sandboxPolicy: true }, dispose: async () => {} })
    await mainApply(ctx, {})
    assert.equal(shellSelectApplyState(), 'inactive')
    assert.deepEqual(updateLog.map((call) => call.patch.disabled), [false, false], '退场后挂载失败同样回滚')
    assert.equal(tool.options.disabled, false)
    assert.equal(sandbox.options.disabled, false)
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})

test('P1 挂载失败且回滚失败:仍落 inactive,guard 死态代挂可接管', async () => {
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    // 前任 fiber 占着 ctx.shell(service shell conflict),且官方行 update 被拒:
    // 回滚不了也必须落 inactive,否则 guard 永远看到 active 不代挂,tools 全灭
    const tool = entryOf(TOOL_PWSH, { rawDisabled: true, disabled: true, updateThrows: true })
    const sandbox = entryOf(PWSH_SANDBOX, { rawDisabled: true, disabled: true, updateThrows: true })
    const { ctx } = stubCtxOf([tool, sandbox], { pluginError: new Error('service shell already provided by predecessor fiber') })
    await mainApply(ctx, {})
    assert.equal(tool.options.disabled, true, '回滚失败行保持禁用(事实如实)')
    assert.equal(sandbox.options.disabled, true)
    assert.equal(shellSelectApplyState(), 'inactive', '回滚失败也必须落终态')
    assert.equal(detectDeadState(ctx.loader, { applyState: shellSelectApplyState }), true, 'guard 死态代挂必须可接管')
    assert.ok(shellSelectTakeoverTrace().some((entry) => entry.event.includes('rollback-failed')))
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
})
