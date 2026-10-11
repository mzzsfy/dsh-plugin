// FIND-020-3 回归:deny 命中返回对象必须通过工具输出 foreground oneOf 分支校验
// (additionalProperties:false)——历史缺陷:blocked/blockedBy 声明外字段致宿主判
// INVALID_TOOL_OUTPUT,拒绝文案在真机不可达。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DenyError } from '../src/denylist.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'tool.mjs'), 'utf8')

// 前台输出分支属性表与 additionalProperties 与 src/tool.mjs 同源抽取
function extractForegroundProperties(src) {
  const start = src.indexOf('function foregroundOutputProperties()')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  return body
}

function pickStringProps(propsSource) {
  const names = [...propsSource.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1])
  return names
}

test('deniedForeground 返回对象逐字段落 foreground 分支声明内', () => {
  const propsSource = extractForegroundProperties(source)
  const declared = pickStringProps(propsSource)
  assert.ok(declared.includes('kind') && declared.includes('stderr'), '属性表抽取自净(schema 自身声明)')
  // deniedForeground 构造器字段全部在声明表内(拒绝实现不再携带声明外字段)
  const fnStart = source.indexOf('function deniedForeground(')
  const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart))
  const used = [...fnBody.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1])
  const extra = used.filter((k) => !declared.includes(k))
  assert.deepEqual(extra, [], `deniedForeground 不得携带声明外字段: ${extra.join(',')}`)
  assert.doesNotMatch(fnBody, /blocked:/)
  assert.doesNotMatch(fnBody, /blockedBy:/)
})

test('两执行分支 catch 均走 deniedForeground(不再内联声明外字段对象)', () => {
  assert.equal((source.match(/deniedForeground\(error, entry\.id\)/g) ?? []).length, 2)
  assert.doesNotMatch(source, /kind: 'foreground', shell: entry\.id, blocked: true/)
})

test('拒绝文案仍含契约锚(模型可见 [blocked by shell-select: matches deny pattern …])', () => {
  const error = new DenyError('echo\\\\s', 'echo x')
  const fnStart = source.indexOf('function deniedForeground(')
  const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart))
  assert.match(fnBody, /blockedMarker\(error\)/)
  assert.match(source, /function blockedMarker\(error\)/)
  assert.ok(error.pattern.length > 0)
})
