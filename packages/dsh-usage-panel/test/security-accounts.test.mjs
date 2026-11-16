// P1 回归:自定义账号的 headers/body 凭据不回传;全量保存带 accounts 修订号,
// 旧快照保存返回 409 且不覆盖他人写入;脱敏占位回存时按旧账号还原。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
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
const queryAccount = (routes, id) => call(routes, '/api/usage-panel/query', makeReq('POST', { id }))
const historyGet = (routes) => call(routes, '/api/usage-panel/history', makeReq('GET'))
const persisted = async () => JSON.parse(await readFile(join(tempDir, 'accounts.json'), 'utf8'))

const KIMI_BODY = {
  limits: [{ detail: { limit: 100, remaining: 5, resetTime: 'T1' } }],
  usage: { limit: 200, remaining: 50, resetTime: 'T2' },
}
const kimiAccount = (id) => ({ id, name: id, type: 'kimi', apiKey: 'sk-test' })

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
  // 体字段名不可信(access_key/auth/pin 等),字符串值整体视为凭据
  assert.equal(body.model, '[已隐藏]')
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

// P3:URL query token 与上游错误体同样属于凭据面
test('P3-a 响应脱敏覆盖 custom.url 查询参数与 last.error 错误体', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const base = customAccount()
  const url = 'https://example.test/usage?token=url-secret&model=m-1'
  await accountsPost(routes, { accounts: [customAccount({ custom: { ...base.custom, url } })] })
  const before = await accountsGet(routes)
  assert.equal(JSON.stringify(before.payload).includes('url-secret'), false, 'URL 查询 token 不得回传')

  // 脱敏占位回存后磁盘仍是原 URL
  const saved = await accountsPost(routes, { accounts: [before.payload.accounts[0]], revision: before.payload.revision })
  assert.equal(saved.status, 200)
  const disk = await persisted()
  assert.equal(disk.accounts[0].custom.url.includes('url-secret'), true)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key Bearer leaked-token-abcdef' })
  try {
    const queried = await queryAccount(routes, 'acct-custom')
    assert.equal(queried.status, 200)
    assert.equal(queried.payload.ok, false)
    const after = await accountsGet(routes)
    assert.equal(JSON.stringify(after.payload).includes('leaked-token-abcdef'), false, '上游错误体不得回传明文凭据')
    assert.match(after.payload.accounts[0].last.error, /HTTP 401/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
// 旧实现先删 history 再持久化,失败回滚只回 config,下一次 persistHistory 把缺历史永久落盘
test('P1-e persistConfig 失败后账号与历史都还在,删除不生效', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify(KIMI_BODY) })
  const accountsFile = join(tempDir, 'accounts.json')
  try {
    await accountsPost(routes, { accounts: [kimiAccount('acct-keep'), kimiAccount('acct-drop')] })
    await queryAccount(routes, 'acct-keep')
    await queryAccount(routes, 'acct-drop')
    const before = await historyGet(routes)
    const beforeKeys = Object.keys(before.payload.sequences).sort()
    assert.ok(beforeKeys.some((key) => key.indexOf('acct-drop:') === 0), '待删账号已有历史序列')

    // 让 persistConfig 必失败:accounts.json 路径被目录占位(写文件 EISDIR/EPERM)
    await rm(accountsFile, { force: true })
    await mkdir(accountsFile)

    const base = await accountsGet(routes)
    const deleted = await accountsPost(routes, {
      accounts: [kimiAccount('acct-keep')],
      revision: base.payload.revision,
    })
    assert.equal(deleted.status, 400, '保存失败必须回 400')

    // Then 账号仍为两个(内存与磁盘)
    const afterAccounts = await accountsGet(routes)
    assert.deepEqual(afterAccounts.payload.accounts.map((item) => item.id).sort(), ['acct-drop', 'acct-keep'])
    // And 历史序列完整(内存与磁盘都未被删除)
    const afterHistory = await historyGet(routes)
    assert.deepEqual(Object.keys(afterHistory.payload.sequences).sort(), beforeKeys)
    const diskHistory = JSON.parse(await readFile(join(tempDir, 'history.json'), 'utf8'))
    assert.deepEqual(Object.keys(diskHistory.sequences).sort(), beforeKeys, '失败时不得执行 persistHistory 删除历史')

    // 恢复可写后重试删除:账号与历史才真正清理
    await rm(accountsFile, { recursive: true, force: true })
    const retry = await accountsPost(routes, {
      accounts: [kimiAccount('acct-keep')],
      revision: base.payload.revision,
    })
    assert.equal(retry.status, 200)
    const finalHistory = await historyGet(routes)
    assert.equal(Object.keys(finalHistory.payload.sequences).some((key) => key.indexOf('acct-drop:') === 0), false)
  } finally {
    globalThis.fetch = originalFetch
    await rm(accountsFile, { recursive: true, force: true })
  }
})

