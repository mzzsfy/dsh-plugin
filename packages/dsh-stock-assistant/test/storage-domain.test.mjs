import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openState } from '../src/state.mjs'
import { operation } from './helpers.mjs'
test('S08 真实DomainFacility校验独立域，关闭重开回读自有结构', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-domain-')), file = join(dir, 'domain.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  let spec, live = false
  const backend = { kv: { async open(descriptor) {
    assert.equal(live, false); live = true; spec = descriptor
    let document = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({ global: null, tables: { control: {}, cache: {} } }))
    return { loadAll: async () => structuredClone(document), async putRecord(table, key, value) { document.tables[table][key] = value; await writeFile(file, JSON.stringify(document)) }, async close() { live = false } }
  } } }
  const ctx = { storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {}, error() {} } }
  const facility = new DomainFacility(ctx, { backend: 'isolated' })
  const state = await openState(facility)
  await state.mutate(operation(), c => ({ ...c, preferences: { ...c.preferences, refreshSeconds: 60 } }))
  await state.close()
  const reopened = await openState(facility)
  assert.equal(reopened.get().revision, 1)
  assert.equal(reopened.get().preferences.refreshSeconds, 60)
  assert.deepEqual(spec.tables, ['control', 'cache'])
  assert.equal(spec.name, 'stock_assistant')
  assert.equal((await readFile(file, 'utf8')).includes('settings'), false)
  await reopened.close()
})
