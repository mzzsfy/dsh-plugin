// 请求日志环形缓冲 BDD: 滚动保留最近 N 条、容量可关、按隧道过滤、字段截断。
// 规格: docs/设计-隧道请求日志.md。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createRequestLog,
  DEFAULT_REQUEST_LOG_LIMIT,
  REQUEST_LOG_LIMIT_MAX,
  REQUEST_LOG_PATH_MAX,
  REQUEST_LOG_ERROR_MAX,
} from '../src/request-log.mjs'

const entryOf = (index, patch = {}) => ({
  at: `2026-11-23T10:00:0${index}.000Z`,
  tunnel: 'app',
  kind: 'http',
  method: 'GET',
  path: `/request-${index}`,
  status: 200,
  ms: index,
  ...patch,
})

test('Given 空日志 When 查询 Then 返回空数组', () => {
  const log = createRequestLog(() => 3)
  assert.deepEqual(log.list(), [])
})

test('Given 三次请求 When 容量 3 Then 新请求在前且字段完整', () => {
  const log = createRequestLog(() => 3)
  for (let index = 1; index <= 3; index += 1) log.record(entryOf(index))
  const items = log.list()
  assert.deepEqual(items.map((item) => item.path), ['/request-3', '/request-2', '/request-1'])
  const { seq, ...entry } = items[0]
  assert.deepEqual(entry, entryOf(3))
  assert.ok(Number.isInteger(seq) && seq > 0, '条目带稳定序号供列表 key')
})

test('Given 容量 2 When 第三次请求 Then 最旧一条被淘汰', () => {
  const log = createRequestLog(() => 2)
  for (let index = 1; index <= 3; index += 1) log.record(entryOf(index))
  assert.deepEqual(log.list().map((item) => item.path), ['/request-3', '/request-2'])
})

test('Given 容量 0 When 记录请求 Then 日志保持为空且不抛错', () => {
  const log = createRequestLog(() => 0)
  log.record(entryOf(1))
  assert.deepEqual(log.list(), [])
})

test('Given 容量被调小 When 再次记录 Then 缓冲按新容量裁剪', () => {
  let limit = 3
  const log = createRequestLog(() => limit)
  for (let index = 1; index <= 3; index += 1) log.record(entryOf(index))
  limit = 1
  log.record(entryOf(4))
  assert.deepEqual(log.list().map((item) => item.path), ['/request-4'])
})

test('Given 已有 5 条 When trim 到 2 Then 物理裁剪, 调回 5 不复现; trim 到 0 则清空', () => {
  let limit = 5
  const log = createRequestLog(() => limit)
  for (let index = 1; index <= 5; index += 1) log.record(entryOf(index))
  limit = 2
  log.trim()
  assert.equal(log.list().length, 2)
  limit = 5
  log.trim()
  assert.equal(log.list().length, 2, '调高容量不得恢复已裁剪条目')
  limit = 0
  log.trim()
  assert.deepEqual(log.list(), [])
  limit = 5
  assert.deepEqual(log.list(), [], '关闭后重开不得恢复旧条目')
})

test('Given 非法容量 When 记录 Then 回退默认容量', () => {
  for (const limit of [Number.NaN, -1, REQUEST_LOG_LIMIT_MAX + 1]) {
    const log = createRequestLog(() => limit)
    for (let index = 0; index <= DEFAULT_REQUEST_LOG_LIMIT; index += 1) log.record(entryOf(index % 10, { path: `/p-${index}` }))
    assert.equal(log.list().length, DEFAULT_REQUEST_LOG_LIMIT, `容量 ${limit} 应回退默认值`)
  }
})

test('Given 多隧道日志 When 按名字过滤 Then 只返回命中隧道, 且支持 limit', () => {
  const log = createRequestLog(() => 10)
  log.record(entryOf(1, { tunnel: 'app' }))
  log.record(entryOf(2, { tunnel: 'web' }))
  log.record(entryOf(3, { tunnel: 'app' }))
  assert.deepEqual(log.list({ name: 'app' }).map((item) => item.path), ['/request-3', '/request-1'])
  assert.deepEqual(log.list({ name: 'app', limit: 1 }).map((item) => item.path), ['/request-3'])
  assert.equal(log.list({ name: 'missing' }).length, 0)
})

test('Given 超长路径与错误 When 记录 Then 按上限截断, 未知字段不进入缓冲', () => {
  const log = createRequestLog(() => 2)
  log.record(entryOf(1, { path: '/x'.repeat(REQUEST_LOG_PATH_MAX), error: 'e'.repeat(REQUEST_LOG_ERROR_MAX * 2), secret: 'drop-me' }))
  const [item] = log.list()
  assert.equal(item.path.length, REQUEST_LOG_PATH_MAX)
  assert.equal(item.error.length, REQUEST_LOG_ERROR_MAX)
  assert.equal('secret' in item, false)
})

test('Given 返回副本 When 修改结果 Then 不污染缓冲', () => {
  const log = createRequestLog(() => 2)
  log.record(entryOf(1))
  log.list()[0].path = '/tampered'
  assert.equal(log.list()[0].path, '/request-1')
})