// U2:userinfo 非空即凭据(常见形态 `https://token:@host` 把 token 放用户名位),
// baseUrl 与 custom.url 同属凭据面;回显、保存、恢复三面对称
const USERINFO_BASE = 'https://base-user-token-secret:@api-example.test/v1'
const USERINFO_BASE_PASS = 'https://:base-pass-secret@api-example.test/v1'
const USERINFO_CUSTOM = 'https://custom-user-' + 'secret' + ':' + 'custom-pass-' + 'secret' + '@other-example.test/v1'
const PLACEHOLDER_URL = 'https://%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D:@example.test/usage?token=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D'

const decode = (value) => decodeURIComponent(value)

test('U2-a 回显脱敏:baseUrl 与 custom.url 的 userinfo 两段都不回传', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const saved = await accountsPost(routes, {
    accounts: [
      { id: 'acct-user', name: 'base', type: 'deepseek', baseUrl: USERINFO_BASE, apiKey: 'sk-user' },
      { id: 'acct-pass', name: 'pass', type: 'deepseek', baseUrl: USERINFO_BASE_PASS, apiKey: 'sk-pass' },
      customAccount({ custom: { ...customAccount().custom, url: USERINFO_CUSTOM } }),
    ],
  })
  assert.equal(saved.status, 200)
  const res = await accountsGet(routes)
  const text = JSON.stringify(res.payload)
  for (const secret of ['base-user-token-secret', 'base-pass-secret', 'custom-user-secret', 'custom-pass-secret']) {
    assert.equal(text.includes(secret), false, '响应不得包含 userinfo 凭据 ' + secret)
  }
  const byId = Object.fromEntries(res.payload.accounts.map((item) => [item.id, item]))
  // 占位形态保留 userinfo 结构,前端可原样回存;空密码位的冒号由 URL 序列化归一省略
  assert.match(decode(byId['acct-user'].baseUrl), /\[已隐藏\]:?@api-example\.test\/v1/)
  assert.match(decode(byId['acct-pass'].baseUrl), /:\[已隐藏\]@api-example\.test\/v1/)
  assert.match(decode(byId['acct-custom'].custom.url), /\[已隐藏\]:\[已隐藏\]@other-example\.test/)
})

test('U2-b 保存/恢复对称:占位原样回存后磁盘仍是原始 userinfo', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  await accountsPost(routes, {
    accounts: [
      { id: 'acct-user', name: 'base', type: 'deepseek', baseUrl: USERINFO_BASE, apiKey: 'sk-user' },
      { id: 'acct-pass', name: 'pass', type: 'deepseek', baseUrl: USERINFO_BASE_PASS, apiKey: 'sk-pass' },
      customAccount({ custom: { ...customAccount().custom, url: USERINFO_CUSTOM } }),
    ],
  })
  const before = await accountsGet(routes)
  const edited = before.payload.accounts.map((item) => ({ ...item, name: item.name + '改名' }))
  const saved = await accountsPost(routes, { accounts: edited, revision: before.payload.revision })
  assert.equal(saved.status, 200)
  const disk = await persisted()
  const storedUser = disk.accounts.find((item) => item.id === 'acct-user')
  const storedPass = disk.accounts.find((item) => item.id === 'acct-pass')
  const storedCustom = disk.accounts.find((item) => item.id === 'acct-custom')
  // userinfo 两段都按旧值还原(空密码位的冒号由 URL 序列化归一,凭据值不变)
  assert.equal(decode(storedUser.baseUrl).includes('base-user-token-secret'), true)
  assert.equal(decode(storedUser.baseUrl).includes('[已隐藏]'), false)
  assert.equal(new URL(storedUser.baseUrl).username, 'base-user-token-secret')
  assert.equal(new URL(storedPass.baseUrl).password, 'base-pass-secret')
  assert.equal(decode(storedCustom.custom.url).includes('[已隐藏]'), false)
  assert.equal(new URL(storedCustom.custom.url).username, 'custom-user-secret')
  assert.equal(new URL(storedCustom.custom.url).password, 'custom-pass-secret')
})

