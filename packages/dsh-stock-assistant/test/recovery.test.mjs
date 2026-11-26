import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, RECOVERY_PROBE_MS } from '../src/provider-router.mjs'
import { createRecovery, createRecoveryLoop } from '../src/recovery.mjs'

const ring = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
const config = () => ({ routes: [ring], providers: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }, { id: 'c', enabled: true }] })

// 适配器自己的探针: ready 的实例回 {status:'ready'}, 其余抛错
function fakeExecutor(ready) {
  const calls = []
  return {
    calls,
    idle: () => true,
    run: async (instance, capability, request, options) => {
      calls.push(`${instance.id}:${request.market}:${capability}:${options?.probe ? 'probe' : 'work'}`)
      if (!ready.has(instance.id)) throw Object.assign(Error('down'), { code: 'NETWORK' })
      return { status: 'ready', capability }
    },
  }
}
const degrade = router => { for (let i = 0; i < 6; i++) router.recordRound('sh', { code: 'NETWORK' }) }

test('主源恢复时探针汇报就绪, 直接回切到主源', async () => {
  let now = 0
  const router = createRouter(config, () => now)
  degrade(router)
  now += RECOVERY_PROBE_MS
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'c')
  const executor = fakeExecutor(new Set(['a']))
  await createRecovery({ getConfig: config, router, executor })()
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a', '主源就绪就不用再往下试')
  assert.deepEqual(executor.calls, ['a:XSHG:quotes:probe'], '只点了一次名')
})

test('主源没恢复就落到下一个恢复了的上级', async () => {
  let now = 0
  const router = createRouter(config, () => now)
  degrade(router)
  now += RECOVERY_PROBE_MS
  const executor = fakeExecutor(new Set(['b']))
  await createRecovery({ getConfig: config, router, executor })()
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b')
  assert.deepEqual(executor.calls, ['a:XSHG:quotes:probe', 'b:XSHG:quotes:probe'])
})

test('都不就绪时保持当前选择, 不改代次也不记失败', async () => {
  let now = 0
  const router = createRouter(config, () => now)
  degrade(router)
  const before = router.select('quotes', 'XSHG')
  await createRecovery({ getConfig: config, router, executor: fakeExecutor(new Set()) })()
  const after = router.select('quotes', 'XSHG')
  assert.equal(after.instance.id, 'c')
  assert.equal(after.routeEpoch, before.routeEpoch, '探测失败不该让客户端重新取数')
  assert.equal(router.selections().sh.failures, 0)
  // 下一次探测不该再点同一个坏源: 刚探不通的实例进退避
  const second = fakeExecutor(new Set())
  await createRecovery({ getConfig: config, router, executor: second })()
  assert.deepEqual(second.calls, [], '退避期内不重复点名')
})

test('还在主源或没开自动切换的路由不探测', async () => {
  const router = createRouter(config)
  const executor = fakeExecutor(new Set(['a']))
  await createRecovery({ getConfig: config, router, executor })()
  assert.deepEqual(executor.calls, [], '没降级就没有回探的意义')
  const off = () => ({ ...config(), routes: [{ ...ring, failoverMode: 'off' }] })
  const routerOff = createRouter(off)
  for (let i = 0; i < 6; i++) routerOff.recordRound('sh', { code: 'NETWORK' })
  await createRecovery({ getConfig: off, router: routerOff, executor })()
  assert.deepEqual(executor.calls, [], '关了自动切换的路由不会自己降级, 也不回探')
})

test('停用的实例不被点名', async () => {
  let now = 0
  const router = createRouter(config, () => now)
  degrade(router)
  now += RECOVERY_PROBE_MS
  const disabled = () => { const cfg = config(); cfg.providers[0] = { id: 'a', enabled: false }; return cfg }
  const executor = fakeExecutor(new Set(['a', 'b']))
  await createRecovery({ getConfig: disabled, router, executor })()
  assert.deepEqual(executor.calls, ['b:XSHG:quotes:probe'], '停用的主源不去打')
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b')
})

test('用户请求在跑时整轮跳过, 不跟首屏抢队列', async () => {
  let now = 0
  const router = createRouter(config, () => now)
  degrade(router)
  now += RECOVERY_PROBE_MS
  const executor = { ...fakeExecutor(new Set(['a'])), idle: () => false }
  await createRecovery({ getConfig: config, router, executor })()
  assert.deepEqual(executor.calls, [], '探测排在一次上游超时后面会把详情页请求推到接口超时线上')
})

