import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openState } from '../src/state.mjs'
import { initialControl, domainSpec } from '../src/schemas.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { operation } from './helpers.mjs'

const facilityOf = backend => new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {}, error() {} } }, { backend: 'isolated' })
async function withDir(t, prefix = 'stock-domain-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const legacyDocument = (root, cache = {}) => JSON.stringify({ unit: { name: 'stock_assistant', version: 1 }, global: null, tables: { control: { root }, cache } })

test('S08 控制记录用真实DomainFacility回读, 关闭后可重开', async t => {
  const dir = await withDir(t), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const facility = facilityOf(backend)
  const state = await openState(facility)
  await state.mutate(operation(), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  await state.close()
  const reopened = await openState(facility)
  assert.equal(reopened.get().revision, 1)
  assert.equal(reopened.get().preferences.refreshSeconds, 60)
  await reopened.close()
})

// 存量字段改名的归一必须落在数据域 schema 上: 校验发生在 storageDomain.open, 早于 openState。
// 只在 openState 里迁移等于永远跑不到, 插件会整体未激活(2026-11-10 现场)。
test('S09 存量 credentialEnv 记录打开即归一, 自选不丢', async t => {
  const dir = await withDir(t), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const base = initialControl(), security = makeSecurity('XSHG', '600519', '贵州茅台')
  const legacyRoot = {
    ...base,
    watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, marks: [], tags: ['沪A'] } } },
    providers: base.providers.map(({ credentialRef, ...rest }) => ({ ...rest, credentialEnv: credentialRef })),
  }
  await writeFile(join(dir, 'stock_assistant.json'), legacyDocument(legacyRoot))
  const state = await openState(facilityOf(backend))
  const root = state.get()
  assert.equal(root.providers.every(p => 'credentialRef' in p && !('credentialEnv' in p)), true, '旧字段读出来就是新字段')
  assert.deepEqual(root.watchlist.order, [security.id], '自选不能被兼容逻辑顺带清掉')
  // 归一发生在打开时, schema 判定有差异即回写; 后续写入继续沿用新字段
  assert.equal((await readFile(join(dir, 'stock_assistant.json'), 'utf8')).includes('credentialEnv'), false, '打开即回写新字段')
  await state.mutate(operation(1, base.revision), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  assert.equal((await readFile(join(dir, 'stock_assistant.json'), 'utf8')).includes('credentialEnv'), false, '写入后不再有旧字段')
  await state.close()
})