test('U2-c 上游错误体带回 userinfo 时按凭据脱敏', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  await accountsPost(routes, {
    accounts: [customAccount({ custom: { ...customAccount().custom, url: USERINFO_CUSTOM } })],
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'denied for ' + USERINFO_CUSTOM })
  try {
    const queried = await queryAccount(routes, 'acct-custom')
    assert.equal(queried.payload.ok, false)
    const after = await accountsGet(routes)
    const text = JSON.stringify(after.payload)
    assert.equal(text.includes('custom-user-secret'), false, '错误体不得回传 userinfo 用户名')
    assert.equal(text.includes('custom-pass-secret'), false, '错误体不得回传 userinfo 密码')
    assert.match(after.payload.accounts[0].last.error, /HTTP 401/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('U2-d 新建账号携带脱敏占位 URL 拒绝落盘(不得把占位当凭据)', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const before = await accountsGet(routes)
  const res = await accountsPost(routes, {
    accounts: [{ id: 'acct-placeholder', name: '占位', type: 'custom', custom: { url: PLACEHOLDER_URL } }],
    revision: before.payload.revision,
  })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /无法还原/)
  const after = await accountsGet(routes)
  assert.equal(after.payload.accounts.some((item) => item.id === 'acct-placeholder'), false)
})

// 终验缺陷 1:非法 URL(含 userinfo 但无主机)此前照单全收,GET 原样回显,
// last.error 里的同一串也不脱敏;保存要拒、回显要安全失败
const INVALID_BASE = 'https://leak-user-' + 'secret' + ':' + 'leak-pass-' + 'secret' + '@'
const INVALID_CUSTOM = 'leak-user-' + 'secret' + '@'

test('V1-a 非法 URL 保存被拒:400 且响应不回显原值', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const before = await accountsGet(routes)
  const res = await accountsPost(routes, {
    accounts: [{ id: 'acct-bad-url', name: 'bad', type: 'custom', baseUrl: INVALID_BASE, custom: { url: '' } }],
    revision: before.payload.revision,
  })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /baseUrl/)
  assert.equal(JSON.stringify(res.payload).includes('leak-user-secret'), false, '拒绝信息不得回显原值')

  const custom = await accountsPost(routes, {
    accounts: [{ id: 'acct-bad-custom', name: 'bad', type: 'custom', custom: { url: INVALID_CUSTOM } }],
    revision: before.payload.revision,
  })
  assert.equal(custom.status, 400)
  assert.match(custom.payload.error, /custom\.url/)
  assert.equal(JSON.stringify(custom.payload).includes('leak-user-secret'), false)

  const after = await accountsGet(routes)
  assert.equal(JSON.stringify(after.payload).includes('leak-user-secret'), false)
  assert.equal(after.payload.accounts.some((item) => item.id.startsWith('acct-bad')), false, '非法账号不得落盘')
  // 合法地址仍可保存,校验不得误伤
  const ok = await accountsPost(routes, {
    accounts: [{ id: 'acct-good-url', name: 'good', type: 'custom', baseUrl: 'https://api.example.test/v1', custom: { url: 'https://api.example.test/usage' } }],
    revision: after.payload.revision,
  })
  assert.equal(ok.status, 200)
})

test('V1-b 已落盘的非法 URL 回显整体占位,错误体 userinfo 同样遮住', async () => {
  const { ctx, routes } = makeCtx()
  await writeFile(join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{
      id: 'acct-bad-url',
      name: 'bad',
      type: 'custom',
      baseUrl: INVALID_BASE,
      apiKey: '',
      custom: { url: '', method: 'GET', headers: {}, body: '', extract: {} },
      last: { ok: false, reading: null, error: 'request ' + INVALID_BASE + ' failed', queriedAt: 1 },
    }],
  }), 'utf8')
  try {
    apply(ctx)
    const res = await accountsGet(routes)
    const text = JSON.stringify(res.payload)
    assert.equal(text.includes('leak-user-secret'), false, '回显不得包含非法 URL 的 userinfo')
    assert.equal(text.includes('leak-pass-secret'), false)
    const account = res.payload.accounts[0]
    assert.equal(account.baseUrl, '[已隐藏]', '无法按分量脱敏的 URL 整体置占位')
    assert.equal(account.last.error.includes('[已隐藏]'), true, 'last.error 里的同串凭据同样要遮住')
  } finally {
    await writeFile(join(tempDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [] }), 'utf8')
  }
})

