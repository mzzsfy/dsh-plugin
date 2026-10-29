import test from 'node:test'
import assert from 'node:assert/strict'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { UsageStore, sharedStore, __resetSharedStoreForTests } from '../src/store.js'

// 真实宿主域,只替换磁盘后端,不读取生产档案或调用回扫。
test('UO1 Given real DomainFacility with live pending owner, When a newcomer collides, Then old tokens remain writable exactly once', async () => {
  const media = new Map(), closes = [], errors = []
  const backend = { kv: { async open(spec) {
    const data = media.get(spec.name) ?? { tables: { buckets: {} }, global: null }
    media.set(spec.name, data)
    return {
      async loadAll() { return structuredClone(data) },
      async setGlobal(value) { data.global = structuredClone(value) },
      async putRecord(table, key, value) { data.tables[table][key] = structuredClone(value) },
      async deleteRecord(table, key) { delete data.tables[table][key] },
      async close() { closes.push(spec.name) },
    }
  } } }
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {} } }, { backend: 'memory' })
  let old, next
  try {
    __resetSharedStoreForTests()
    old = new UsageStore(facility, { onFlushError: error => errors.push(error.message) })
    await old.readyPromise()
    await old.markSeenSessions(['s1'])
    await old.record({ time: Date.now(), model: 'probe/model', inputTokens: 17, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    next = sharedStore(facility)
    await next.readyPromise()
    assert.ok(next.degradation)
    assert.deepEqual(closes, [])
    assert.deepEqual(await old.seenSessions(), new Set(['s1']))
    await old.flushNow()
    await old.flushNow()
    assert.deepEqual(errors, [])
    const sums = Object.entries(media.get('usage_stats').tables.buckets).filter(([key]) => key.startsWith('D|')).reduce((sum, [, row]) => sum + row.inputTokens, 0)
    assert.equal(sums, 17)
    assert.equal(old.pending.size, 0)
    await assert.rejects(next.record({ time: Date.now(), model: 'probe/model', inputTokens: 17 }), /usage store degraded/)
  } finally {
    clearTimeout(old?.flushTimer); clearTimeout(next?.flushTimer)
    await facility.closeAll()
    __resetSharedStoreForTests()
  }
})
