// 官方 entry 生命周期探测与复活守卫 BDD:
// 接管决策四态(接管/等待退场/让位/运行时禁用)与官方复活让位(守卫自停)。
// 背景:宿主注册排他,官方行复活撞本包在场注册会令官方 init 失败并拖垮
// 整批 patch 应用;守卫经 waterfall 在官方 apply 前自停让位。
// 运行时接管:bundle patch 不再静态禁官方行(组合期禁用不检查 gateway 可
// 服务性,gateway 损伤即全模型不可用);官方行的禁用由 gateway apply 落定
// 后 runtime-disable 执行。行 options.disabled 原始值三态区分意图:
// undefined=默认态(runtime-disable 的接管空间)/ false=用户显式启用(yield,
// 永不强抢)/ true=已禁(await-exit/takeover)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OFFICIAL_ENTRY_ID,
  officialEntryState,
  takeoverDecision,
  awaitOfficialExit,
  installOfficialRevivalGuard,
  armDeferredTakeover,
} from '../src/takeover.mjs'

const ABSENT_LOADER = undefined

function loaderOf(entry) {
  return {
    resolve: (id) => {
      if (id !== OFFICIAL_ENTRY_ID) throw new Error(`cannot resolve entry ${id}`)
      return entry
    },
  }
}

// rawDisabled:options.disabled 原始值(默认 undefined);disabled:entry.disabled
// getter 求值结果(含 !!js 表达式与父链回溯语义);updateLog:entry.update 调用记录
// (runtime-disable 断言点);exitOnDisable:update(disabled:true) 时模拟宿主
// 「禁用 → fiber 撤清」语义(真实宿主 dispose 异步,测试即时或经延迟函数控制)
function entryOf({ disabled = false, running = false, disabledThrows = false, rawDisabled, updateLog, exitOnDisable = true } = {}) {
  const entry = {
    options: { disabled: rawDisabled, ...(disabled ? { disabled: true } : {}) },
    // 宿主 Entry.disabled getter 桩:!!js 求值结果以 options.disabled 为源
    // (runtime-disable update 后 getter 跟随翻转,同宿主行为)
    get disabled() {
      if (disabledThrows) throw new Error('bad !!js expression')
      return entry.options.disabled === true
    },
    fiber: running ? { uid: 1 } : undefined,
    update: async (patch, quiet, force) => {
      updateLog?.push({ patch, quiet, force })
      if (patch?.disabled === true) {
        entry.options.disabled = true
        if (exitOnDisable) entry.fiber = undefined
      }
      return undefined
    },
  }
  return entry
}

test('探测: loader 缺失或官方行不存在,按缺席处理(接管语义)', () => {
  assert.deepEqual(officialEntryState(ABSENT_LOADER).present, false)
  assert.deepEqual(officialEntryState({ resolve: () => { throw new Error('gone') } }).present, false)
})

test('探测: 状态三字段映射(disabled 读宿主 getter,running 读 fiber uid)', () => {
  assert.equal(officialEntryState(loaderOf(entryOf())).disabled, false)
  assert.equal(officialEntryState(loaderOf(entryOf({ disabled: true }))).disabled, true)
  assert.equal(officialEntryState(loaderOf(entryOf({ running: true }))).running, true)
  assert.equal(officialEntryState(loaderOf(entryOf({ disabled: true, running: true }))).running, true)
})

test('探测: disabled getter 抛错(!!js 求值失败)按未禁用处理,决策让位安全向', () => {
  const state = officialEntryState(loaderOf(entryOf({ disabledThrows: true })))
  assert.equal(state.disabled, false)
  assert.equal(takeoverDecision(state), 'yield')
})

test('决策: getter 抛错时即使 options 显式 false 或 undefined,一律让位安全向', () => {
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf({ disabledThrows: true, rawDisabled: false })))), 'yield')
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf({ disabledThrows: true, rawDisabled: undefined })))), 'yield')
})

test('决策: 缺席或已禁用停稳 → 接管', () => {
  assert.equal(takeoverDecision(officialEntryState(ABSENT_LOADER)), 'takeover')
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf({ disabled: true })))), 'takeover')
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf({ disabled: true, rawDisabled: true })))), 'takeover')
})