// 终验缺陷 2:自定义头/体整块属凭据面,上游错误体把它们带回时此前未进脱敏集合
const CRED_HEADER = 'header-' + 'secret' + '-1'
const CRED_TRACE = 'trace-' + 'secret' + '-1'
const CRED_BODY = 'body-' + 'secret' + '-1'

test('V2 自定义请求头/体凭据进入 last.error 脱敏集合', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const base = customAccount()
  await accountsPost(routes, {
    accounts: [customAccount({
      custom: {
        ...base.custom,
        headers: { Authorization: 'Bearer ' + CRED_HEADER, 'X-Trace': CRED_TRACE },
        body: JSON.stringify({ apiKey: CRED_BODY, model: 'm-1' }),
      },
    })],
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({
      error: { message: 'rejected X-Trace: ' + CRED_TRACE + ' auth: Bearer ' + CRED_HEADER + ' body: ' + CRED_BODY },
    }),
  })
  try {
    const queried = await queryAccount(routes, 'acct-custom')
    assert.equal(queried.payload.ok, false)
    const after = await accountsGet(routes)
    const text = JSON.stringify(after.payload)
    assert.equal(text.includes(CRED_HEADER), false, '自定义头值(Authorization)不得随错误体回传')
    assert.equal(text.includes(CRED_TRACE), false, '自定义头值(X-Trace)不得随错误体回传')
    assert.equal(text.includes(CRED_BODY), false, '自定义体值不得随错误体回传')
    assert.match(after.payload.accounts[0].last.error, /rejected/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// P-D2:体字段名不可信(access_key/auth/pin 都不是凭据词),字符串值必须整体视为凭据
const BANK_ACCESS = 'AK-' + 'secret' + '-1'
const BANK_AUTH = 'auth-' + 'secret' + '-1'
const BANK_PIN = 'pin-' + 'secret' + '-1'

test('P2-a 自定义体非凭据词命名字段(access_key/auth/pin)同样脱敏,数字结构保留', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const body = JSON.stringify({
    access_key: BANK_ACCESS,
    auth: BANK_AUTH,
    pin: BANK_PIN,
    model: 'deepseek-chat',
    max_tokens: 128,
  }, null, 2)
  const base = customAccount()
  const saved = await accountsPost(routes, {
    accounts: [customAccount({ custom: { ...base.custom, body } })],
  })
  assert.equal(saved.status, 200)

  const res = await accountsGet(routes)
  const text = JSON.stringify(res.payload)
  for (const secret of [BANK_ACCESS, BANK_AUTH, BANK_PIN]) {
    assert.equal(text.includes(secret), false, `响应不得回显体值 ${secret}`)
  }
  const returned = JSON.parse(res.payload.accounts[0].custom.body)
  assert.deepEqual(Object.keys(returned).sort(), ['access_key', 'auth', 'max_tokens', 'model', 'pin'])
  assert.equal(returned.access_key, '[已隐藏]')
  assert.equal(returned.auth, '[已隐藏]')
  assert.equal(returned.pin, '[已隐藏]')
  assert.equal(returned.max_tokens, 128, '数字结构保留,便于核对体形状')
})

test('P2-b 体占位原样回存后磁盘仍是原始值(整段脱敏不破坏回存)', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const base = customAccount()
  const body = JSON.stringify({ access_key: BANK_ACCESS, auth: BANK_AUTH, pin: BANK_PIN, model: 'm-2' }, null, 2)
  await accountsPost(routes, { accounts: [customAccount({ custom: { ...base.custom, body } })] })
  const before = await accountsGet(routes)

  const res = await accountsPost(routes, { accounts: before.payload.accounts, revision: before.payload.revision })
  assert.equal(res.status, 200, '整段占位可原样回存')
  const disk = await persisted()
  assert.equal(disk.accounts[0].custom.body, body, '磁盘保留原始体,未落占位符')
})