// P1-10: 旧记录把代理账号密码写在 URL userinfo 里, 打开时剥离; 打开即回写, 不等下一次写入
test('P1-10 存量代理 userinfo 打开即剥离, 持久化不再含账号密码', async t => {
  const dir = await withDir(t), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const base = initialControl()
  const legacyProxy = 'https://' + ['proxy-user', 'proxy-secret'].join(':') + '@proxy.corp:8443'
  const legacyRoot = { ...base, providers: base.providers.map((p, index) => index === 0 ? { ...p, proxy: legacyProxy } : p) }
  const file = join(dir, 'stock_assistant.json')
  await writeFile(file, legacyDocument(legacyRoot))
  const state = await openState(facilityOf(backend))
  const proxy = state.get().providers[0].proxy
  assert.equal(typeof proxy, 'string')
  const url = new URL(proxy)
  assert.equal(url.username, '', '用户名不得留在内存配置')
  assert.equal(url.password, '', '密码不得留在内存配置')
  // K3: 归一差异在 openState 内回写, 用户没有任何写操作也不该留下明文
  const opened = await readFile(file, 'utf8')
  assert.equal(opened.includes('proxy-user'), false, '打开即回写: 持久化文件不得含代理用户名')
  assert.equal(opened.includes('proxy-secret'), false, '打开即回写: 持久化文件不得含代理密码')
  await state.mutate(operation(1, base.revision), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  const persisted = await readFile(file, 'utf8')
  assert.equal(persisted.includes('proxy-user'), false, '持久化文件不得含代理用户名')
  assert.equal(persisted.includes('proxy-secret'), false, '持久化文件不得含代理密码')
  await state.close()
})

// K2/K3: 反代端点 userinfo 与 operations 里的配置副本同样是明文入口: 打开即回写, 三处都清洗
test('K2/K3 打开即回写: 端点和 operations 载荷都不再留明文', async t => {
  const dir = await withDir(t), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const base = initialControl()
  const userinfo = (host, path = '') => `https://${['legacy-user', 'legacy-secret'].join(':')}@${host}${path}`
  const legacyProvider = { ...base.providers[0], proxy: userinfo('proxy.example.com:8443'), endpoints: { kline: userinfo('mirror.example.com', '/kline') } }
  const legacyRoot = {
    ...base,
    providers: [legacyProvider, ...base.providers.slice(1)],
    operations: [{ id: crypto.randomUUID(), hash: 'h', at: 1, result: { revision: 1 }, action: 'configuration', payload: { providers: [legacyProvider], endpoints: { quotes: userinfo('alt.example.com', '/quotes') } } }],
  }
  const file = join(dir, 'stock_assistant.json')
  await writeFile(file, legacyDocument(legacyRoot))
  const state = await openState(facilityOf(backend))
  const opened = await readFile(file, 'utf8')
  assert.equal(opened.includes('legacy-user'), false, '打开即回写: 文件不得含端点/代理用户名')
  assert.equal(opened.includes('legacy-secret'), false, '打开即回写: 文件不得含端点/代理密码')
  const root = state.get()
  assert.equal(new URL(root.providers[0].proxy).username, '', '代理 URL 无 userinfo')
  assert.equal(new URL(root.providers[0].endpoints.kline).username, '', '端点 URL 无 userinfo')
  const payload = root.operations[0].payload
  assert.equal(new URL(payload.providers[0].proxy).username, '', 'operations.payload.providers 同样剥离')
  assert.equal(new URL(payload.endpoints.quotes).username, '', 'operations.payload.endpoints 同样剥离')
  await state.close()
})

// Given 数据文件里只有单值 group When 真实数据域打开并写入 Then tags 生效且文件不再保留旧字段。
// 归一实现本身在 tags-schema 的 TAG01 先行验证过, 这里锁的是 storageDomain.open 这条真实路径。
test('TAG06 存量 group 记录打开即归一为 tags', async t => {
  const dir = await withDir(t, 'stock-group-migrate-'), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const base = initialControl(), security = makeSecurity('XSHG', '600519', '贵州茅台')
  const legacyRoot = { ...base, watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, marks: [], group: '白酒' } } } }
  const file = join(dir, 'stock_assistant.json')
  await writeFile(file, legacyDocument(legacyRoot))
  const state = await openState(facilityOf(backend))
  assert.deepEqual(state.get().watchlist.items[security.id].tags, ['白酒'])
  await state.mutate(operation(1, base.revision), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  const text = await readFile(file, 'utf8')
  assert.equal(text.includes('"group"'), false, '写入后不再有旧字段')
  assert.deepEqual(JSON.parse(text).tables.control.root.watchlist.items[security.id].tags, ["白酒"])
  await state.close()
})

// 旧文件里的缓存表不再声明: 打开时忽略, 下次写入后文件从几 MB 缩成一条控制记录
test('S10 旧文件里的缓存数据被丢弃, 写入后文件只剩控制记录', async t => {
  const dir = await withDir(t, 'stock-single-shrink-'), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const base = initialControl(), security = makeSecurity('XSHG', '600519', '贵州茅台')
  const legacyRoot = {
    ...base,
    watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '茅台', pinned: false, marks: [], tags: ['沪A'] } } },
  }
  const bigCache = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`kline:em:XSHG:1d:6005${i}`, { kind: 'kline', source: 'em', fetchedAt: i, payload: { candles: 'x'.repeat(40_000) } }]))
  const file = join(dir, 'stock_assistant.json')
  await writeFile(file, legacyDocument(legacyRoot, bigCache))
  const before = (await stat(file)).size
  const state = await openState(facilityOf(backend))
  assert.equal(state.cache.size, 0, '缓存不落盘, 打开时也没有历史缓存')
  assert.equal(state.get().watchlist.items[security.id].alias, '茅台')
  await state.mutate(operation(1, base.revision), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  const text = await readFile(file, 'utf8')
  const after = (await stat(file)).size
  assert.equal(text.includes('kline:'), false, '缓存键不再留在文件里')
  assert.ok(after < before / 10, `文件应缩到控制记录大小(前 ${before}, 后 ${after})`)
  await state.close()
})