test('决策: 默认启用(options.disabled undefined)→ runtime-disable(gateway 落定后运行时禁用接管)', () => {
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf()))), 'runtime-disable')
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf({ running: true })))), 'runtime-disable', 'boot 常态:官方先服务,gateway 落定后禁用接管')
})

test('决策: 用户显式启用(options.disabled false)→ 让位,永不强抢', () => {
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf({ rawDisabled: false })))), 'yield')
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf({ rawDisabled: false, running: true })))), 'yield')
})

test('决策: 禁用但插件仍在退场 → 等待退场', () => {
  assert.equal(takeoverDecision(officialEntryState(loaderOf(entryOf({ disabled: true, running: true })))), 'await-exit')
})

test('等待退场: 已退场立即返回 true', async () => {
  const polled = await awaitOfficialExit(entryOf(), { delay: async () => {} })
  assert.equal(polled, true)
})

test('等待退场: 轮询期间退场返回 true', async () => {
  const entry = entryOf({ running: true })
  let polls = 0
  const polled = await awaitOfficialExit(entry, {
    rounds: 5,
    delay: async () => {
      polls += 1
      if (polls === 2) entry.fiber = undefined
    },
  })
  assert.equal(polled, true)
})

test('等待退场: 轮询耗尽仍在场返回 false', async () => {
  const polled = await awaitOfficialExit(entryOf({ running: true }), { rounds: 3, delay: async () => {} })
  assert.equal(polled, false)
})

// 延迟补接管:await-exit 快速窗超时只是"决策推迟",官方行退场完成后必须补完
// 接管(复活守卫 + 官方 discovery/节),把接管从一次性决策补成最终一致。

// 真实定时器微延迟:供轮询循环退场后的收尾等待;空转延迟(noop)的循环必须
// 靠 cancel/清 fiber 退出,任何断言先失败都会挂死测试进程,收尾一律 try/finally
const tickDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('延迟接管: 官方退场后执行 complete 恰好一次', async () => {
  const entry = entryOf({ running: true })
  const logs = { warn: [] }
  const ctx = { logger: { warn: (m) => logs.warn.push(m) }, fiber: { uid: 1 } }
  let completed = 0
  let delayCalls = 0
  const cancel = armDeferredTakeover(ctx, entry, () => { completed += 1 }, {
    intervalMs: 1,
    delay: async () => { delayCalls += 1 },
  })
  try {
    assert.equal(completed, 0, '官方在场时不得提前接管')
    entry.fiber = undefined
    await tickDelay(10)
    assert.equal(completed, 1, '退场完成后必须补接管')
    assert.ok(delayCalls >= 2, '退场后必须补一拍收尾延迟再接管')
  } finally {
    cancel()
  }
})

test('延迟接管: gateway 先退场则放弃,complete 不执行', async () => {
  const entry = entryOf({ running: true })
  const ctx = { logger: { warn: () => {} }, fiber: { uid: 1 } }
  let completed = 0
  const cancel = armDeferredTakeover(ctx, entry, () => { completed += 1 }, { intervalMs: 1, delay: async () => {} })
  try {
    ctx.fiber = undefined
    entry.fiber = undefined
    await tickDelay(10)
    assert.equal(completed, 0, 'gateway 行已退场,补接管必须在死 context 前放弃')
  } finally {
    cancel()
  }
})

test('延迟接管: cancel 句柄生效,complete 不再执行', async () => {
  const entry = entryOf({ running: true })
  const ctx = { logger: { warn: () => {} }, fiber: { uid: 1 } }
  let completed = 0
  const cancel = armDeferredTakeover(ctx, entry, () => { completed += 1 }, { intervalMs: 1, delay: async () => {} })
  try {
    cancel()
    entry.fiber = undefined
    await tickDelay(10)
    assert.equal(completed, 0)
  } finally {
    cancel()
  }
})

test('延迟接管: complete 抛错只告警,不产生未处理拒绝', async () => {
  const entry = entryOf({ running: true })
  const logs = { warn: [] }
  const ctx = { logger: { warn: (m) => logs.warn.push(m) }, fiber: { uid: 1 } }
  const cancel = armDeferredTakeover(ctx, entry, () => { throw new Error('boom') }, { intervalMs: 1, delay: async () => {} })
  try {
    entry.fiber = undefined
    await tickDelay(10)
    assert.match(logs.warn.join('\n'), /延迟接管失败/)
  } finally {
    cancel()
  }
})

