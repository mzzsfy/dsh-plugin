// L3 断言判定与步骤编排的纯函数用例:不进浏览器即可锁定选择器断言、计数断言与失败归因格式。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deepEqual,
  formatMismatch,
  judgeAssert,
  judgeEval,
  judgeHttp,
  judgeLog,
  matchField,
  readPath,
} from './l3-assert.mjs'
import { countNonHostConsole } from './l3-run.mjs'

test('readPath 读嵌套字段、数组下标,缺失返回 undefined', () => {
  const body = { value: { keys: ['a', 'b'], nested: { ok: true } } }
  assert.equal(readPath(body, 'value.nested.ok'), true)
  assert.equal(readPath(body, 'value.keys.1'), 'b')
  assert.equal(readPath(body, 'value.missing.deep'), undefined)
  assert.equal(readPath(null, 'value'), undefined)
})

test('deepEqual 忽略对象键顺序,区分数组顺序', () => {
  assert.equal(deepEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }), true)
  assert.equal(deepEqual([1, 2], [2, 1]), false)
  assert.equal(deepEqual({ a: 1 }, [1]), false)
})

test('judgeAssert 以选择器计数判定并通过,失败时带 selector 与期望/实际', () => {
  const pass = judgeAssert({ selector: '.ud-card-label', count: 6 }, {
    selector: '.ud-card-label',
    count: 6,
    texts: ['Tokens 用量'],
  })
  assert.equal(pass.ok, true)

  const fail = judgeAssert({ selector: '.ud-card-label', count: 6 }, {
    selector: '.ud-card-label',
    count: 4,
    texts: [],
  })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /selector \.ud-card-label/)
  assert.match(fail.error, /期望 count=6/)
  assert.match(fail.error, /实际 count=4/)
})

test('judgeAssert 支持存在性、最小数量、空集合与文本 AND/任一词语义', () => {
  const actual = { selector: '.sm-cfg', count: 1, texts: ['自动归档 阈值 检查周期'] }
  assert.equal(judgeAssert({ selector: '.sm-cfg', exists: true }, actual).ok, true)
  assert.equal(judgeAssert({ selector: '.sm-cfg', exists: false }, actual).ok, false)
  assert.equal(judgeAssert({ selector: '.sm-cfg', minCount: 1 }, actual).ok, true)
  assert.equal(judgeAssert({ selector: '.sm-cfg', minCount: 2 }, actual).ok, false)
  assert.equal(judgeAssert({ selector: '.sm-cfg', text: ['自动归档', '检查周期'] }, actual).ok, true)
  assert.equal(judgeAssert({ selector: '.sm-cfg', text: ['自动归档', '不存在'] }, actual).ok, false)
  assert.equal(judgeAssert({ selector: '.sm-cfg', textAny: ['不存在', '阈值'] }, actual).ok, true)
  assert.equal(judgeAssert({ selector: '.sm-cfg', textNot: ['已关闭'] }, actual).ok, true)
  assert.equal(judgeAssert({ selector: '.sm-cfg', empty: true }, { selector: '.sm-cfg', count: 0, texts: [] }).ok, true)
})

test('judgeAssert 支持属性与计算样式断言', () => {
  const actual = {
    selector: '.dm-select',
    count: 1,
    texts: ['latest'],
    attrs: { 'aria-expanded': 'true' },
    computed: { overflowY: 'auto' },
  }
  assert.equal(judgeAssert({ selector: '.dm-select', attr: { name: 'aria-expanded', equals: 'true' } }, actual).ok, true)
  assert.equal(judgeAssert({ selector: '.dm-select', attr: { name: 'aria-expanded', includes: 'tru' } }, actual).ok, true)
  assert.equal(judgeAssert({ selector: '.dm-select', attr: { name: 'aria-expanded', equals: 'false' } }, actual).ok, false)
  assert.equal(judgeAssert({ selector: '.dm-select', computed: { prop: 'overflowY', equals: 'auto' } }, actual).ok, true)
})

test('judgeHttp 缺省 2xx,显式状态与字段断言可组合', () => {
  assert.equal(judgeHttp(null, { status: 200, body: {} }).ok, true)
  assert.equal(judgeHttp(null, { status: 302, body: {} }).ok, false)
  assert.equal(judgeHttp({ status: [200, 405] }, { status: 405, body: {} }).ok, true)
  assert.equal(judgeHttp({ status: 200, fields: { 'value.ok': true } }, { status: 200, body: { value: { ok: true } } }).ok, true)
  assert.equal(judgeHttp({ status: 200, fields: { 'value.ok': true } }, { status: 200, body: { value: { ok: false } } }).ok, false)
  assert.equal(judgeHttp({ fields: { 'value.days': { type: 'number', min: 0 } } }, { status: 200, body: { value: { days: 7 } } }).ok, true)
  assert.equal(judgeHttp({ fields: { 'value.days': { type: 'number', min: 0 } } }, { status: 200, body: { value: { days: -1 } } }).ok, false)
  assert.equal(judgeHttp({ present: ['value.tokens', 'value.sessions'] }, { status: 200, body: { value: { tokens: 1, sessions: 2 } } }).ok, true)
  assert.equal(judgeHttp({ absent: ['error'] }, { status: 200, body: { ok: true } }).ok, true)
  assert.equal(judgeHttp({ absent: ['error'] }, { status: 200, body: { error: 'x' } }).ok, false)
})

