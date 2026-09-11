// guard 哨兵行 BDD:死态(gateway 行功能性停摆:行被禁停稳,或行活着但
// apply 因宿主能力缺失干净早退;且官方行仍被 bundle patch 禁用停稳)时
// 动态代挂官方插件恢复服务;gateway 行复活时先卸代挂再放行,零冲突交接。
// 背景:dsh-market 对 carrier 包的禁用写即时生效的 user patch 行,而其恢复
// 机制(整包移出 bundles)只在下次 boot 生效,窗口内 composed = 官方禁 +
// gateway 停 = 全模型不可用;旧宿主(rc.2)上 gateway 行恒为假活形态。
// guard 行 id 带 "/" 使 market 的行写入拒绝,窗口内始终存活,是死态唯一的
// 自愈执行者。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GUARD_FOR_GATEWAY_ID, detectDeadState, installGuard } from '../src/guard.js'
import { OFFICIAL_ENTRY_ID } from '../src/takeover.mjs'
import { beginGatewayApply, endGatewayApplyActive, endGatewayApplyInactive } from '../src/apply-state.mjs'

const OFFICIAL_STUB = { name: 'dsh-llm-pi-ai', apply() {}, Config: undefined }

function entryOf({ id, disabled = false, running = false } = {}) {
  return {
    options: { id, ...(disabled ? { disabled: true } : {}) },
    get disabled() { return this.options.disabled === true },
    fiber: running ? { uid: 1 } : undefined,
  }
}

function loaderOf({ gateway, official } = {}) {
  return {
    resolve: (id) => {
      if (id === 'llm-pi-gateway' && gateway !== undefined) return gateway
      if (id === OFFICIAL_ENTRY_ID && official !== undefined) return official
      throw new Error(`cannot resolve entry ${id}`)
    },
  }
}

function ctxFixture({ loader, officialModule = OFFICIAL_STUB } = {}) {
  const state = { plugged: 0, unplugged: 0, logs: { warn: [], error: [] } }
  const callbacks = []
  let mountedFiber = null
  const ctx = {
    loader,
    // 注入 API:服务已就绪形态,回调同步执行并携带 settings 服务面
    inject: (names, callback) => { if (names.includes('settings')) callback({ settings: { get: (ns) => (ns === 'llm-pi-ai' ? { providers: {} } : undefined) } }) },
    logger: {
      warn: (message) => state.logs.warn.push(message),
      error: (message) => state.logs.error.push(message),
    },
    on: (name, callback, options) => callbacks.push({ name, callback, options }),
    plugin: (module, config) => {
      state.plugged += 1
      state.lastMountConfig = config
      mountedFiber = {
        disposed: false,
        async dispose() {
          if (mountedFiber === null) throw new Error('no mount')
          state.unplugged += 1
          mountedFiber.disposed = true
          mountedFiber = null
        },
      }
      return mountedFiber
    },
  }
  const mountImport = async () => {
    if (officialModule === null) throw new Error('official package missing')
    return officialModule
  }
  return { ctx, state, callbacks, mountImport, currentMount: () => mountedFiber }
}

// installGuard 的树就绪等待在测试注入 noop delay,避免真实 5s 上限
const NO_DELAY = async () => {}

test('死态判定: gateway 行禁用停稳且官方行禁用停稳 → 死态', () => {
  assert.equal(detectDeadState(loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })), true)
})

test('死态判定: 行缺席 = PENDING(不可判),交由等待与轮询重试', () => {
  assert.equal(detectDeadState(loaderOf({ official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })), null, 'gateway 行缺席不可判:boot 时序(未入树)与真移除不可区分')
  assert.equal(detectDeadState(loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }) })), null, '官方行缺席同上')
})

test('行 id 解析: include: 前缀命名空间(rc.1/rc.2 宿主形态)可判定', () => {
  const loader = {
    resolve: (id) => {
      if (id === 'include:llm-pi-gateway') return entryOf({ id: 'llm-pi-gateway', disabled: true })
      if (id === 'include:llm-pi-ai') return entryOf({ id: 'llm-pi-ai', disabled: true })
      throw new Error(`cannot resolve entry ${id}`)
    },
  }
  assert.equal(detectDeadState(loader), true)
})