test('守卫: 以 global 监听注册 loader/patch-context', () => {
  const registered = []
  const ctx = { on: (name, callback, options) => registered.push({ name, callback, options }) }
  installOfficialRevivalGuard(ctx, () => true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'loader/patch-context')
  assert.equal(registered[0].options.global, true)
})

function guardFixture({ active = true, officialId = OFFICIAL_ENTRY_ID, running = false, disposed } = {}) {
  const logs = { warn: [] }
  const callbacks = []
  const ctx = {
    logger: { warn: (message) => logs.warn.push(message) },
    on: (name, callback) => callbacks.push(callback),
    fiber: { dispose: async () => { disposed.value = true } },
  }
  installOfficialRevivalGuard(ctx, () => active)
  return { callback: callbacks[0], logs, disposed }
}

test('守卫: 官方行无 fiber 将 init 且本包接管中 → 自停让位后放行', async () => {
  const disposed = { value: false }
  const { callback, logs } = guardFixture({ disposed })
  let released = false
  await callback({ options: { id: OFFICIAL_ENTRY_ID }, fiber: undefined }, async () => { released = true })
  assert.equal(disposed.value, true, '必须自停卸载本包注册')
  assert.equal(released, true, '放行不得中断,否则官方 init 永久挂起')
  assert.match(logs.warn.join('\n'), /自停让位/)
})

test('守卫: 非官方行 / 官方已运行 / 本包未接管 → 直接过', async () => {
  for (const { officialId, running, active } of [
    { officialId: 'other-entry', running: false, active: true },
    { officialId: OFFICIAL_ENTRY_ID, running: true, active: true },
    { officialId: OFFICIAL_ENTRY_ID, running: false, active: false },
  ]) {
    const disposed = { value: false }
    const { callback } = guardFixture({ active, disposed })
    let released = false
    await callback({ options: { id: officialId }, fiber: running ? { uid: 1 } : undefined }, async () => { released = true })
    assert.equal(disposed.value, false)
    assert.equal(released, true)
  }
})

test('守卫: 自停抛错仍放行(dispose 理论不抛,防御异常宿主状态)', async () => {
  const callbacks = []
  const ctx = {
    logger: { warn: () => {} },
    on: (name, callback) => callbacks.push(callback),
    fiber: { dispose: async () => { throw new Error('host on fire') } },
  }
  installOfficialRevivalGuard(ctx, () => true)
  let released = false
  await callbacks[0]({ options: { id: OFFICIAL_ENTRY_ID }, fiber: undefined }, async () => { released = true })
  assert.equal(released, true)
})

// apply 接线集成:官方 entry 状态决定接管/等待退场/让位三态的资源占用面。
// 宿主契约同 host-compat 桩:llm 注册记录、settings 安装记录、守卫注册记录。

import { apply } from '../src/index.js'
import { SETTINGS_NS, OFFICIAL_SETTINGS_NS } from '../src/config.mjs'

function integrationCtx({ officialEntry, officialDiscoveryPresent = false } = {}) {
  const logs = { warn: [], error: [] }
  const installed = []
  const discovery = []
  const guards = []
  const disposed = { value: false }
  const hooksByNs = {}
  const sectionValues = {}
  const discoveries = new Set()
  if (officialDiscoveryPresent) discoveries.add(OFFICIAL_SETTINGS_NS)
  const ctx = {
    logger: {
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message),
    },
    get: () => undefined,
    loader: officialEntry === undefined ? undefined : loaderOf(officialEntry),
    on: (name, callback, options) => guards.push({ name, callback, options }),
    // 真实 cordis 契约:活跃 fiber 带 uid,dispose 置 null(延迟补接管以此为退场判据)
    fiber: { uid: 7, dispose: async () => { disposed.value = true } },
    llm: {
      registerAdapter: () => ({ replace: () => {} }),
      registerConfigurableProviders: () => ({ replace: () => {} }),
      registerModelDiscovery: (ns) => {
        if (discoveries.has(ns)) throw new Error(`model discovery for "${ns}" is already registered`)
        discoveries.add(ns)
        discovery.push(ns)
      },
    },
    settings: {
      installSection: (target, ns, schema, config, hooks) => {
        // 真实排他性:官方 discovery 被占即官方插件在场,官方 settings 节同
        // ns 注册必同时冲突,两者一并模拟
        if (ns === OFFICIAL_SETTINGS_NS && officialDiscoveryPresent) {
          throw new Error(`settings namespace "${ns}" is already registered`)
        }
        installed.push(ns)
        hooksByNs[ns] = hooks
        hooks.setSource(() => sectionValues[ns] ?? config)
      },
    },
  }
  return { ctx, logs, installed, discovery, guards, disposed, hooksByNs, sectionValues }
}

