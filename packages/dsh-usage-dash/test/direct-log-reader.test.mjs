// direct-log-reader 测试:多帧 zstd 解压、JSONL 宽松解析、目录定位与 id 枚举。
// 全部经由 root 参数注入临时目录,不依赖真实 DSH_HOME

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { decodeZstdFile, parseJsonlEvents, parseJsonlLog, findSessionDir, listSessionIdsDirect, readSessionLogDirect } from '../src/direct-log-reader.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'ud-direct-'))
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

test('decodeZstdFile:多帧顺序解压拼接', () => {
  const a = zstdCompressSync(Buffer.from('hello\n'))
  const b = zstdCompressSync(Buffer.from('world\n'))
  const bytes = Buffer.concat([MAGIC.slice(0, 3), a.subarray(3), MAGIC.slice(0, 3), b.subarray(3)])
  assert.equal(decodeZstdFile(bytes), 'hello\nworld\n')
})

test('decodeZstdFile:无帧抛错', () => {
  assert.throws(() => decodeZstdFile(Buffer.from('plain text')), /no zstd frame/)
})

test('parseJsonlEvents:header 行剔除,坏行跳过,事件保留', () => {
  const text = [
    JSON.stringify({ type: 'session/header', id: 's1', version: 1 }),
    JSON.stringify({ type: 'assistant/message', seq: 1, data: { turn: 0, step: 0, usage: { inputTokens: 5 } } }),
    'not json',
    '',
    JSON.stringify({ type: 'request/context', seq: 2, data: { provider: 'p', model: 'm' } }),
  ].join('\n')
  const events = parseJsonlEvents(text)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'assistant/message')
  assert.equal(events[1].type, 'request/context')
})

// 宿主档案首行是 `type: 'session'` 的 header 行,不是事件;直读需要把它
// 交给分类层判定会话是否派生,同时不得混进事件流
test('parseJsonlLog:首行 header 提取为独立字段并从事件流剔除', () => {
  const text = [
    JSON.stringify({ type: 'session', version: 4, id: 'sid-h', parentSession: 'sid-p', origin: 'subagent', delegationDepth: 1 }),
    JSON.stringify({ type: 'turn/end', seq: 0 }),
  ].join('\n')
  const log = parseJsonlLog(text)
  assert.equal(log.header.id, 'sid-h')
  assert.equal(log.header.origin, 'subagent')
  assert.equal(log.events.length, 1)
  assert.equal(log.events[0].type, 'turn/end')
})

test('parseJsonlLog:无 header 行时 header 为 undefined 且事件完整保留', () => {
  const log = parseJsonlLog(JSON.stringify({ type: 'turn/end', seq: 0 }))
  assert.equal(log.header, undefined)
  assert.equal(log.events.length, 1)
})

test('findSessionDir:跨 cwd 桶定位 id 目录', () => {
  const root = tempRoot()
  try {
    const dir = join(root, '--C-users-proj--', 'sid-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from('{}\n')))
    assert.equal(findSessionDir('sid-1', root), dir)
    assert.equal(findSessionDir('missing', root), undefined)
    assert.equal(findSessionDir('sid-1', join(root, 'nope')), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listSessionIdsDirect:只收含日志文件的会话目录', () => {
  const root = tempRoot()
  try {
    const withLog = join(root, 'bucket-a', 'id-1')
    mkdirSync(withLog, { recursive: true })
    writeFileSync(join(withLog, 'session.jsonl.zstd'), '')
    const withV3 = join(root, 'bucket-a', 'id-2')
    mkdirSync(withV3, { recursive: true })
    writeFileSync(join(withV3, 'session.v3.jsonl.zstd'), '')
    const withV4 = join(root, 'bucket-b', 'id-4')
    mkdirSync(withV4, { recursive: true })
    writeFileSync(join(withV4, 'session.v4.jsonl.zstd'), '')
    const empty = join(root, 'bucket-b', 'id-3')
    mkdirSync(empty, { recursive: true })
    assert.deepEqual(listSessionIdsDirect(root).sort(), ['id-1', 'id-2', 'id-4'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionLogDirect:压缩档案解出事件流与 header', () => {
  const root = tempRoot()
  try {
    const dir = join(root, 'bucket', 'sid-9')
    mkdirSync(dir, { recursive: true })
    const text = [
      JSON.stringify({ type: 'session', version: 4, id: 'sid-9', origin: 'subagent', delegationDepth: 1 }),
      JSON.stringify({ type: 'assistant/message', seq: 0, data: { turn: 0, step: 0, usage: { inputTokens: 7 } } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(text)))
    const { events, header } = readSessionLogDirect('sid-9', root)
    assert.equal(header.origin, 'subagent')
    assert.equal(events.length, 1)
    assert.equal(events[0].data.usage.inputTokens, 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionLogDirect:明文 jsonl 档案同样可读,无 header 行时为 undefined', () => {
  const root = tempRoot()
  try {
    const dir = join(root, 'bucket', 'sid-plain')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ type: 'turn/end', seq: 0 }))
    const { events, header } = readSessionLogDirect('sid-plain', root)
    assert.equal(header, undefined)
    assert.equal(events.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionLogDirect:多代档案并存时取最新代,不回落旧代', () => {
  const root = tempRoot()
  try {
    const dir = join(root, 'bucket', 'sid-multi')
    mkdirSync(dir, { recursive: true })
    const oldText = [
      JSON.stringify({ type: 'session', version: 3, id: 'sid-multi', origin: 'subagent', delegationDepth: 1 }),
      JSON.stringify({ type: 'turn/end', seq: 0 }),
    ].join('\n')
    const newText = [
      JSON.stringify({ type: 'session', version: 4, id: 'sid-multi' }),
      JSON.stringify({ type: 'turn/end', seq: 0 }),
      JSON.stringify({ type: 'turn/end', seq: 1 }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(oldText)))
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(newText)))
    const { events, header } = readSessionLogDirect('sid-multi', root)
    assert.equal(header.version, 4)
    assert.equal(events.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