// single 布局只有一个文档: 坏文件不会被当缺失覆盖, 直接拒绝打开 —— 数据坏了就别再动它
test('S11 控制文件不可解析时拒绝打开且不覆盖', async t => {
  const dir = await withDir(t, 'stock-broken-file-'), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const file = join(dir, 'stock_assistant.json'), broken = '{"unit":{"name":"stock_assistant","version":1},"tables":{'
  await writeFile(file, broken)
  await assert.rejects(openState(facilityOf(backend)), error => error.code === 'malformed-medium')
  assert.equal(await readFile(file, 'utf8'), broken, '坏文件原样保留')
})

// 版本不认与 schema 不合法同样是打开失败、原字节不动(single 布局是硬校验)
test('S11b 版本不认时拒绝打开且不覆盖', async t => {
  const dir = await withDir(t, 'stock-version-mismatch-'), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const file = join(dir, 'stock_assistant.json')
  const text = JSON.stringify({ unit: { name: 'stock_assistant', version: 99 }, global: null, tables: { control: { root: initialControl() } } })
  await writeFile(file, text)
  await assert.rejects(openState(facilityOf(backend)), error => error.code === 'version-mismatch')
  assert.equal(await readFile(file, 'utf8'), text)
})

test('S11c 控制记录不合 schema 时拒绝打开且不覆盖', async t => {
  const dir = await withDir(t, 'stock-invalid-record-'), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const file = join(dir, 'stock_assistant.json')
  const text = JSON.stringify({ unit: { name: 'stock_assistant', version: 1 }, global: null, tables: { control: { root: { revision: 'not-a-number' } } } })
  await writeFile(file, text)
  await assert.rejects(openState(facilityOf(backend)), error => error.code === 'invalid-record')
  assert.equal(await readFile(file, 'utf8'), text)
})

test('S12 首次安装初始化空自选并落盘', async t => {
  const dir = await withDir(t, 'stock-fresh-install-'), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const state = await openState(facilityOf(backend))
  assert.deepEqual(state.get().watchlist.order, [])
  const text = await readFile(join(dir, 'stock_assistant.json'), 'utf8')
  assert.match(text, /"revision": 0/)
  assert.match(text, new RegExp(`"name": "${domainSpec.name}"`))
  await state.close()
})

// 内存缓存: 超限丢最久未写的, 遍历接口与数据域 table 同形(catalog 依赖 entries)
test('S13 内存缓存有上限且提供 entries', async () => {
  const { createMemoryCache } = await import('../src/memory-cache.mjs')
  const cache = createMemoryCache({ limit: 2 })
  await cache.put('a', 1); await cache.put('b', 2); await cache.put('c', 3)
  assert.equal(cache.size, 2)
  assert.equal(cache.get('a'), undefined, '最久未写的被丢掉')
  assert.deepEqual([...cache.entries()].map(([key]) => key), ['b', 'c'])
  await cache.put('b', 9)
  assert.equal(cache.get('b'), 9)
})

// 有效文件但没有控制记录: 视为首次安装, 初始化后落盘
test('S11d 有效文件缺少控制记录时初始化为空自选', async t => {
  const dir = await withDir(t, 'stock-empty-tables-'), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const file = join(dir, 'stock_assistant.json')
  await writeFile(file, JSON.stringify({ unit: { name: 'stock_assistant', version: 1 }, global: null, tables: { control: {} } }))
  const state = await openState(facilityOf(backend))
  assert.deepEqual(state.get().watchlist.order, [])
  assert.match(await readFile(file, 'utf8'), /"revision": 0/)
  await state.close()
})