test('死态判定: gateway 行活着但 apply 声明未接管(rc.2 假活)→ 死态', () => {
  const loader = loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway' }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })
  beginGatewayApply()
  assert.equal(detectDeadState(loader), false, 'apply 运行中旗标未定 = 保守不代挂,防与在途注册冲突')
  endGatewayApplyActive()
  assert.equal(detectDeadState(loader), false, '有效接管 = 非死态')
  beginGatewayApply()
  endGatewayApplyInactive()
  assert.equal(detectDeadState(loader), true, '干净早退 = 功能性死态,guard 代挂官方恢复服务')
  beginGatewayApply()
})

test('死态判定: 接管态(gateway 启)/官方启用态/官方退场中/官方已在跑 → 非死态', () => {
  const base = { official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) }
  assert.equal(detectDeadState(loaderOf({ ...base, gateway: entryOf({ id: 'llm-pi-gateway' }) })), false)
  assert.equal(detectDeadState(loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway' }), official: entryOf({ id: OFFICIAL_ENTRY_ID }) })), false, '官方行未禁归官方服务')
  assert.equal(detectDeadState(loaderOf({ base, gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true, running: true }) })), false, '官方仍退场中,等它死透再判')
})

test('apply: 死态下代挂官方模块并等待其激活', async () => {
  const { ctx, state } = ctxFixture({ loader: loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) }) })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  assert.equal(state.plugged, 1)
})

test('apply: 非死态(正常接管)不代挂,仅装复活监听', async () => {
  const { ctx, state, callbacks } = ctxFixture({ loader: loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway' }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) }) })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  assert.equal(state.plugged, 0)
  assert.equal(callbacks.filter(cb => cb.name === 'loader/patch-context').length, 1)
  assert.equal(callbacks.filter(cb => cb.name === 'loader/partial-dispose').length, 1)
  assert.equal(callbacks.every(cb => cb.options.global === true), true, '监听必须 global,gateway 行事件才能到达 guard')
})

test('apply: 官方包缺失 → 干净禁用,不装任何监听', async () => {
  const { ctx, state, callbacks } = ctxFixture({ loader: loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) }), officialModule: null })
  await installGuard(ctx, { importOfficial: async () => { throw new Error('missing') } })
  assert.equal(state.plugged, 0)
  assert.equal(callbacks.length, 0)
  assert.match(state.logs.warn.join('\n'), /官方/)
})

test('复活让位: gateway 行将 init 且正代挂 → 先卸代挂再放行', async () => {
  const { ctx, callbacks, currentMount, state } = ctxFixture({ loader: loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) }) })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  assert.equal(state.plugged, 1)
  let released = false
  await callbacks.find(cb => cb.name === 'loader/patch-context').callback(
    { options: { id: 'llm-pi-gateway' }, fiber: undefined },
    async () => { released = true },
  )
  assert.equal(currentMount(), null, '放行前代挂必须完全卸载,gateway apply 才无冲突')
  assert.equal(state.unplugged, 1, '卸载成功而非仅清引用')
  assert.equal(released, true)
})

test('禁用感知: partial-dispose 到官方行(手动禁官方铸成死态)→ 自愈代挂', async () => {
  const loader = loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID }) })
  const { ctx, callbacks, state } = ctxFixture({ loader })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  assert.equal(state.plugged, 0, '初始:官方行未禁由官方服务,guard 空转')
  // 用户随后手动禁官方行并退场落定(宿主形态:退场事件发射时 fiber 已
  // void)→ gateway 禁 + 官方禁 = 死态铸成
  const official = loader.resolve(OFFICIAL_ENTRY_ID)
  official.options.disabled = true
  const disposeEvent = callbacks.find(cb => cb.name === 'loader/partial-dispose').callback
  await disposeEvent(official, undefined, true)
  assert.equal(state.plugged, 1, '官方行退场落定后死态成立,自愈代挂')
})

