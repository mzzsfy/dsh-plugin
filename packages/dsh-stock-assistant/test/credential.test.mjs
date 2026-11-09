import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { memoryStorage, operation, provider, route } from './helpers.mjs'
const REF = 'DSH_STOCK_TUSHARE_TOKEN'
const fake = { descriptor: { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }, async probe() { return { status: 'ready' } }, async quotes() { return { items: [], errors: [] } } }
// 凭据服务的对偶: resolve 的返回值与 set/unset 的写入都落在这张表上, 用来观察插件到底写了什么
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref), source: 'env' } : undefined },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
  }
}
const configured = { providers: [provider('ts-one', 'fake')], routes: [route('ts-one', 'XSHG', 'quotes')] }

test('密钥写入宿主凭据存储并立即反映在快照的存在性上', async () => {
  const credentials = fakeCredentials()
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [fake], credentials, env: {}, now: () => 1000 })
  await app.configuration({ ...operation(), payload: configured })
  assert.equal(app.snapshot().providerStatus[0].credentialPresent, false, '保存配置时还没有密钥')

  const written = await app.credential({ ref: REF, value: 'real-secret' })
  assert.deepEqual(written, { ref: REF, present: true })
  assert.equal(credentials.store.get(REF), 'real-secret', '值落在宿主凭据存储里')
  assert.equal(app.snapshot().providerStatus[0].credentialPresent, true, '存在性立刻跟上')
  assert.equal(JSON.stringify(app.snapshot()).includes('real-secret'), false, '密钥不回显到快照')
})

test('清除密钥后存在性回落且插件状态里不留副本', async () => {
  const credentials = fakeCredentials({ [REF]: 'old-secret' })
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [fake], credentials, env: {}, now: () => 1000 })
  await app.configuration({ ...operation(), payload: configured })
  assert.equal(app.snapshot().providerStatus[0].credentialPresent, true, '启动时就能看到已有密钥')

  await app.credential({ ref: REF, value: null })
  assert.equal(credentials.store.has(REF), false)
  assert.equal(app.snapshot().providerStatus[0].credentialPresent, false)
  assert.equal(JSON.stringify(app.snapshot()).includes('old-secret'), false)
})

test('只允许写本插件已声明的凭据引用', async () => {
  const credentials = fakeCredentials()
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [fake], credentials, env: {}, now: () => 1000 })
  await app.configuration({ ...operation(), payload: configured })
  // 未声明的引用直接拒绝: 插件不能越界写别人的密钥空间
  await assert.rejects(() => app.credential({ ref: 'NEWAPI_API_KEY', value: 'x' }), e => e.code === 'INVALID_REQUEST')
  assert.equal(credentials.store.size, 0)
})

test('宿主没有凭据服务时写密钥报不支持而不是静默丢弃', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [fake], env: {}, now: () => 1000 })
  await app.configuration({ ...operation(), payload: configured })
  await assert.rejects(() => app.credential({ ref: REF, value: 'x' }), e => e.code === 'UNSUPPORTED')
})

test('宿主给的凭据服务接口不完整时退回环境变量, 不在取数时炸掉', async () => {
  const partial = { resolve: async () => undefined }
  const seen = []
  const echo = { descriptor: { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }, async probe() { return { status: 'ready' } }, async quotes(request, ctx) { seen.push(ctx.credential()); return { items: [], errors: [] } } }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [echo], credentials: partial, env: { [REF]: 'from-env' }, now: () => 1000 })
  await app.configuration({ ...operation(), payload: configured })
  await app.refresh({ securities: [{ id: 'XSHG:equity:600519', exchange: 'XSHG', code: '600519' }] }, new AbortController().signal)
  assert.deepEqual(seen, ['from-env'], '缺 set/unset 就整块不用, 回退到环境变量')
  await assert.rejects(() => app.credential({ ref: REF, value: 'x' }), e => e.code === 'UNSUPPORTED')
})

test('执行层每次操作重新解析凭据, 换密钥不必重启插件', async () => {
  const credentials = fakeCredentials({ [REF]: 'first' })
  const seen = []
  let clock = 1000
  const echo = { descriptor: { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }, async probe() { return { status: 'ready' } }, async quotes(request, ctx) { seen.push(ctx.credential()); return { items: [], errors: [] } } }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [echo], credentials, env: {}, now: () => clock })
  await app.configuration({ ...operation(), payload: configured })
  const target = { id: 'XSHG:equity:600519', exchange: 'XSHG', code: '600519' }
  await app.refresh({ securities: [target] }, new AbortController().signal)
  // 同额度组两次请求必须间隔一秒以上(额度层的突发保护), 换密钥的同时把时钟推过去
  clock += 2000
  credentials.store.set(REF, 'second')
  await app.refresh({ securities: [target] }, new AbortController().signal)
  assert.deepEqual(seen, ['first', 'second'], '第二次操作拿到的是新值')
})

test('凭据缺失时执行层报 AUTH 而不是把空串当密钥发出去', async () => {
  const credentials = fakeCredentials()
  const strict = { descriptor: { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }, async probe() { return { status: 'ready' } }, async quotes() { return { items: [], errors: [] } } }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [strict], credentials, env: {}, now: () => 1000 })
  await app.configuration({ ...operation(), payload: configured })
  const target = { id: 'XSHG:equity:600519', exchange: 'XSHG', code: '600519' }
  await app.refresh({ securities: [target] }, new AbortController().signal).catch(() => {})
  assert.equal(app.snapshot().quotes['XSHG:equity:600519']?.lastError?.code, 'AUTH')
})