const OFFICIAL_STUB = async () => ({ Config: {} })

// runtime-disable 异步序列的等待锚点:序列挂在 apply 返回后的微任务链上,
// 轮询/退场等待经注入参数收敛为即时完成
const runtimeDisableOptions = { exitPoll: { intervalMs: 1, rounds: 3 }, deferredExit: { intervalMs: 1, delay: async () => {} } }
const flushDisableSequence = () => new Promise((resolve) => setTimeout(resolve, 20))

test('接线: 官方行默认启用(options undefined)→ apply 落定后 runtime-disable 官方行并补接管', async () => {
  const updateLog = []
  const entry = entryOf({ running: true, updateLog })
  const { ctx, installed, discovery, guards } = integrationCtx({ officialEntry: entry })
  await apply(ctx, undefined, OFFICIAL_STUB, runtimeDisableOptions)
  // apply 落定期:官方资源零占用(接管未完成)
  assert.deepEqual(installed, [SETTINGS_NS], 'apply 返回时官方节尚未接管')
  assert.deepEqual(discovery, [SETTINGS_NS], '官方 ns 在官方退场前不得抢占')
  assert.equal(guards.length, 0, '守卫在接管完成序列中安装')
  await flushDisableSequence()
  assert.deepEqual(updateLog, [{ patch: { disabled: true }, quiet: false, force: true }], 'market 同款运行时禁用调用')
  assert.deepEqual(installed, [SETTINGS_NS, OFFICIAL_SETTINGS_NS], '官方退场后补接管官方节')
  assert.deepEqual(discovery, [SETTINGS_NS, OFFICIAL_SETTINGS_NS], '官方 ns discovery 补注册')
  assert.equal(guards.length, 1, '接管完成后复活守卫在位')
})

test('接线: 官方行显式启用(options false)→ 让位态,不调用 update,settings/discovery 均不占用官方资源', async () => {
  const updateLog = []
  const entry = entryOf({ running: true, rawDisabled: false, updateLog })
  const { ctx, logs, installed, discovery, guards } = integrationCtx({ officialEntry: entry })
  await apply(ctx, undefined, OFFICIAL_STUB, runtimeDisableOptions)
  await flushDisableSequence()
  assert.match(logs.warn.join('\n'), /显式启用/)
  assert.deepEqual(updateLog, [], '用户意图最高,永不强抢')
  assert.deepEqual(installed, [SETTINGS_NS])
  assert.deepEqual(discovery, [SETTINGS_NS], '官方 ns 必须留给官方插件注册')
  assert.equal(guards.length, 0, '让位态无需复活守卫')
})

test('接线: runtime-disable update 抛错 → 降级让官方继续服务,不接管', async () => {
  const entry = entryOf({ running: true })
  entry.update = async () => { throw new Error('host update rejected') }
  const { ctx, logs, installed, discovery, guards } = integrationCtx({ officialEntry: entry })
  await apply(ctx, undefined, OFFICIAL_STUB, runtimeDisableOptions)
  await flushDisableSequence()
  assert.match(logs.warn.join('\n'), /运行时禁用失败/)
  assert.deepEqual(installed, [SETTINGS_NS])
  assert.deepEqual(discovery, [SETTINGS_NS])
  assert.equal(guards.length, 0)
})

