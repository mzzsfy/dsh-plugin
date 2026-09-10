// client 注入契约 BDD:inject 按宿主代际二选一——0.1.2+(带 __DSH_BOOT__
// wire)点分声明 remote.settings 由 cordis 门控等挂载,0.1.1(无 wire)声明
// 两代基座 remote+connection,settings 传输在 apply 内按面形状异步轮询——
// 0.1.2+ 的 remote.settings 直返 RemoteResult 信封,0.1.1 的 connection.api
// 走 HTTP 面({rpcId,result} 信封);面形状由 makeSettingsFace 判定,缺失面
// 降级只读呈现,不阻塞 fiber。
// require 桩采用宿主语义:未知模块名 throw(宿主 client-modules 对种子表外
// 键直接抛错),使顶层硬依赖与可选消费的降级路径都被真实执行。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 宿主种子表桩:react / react-dom/client 为一级键(dsh-web-frontend 种子表同形);
// extra 模拟可选依赖(@mzzsfy/dsh-toast/client)在/不在表中的两种宿主形态
const SEED = {
  react: {
    useState: () => [null, () => {}],
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    memo: (component) => component,
  },
  'react-dom/client': { createRoot: () => ({ render() {}, unmount() {} }) },
}
function requireOf(extra = {}) {
  const table = { ...SEED, ...extra }
  return (name) => {
    const mod = table[name]
    if (mod === undefined) throw new Error('client-modules: require("' + name + '") missed the module table')
    return mod
  }
}

// client.js 顶层即引用 window(client-modules 自注册格式),node 侧先补桩;
// 模块只导入一次,factory 捕获后跨用例复用(重复 import 走缓存不再触发 load)
let factoryPromise = null
function loadFactory() {
  globalThis.window ??= {}
  if (factoryPromise === null) {
    const loader = { factory: null }
    globalThis.window.__ModuleLoader__ = { load: (spec) => { loader.factory = spec.factory } }
    factoryPromise = import('../src/client.js').then(() => loader.factory)
  }
  return factoryPromise
}

// apply 的定面轮询(settle→scheduleScan)会在测试结束后的一拍触达 document;
// 桩 querySelector 恒 null,扫描回调即静默返回,异步尾巴不抛错
globalThis.document ??= { querySelector: () => null, getElementById: () => null }
// applyTracked 真实执行 effect fn(其中 new MutationObserver),桩不派发变更
globalThis.MutationObserver ??= class { observe() {} disconnect() {} }

// cordis effect 语义:注册即执行,返回的 disposer 由宿主持有;测试以
// applyTracked 持有 disposer,用例结束前统一清算,停掉面轮询的定时器链。
// 在原对象上临时替换 effect(禁止 spread):spread 会把 getter 展开成
// 数据属性,面读取计数桩(getter)从此对 apply 内不可见,断言恒真失效
function applyTracked(entry, ctx) {
  const disposers = []
  const userEffect = ctx.effect
  ctx.effect = (fn, name) => {
    if (userEffect !== undefined) userEffect(fn, name)
    disposers.push(fn())
    return name
  }
  try { entry.apply(ctx) } finally {
    if (userEffect === undefined) delete ctx.effect
    else ctx.effect = userEffect
  }
  return () => { for (const dispose of disposers) dispose() }
}

// apply 期面已就绪路径走 batches wire 快取;0.1.1 路径走 facePoll。测试环境
// 无 __DSH_BOOT__,默认全走 0.1.1 分支;带 wire 场景由 wire 测试覆盖
// 0.1.2+ wire 判据 = batches 批次调度字段(0.1.1 wire 无)
const BOOT_WIRE = { rev: 'test', batches: [] }
function withBootWire(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis.window, '__DSH_BOOT__')
  const previous = globalThis.window.__DSH_BOOT__
  if (value === undefined) delete globalThis.window.__DSH_BOOT__
  else globalThis.window.__DSH_BOOT__ = value
  try { return fn() } finally {
    if (had) globalThis.window.__DSH_BOOT__ = previous
    else delete globalThis.window.__DSH_BOOT__
  }
}

test('注入契约:0.1.2+(wire.batches)点分声明 remote.settings,0.1.1 声明基座', async () => {
  const factory = await loadFactory()
  withBootWire(BOOT_WIRE, () => {
    const entry = factory(requireOf())
    assert.deepEqual(entry.inject, ['remote', 'remote.settings'])
  })
  withBootWire(undefined, () => {
    const entry = factory(requireOf())
    assert.deepEqual(entry.inject, ['remote', 'connection'])
  })
})

test('面选择:0.1.1 形态(无 wire)typed 缺失走 connection.api 面', async () => {
  const factory = await loadFactory()
  withBootWire(undefined, () => {
    const effects = []
    const dispose = applyTracked(factory(requireOf()), {
      remote: {},
      connection: { api: { settings: { describe() {}, mutate() {} } } },
      effect: (fn, name) => effects.push(name),
    })
    assert.deepEqual(effects, ['model-capability-editor: models-page injector'])
    dispose()
  })
})

test('面选择:0.1.2+(wire)typed 面挂载完成,apply 期直接消费', async () => {
  const factory = await loadFactory()
  withBootWire(BOOT_WIRE, () => {
    const effects = []
    const dispose = applyTracked(factory(requireOf()), {
      remote: { settings: { describe() {}, mutate() {} } },
      connection: null,
      effect: (fn, name) => effects.push(name),
    })
    assert.deepEqual(effects, ['model-capability-editor: models-page injector'])
    dispose()
  })
})

