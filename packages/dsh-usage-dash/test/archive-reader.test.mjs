// archive-reader 行为测试:宿主 sessionPersistence API 多版本适配层的
// 工厂分派与各代映射。宿主 API 形状以各代真实签名为蓝本,collector 只见
// 内部统一契约(list → [{id}],readLog → {inheritedEventCount, events})。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createArchiveReader } from '../src/archive-reader.js'

const ev = (seq) => ({ type: 'turn/end', seq, time: 0, data: { turn: 0 } })
const NAMES = {
  handle: 'HandleArchiveReader',
  inspect: 'InspectArchiveReader',
  unknown: 'UnknownArchiveReader',
}
const nameOf = (reader) => reader.constructor.name

test('工厂:open 形宿主分派到 handle 代适配器', () => {
  const persistence = { open: () => {}, list: () => {} }
  assert.equal(nameOf(createArchiveReader(persistence)), NAMES.handle)
})

test('工厂:inspect 形宿主分派到 inspect 代适配器', () => {
  const persistence = { inspect: () => {}, list: () => {} }
  assert.equal(nameOf(createArchiveReader(persistence)), NAMES.inspect)
})

test('工厂:两代形状都不匹配分派到 unknown 恒抛适配器', async () => {
  const reader = createArchiveReader({})
  assert.equal(nameOf(reader), NAMES.unknown)
  await assert.rejects(reader.list(), /sessionPersistence/)
  await assert.rejects(reader.readLog('s1'), /sessionPersistence/)
})

test('handle 代:list 归一 snapshot 为 {id},signal 包裹透传', async () => {
  const seen = []
  const persistence = {
    async list(options) {
      seen.push(options)
      return [
        { header: { id: 'a' }, revision: 'r1', sizeBytes: 10 },
        { header: { id: 'b' }, revision: 'r2' },
      ]
    },
    async open() {
      throw new Error('not reached')
    },
  }
  const signal = new AbortController().signal
  const reader = createArchiveReader(persistence)
  assert.deepEqual(await reader.list(signal), [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual(seen, [{ signal }])
})

test('handle 代:readLog 经 open(read)/read/close 整读,handle 元数据透出', async () => {
  const calls = []
  const events = [ev(0), ev(1)]
  const persistence = {
    async open(id, access, options) {
      calls.push(['open', id, access, options])
      return {
        header: { id },
        inheritedEventCount: 3,
        async read(offset, length, readOptions) {
          calls.push(['read', offset, length, readOptions])
          return { eventState: 'detached', events }
        },
        async close() {
          calls.push(['close'])
        },
      }
    },
  }
  const signal = new AbortController().signal
  const reader = createArchiveReader(persistence)
  assert.deepEqual(
    await reader.readLog('s1', signal),
    { inheritedEventCount: 3, events },
  )
  assert.deepEqual(calls, [
    ['open', 's1', 'read', { signal }],
    ['read', 0, undefined, { signal }],
    ['close'],
  ])
})

test('handle 代:read 抛错时 close 仍被调用且原错误传播', async () => {
  let closed = 0
  const failure = new Error('corrupted log')
  const persistence = {
    async open() {
      return {
        inheritedEventCount: 0,
        async read() {
          throw failure
        },
        async close() {
          closed += 1
        },
      }
    },
  }
  const reader = createArchiveReader(persistence)
  await assert.rejects(reader.readLog('s1'), (error) => error === failure)
  assert.equal(closed, 1)
})

test('handle 代:read 抛错且 close 也抛错时,原错误传播不被掩盖', async () => {
  const failure = new Error('corrupted log')
  const persistence = {
    async open() {
      return {
        inheritedEventCount: 0,
        async read() {
          throw failure
        },
        async close() {
          throw new Error('close failure')
        },
      }
    },
  }
  const reader = createArchiveReader(persistence)
  await assert.rejects(reader.readLog('s1'), (error) => error === failure)
})

test('handle 代:read 成功后 close 拒绝则 readLog 整体拒绝', async () => {
  let closed = 0
  const closeFailure = new Error('close failure')
  const persistence = {
    async open() {
      return {
        inheritedEventCount: 0,
        async read() {
          return { eventState: 'detached', events: [ev(0)] }
        },
        async close() {
          closed += 1
          throw closeFailure
        },
      }
    },
  }
  const reader = createArchiveReader(persistence)
  await assert.rejects(reader.readLog('s1'), (error) => error === closeFailure)
  assert.equal(closed, 1)
})

test('handle 代:open 抛错直接传播,不触发 close', async () => {
  const failure = new Error('format unsupported')
  const persistence = {
    async open() {
      throw failure
    },
  }
  const reader = createArchiveReader(persistence)
  await assert.rejects(reader.readLog('s1'), (error) => error === failure)
})

test('inspect 代:list 归一 header 数组为 {id},signal 直传', async () => {
  const seen = []
  const persistence = {
    async list(arg) {
      seen.push(arg)
      return [{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }]
    },
    async inspect() {
      throw new Error('not reached')
    },
  }
  const signal = new AbortController().signal
  const reader = createArchiveReader(persistence)
  assert.deepEqual(await reader.list(signal), [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual(seen, [signal])
})

test('inspect 代:readLog 经 inspect 整读,signal 直传', async () => {
  const seen = []
  const events = [ev(0)]
  const signal = new AbortController().signal
  const persistence = {
    async inspect(id, arg) {
      seen.push([id, arg])
      return { meta: { id }, inheritedEventCount: 2, events }
    },
  }
  const reader = createArchiveReader(persistence)
  assert.deepEqual(
    await reader.readLog('s1', signal),
    { inheritedEventCount: 2, events },
  )
  assert.deepEqual(seen, [['s1', signal]])
})
