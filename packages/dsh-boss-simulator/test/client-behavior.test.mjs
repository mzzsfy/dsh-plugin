import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/client.js'), 'utf8')

test('Given controls and token coverage When client displays card and detail Then state facts are explicit and unknown is not zero', () => {
  for (const literal of ['可执行', '中断中', '已暂停', '恢复核对中', '停止结果待确认', 'token 未知', '已知 ${total} token · 不完整', '受阻原因：', '已暂停。需要继续时']) assert.ok(source.includes(literal), `missing ${literal}`)
})

test('Given actual intervals When rendering run rows Then 未开始的运行不显示开始时刻且无伪造进度', () => {
  assert.match(source, /started \? h\('span', null, `开始 \$\{new Date\(run\.startedAt\)\.toLocaleString\(\)\}`\) : h\('span', null, '尚未开始'\)/)
  assert.match(source, /运行中/)
  assert.doesNotMatch(source, /预计完成|百分比|绩效图|bs-run__line/)
})

test('Given detail sections with optional collections When some are empty Then fallbacks stay literal text rather than fabricated facts', () => {
  assert.match(source, /'尚无 Run 记录'/)
  assert.match(source, /'尚无验收结果'/)
})

test('Given UI elements When rendered Then style ownership and named labelled controls remain', () => {
  assert.match(source, /data-plugin': ID/)
  assert.match(source, /label', \{ className: 'bs-visually-hidden', htmlFor: 'bs-search'/)
  assert.match(source, /label', \{ className: 'bs-visually-hidden', htmlFor: 'bs-workspace'/)
  assert.match(source, /prefers-reduced-motion:reduce/)
})