test('matchField 对对象形态逐项匹配并报告首个失败项', () => {
  assert.equal(matchField({ type: 'object' }, { a: 1 }).ok, true)
  assert.equal(matchField({ oneOf: ['a', 'b'] }, 'b').ok, true)
  assert.equal(matchField({ oneOf: ['a', 'b'] }, 'c').ok, false)
  assert.equal(matchField({ includes: '归档' }, '会话归档').ok, true)
  assert.equal(matchField({ truthy: true }, 1).ok, true)
  assert.equal(matchField({ notNull: true }, null).ok, false)
  assert.equal(matchField({ length: 2 }, ['a', 'b']).ok, true)
})

test('judgeEval 支持 equals/truthy/falsy/type/includes/字段路径', () => {
  assert.equal(judgeEval({ equals: { installed: true } }, { installed: true }).ok, true)
  assert.equal(judgeEval({ equals: { installed: true } }, { installed: false }).ok, false)
  assert.equal(judgeEval({ truthy: true }, 1).ok, true)
  assert.equal(judgeEval({ falsy: true }, 0).ok, true)
  assert.equal(judgeEval({ type: 'function' }, () => {}).ok, true)
  assert.equal(judgeEval({ includes: 'M8 2.2' }, '<path d="M8 2.2"/>').ok, true)
  assert.equal(judgeEval({ fields: { 'state.windowUsed': { type: 'number' } } }, { state: { windowUsed: 0 } }).ok, true)
})

test('judgeLog 对宿主日志做包含与正则断言', () => {
  const log = 'auto-trust-all: 动态信任已启用 (bind 127.0.0.1, 容量 100)\nauto-trust-all: registered host probe.evil.test'
  assert.equal(judgeLog({ includes: ['动态信任已启用', 'registered host'] }, log).ok, true)
  assert.equal(judgeLog({ regex: ['registered host probe\\.evil\\.test'] }, log).ok, true)
  assert.equal(judgeLog({ includes: ['evicted host'] }, log).ok, false)
})

test('formatMismatch 统一归因格式,长值截断', () => {
  assert.equal(formatMismatch(6, 4, '.ud-card-label'), 'selector .ud-card-label · 期望 6 · 实际 4')
  assert.equal(formatMismatch('a', 'b'), '期望 a · 实际 b')
  const long = 'x'.repeat(400)
  assert.ok(formatMismatch(long, 'y').includes('…'))
})

test('judgeAssert exactTexts 锁定文本集合与顺序,失败带逐项差异', () => {
  const actual = { selector: '.ud-card-label', count: 3, texts: ['Tokens 用量', '会话数量', '请求数量'] }
  assert.equal(judgeAssert({ selector: '.ud-card-label', exactTexts: ['Tokens 用量', '会话数量', '请求数量'] }, actual).ok, true)
  const fail = judgeAssert({ selector: '.ud-card-label', exactTexts: ['Tokens 用量', '请求数量', '会话数量'] }, actual)
  assert.equal(fail.ok, false)
  assert.match(fail.error, /selector \.ud-card-label/)
  assert.match(fail.error, /期望/)
})

test('judgeHttp 字段 length/notNull 与 present 缺失归因可机检', () => {
  assert.equal(judgeHttp({ fields: { deleted: { type: 'array', length: 0 } } }, { status: 200, body: { deleted: [] } }).ok, true)
  assert.equal(judgeHttp({ fields: { deleted: { type: 'array', length: 0 } } }, { status: 200, body: { deleted: [1] } }).ok, false)
  assert.equal(judgeHttp({ fields: { activation: { notNull: true } } }, { status: 200, body: { activation: {} } }).ok, true)
  const fail = judgeHttp({ fields: { activation: { notNull: true } } }, { status: 200, body: {} })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /期望/)
})

test('countNonHostConsole 剔除 /login 噪声、负例探针 URL 与登记噪声文本', () => {
  const details = [
    { text: 'Failed to load resource: 404', url: 'http://127.0.0.1:9291/login' },
    { text: 'Failed to load resource: 400', url: 'http://127.0.0.1:9291/api/session-manager/auto-archive' },
    { text: 'useFloatingTrend is not defined', url: 'http://127.0.0.1:9291/assets/index-abc.js' },
    { text: '真正的本包错误', url: 'http://127.0.0.1:9291/api/dsh-maintain/status' },
  ]
  assert.equal(countNonHostConsole(details, 4, ['/api/session-manager/auto-archive'], ['useFloatingTrend is not defined']), 1)
  assert.equal(countNonHostConsole(details, 4), 3)
  assert.equal(countNonHostConsole(undefined, 7), 7)
})
