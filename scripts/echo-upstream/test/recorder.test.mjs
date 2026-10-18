// BDD 场景 11 + 12:usage 可配(--tokens)与留档 scenario 字段(只增不改)。
// BDD 场景 13:留档总大小上限(超 maxBytes 截到 maxBytes/2 以下,行完整优先)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../server.mjs'
import { createRecorder } from '../recorder.mjs'
import { installDelegate } from '../streaming.mjs'
import { parseSse } from './helpers.mjs'

async function launch(options = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-test-')), 'requests.jsonl')
  const server = await start({ port: 0, log, ...installDelegate(options), ...options })
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, log, close: () => { server.close(); server.closeIdleConnections() } }
}

const post = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('--tokens 双协议非流式 usage 覆写', async () => {
  const { base, close } = await launch({ tokens: [100, 200] })
  try {
    const o = await post(base, '/v1/chat/completions', { model: 'm' })
    assert.deepEqual((await o.json()).usage, { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 })
    const a = await post(base, '/v1/messages', { model: 'm' })
    assert.deepEqual((await a.json()).usage, { input_tokens: 100, output_tokens: 200 })
  } finally { close() }
})

test('--tokens 流式 usage 同步覆写', async () => {
  const { base, close } = await launch({ tokens: [100, 200] })
  try {
    const o = await post(base, '/v1/chat/completions', { model: 'm', stream: true })
    const chunks = parseSse(await o.text()).map((e) => e.data).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d))
    assert.deepEqual(chunks.find((c) => c.usage).usage, { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 })
    const a = await post(base, '/v1/messages', { model: 'm', stream: true })
    const events = parseSse(await a.text()).map((e) => JSON.parse(e.data))
    assert.equal(events.find((d) => d.type === 'message_start').message.usage.input_tokens, 100)
    assert.equal(events.find((d) => d.type === 'message_delta').usage.output_tokens, 200)
  } finally { close() }
})

test('留档 scenario 字段记录场景判定', async () => {
  const { base, log, close } = await launch({ tokens: [5, 6] })
  try {
    await post(base, '/v1/chat/completions', { model: 'echo-model-think', stream: true })
    await post(base, '/v1/chat/completions', { model: 'echo-model-err429' })
    await post(base, '/v1/chat/completions', { model: 'plain' })
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => l.scenario), ['think', 'err429', 'default'])
    assert.equal(lines[0].body.stream, true)
  } finally { close() }
})

test('--models 扩展目录与空数组回退默认模型', async () => {
  const { base, close } = await launch({ models: ['a', 'b'] })
  try {
    const ob = await (await fetch(`${base}/v1/models`)).json()
    assert.deepEqual(ob.data.map((m) => m.id), ['a', 'b'])
    const ab = await (await fetch(`${base}/v1/models`, { headers: { 'anthropic-version': 'x' } })).json()
    assert.deepEqual(ab.data.map((m) => m.id), ['a', 'b'])
  } finally { close() }
  const { base: base2, close: close2 } = await launch({ models: [] })
  try {
    const ob = await (await fetch(`${base2}/v1/models`)).json()
    assert.deepEqual(ob.data.map((m) => m.id), ['echo-model'])
  } finally { close2() }
})

test('错误码注入先于流式判定:stream 与 -err 组合仍为错误码', async () => {
  const { base, close } = await launch()
  try {
    const res = await post(base, '/v1/chat/completions', { model: 'echo-model-err429', stream: true })
    assert.equal(res.status, 429)
    assert.doesNotMatch(res.headers.get('content-type'), /event-stream/)
  } finally { close() }
})

// Given maxBytes=1000 的 recorder / When 记录总量越过上限 / Then 文件收缩至 500 以下且行完整可解析
test('留档超限截断:总量超 maxBytes 后收缩至 maxBytes/2 以下', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-rec-')), 'r.jsonl')
  const rec = createRecorder(log, 1000)
  rec({ msg: 'a'.repeat(400) })
  rec({ msg: 'b'.repeat(400) })
  rec({ msg: 'c'.repeat(400) })
  const buf = readFileSync(log)
  assert.ok(buf.length <= 500, `size=${buf.length}`)
  const lines = buf.toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines, [{ msg: 'c'.repeat(400) }])
})

// Given 已截断的 recorder / When 继续记录再次超限 / Then 再次收缩且追加不受影响
test('留档截断可重复触发:截断后继续记录仍有界', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-rec-')), 'r.jsonl')
  const rec = createRecorder(log, 1000)
  rec({ msg: 'a'.repeat(400) })
  rec({ msg: 'b'.repeat(400) })
  rec({ msg: 'c'.repeat(400) })
  rec({ msg: 'd'.repeat(400) })
  rec({ msg: 'e'.repeat(400) })
  const buf = readFileSync(log)
  assert.ok(buf.length <= 500, `size=${buf.length}`)
  const lines = buf.toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines, [{ msg: 'e'.repeat(400) }])
})

// Given 单条记录超过保留线 / When 总量超限触发截断 / Then 最后一条完整行保留,不产生半行
test('留档单行超限:截断退化为保留最后一行', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-rec-')), 'r.jsonl')
  const rec = createRecorder(log, 1000)
  rec({ msg: 'a'.repeat(400) })
  rec({ msg: 'b'.repeat(1200) })
  const buf = readFileSync(log)
  const lines = buf.toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines, [{ msg: 'b'.repeat(1200) }])
})

// Given 文件仅一条自身超限的记录(此前无任何行边界) / When 记录触发超限 / Then 无旧边界可回退,完整保留该行
test('留档首行即超限:无旧行边界时完整保留全部', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-rec-')), 'r.jsonl')
  const rec = createRecorder(log, 1000)
  rec({ msg: 'b'.repeat(1200) })
  const buf = readFileSync(log)
  const lines = buf.toString('utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines, [{ msg: 'b'.repeat(1200) }])
})
