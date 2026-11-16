import test from 'node:test'
import assert from 'node:assert/strict'
import { createExecutor } from '../src/executor.mjs'
import { createRegistry } from '../src/provider-registry.mjs'
import { tickPeriodMs, TICK_SAFETY_RATIO, initialControl } from '../src/schemas.mjs'
import { createApplication } from '../src/application.mjs'
import { memoryStorage, provider } from './helpers.mjs'

const instance = { id: 'em-1', adapterId: 'fake', credentialRef: null, quotaGroup: 'g1', budget: { requestsPerMinute: 600 } }
const other = { ...instance, id: 'tx-1', quotaGroup: 'g2' }

// 假时钟: 只把到期的定时器按时间顺序执行, 便于断言"请求在什么时刻发出"。
// 每轮先 flush 一次 microtask: 请求链常常在 promise 里才注册定时器, 直接查队列会漏。
function fakeClock(start = 0) {
  let t = start
  const queue = []
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const runTo = async target => {
    for (;;) {
      await flush()
      const due = queue.filter(h => h.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      queue.splice(queue.indexOf(due), 1)
      t = Math.max(t, due.at)
      due.fn()
    }
    t = Math.max(t, target)
    await flush()
  }
  return {
    now: () => t,
    setTimeout(fn, ms) { const handle = { at: t + Math.max(0, ms), fn }; queue.push(handle); return handle },
    clearTimeout(handle) { const i = queue.indexOf(handle); if (i >= 0) queue.splice(i, 1) },
    advance: ms => runTo(t + ms),
  }
}

const setup = period => {
  const clock = fakeClock(0)
  const calls = []
  const fake = {
    descriptor: { adapterId: 'fake', capabilities: ['quotes', 'catalog'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { calls.push({ at: clock.now(), kind: 'probe' }); return { status: 'ready', capability: request.capability } },
    async quotes() { calls.push({ at: clock.now(), kind: 'quotes' }); return { items: [] } },
    async catalog() { calls.push({ at: clock.now(), kind: 'catalog' }); return { items: [], complete: true } },
  }
  const executor = createExecutor({ registry: createRegistry([fake]), budget: { reserve() {} }, env: {}, now: clock.now, timers: clock, tickPeriodMs: () => period })
  return { clock, calls, executor }
}

test('节拍周期 = 两处刷新设置里更快者 × 90%', () => {
  assert.equal(TICK_SAFETY_RATIO, 0.9)
  const defaults = initialControl().preferences
  assert.equal(tickPeriodMs({ ...defaults, refreshSeconds: 15, floatRefreshSeconds: 10 }), 9000)
  assert.equal(tickPeriodMs({ ...defaults, refreshSeconds: 60, floatRefreshSeconds: 3 }), 2700, '浮窗更快时按浮窗算')
  assert.equal(tickPeriodMs({ ...defaults, refreshSeconds: 15, floatRefreshSeconds: 30 }), 13500, '列表更快时按列表算')
})

test('一拍内的连续请求立即发出, 不按拍拆开', async () => {
  const { clock, calls, executor } = setup(9000)
  const first = executor.run(instance, 'quotes', {}, {})
  await clock.advance(0)
  await first
  const second = executor.run(instance, 'quotes', {}, {})
  await clock.advance(1500)
  await second
  assert.equal(calls.length, 2)
  // 第二笔只受 1 秒防连打约束, 不额外等一个节拍
  assert.ok(calls[1].at >= 1000 && calls[1].at < 2000, `第二笔应在一秒后发出, 实际 ${calls[1].at}`)
  executor.dispose()
})

test('拍的后半段请求被压到下一拍', async () => {
  const { clock, calls, executor } = setup(9000)
  const first = executor.run(instance, 'quotes', {}, {})
  await clock.advance(0)
  await first
  await clock.advance(6000)
  const late = executor.run(instance, 'quotes', {}, {})
  await clock.advance(2500)
  assert.equal(calls.length, 1, '没到下一拍不该发出')
  await clock.advance(1000)
  await late
  assert.equal(calls.length, 2)
  assert.ok(calls[1].at >= 9000, `应在下一拍发出, 实际 ${calls[1].at}`)
  executor.dispose()
})

test('探针与目录同步不受节拍约束', async () => {
  const { clock, calls, executor } = setup(9000)
  const first = executor.run(instance, 'quotes', {}, {})
  await clock.advance(0)
  await first
  await clock.advance(6000)
  // 同一实例、同一额度组: 仍受 1 秒防连打, 但不应被压到 9 秒那一拍
  const probe = executor.run(instance, 'quotes', {}, { probe: true })
  const catalog = executor.run(instance, 'catalog', {}, {})
  await clock.advance(2500)
  await Promise.all([probe, catalog])
  assert.equal(calls.length, 3)
  assert.ok(calls[1].at < 9000 && calls[2].at < 9000, `一次性动作不该等节拍, 实际 ${calls[1].at}/${calls[2].at}`)
  executor.dispose()
})

test('节拍按数据源实例各算各的', async () => {
  const { clock, calls, executor } = setup(9000)
  const a = executor.run(instance, 'quotes', {}, {})
  await clock.advance(0)
  await a
  await clock.advance(6000)
  const b = executor.run(other, 'quotes', {}, {})
  await clock.advance(1000)
  await b
  assert.equal(calls.length, 2)
  assert.ok(calls[1].at < 9000, `另一个实例不该被前一个实例的拍压住, 实际 ${calls[1].at}`)
  executor.dispose()
})

test('端到端: 分时请求走 application 时也受同一节拍约束', async () => {
  const clock = fakeClock(0)
  const calls = []
  const fake = {
    descriptor: { adapterId: 'fake', capabilities: ['trend'], markets: ['XSHG'], instruments: ['equity'] },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async trend(request) { calls.push(clock.now()); return { providerInstanceId: request.providerInstanceId, fetchedAt: 1, complete: true, preClose: 10, candles: [{ time: '09:30', open: 10, high: 10, low: 10, close: 10, volume: 1 }, { time: '09:31', open: 10, high: 10, low: 10, close: 10, volume: 1 }] } },
  }
  const storage = memoryStorage()
  const control = initialControl()
  control.providers = [{ ...provider('em-one', 'fake'), credentialRef: null }]
  control.routes = [{ id: 'xshg-trend', capability: 'trend', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'em-one', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }]
  control.preferences = { refreshSeconds: 15, colorMode: 'red-up', floatRefreshSeconds: 10 }
  storage.maps.control.set('root', control)
  const app = await createApplication({ storageDomain: storage, providers: [fake], env: {}, now: clock.now, timers: clock })
  const request = () => app.kline({ securityId: 'XSHG:equity:600519', period: 'trend', limit: 250 })
  try {
    const first = request()
    await clock.advance(0); await first
    assert.equal(calls.length, 1)
    await clock.advance(6000)
    const late = request()
    await clock.advance(2500)
    assert.equal(calls.length, 1, '拍的后半段还没到下一拍')
    await clock.advance(1000)
    await late
    assert.equal(calls.length, 2)
    assert.ok(calls[1] >= 9000, `应用层也应压到下一拍, 实际 ${calls[1]}`)
  } finally { await app.close() }
})