test('接线: 官方行禁用且停稳 → 接管态,装守卫并安装官方节', async () => {
  const { ctx, installed, discovery, guards } = integrationCtx({ officialEntry: entryOf({ disabled: true }) })
  await apply(ctx, undefined, OFFICIAL_STUB)
  assert.deepEqual(installed, [OFFICIAL_SETTINGS_NS, SETTINGS_NS])
  assert.deepEqual(discovery, [SETTINGS_NS, OFFICIAL_SETTINGS_NS])
  assert.equal(guards.length, 1)
  assert.equal(guards[0].options.global, true)
})

test('接线: 官方行禁用但仍在退场 → 等待退场后接管', async () => {
  const entry = entryOf({ disabled: true, running: true })
  setTimeout(() => { entry.fiber = undefined }, 5)
  const { ctx, logs, installed } = integrationCtx({ officialEntry: entry })
  await apply(ctx, undefined, OFFICIAL_STUB)
  assert.match(logs.warn.join('\n'), /退场中.*等待/)
  assert.deepEqual(installed, [OFFICIAL_SETTINGS_NS, SETTINGS_NS], '退场完成后必须接管官方节')
})

test('接线: 官方行禁用但退场超时(runtime-disable 后在途流)→ 降级为只服务本包节,武装延迟补接管', async () => {
  const updateLog = []
  const entry = entryOf({ running: true, updateLog, exitOnDisable: false })
  const { ctx, logs, installed, discovery } = integrationCtx({ officialEntry: entry })
  try {
    await apply(ctx, undefined, OFFICIAL_STUB, { exitPoll: { intervalMs: 1, rounds: 1 }, deferredExit: { intervalMs: 2, delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } })
    await flushDisableSequence()
    assert.deepEqual(updateLog, [{ patch: { disabled: true }, quiet: false, force: true }])
    assert.match(logs.warn.join('\n'), /退场超时/)
    assert.deepEqual(installed, [SETTINGS_NS])
    assert.deepEqual(discovery, [SETTINGS_NS])
  } finally {
    // 释放轮询循环,断言先失败也不得挂死测试进程
    entry.fiber = undefined
    await tickDelay(5)
  }
})

test('接线: loader 缺失(官方行缺席)→ 接管态,行为与官方包缺失路径一致', async () => {
  const { ctx, installed, discovery, guards } = integrationCtx()
  await apply(ctx, undefined, OFFICIAL_STUB)
  assert.deepEqual(installed, [OFFICIAL_SETTINGS_NS, SETTINGS_NS])
  assert.deepEqual(discovery, [SETTINGS_NS, OFFICIAL_SETTINGS_NS])
  assert.equal(guards.length, 1)
})

test('接线: 接管态官方节安装成功后,官方行复活预兆触发守卫自停让位', async () => {
  const { ctx, guards, disposed } = integrationCtx({ officialEntry: entryOf({ disabled: true }) })
  await apply(ctx, undefined, OFFICIAL_STUB)
  let released = false
  await guards[0].callback({ options: { id: OFFICIAL_ENTRY_ID }, fiber: undefined }, async () => { released = true })
  assert.equal(disposed.value, true, '让位必须完全卸载本包注册,官方 apply 才能无冲突')
  assert.equal(released, true)
})

test('接线: 官方 discovery 已被占(接管冲突降级,未持有官方注册)守卫不自停', async () => {
  const { ctx, guards, disposed } = integrationCtx({ officialEntry: entryOf({ disabled: true }), officialDiscoveryPresent: true })
  await apply(ctx, undefined, OFFICIAL_STUB)
  let released = false
  await guards[0].callback({ options: { id: OFFICIAL_ENTRY_ID }, fiber: undefined }, async () => { released = true })
  assert.equal(disposed.value, false, '未持有任何官方注册时官方复活与本包无冲突,不得自停')
  assert.equal(released, true)
})

test('接线: 仅持有官方 discovery(settings 节安装失败)官方复活仍触发守卫自停', async () => {
  const { ctx, guards, disposed } = integrationCtx({ officialEntry: entryOf({ disabled: true }) })
  ctx.settings.installSection = (target, ns, schema, config, hooks) => {
    if (ns === OFFICIAL_SETTINGS_NS) throw new Error(`settings namespace "${ns}" is already registered`)
    hooks.setSource(() => config)
  }
  await apply(ctx, undefined, OFFICIAL_STUB)
  let released = false
  await guards[0].callback({ options: { id: OFFICIAL_ENTRY_ID }, fiber: undefined }, async () => { released = true })
  assert.equal(disposed.value, true, '官方 discovery 在本包手中,官方复活必撞注册,必须让位')
  assert.equal(released, true)
})

