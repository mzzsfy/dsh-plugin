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
    watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, marks: [], group: '' } } },
    providers: base.providers.map(({ credentialRef, ...rest }) => ({ ...rest, credentialEnv: credentialRef })),
  }
  await writeFile(join(dir, 'stock_assistant.json'), legacyDocument(legacyRoot))
  const state = await openState(facilityOf(backend))
  const root = state.get()
  assert.equal(root.providers.every(p => 'credentialRef' in p && !('credentialEnv' in p)), true, '旧字段读出来就是新字段')
  assert.deepEqual(root.watchlist.order, [security.id], '自选不能被兼容逻辑顺带清掉')
  // 下一次 control 写入才把记录换成新字段(打开本身只读)
  await state.mutate(operation(1, base.revision), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  assert.equal((await readFile(join(dir, 'stock_assistant.json'), 'utf8')).includes('credentialEnv'), false, '写入后不再有旧字段')
  await state.close()
})

// 旧文件里的缓存表不再声明: 打开时忽略, 下次写入后文件从几 MB 缩成一条控制记录
test('S10 旧文件里的缓存数据被丢弃, 写入后文件只剩控制记录', async t => {
  const dir = await withDir(t, 'stock-single-shrink-'), backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const base = initialControl(), security = makeSecurity('XSHG', '600519', '贵州茅台')
  const legacyRoot = {
    ...base,
    watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '茅台', pinned: false, marks: [], group: '' } } },
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
