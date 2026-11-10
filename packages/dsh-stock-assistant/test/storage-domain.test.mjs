import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openState } from '../src/state.mjs'
import { initialControl } from '../src/schemas.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { operation } from './helpers.mjs'

// 每域一个文件的极简 backend: 只用于两域打开/关闭与归一, 不做 schema 校验
function fileBackend(dir) {
  const docs = new Map()
  return { kv: { async open(descriptor) {
    const file = join(dir, `${descriptor.name}.json`)
    let doc = docs.get(descriptor.name)
    if (!doc) {
      doc = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({ global: null, tables: Object.fromEntries(descriptor.tables.map(t => [t, {}])) }))
      docs.set(descriptor.name, doc)
    }
    return {
      loadAll: async () => structuredClone(doc),
      async putRecord(table, key, value) { doc.tables[table][key] = value; await writeFile(file, JSON.stringify(doc)) },
      async close() {},
    }
  } } }
}
const facilityOf = backend => new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {}, error() {} } }, { backend: 'isolated' })
async function withDir(t, prefix = 'stock-domain-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('S08 真实DomainFacility校验两个独立域，关闭重开回读自有结构', async t => {
  const dir = await withDir(t), specs = []
  const backend = { kv: { async open(descriptor) {
    specs.push(descriptor)
    return (await fileBackend(dir).kv.open(descriptor))
  } } }
  const facility = facilityOf(backend)
  const state = await openState(facility)
  await state.mutate(operation(), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  await state.close()
  const reopened = await openState(facility)
  assert.equal(reopened.get().revision, 1)
  assert.equal(reopened.get().preferences.refreshSeconds, 60)
  assert.deepEqual(specs.slice(0, 2).map(s => [s.name, s.tables]), [['stock_assistant', ['control']], ['stock_assistant_cache', ['cache']]])
  assert.equal((await readFile(join(dir, 'stock_assistant.json'), 'utf8')).includes('settings'), false)
  await reopened.close()
})

// 存量字段改名必须落在数据域 schema 上: 校验发生在 storageDomain.open, 早于 openState。
// 只在 openState 里迁移等于永远跑不到, 插件会整体未激活(2026-11-10 现场)。
test('S09 存量 credentialEnv 记录经真实DomainFacility打开即归一, 自选不丢', async t => {
  const dir = await withDir(t)
  const base = initialControl(), security = makeSecurity('XSHG', '600519', '贵州茅台')
  const legacyRoot = {
    ...base,
    watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, marks: [], group: '' } } },
    providers: base.providers.map(({ credentialRef, ...rest }) => ({ ...rest, credentialEnv: credentialRef })),
  }
  await writeFile(join(dir, 'stock_assistant.json'), JSON.stringify({ global: null, tables: { control: { root: legacyRoot }, cache: {} } }))
  const state = await openState(facilityOf(fileBackend(dir)))
  const root = state.get()
  assert.equal(root.providers.every(p => 'credentialRef' in p && !('credentialEnv' in p)), true, '旧字段读出来就是新字段')
  assert.deepEqual(root.watchlist.order, [security.id], '自选不能被兼容逻辑顺带清掉')
  assert.equal(root.revision, base.revision)
  // 下一次 control 写入才把记录整体换成新字段(打开本身只读)
  await state.mutate(operation(), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  assert.equal((await readFile(join(dir, 'stock_assistant.json'), 'utf8')).includes('credentialEnv'), false, '写入后记录不再有旧字段')
  await state.close()
})