test('禁用感知: fiber 在场的 partial-dispose(配置更新路径)→ 快速返回不轮询', async () => {
  const loader = loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway' }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })
  const { ctx, callbacks, state } = ctxFixture({ loader })
  let delayCalls = 0
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: async () => { delayCalls += 1 } })
  const gateway = loader.resolve('llm-pi-gateway')
  gateway.fiber = { uid: 5 }
  const disposeEvent = callbacks.find(cb => cb.name === 'loader/partial-dispose').callback
  await disposeEvent(gateway, undefined, true)
  assert.equal(delayCalls, 0, '在场事件非退场,不得空转轮询')
  assert.equal(state.plugged, 0)
})

test('复活让位: 非目标行 / gateway 已运行 / 未代挂 → 直接过', async () => {
  const { ctx, callbacks, state } = ctxFixture({ loader: loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) }) })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  const guard = callbacks.find(cb => cb.name === 'loader/patch-context').callback
  for (const [entry, expectedPlugged] of [
    [{ options: { id: 'other' }, fiber: undefined }, 1],
    [{ options: { id: 'llm-pi-gateway' }, fiber: { uid: 1 } }, 1],
  ]) {
    let released = false
    await guard(entry, async () => { released = true })
    assert.equal(released, true)
    assert.equal(state.plugged, expectedPlugged)
  }
})

test('禁用感知: partial-dispose 到 gateway 行且行已禁 → 等注册撤清后代挂', async () => {
  const loader = loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway' }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })
  const { ctx, callbacks, state } = ctxFixture({ loader })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  assert.equal(state.plugged, 0, 'apply 时 gateway 行活着,非死态')
  const gateway = loader.resolve('llm-pi-gateway')
  gateway.fiber = { uid: 2 }
  gateway.options.disabled = true
  const disposeEvent = callbacks.find(cb => cb.name === 'loader/partial-dispose').callback
  await disposeEvent(gateway, undefined, true)
  assert.equal(state.plugged, 0, 'fiber 未撤清前不得代挂,防注册冲突')
  gateway.fiber = undefined
  await disposeEvent(gateway, undefined, true)
  assert.equal(state.plugged, 1)
})

test('禁用感知: partial-dispose 到非 gateway 行 → 忽略', async () => {
  const loader = loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway' }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })
  const { ctx, callbacks, state } = ctxFixture({ loader })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  const disposeEvent = callbacks.find(cb => cb.name === 'loader/partial-dispose').callback
  const gateway = loader.resolve('llm-pi-gateway')
  gateway.options.disabled = true
  gateway.fiber = undefined
  await disposeEvent(entryOf({ id: 'other', disabled: true }), undefined, true)
  assert.equal(state.plugged, 0, 'gateway 行自己的退场事件才触发死态复判')
})

test('代挂幂等: 重复触发死态不重复挂载', async () => {
  const loader = loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })
  const { ctx, callbacks, state } = ctxFixture({ loader })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  const disposeEvent = callbacks.find(cb => cb.name === 'loader/partial-dispose').callback
  await disposeEvent(loader.resolve('llm-pi-gateway'), undefined, true)
  await disposeEvent(loader.resolve('llm-pi-gateway'), undefined, true)
  assert.equal(state.plugged, 1)
})

test('兼容剥离: 首挂因 compat 键被拒 → 剥键重挂通过,行配置随之收敛', async () => {
  const loader = loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })
  const { ctx, state, callbacks } = ctxFixture({ loader })
  const REFUSED = 'llm-pi-ai: provider "p" model "m" sets compat "chatTemplateArgs", which no wire protocol declares'
  const SECTION = { providers: { p: { models: [{ compat: { chatTemplateArgs: {}, chatTemplateKwargs: {} } }] } } }
  let attempts = 0
  const mountConfigs = []
  ctx.plugin = (module, config) => {
    attempts += 1
    mountConfigs.push(config)
    state.plugged += 1
    if (attempts === 1) {
      return { dispose: async () => {}, then: (_ok, fail) => fail(new Error(REFUSED)) }
    }
    return { dispose: async () => {} }
  }
  await installGuard(ctx, {
    importOfficial: async () => OFFICIAL_STUB,
    rowConfig: async () => SECTION,
    delay: NO_DELAY,
  })
  // 首挂被拒后,经事件通道(等效 sweep)再次触发死态复判 → 剥键重挂
  const disposeEvent = callbacks.find(cb => cb.name === 'loader/partial-dispose').callback
  await disposeEvent(loader.resolve('llm-pi-gateway'), undefined, true)
  assert.ok(attempts >= 2, '首挂被拒后必须重试')
  const last = mountConfigs[mountConfigs.length - 1]
  assert.notEqual(last, SECTION, '剥键必须作用在副本上')
  assert.equal(last.providers.p.models[0].compat.chatTemplateArgs, undefined, '被拒键剥离')
  assert.equal(JSON.stringify(last.providers.p.models[0].compat.chatTemplateKwargs), '{}', '未被拒键保留')
})

