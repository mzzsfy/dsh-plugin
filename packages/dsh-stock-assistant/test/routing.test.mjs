import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, RECOVERY_PROBE_MS, PROBE_BACKOFF_MAX_MS } from '../src/provider-router.mjs'
import { routeSchema } from '../src/schemas.mjs'
const route = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b'], failoverMode: 'network' }
const config = { routes: [route], providers: [{ id: 'a' }, { id: 'b' }] }
test('P06/P07/P08 路由连续网络失败才整源切换，429不切，返回不自动跳主源', () => {
  const router = createRouter(() => config)
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  router.recordRound('sh', { code: 'RATE_LIMIT' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  for (let i = 0; i < 3; i++) router.recordRound('sh', { code: 'NETWORK' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b')
  assert.equal(router.select('quotes', 'XSHG').routeEpoch, 1)
  router.switchPrimary('sh', 1)
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  assert.equal(router.select('quotes', 'XSHG').routeEpoch, 2)
  router.recordRound('sh', { code: 'NETWORK' })
  for (let i = 0; i < 2; i++) router.recordRound('sh', { code: 'NETWORK' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b')
  assert.equal(router.select('quotes', 'XSHG').routeEpoch, 3)
  assert.throws(() => router.switchPrimary('sh', 2), e => e.code === 'ROUTE_CONFLICT', '代次不符仍然拒绝')
})

test('多个备用源沿环依次降级, 走到底回到主源', () => {
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const router = createRouter(() => cfg)
  const fail = () => { for (let i = 0; i < 3; i++) router.recordRound('sh', { code: 'NETWORK' }) }
  fail()
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b', '第一个备用源')
  fail()
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'c', '第二级')
  fail()
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a', '走到底回到主源, 不是一个方向降到头就停住')
  assert.equal(router.nextInRing('sh', 'a'), 'b', '环上主源的下一格仍是第一个备用源')
  assert.equal(router.nextInRing('sh', 'c'), 'a', '最后一格的下一格是主源')
})

test('nextInRing 可跳过停用或无预算的成员, 都不可用返回 null', () => {
  const multi = { id: 'sh', capability: 'trend', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c', 'd'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b', enabled: false }, { id: 'c', budget: { requestsPerMinute: null } }, { id: 'd', budget: { requestsPerMinute: 10 } }] }
  const skip = provider => !provider || provider.enabled === false || provider.budget?.requestsPerMinute === null
  const router = createRouter(() => cfg)
  assert.equal(router.nextInRing('sh', 'a', skip), 'd', '跳过停用与无预算成员')
  assert.equal(router.nextInRing('sh', 'a'), 'b', '不传 skip 仍是环上下一格')
  const none = { ...multi, fallbackInstanceIds: ['b'] }
  assert.equal(createRouter(() => ({ routes: [none], providers: cfg.providers })).nextInRing('sh', 'a', skip), null, '只剩不可用成员时没有下一格')
})

test('刚降级的来源不进回探名单, 冷却过后才点名', () => {
  let now = 0
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const router = createRouter(() => cfg, () => now)
  assert.deepEqual(router.recoveryCandidates('sh'), [], '还在主源上没有上级可回探')
  for (let i = 0; i < 6; i++) router.recordRound('sh', { code: 'NETWORK' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'c')
  assert.deepEqual(router.recoveryCandidates('sh'), [], '刚被证明不可用的来源不立刻回探')
  now += RECOVERY_PROBE_MS
  assert.deepEqual(router.recoveryCandidates('sh'), ['a', 'b'], '冷却过后才把上级都试一遍, 从主源往下')
})

test('探不通的上级按倍数退避, 不会每轮都被点名', () => {
  let now = 0
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const router = createRouter(() => cfg, () => now)
  for (let i = 0; i < 6; i++) router.recordRound('sh', { code: 'NETWORK' })
  now += RECOVERY_PROBE_MS
  assert.deepEqual(router.recoveryCandidates('sh'), ['a', 'b'])
  router.recordProbe('sh', 'a', false)
  router.recordProbe('sh', 'b', false)
  assert.deepEqual(router.recoveryCandidates('sh'), [], '探不通就歇一个周期')
  now += RECOVERY_PROBE_MS
  assert.deepEqual(router.recoveryCandidates('sh'), ['a', 'b'], '歇完再试')
  router.recordProbe('sh', 'a', false)
  now += RECOVERY_PROBE_MS
  assert.deepEqual(router.recoveryCandidates('sh'), ['b'], 'a 连续两次探不通, 退避翻倍')
  now += RECOVERY_PROBE_MS
  assert.deepEqual(router.recoveryCandidates('sh'), ['a', 'b'], '翻倍的那一档过去后回到名单')
})

test('探针汇报就绪就回切, 之后的回探只针对更上级', () => {
  let now = 0
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const router = createRouter(() => cfg, () => now)
  const epoch = () => router.select('quotes', 'XSHG').routeEpoch
  for (let i = 0; i < 6; i++) router.recordRound('sh', { code: 'NETWORK' })
  now += RECOVERY_PROBE_MS
  const candidates = router.recoveryCandidates('sh')
  const before = epoch()
  router.recordProbe('sh', candidates[1], true, before)
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b', '主源没恢复就停在恢复了的 b')
  assert.ok(epoch() > before, '回切换代次, 客户端会重新取数')
  assert.deepEqual(router.recoveryCandidates('sh'), ['a'], '下一轮回探只剩更上面的主源')
  router.recordProbe('sh', 'a', true, epoch())
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  assert.deepEqual(router.recoveryCandidates('sh'), [], '回到主源就没有上级了')
})

test('同轮补救的下一格在末级回到主源, 不留在死胡同', () => {
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const router = createRouter(() => cfg)
  assert.equal(router.nextInRing('sh', 'a'), 'b', '主源之后是第一个备源')
  assert.equal(router.nextInRing('sh', 'b'), 'c')
  assert.equal(router.nextInRing('sh', 'c'), 'a', '降到末级时回到主源: 否则这一级是死胡同, 主源恢复了也打不到')
})

test('探不通的次数封顶, 退避不会无限拉长', () => {
  let now = 0
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const router = createRouter(() => cfg, () => now)
  for (let i = 0; i < 6; i++) router.recordRound('sh', { code: 'NETWORK' })
  now += RECOVERY_PROBE_MS
  for (let i = 0; i < 6; i++) router.recordProbe('sh', 'a', false)
  now += PROBE_BACKOFF_MAX_MS - 1000
  assert.deepEqual(router.recoveryCandidates('sh'), ['b'], '封顶后仍在冷却, 只探没问题的那个')
  now += 2000
  assert.deepEqual(router.recoveryCandidates('sh'), ['a', 'b'], '封顶一小时, 不会更久')
})

test('对当前实例汇报就绪只是清退避, 不换代次', () => {
  let now = 0
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b' }] }
  const router = createRouter(() => cfg, () => now)
  for (let i = 0; i < 3; i++) router.recordRound('sh', { code: 'NETWORK' })
  const before = router.select('quotes', 'XSHG')
  assert.equal(before.instance.id, 'b')
  router.recordProbe('sh', 'b', true, before.routeEpoch)
  assert.equal(router.select('quotes', 'XSHG').routeEpoch, before.routeEpoch, '已经在这一级, 汇报就绪不该让客户端白重取一次')
})

test('探测就绪后清掉退避, 再次降级时它立刻回到回探名单', () => {
  let now = 0
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
  const cfg = { routes: [multi], providers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const router = createRouter(() => cfg, () => now)
  for (let i = 0; i < 6; i++) router.recordRound('sh', { code: 'NETWORK' })
  now += RECOVERY_PROBE_MS
  router.recordProbe('sh', 'a', false)
  router.recordProbe('sh', 'a', false)
  assert.deepEqual(router.recoveryCandidates('sh'), ['b'], 'a 探不通两次, 暂时不进名单')
  now += 2 * RECOVERY_PROBE_MS
  router.recordProbe('sh', 'a', true, router.select('quotes', 'XSHG').routeEpoch)
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a', '探通了就回切')
  for (let i = 0; i < 3; i++) router.recordRound('sh', { code: 'NETWORK' })
  now += RECOVERY_PROBE_MS
  assert.deepEqual(router.recoveryCandidates('sh'), ['a'], '再来一轮降级时它没有历史倍数退避, 只歇一个周期就回到名单')
})

test('降级跳过停用与没填预算的成员', () => {
  const multi = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b', 'c'], failoverMode: 'network' }
  const disabled = { routes: [multi], providers: [{ id: 'a', budget: { requestsPerMinute: 50 } }, { id: 'b', enabled: false, budget: { requestsPerMinute: 50 } }, { id: 'c', budget: { requestsPerMinute: 50 } }] }
  const router = createRouter(() => disabled)
  for (let i = 0; i < 3; i++) router.recordRound('sh', { code: 'NETWORK' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'c', '停用的备源派不了活, 直接落到能用的下一个')
  const unknown = { routes: [multi], providers: [{ id: 'a', budget: { requestsPerMinute: 50 } }, { id: 'b', budget: { requestsPerMinute: null } }, { id: 'c', budget: { requestsPerMinute: 50 } }] }
  const router2 = createRouter(() => unknown)
  for (let i = 0; i < 3; i++) router2.recordRound('sh', { code: 'NETWORK' })
  assert.equal(router2.select('quotes', 'XSHG').instance.id, 'c', '预算未知的实例只能探测, 不能承接业务请求')
})

test('一条路由最多挂三个备源', () => {
  const configurable = ids => ({ ...route, maxDelaySeconds: null, acceptUnknownDelay: true, fallbackInstanceIds: ids })
  assert.equal(routeSchema.safeParse(configurable(['b', 'c', 'd'])).success, true, '三级降级是允许的')
  assert.equal(routeSchema.safeParse(configurable(['b', 'c', 'd', 'e'])).success, false, '再多就不是主备而是轮询列表了')
  assert.equal(routeSchema.safeParse(configurable(['b', 'b'])).success, false, '同一个来源不能挂两遍')
  assert.equal(routeSchema.safeParse(configurable(['a'])).success, false, '备源不能是主源自己, 否则换源等于没换')
})
