// archive-reader 行为测试:宿主 sessionPersistence API 多版本适配层的
// 工厂分派与各代映射。宿主 API 形状以各代真实签名为蓝本,collector 只见
// 内部统一契约(list → [{id}],readLog → {inheritedEventCount, events})。
// 分页读、close 吞错、畸形行丢弃对齐竞品 0.1.12 双路径语义;
// V3 日志兼容由 collector 测试的专有事件忽略用例钉住。

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

test('handle 代:list 归一 snapshot 为 {id},signal 包裹透传,畸形行丢弃', async () => {
  const seen = []
  const persistence = {
    async list(options) {
      seen.push(options)
      return [
        { header: { id: 'a' }, revision: 'r1', sizeBytes: 10 },
        { header: { id: 'b' }, revision: 'r2' },
        { revision: 'no-header' },
        null,
        { header: { id: '' } },
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

test('handle 代:readLog 分页循环直到空页,handle 元数据透出', async () => {
  const calls = []
  const events = Array.from({ length: 1250 }, (_, seq) => ev(seq))
  const persistence = {
    async open(id, access, options) {
      calls.push(['open', id, access, options])
      return {
        header: { id },
        inheritedEventCount: 3,
        async read(offset, length, readOptions) {
          calls.push(['read', offset, length])
          assert.equal(typeof readOptions, 'object')
          assert.equal(length, 500)
          return { eventState: 'detached', events: events.slice(offset, offset + length) }
        },
        async close() {
          calls.push(['close'])
        },
      }
    },
  }
  const signal = new AbortController().signal
  const reader = createArchiveReader(persistence)
  const result = await reader.readLog('s1', signal)
  assert.equal(result.inheritedEventCount, 3)
  assert.deepEqual(result.events, events)
  const reads = calls.filter(([kind]) => kind === 'read')
  // 1250 条 = 500+500+250 三页取到,第 4 次读到空页才终止
  assert.equal(reads.length, 4)
  assert.deepEqual(reads.map(([, offset]) => offset), [0, 500, 1000, 1250])
  assert.deepEqual(calls[calls.length - 1], ['close'])
})

test('handle 代:inheritedEventCount 非法值回落 0', async () => {
  const persistence = {
    async open() {
      return {
        inheritedEventCount: -5,
        async read() {
          return { eventState: 'detached', events: [] }
        },
        async close() {},
      }
    },
  }
  const reader = createArchiveReader(persistence)
  const result = await reader.readLog('s1')
  assert.equal(result.inheritedEventCount, 0)
  assert.deepEqual(result.events, [])
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

test('handle 代:read 成功后 close 失败被吞掉,读取结果照常返回', async () => {
  let closed = 0
  const events = [ev(0)]
  let reads = 0
  const persistence = {
    async open() {
      return {
        inheritedEventCount: 0,
        async read() {
          reads += 1
          // 首读返回数据页,再读返回空页终止分页循环
          return { eventState: 'detached', events: reads === 1 ? events : [] }
        },
        async close() {
          closed += 1
          throw new Error('close failure')
        },
      }
    },
  }
  const reader = createArchiveReader(persistence)
  const result = await reader.readLog('s1')
  assert.equal(closed, 1)
  assert.deepEqual(result, { inheritedEventCount: 0, events })
})

test('handle 代:abort 中断分页循环,当前页已读数据保留', async () => {
  const controller = new AbortController()
  const events = Array.from({ length: 700 }, (_, seq) => ev(seq))
  const persistence = {
    async open() {
      return {
        inheritedEventCount: 0,
        async read(offset) {
          if (offset > 0) controller.abort()
          return { eventState: 'detached', events: events.slice(offset, offset + 500) }
        },
        async close() {},
      }
    },
  }
  const reader = createArchiveReader(persistence)
  // abort 在第二页读取时触发:第二页已返回故被保留,下一轮循环检测到中止退出
  const result = await reader.readLog('s1', controller.signal)
  assert.equal(result.events.length, 700)
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

test('inspect 代:list 归一 header 数组为 {id},signal 直传,畸形行丢弃', async () => {
  const seen = []
  const persistence = {
    async list(arg) {
      seen.push(arg)
      return [{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }, null, {}]
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
