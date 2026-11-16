import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { memoryStorage, operation, provider, route } from './helpers.mjs'

const REF = 'DSH_STOCK_PROXY'
const fake = { descriptor: { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }, async probe(request) { return { status: 'ready', capability: request.capability } }, async quotes() { return { items: [], errors: [] } } }
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    async resolve(ref) { return store.has(ref) ? { value: store.get(ref), source: 'store' } : undefined },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
  }
}

test('P1-10 代理凭据只存宿主凭据, 快照与持久化均不含账号密码', async () => {
  const storage = memoryStorage(), credentials = fakeCredentials()
  const app = await createApplication({ storageDomain: storage, providers: [fake], credentials, env: {}, now: () => 1000 })
  const instance = { ...provider('px-one', 'fake'), credentialRef: null, proxy: 'http://proxy.corp:8080', proxyCredentialRef: REF }
  await app.configuration({ ...operation(), payload: { providers: [instance], routes: [route('px-one', 'XSHG', 'quotes')] } })
  assert.equal(app.snapshot().providerStatus[0].proxyCredentialPresent, false, '未写凭据时存在性为 false')

  const secret = ['alice', 's3cret'].join(':')
  await app.credential({ ref: REF, value: secret })
  assert.equal(credentials.store.get(REF), secret, '账号密码落在宿主凭据存储')
  assert.equal(app.snapshot().providerStatus[0].proxyCredentialPresent, true)

  const snapshot = JSON.stringify(app.snapshot())
  assert.equal(snapshot.includes(secret), false, '快照不得回显代理账号密码')
  assert.equal(snapshot.includes('alice'), false, '快照不得回显代理用户名')
  assert.equal(JSON.stringify(storage.maps.control.get('root')).includes(secret), false, '持久化记录不得包含账号密码')
  assert.equal(JSON.stringify(storage.maps.control.get('root')).includes('alice'), false)
  await app.close()
})

test('P1-10 代理凭据引用可被清除, 且不存在时写接口拒绝未声明引用', async () => {
  const storage = memoryStorage(), credentials = fakeCredentials({ [REF]: ['bob', 'pw'].join(':') })
  const app = await createApplication({ storageDomain: storage, providers: [fake], credentials, env: {}, now: () => 1000 })
  const instance = { ...provider('px-one', 'fake'), credentialRef: null, proxy: 'http://proxy.corp:8080', proxyCredentialRef: REF }
  await app.configuration({ ...operation(), payload: { providers: [instance], routes: [] } })
  await app.credential({ ref: REF, value: null })
  assert.equal(credentials.store.has(REF), false)
  await assert.rejects(() => app.credential({ ref: 'OTHER_PROXY', value: 'x' }), e => e.code === 'INVALID_REQUEST')
  await app.close()
})