test('探测中途路由被删掉, 其余路由照常探完', async () => {
  let now = 0
  const second = { ...ring, id: 'sz', market: 'XSHE' }
  const two = () => ({ routes: [ring, second], providers: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }, { id: 'c', enabled: true }] })
  const router = createRouter(two, () => now)
  for (const id of ['sh', 'sz']) for (let i = 0; i < 6; i++) router.recordRound(id, { code: 'NETWORK' })
  now += RECOVERY_PROBE_MS
  let round = 0
  // 第一轮探测汇报时路由已被删, recordProbe 会抛 NO_ROUTE; 后面那条路由不能被一起带走
  const shrinking = () => (round++ === 0 ? two() : { ...two(), routes: [second] })
  const executor = fakeExecutor(new Set())
  await createRecovery({ getConfig: shrinking, router, executor })()
  assert.ok(executor.calls.some(call => call.endsWith('XSHE:quotes:probe')), '后一条路由仍然探到了')
})

test('上一轮探测没跑完时, 周期触发不会重入', async () => {
  let concurrent = 0, peak = 0, release = () => {}
  const probe = () => { concurrent++; peak = Math.max(peak, concurrent); return new Promise(resolve => { release = () => { concurrent--; resolve() } }) }
  let tick = null
  const timers = { setInterval: fn => { tick = fn; return { unref() {} } }, clearInterval: () => { tick = null } }
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const loop = createRecoveryLoop({ probe, timers, interval: 5 * 60 * 1000 })
  loop.sync(true)
  await flush()
  assert.equal(peak, 1)
  tick()
  await flush()
  assert.equal(peak, 1, '上一轮还在飞, 这一拍跳过')
  release()
  await flush()
  tick()
  await flush()
  assert.equal(peak, 1, '上一轮收尾后才允许下一轮')
  release(); await flush()
  loop.stop()
})

test('面板刚活跃时用户请求在飞, 探测短重试而不是等满一个周期', async () => {
  let ready = false, calls = 0, retry = null
  const timers = { setTimeout: fn => { retry = fn; return { unref() {} } }, clearTimeout: () => { retry = null }, setInterval: () => ({ unref() {} }), clearInterval: () => {} }
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const loop = createRecoveryLoop({ probe: async () => { calls++ }, timers, interval: 5 * 60 * 1000, canRun: () => ready })
  loop.sync(true)
  await flush()
  assert.equal(calls, 0, '用户请求在飞, 这一拍不探')
  assert.ok(retry, '排了一次短重试')
  ready = true
  retry()
  await flush()
  assert.equal(calls, 1, '空闲后立刻补探, 不用等满一个周期')
  loop.stop()
  await flush()
  assert.equal(calls, 1, '停止后不会再有探测')
})

test('探测节奏跟着面板走: 活跃时立刻探一次并按周期重复, 不活跃就停', async () => {
  const started = []
  let tick = null, calls = 0
  const timers = { setInterval: (fn, ms) => { started.push(ms); tick = fn; return { unref() {} } }, clearInterval: () => { tick = null } }
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const loop = createRecoveryLoop({ probe: async () => { calls++ }, timers, interval: 5 * 60 * 1000 })
  loop.sync(false)
  assert.equal(calls, 0, '没人看就不探')
  loop.sync(true)
  await flush()
  assert.equal(calls, 1, '刚活跃先探一次, 不用干等一个周期')
  assert.deepEqual(started, [5 * 60 * 1000], '按回探周期排期')
  loop.sync(true)
  await flush()
  assert.equal(calls, 1, '重复同步不重复探')
  tick()
  await flush()
  assert.equal(calls, 2, '之后按周期探')
  loop.sync(false)
  assert.equal(tick, null, '不活跃就停掉定时器')
  loop.stop()
  assert.equal(started.length, 1, '整个生命周期只起过一次定时器')
})

test('应用层把配置读取器接对: 传整条控制记录会让回探静默失效', async () => {
  // 接线曾经写成 getControl(整个控制记录), 而 createRecovery 读的是 getConfig().routes:
  // 每轮都在 getConfig 处抛 TypeError, 被循环的 catch 吞掉, 自动回切一次都没跑过
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/application.mjs', import.meta.url), 'utf8')
  assert.match(source, /createRecovery\(\{ getConfig: \(\) => state\.get\(\), router, executor \}\)/, '必须传能读出 routes/providers 的读取器')
  assert.doesNotMatch(source, /createRecovery\(\{ getControl/, '不得把整条控制记录当配置传进去')
})