test('定面轮询:0.1.1 直接走 api 面定面成功;面缺失满窗恒定禁用并停轮询', async (t) => {
  const factory = await loadFactory()
  // mock 定时器:轮询/扫描链与 Date.now() 全部确定性推进,不真等超时窗口。
  // settings 面经 connection.api 属性读取,以 getter 计数锁定"读了多少拍":
  // 首拍定面 ⇒ 计数 1 且不再增长;恒定禁用 ⇒ 计数随窗口耗尽停止
  const trackedConnection = (settingsFace) => ({
    get connection() {
      this.reads = (this.reads ?? 0) + 1
      return { api: { settings: settingsFace } }
    },
  })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  withBootWire(undefined, () => {
    // 场景一(0.1.1 主干路径):api 面可定面 → 首拍定型,零告警,不再读
    const warnOk = t.mock.method(console, 'warn', () => {})
    const okConn = trackedConnection({ describe() {}, mutate() {} })
    const disposeOk = applyTracked(factory(requireOf()), okConn)
    assert.equal(okConn.reads, 1, 'api 面必须首拍定面')
    t.mock.timers.tick(1000 + 50)
    assert.equal(okConn.reads, 1, '定面后不得继续轮询')
    assert.equal(warnOk.mock.callCount(), 0, 'api 面可定面时不得有降级告警')
    disposeOk()
    warnOk.mock.restore()
    // 场景二(两代皆无):窗口耗尽 → 恒定禁用告警,轮询终止(计数停止增长)
    t.mock.timers.reset()
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const warns = []
    const warnNone = t.mock.method(console, 'warn', (text) => warns.push(text))
    const noneConn = trackedConnection(undefined)
    const disposeNone = applyTracked(factory(requireOf()), noneConn)
    t.mock.timers.tick(1000 + 50)
    assert.ok(
      warns.some((text) => text.includes('settings RPC 面不可用')),
      '两代面皆缺必须留下禁用告警',
    )
    const readsAtExhaust = noneConn.reads
    t.mock.timers.tick(1000 + 50)
    disposeNone()
    assert.equal(noneConn.reads, readsAtExhaust, '恒定禁用后轮询必须终止')
    assert.equal(warns.length, 1, '禁用告警必须只出现一次')
  })
})

test('禁用分支清偿:client.js 不再含面缺失探测告警', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(!source.includes('缺少 remote.settings'), '残留面缺失探测告警分支')
})

test('顶层硬依赖:种子表缺 react-dom/client 时 factory 抛错,不静默降级', async () => {
  const factory = await loadFactory()
  // spread 后显式置 undefined 模拟该键不在种子表
  assert.throws(
    () => factory(requireOf({ 'react-dom/client': undefined })),
    /react-dom\/client/,
    '缺 react-dom/client 必须显式抛错',
  )
})

test('顶层硬依赖:种子表缺 react 时 factory 抛错(第一个顶层 require)', async () => {
  const factory = await loadFactory()
  assert.throws(
    () => factory(requireOf({ react: undefined })),
    /require\("react"\)/,
    '缺 react 必须显式抛错',
  )
})

test('toast 可选消费:模块表有 toast 走 show,缺失降级 console.warn', async () => {
  const factory = await loadFactory()
  // 源码契约:factory 顶层对 toast 用 try/catch 可选消费,catch 后 notify 降级 console
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  assert.ok(/try \{\s*\n\s*toast = require\('@mzzsfy\/dsh-toast\/client'\)\.show\s*\n\s*\} catch \{/.test(source), 'toast 必须经 try/catch 可选消费')
  assert.ok(source.includes("console.warn('[dsh-model-capability-editor] ' + text)"), '降级分支必须走 console.warn')
  // 两种宿主形态下 factory 均不抛(降级在 notify 调用时发生,不在装载期)
  const withToast = factory(requireOf({ '@mzzsfy/dsh-toast/client': { show: () => {} } }))
  const withoutToast = factory(requireOf())
  assert.equal(typeof withToast.apply, 'function')
  assert.equal(typeof withoutToast.apply, 'function')
})

test('apply 注册注入 effect:两代路径均成立', async () => {
  const effects = []
  const factory = await loadFactory()
  const entry = factory(requireOf())
  withBootWire(undefined, () => {
    // 0.1.1:typed 面在场也不被消费(版本排他,轮询只读 connection)
    let typedReads = 0
    const remote = {}
    Object.defineProperty(remote, 'settings', { get() { typedReads += 1; return { describe() {}, mutate() {} } } })
    const disposeLegacy = applyTracked(entry, { remote, connection: null, effect: (fn, name) => effects.push(name) })
    assert.equal(typedReads, 0, '0.1.1 路径不得消费 typed 面')
    disposeLegacy()
  })
  withBootWire(undefined, () => {
    // 两代路径下 effect 注册契约一致
    const effectsWire = []
    const dispose = applyTracked(entry, {
      remote: { settings: { describe() {}, mutate() {} } },
      connection: null,
      effect: (fn, name) => effectsWire.push(name),
    })
    assert.deepEqual(effectsWire, ['model-capability-editor: models-page injector'])
    dispose()
  })
  assert.deepEqual(effects, ['model-capability-editor: models-page injector'])
})
