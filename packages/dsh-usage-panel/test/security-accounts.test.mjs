// P1 回归:自定义账号的 headers/body 凭据不回传;全量保存带 accounts 修订号,
// 旧快照保存返回 409 且不覆盖他人写入;脱敏占位回存时按旧账号还原。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = await mkdtemp(join(tmpdir(), 'usage-p1-'))
process.env.DSH_USAGE_PANEL_DATA_DIR = tempDir

const { apply } = await import('../src/index.js')

after(async () => {
  delete process.env.DSH_USAGE_PANEL_DATA_DIR
  await rm(tempDir, { recursive: true, force: true })
})

function makeCtx() {
  const routes = new Map()
  const settings = { register() {}, get: () => ({ notify: { enabled: false } }), update: async () => {} }
  const ctx = {
    get: (name) => (name === 'settings' ? settings : undefined),
    effect: (fn) => { fn() },
    inject: (_deps, fn) => fn({ settings, interval: () => {} }),
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, routes }
}

function makeReq(method, body) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000' }
  if (body !== undefined) {
    req.headers['content-type'] = 'application/json'
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    process.nextTick(() => {
      req.emit('data', Buffer.from(text))
      req.emit('end')
    })
  }
  return req
}

async function call(routes, path, req) {
  if (req.url === undefined) req.url = path
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = text ? JSON.parse(text) : null }
  await routes.get(path)(req, res)
  return res
}

const accountsGet = (routes) => call(routes, '/api/usage-panel/accounts', makeReq('GET'))
const accountsPost = (routes, body) => call(routes, '/api/usage-panel/accounts', makeReq('POST', body))
const persisted = async () => JSON.parse(await readFile(join(tempDir, 'accounts.json'), 'utf8'))

const SECRET_HEADER = 'Bearer sk-header-secret'
const SECRET_BODY = 'sk-body-secret'

function customAccount(overrides = {}) {
  return {
    id: 'acct-custom',
    name: '自定义',
    type: 'custom',
    custom: {
      url: 'https://example.test/usage',
      method: 'POST',
      headers: { Authorization: SECRET_HEADER, 'X-Trace': 'trace-1' },
      body: JSON.stringify({ apiKey: SECRET_BODY, model: 'm-1' }),
      extract: {},
    },
    ...overrides,
  }
}

test('P1-a GET accounts 不回传 custom.headers 与 body 中的凭据', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const saved = await accountsPost(routes, { accounts: [customAccount()] })
  assert.equal(saved.status, 200)

  const res = await accountsGet(routes)
  const text = JSON.stringify(res.payload)
  assert.equal(text.includes(SECRET_HEADER), false, '响应不得包含 header 凭据')
  assert.equal(text.includes(SECRET_BODY), false, '响应不得包含 body 凭据')

  const account = res.payload.accounts[0]
  assert.deepEqual(Object.keys(account.custom.headers), ['Authorization', 'X-Trace'])
  assert.equal(account.custom.headers['X-Trace'], '[已隐藏]', '所有自定义头值都可能是凭据,统一脱敏')
  assert.equal(account.custom.headers.Authorization, '[已隐藏]')
  const body = JSON.parse(account.custom.body)
  assert.equal(body.model, 'm-1')
  assert.notEqual(body.apiKey, SECRET_BODY)
})

test('P1-b 脱敏占位回存时按旧账号还原真实凭据', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  await accountsPost(routes, { accounts: [customAccount()] })
  const before = await accountsGet(routes)

  const edited = { ...before.payload.accounts[0], name: '改名' }
  const res = await accountsPost(routes, { accounts: [edited], revision: before.payload.revision })
  assert.equal(res.status, 200)
  assert.equal(res.payload.accounts[0].name, '改名')

  const disk = await persisted()
  assert.equal(disk.accounts[0].custom.headers.Authorization, SECRET_HEADER)
  assert.equal(JSON.parse(disk.accounts[0].custom.body).apiKey, SECRET_BODY)
})

test('P1-c 并发同 revision 保存只允许一个成功', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  await accountsPost(routes, { accounts: [customAccount()] })
  const base = await accountsGet(routes)

  const [left, right] = await Promise.all([
    accountsPost(routes, { accounts: [customAccount({ name: '窗口A' })], revision: base.payload.revision }),
    accountsPost(routes, { accounts: [customAccount({ name: '窗口B' })], revision: base.payload.revision }),
  ])
  assert.deepEqual([left.status, right.status].sort(), [200, 409])
  const final = await accountsGet(routes)
  assert.equal(final.payload.revision, base.payload.revision + 1)
  assert.ok(['窗口A', '窗口B'].includes(final.payload.accounts[0].name))
})

test('P1-d 旧 revision 保存返回 409,且不覆盖新账号与历史', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  await accountsPost(routes, { accounts: [customAccount()] })
  const base = await accountsGet(routes)

  const added = await accountsPost(routes, {
    accounts: [base.payload.accounts[0], { id: 'acct-new', name: '新账号', type: 'kimi', apiKey: 'sk-new' }],
    revision: base.payload.revision,
  })
  assert.equal(added.status, 200)

  const stale = await accountsPost(routes, {
    accounts: [customAccount({ name: '旧窗口覆盖' })],
    revision: base.payload.revision,
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.payload.revision, added.payload.revision)

  const after = await accountsGet(routes)
  assert.deepEqual(after.payload.accounts.map((item) => item.id).sort(), ['acct-custom', 'acct-new'])
  assert.equal(after.payload.accounts.find((item) => item.id === 'acct-custom').name, '自定义')
})