test('接线: 官方包缺失 + loader 缺失(双缺席)守卫在位,官方补注册后复活仍让位', async () => {
  const { ctx, guards, disposed } = integrationCtx()
  await apply(ctx, undefined, async () => ({}))
  let released = false
  await guards[0].callback({ options: { id: OFFICIAL_ENTRY_ID }, fiber: undefined }, async () => { released = true })
  assert.equal(disposed.value, true, '官方 ns 补注册在本包手中,复活守卫必须生效')
  assert.equal(released, true)
})

test('接线: 退场超时先降级服务本包节,官方退场后自动补接管(守卫+discovery+节+路由重算)', async () => {
  const entry = entryOf({ disabled: true, running: true })
  const { ctx, logs, installed, discovery, guards, hooksByNs } = integrationCtx({ officialEntry: entry })
  const pollOptions = { exitPoll: { intervalMs: 1, rounds: 1 }, deferredExit: { intervalMs: 1, delay: async () => {} } }
  try {
    await apply(ctx, undefined, OFFICIAL_STUB, pollOptions)
    assert.match(logs.warn.join('\n'), /退场超时/)
    assert.deepEqual(installed, [SETTINGS_NS], '超时窗口只服务本包节')
    assert.deepEqual(discovery, [SETTINGS_NS])
    assert.equal(guards.length, 0, '补接管前未持有官方注册,不装复活守卫')
    // 官方行退场完成
    entry.fiber = undefined
    await tickDelay(30)
    assert.deepEqual(installed, [SETTINGS_NS, OFFICIAL_SETTINGS_NS], '退场后必须补装官方节')
    assert.deepEqual(discovery, [SETTINGS_NS, OFFICIAL_SETTINGS_NS], '退场后必须补注册官方 discovery')
    assert.equal(guards.length, 1, '补接管完成即持有官方注册,复活守卫必须在位')
    assert.equal(typeof hooksByNs[OFFICIAL_SETTINGS_NS].onChange, 'function')
  } finally {
    entry.fiber = undefined
    await tickDelay(5)
  }
})

test('接线: 退场超时后 gateway 先退场,官方退场不补接管(死 context 放弃)', async () => {
  const entry = entryOf({ disabled: true, running: true })
  const { ctx, logs, installed, discovery } = integrationCtx({ officialEntry: entry })
  const pollOptions = { exitPoll: { intervalMs: 1, rounds: 1 }, deferredExit: { intervalMs: 1, delay: async () => {} } }
  try {
    await apply(ctx, undefined, OFFICIAL_STUB, pollOptions)
    assert.match(logs.warn.join('\n'), /退场超时/)
    ctx.fiber = { uid: null, dispose: async () => {} }
    entry.fiber = undefined
    await tickDelay(30)
    assert.deepEqual(installed, [SETTINGS_NS], 'gateway 已退场,不得在死 context 上补装官方节')
    assert.deepEqual(discovery, [SETTINGS_NS])
  } finally {
    entry.fiber = undefined
    await tickDelay(5)
  }
})

test('接线: 官方包加载挂起超时 → 降级只服务本包节,apply 不被拖死', async () => {
  const { ctx, logs, installed, discovery } = integrationCtx({ officialEntry: entryOf({ disabled: true }) })
  const never = () => new Promise(() => {})
  const start = Date.now()
  await apply(ctx, undefined, never, { loadTimeoutMs: 15 })
  assert.ok(Date.now() - start < 5000, 'apply 在护栏上界附近返回而非无限等待')
  assert.match(logs.warn.join('\n'), /官方 dsh-llm-pi-ai 不可用/)
  assert.deepEqual(installed, [SETTINGS_NS], '官方节不接管')
  // 官方 discovery 双 ns 注册为既有语义(不依赖官方包 Config),同 host-compat 用例
  assert.deepEqual(discovery, [SETTINGS_NS, OFFICIAL_SETTINGS_NS])
})