// 宿主 0.2.2 的 json backend: per-record 目录缺失时从同名整域单文件 bootstrap 出已声明的表,
// 未声明的 cache 被跳过(它的旧键含冒号, 在 Windows 上根本不能当文件名), 旧文件保留不改。
test('S10 整域单文件迁移到按记录目录: 控制面全搬, 缓存表被跳过, 旧文件保留', async t => {
  const dir = await withDir(t, 'stock-legacy-migrate-')
  const base = initialControl(), security = makeSecurity('XSHG', '600519', '贵州茅台')
  const legacyRoot = {
    ...base,
    revision: 55,
    watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '茅台', pinned: false, marks: [], group: '' } } },
    providers: base.providers.map(({ credentialRef, ...rest }) => ({ ...rest, credentialEnv: credentialRef })),
  }
  const legacyText = JSON.stringify({ unit: { name: 'stock_assistant', version: 1 }, global: null, tables: { control: { root: legacyRoot }, cache: { 'kline:em-default:XSHG:1d:600519': { kind: 'kline', source: 'em-default', fetchedAt: 1, payload: {} } } } })
  await writeFile(join(dir, 'stock_assistant.json'), legacyText)
  const backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const state = await openState(facilityOf(backend))
  assert.equal(state.get().revision, 55)
  assert.deepEqual(state.get().watchlist.order, [security.id])
  assert.equal(state.get().watchlist.items[security.id].alias, '茅台')
  // 迁移是原样搬记录: 磁盘仍是旧字段, 归一发生在数据域读入时; 因此界面拿到的已是新字段
  const recordFile = join(dir, 'stock_assistant', 'control', 'root.json')
  assert.match(await readFile(recordFile, 'utf8'), /"credentialEnv": null/)
  assert.equal(state.get().providers.every(p => 'credentialRef' in p && !('credentialEnv' in p)), true)
  await state.mutate(operation(1, 55), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  assert.equal((await readFile(recordFile, 'utf8')).includes('credentialEnv'), false, 'control 写入后记录升级为新字段')
  await assert.rejects(readFile(join(dir, 'stock_assistant', 'cache', 'kline:em-default:XSHG:1d:600519.json')), '未声明的 cache 表不该被迁移')
  assert.equal(await readFile(join(dir, 'stock_assistant.json'), 'utf8'), legacyText, '旧整域文件保留不改')
  await state.close()
  const reopened = await openState(facilityOf(backend))
  assert.equal(reopened.get().revision, 56, '按记录目录重开回读, 含上一次写入')
  await reopened.close()
})

// 按记录落盘的核心收益: 一条坏缓存只丢自己(宿主备份成 *.bak.<时间戳>), 不再让整个域打不开
test('S11 坏缓存记录被备份跳过, 控制面与其余缓存照常打开', async t => {
  const dir = await withDir(t, 'stock-broken-cache-')
  await mkdir(join(dir, 'stock_assistant_cache', 'cache'), { recursive: true })
  await writeFile(join(dir, 'stock_assistant_cache', 'cache', 'broken.json'), JSON.stringify({ version: 1, record: { kind: 'kline' } }))
  await writeFile(join(dir, 'stock_assistant_cache', 'cache', 'kline_em-default_XSHG_1d_600519.json'), JSON.stringify({ version: 1, record: { kind: 'kline', source: 'em-default', fetchedAt: 1, payload: {} } }))
  const backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const state = await openState(facilityOf(backend))
  assert.deepEqual([...state.cache.keys()], ['kline_em-default_XSHG_1d_600519'])
  const files = await readdir(join(dir, 'stock_assistant_cache', 'cache'))
  assert.equal(files.some(name => name.startsWith('broken.json.bak.')), true, '坏记录被移出可读集')
  await state.close()
})

// 权威记录被跳过后不能悄悄变成"新装": 至少日志里要能看出备份规律
test('S12 控制记录缺失时按空自选初始化并留下恢复提示', async t => {
  const dir = await withDir(t, 'stock-authority-missing-')
  await mkdir(join(dir, 'stock_assistant', 'control'), { recursive: true })
  await mkdir(join(dir, 'stock_assistant_cache', 'cache'), { recursive: true })
  const backend = new JsonStorageBackend(dir)
  t.after(() => backend.close())
  const warns = []
  const state = await openState(facilityOf(backend), () => {}, Date.now, message => warns.push(message))
  assert.deepEqual(state.get().watchlist.order, [])
  assert.equal(warns.length, 1)
  assert.match(warns[0], /control\/root/)
  await state.close()
})