test('导出: guard 行 id 含 "/"(market 行写入对其拒绝,窗口内不被禁)', () => {
  assert.match(GUARD_FOR_GATEWAY_ID, /\//)
  assert.equal(GUARD_FOR_GATEWAY_ID.startsWith('llm-pi-gateway'), true, '与主行同源前缀,便于排查')
})

test('让位: 官方行复活(两行交还路径)且正代挂 → 先卸代挂再放行', async () => {
  const { ctx, callbacks, currentMount, state } = ctxFixture({ loader: loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) }) })
  await installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  assert.equal(state.plugged, 1, '前置:死态已代挂')
  let released = false
  await callbacks.find(cb => cb.name === 'loader/patch-context').callback(
    { options: { id: OFFICIAL_ENTRY_ID }, fiber: undefined },
    async () => { released = true },
  )
  assert.equal(currentMount(), null, '官方原生复活前代挂必须撤清,否则撞排他注册拖垮整批')
  assert.equal(released, true)
})

test('让位: 在途代挂(mounting)未完成时复活 → 等待落定后卸载再放行', async () => {
  // 初始死态触发代挂,但代挂的激活(thenable 未落定)被 gate 拖住;
  // 此刻 gateway 行复活事件到达,让位必须等代挂落定并卸载后才放行
  const loader = loaderOf({ gateway: entryOf({ id: 'llm-pi-gateway', disabled: true }), official: entryOf({ id: OFFICIAL_ENTRY_ID, disabled: true }) })
  const state = { plugged: 0, unplugged: 0, logs: { warn: [], error: [] } }
  const callbacks = []
  let mountedFiber = null
  let releaseMount = () => {}
  const mountGate = new Promise((resolve) => { releaseMount = resolve })
  const ctx = {
    loader,
    // 注入 API:服务已就绪形态,回调同步执行并携带 settings 服务面
    inject: (names, callback) => { if (names.includes('settings')) callback({ settings: { get: () => ({ providers: {} }) } }) },
    logger: {
      warn: (message) => state.logs.warn.push(message),
      error: (message) => state.logs.error.push(message),
    },
    on: (name, callback, options) => callbacks.push({ name, callback, options }),
    plugin: () => {
      state.plugged += 1
      mountedFiber = {
        then: (onFulfilled, onRejected) => mountGate.then(onFulfilled, onRejected),
        async dispose() {
          state.unplugged += 1
          mountedFiber = null
        },
      }
      return mountedFiber
    },
  }
  const installing = installGuard(ctx, { importOfficial: async () => OFFICIAL_STUB, delay: NO_DELAY })
  for (let tick = 0; (callbacks.length < 2 || state.plugged < 1) && tick < 100; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(callbacks.length, 2, '监听先于初始代挂判定注册')
  assert.equal(state.plugged, 1, '初始死态已触发代挂,激活在途')
  let released = false
  const guard = callbacks.find(cb => cb.name === 'loader/patch-context').callback
  const yielding = guard({ options: { id: 'llm-pi-gateway' }, fiber: undefined }, async () => { released = true })
  let settleCheck = false
  yielding.then(() => { settleCheck = true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(settleCheck, false, '在途代挂未落定前放行不得完成')
  releaseMount()
  await Promise.all([installing, yielding])
  assert.equal(state.unplugged, 1, '让位 = 落定后卸载')
  assert.equal(released, true)
})
