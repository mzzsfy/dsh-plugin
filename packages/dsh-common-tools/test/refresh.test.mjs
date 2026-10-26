import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as host from '../src/host.js'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))
function client() {
  let definition
  const window = { __ModuleLoader__: { load(value) { definition = value } } }
  new Function('window', source)(window)
  return definition.factory(() => ({}))
}

for (const side of ['host', 'client']) {
  test(`Given ${side} 快速失效 When 持续变更 Then 首次立即且后续起始至少间隔一秒并最终收敛`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
    const starts = []
    const api = side === 'host' ? host : client()
    const work = side === 'host' ? api.createChangeNotifier(() => starts.push(Date.now())) : api.createSnapshotRefresh(() => starts.push(Date.now()))
    work.refresh(); await flush()
    assert.deepEqual(starts, [0])
    for (let i = 0; i < 9; i++) { t.mock.timers.tick(100); work.refresh(); await flush() }
    assert.deepEqual(starts, [0])
    t.mock.timers.tick(100); await flush()
    assert.deepEqual(starts, [0, 1000])
    work.refresh(); work.dispose(); t.mock.timers.tick(5000); await flush()
    assert.deepEqual(starts, [0, 1000])
    work.refresh(); await flush(); assert.equal(starts.length, 2)
  })
}

test('Given 快照慢于时间窗且积累变更 When 完成 Then 单飞补拉最新且失败不自动重试', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const starts = [], pending = []
  const work = client().createSnapshotRefresh(() => { starts.push(Date.now()); return new Promise(resolve => pending.push(resolve)) })
  work.refresh(); await flush(); t.mock.timers.tick(2000)
  work.refresh(); work.refresh(); await flush(); assert.equal(starts.length, 1)
  pending.shift()(); await flush(); assert.deepEqual(starts, [0, 2000])
  pending.shift()(); await flush(); t.mock.timers.tick(5000); await flush(); assert.equal(starts.length, 2)
  work.dispose()
  let calls = 0
  const failed = client().createSnapshotRefresh(async () => { calls++; throw Error('planned failure') })
  failed.refresh(); await flush(); t.mock.timers.tick(5000); await flush(); assert.equal(calls, 1)
  failed.dispose()
})

test('Given 快照在途且有dirty When dispose后完成 Then 不再补拉', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let release, count = 0
  const work = client().createSnapshotRefresh(() => { count++; return new Promise(resolve => { release = resolve }) })
  work.refresh(); await flush(); work.refresh(); work.dispose(); release(); t.mock.timers.tick(5000); await flush()
  assert.equal(count, 1)
})
