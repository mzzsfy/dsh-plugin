import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/client.js'), 'utf8')

test('Given controls and token coverage When client displays card and detail Then state facts are explicit and unknown is not zero', () => {
  for (const literal of ['可执行', '中断中', '已暂停', '恢复核对中', '停止结果待确认', 'token 未知', '已知 ${total} token · 不完整', '受阻原因：', '已暂停。需要继续时']) assert.ok(source.includes(literal), `missing ${literal}`)
})

test('Given actual intervals When rendering timeline Then queued work has no bar and running intervals are bounded to observed facts', () => {
  assert.match(source, /run\.startedAt \? h\('div', \{ className: 'bs-run__line'/)
  assert.match(source, /尚未开始。/)
  assert.match(source, /最后观测仍在运行/)
  assert.doesNotMatch(source, /预计完成|百分比|绩效图/)
})

test('Given detail sections with optional collections When some are empty Then fallbacks stay literal text rather than fabricated facts', () => {
  assert.match(source, /'尚无 Run 记录'/)
  assert.match(source, /'尚无结果；待核对'/)
})

test('Given UI elements When rendered Then style ownership and named labelled controls remain', () => {
  assert.match(source, /data-plugin': ID/)
  assert.match(source, /label', \{ className: 'bs-visually-hidden', htmlFor: 'bs-search'/)
  assert.match(source, /label', \{ className: 'bs-visually-hidden', htmlFor: 'bs-workspace'/)
  assert.match(source, /prefers-reduced-motion:reduce/)
})
