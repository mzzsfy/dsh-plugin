// direct-log-reader 测试:多帧 zstd 解压、JSONL 宽松解析、目录定位与 id 枚举。
// 全部经由 root 参数注入临时目录,不依赖真实 DSH_HOME

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { decodeZstdFile, parseJsonlEvents, findSessionDir, listSessionIdsDirect, readSessionLogDirect } from '../src/direct-log-reader.js'

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
    const empty = join(root, 'bucket-b', 'id-3')
    mkdirSync(empty, { recursive: true })
    assert.deepEqual(listSessionIdsDirect(root).sort(), ['id-1', 'id-2'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionLogDirect:压缩档案解出事件流', () => {
  const root = tempRoot()
  try {
    const dir = join(root, 'bucket', 'sid-9')
    mkdirSync(dir, { recursive: true })
    const text = [
      JSON.stringify({ type: 'session/header', id: 'sid-9' }),
      JSON.stringify({ type: 'assistant/message', seq: 0, data: { turn: 0, step: 0, usage: { inputTokens: 7 } } }),
    ].join('\n')
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(text)))
    const events = readSessionLogDirect('sid-9', root)
    assert.equal(events.length, 1)
    assert.equal(events[0].data.usage.inputTokens, 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionLogDirect:明文 jsonl 档案同样可读', () => {
  const root = tempRoot()
  try {
    const dir = join(root, 'bucket', 'sid-plain')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ type: 'turn/end', seq: 0 }))
    const events = readSessionLogDirect('sid-plain', root)
    assert.equal(events.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
