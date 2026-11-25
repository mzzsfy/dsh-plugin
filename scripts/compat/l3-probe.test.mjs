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
import { EXTERNAL_SUPPLY_HIDDEN_BROKEN, classifyNavCells, isExternalSupplyCell, isGearSvg } from './l3-checks.mjs'
import { countNonHostConsole, judgePackage } from './l3-run.mjs'

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

// 导航格快照夹具:页面侧 c3-taken 采集的形态(结构事实,判定在 Node 侧)
const navSvg = (overrides = {}) => ({
  selector: 'button[class*="_navCell"] > span > svg',
  navic: '',
  useHrefs: [],
  pathStarts: [],
  display: 'inline-block',
  visibility: 'visible',
  width: 16,
  height: 16,
  ...overrides,
})
const navCell = (label, attrs, svgs) => ({ label, attrs: ['type', 'class', ...attrs], svgs })
const navSnapshot = (cells) => ({
  labels: cells.length,
  navicSvgs: cells.reduce((total, cell) => total + cell.svgs.filter((svg) => svg.navic !== '').length, 0),
  inert1: 0,
  cells,
})

test('isExternalSupplyCell 只认 data-<vendor>-nav-icon 属性名', () => {
  assert.equal(isExternalSupplyCell({ attrs: ['type', 'data-dsh-market-nav-icon'] }), true)
  assert.equal(isExternalSupplyCell({ attrs: ['data-foo-bar-nav-icon'] }), true)
  assert.equal(isExternalSupplyCell({ attrs: ['data-navic', 'data-dsh-market-nav-icon-x'] }), false)
  assert.equal(isExternalSupplyCell({ attrs: ['data--nav-icon'] }), false)
  assert.equal(isExternalSupplyCell({}), false)
  assert.equal(isExternalSupplyCell(null), false)
})

test('isGearSvg 认两代齿轮 use 与 path 前缀,非齿轮不认', () => {
  assert.equal(isGearSvg(navSvg({ useHrefs: ['#dsw-icon-settings-outline-medium'] })), true)
  assert.equal(isGearSvg(navSvg({ pathStarts: ['M14.0861 2.5H17.9139'] })), true)
  assert.equal(isGearSvg(navSvg({ pathStarts: ['M13.0107 7.79377C13.0107'] })), true)
  assert.equal(isGearSvg(navSvg({ useHrefs: ['#dsw-icon-data-outline-medium'], pathStarts: ['M8 2.2'] })), false)
  assert.equal(isGearSvg(null), false)
})

test('classifyNavCells:外部供给格不计残差(让位非漏接管),普通齿轮格才计残差', () => {
  const snapshot = navSnapshot([
    navCell('插件市场', ['data-dsh-market-nav-icon'], [
      navSvg({
        selector: 'button[class*="_navCell"] > span > span[data-slot="settings.section.icon"] > svg',
        useHrefs: ['#dsw-icon-settings-outline-medium'],
        display: 'block',
      }),
    ]),
    navCell('通用设置', [], [navSvg({ navic: '通用设置', useHrefs: ['#navic-general'], pathStarts: ['M8 2.2'] })]),
    navCell('模型', [], [navSvg({ useHrefs: ['#dsw-icon-data-outline-medium'], pathStarts: ['M8 2.2'] })]),
    navCell('漏接管分区', [], [navSvg({ pathStarts: ['M14.0861 2.5H17.9139'] })]),
  ])
  const v = classifyNavCells(snapshot)
  assert.equal(v.takenCells, 1)
  assert.equal(v.navicSvgs, 1)
  assert.deepEqual(v.residual, ['漏接管分区'])
  assert.equal(v.residualGear, 1)
  assert.deepEqual(v.externalSupplyCells, ['插件市场'])
  // 外部供给格内部 svg 可见 = 供给方隐藏规则失效,记发现但不进残差
  assert.equal(v.externalSupplyHiddenBroken, 1)
  const [finding] = v.findings
  assert.equal(finding.id, EXTERNAL_SUPPLY_HIDDEN_BROKEN)
  assert.equal(finding.severity, '外部供给缺陷')
  assert.equal(finding.cell, '插件市场')
  assert.deepEqual(finding.attr, ['data-dsh-market-nav-icon'])
  assert.equal(finding.selector, 'button[class*="_navCell"] > span > span[data-slot="settings.section.icon"] > svg')
  assert.equal(finding.display, 'block')
  assert.equal(finding.visibility, 'visible')
  assert.equal(finding.size, '16x16')
})

test('classifyNavCells:外部供给格 svg 已隐藏(display:none / visibility:hidden)时零发现', () => {
  const snapshot = navSnapshot([
    navCell('插件市场', ['data-dsh-market-nav-icon'], [navSvg({ display: 'none' })]),
    navCell('另一供给格', ['data-dsh-market-nav-icon'], [navSvg({ visibility: 'hidden' })]),
    navCell('通用设置', [], [navSvg({ navic: '通用设置', useHrefs: ['#navic-general'] })]),
  ])
  const v = classifyNavCells(snapshot)
  assert.equal(v.externalSupplyHiddenBroken, 0)
  assert.deepEqual(v.findings, [])
  assert.equal(v.residualGear, 0)
  assert.equal(v.residual.length, 0)
})

test('classifyNavCells:祖先隐藏(checkVisibility=false)等价于已隐藏,不记发现', () => {
  const snapshot = navSnapshot([
    navCell('插件市场', ['data-dsh-market-nav-icon'], [navSvg({ rendered: false, display: 'block' })]),
  ])
  const v = classifyNavCells(snapshot)
  assert.equal(v.externalSupplyHiddenBroken, 0)
  assert.deepEqual(v.findings, [])
})

test('classifyNavCells:带 navicYield 的让位格不重入,不计残差', () => {
  const snapshot = navSnapshot([
    navCell('历史让位分区', [], [navSvg({ yield: true, pathStarts: ['M14.0861 2.5H17.9139'] })]),
    navCell('通用设置', [], [navSvg({ navic: '通用设置', useHrefs: ['#navic-general'] })]),
  ])
  const v = classifyNavCells(snapshot)
  assert.equal(v.residualGear, 0)
  assert.deepEqual(v.yieldedCells, ['历史让位分区'])
})

test('classifyNavCells:首枚 svg 未记账、记账落在后续 svg 时仍计残差(与 #7 首枚语义一致)', () => {
  const snapshot = navSnapshot([
    navCell('错位记账', [], [
      navSvg({ pathStarts: ['M14.0861 2.5H17.9139'] }),
      navSvg({ navic: '错位记账', useHrefs: ['#navic-x'] }),
    ]),
  ])
  const v = classifyNavCells(snapshot)
  assert.equal(v.takenCells, 0)
  assert.equal(v.navicSvgs, 1)
  assert.deepEqual(v.residual, ['错位记账'])
})

test('classifyNavCells:空快照降级为零计数,不抛错', () => {
  const v = classifyNavCells(null)
  assert.equal(v.takenCells, 0)
  assert.equal(v.residualGear, 0)
  assert.equal(v.externalSupplyHiddenBroken, 0)
  assert.deepEqual(v.findings, [])
})

test('judgePackage #3:外部供给双图记 external-supply-hidden-broken 发现且判定通过', () => {
  const snapshot = navSnapshot([
    navCell('插件市场', ['data-dsh-market-nav-icon'], [
      navSvg({ useHrefs: ['#dsw-icon-settings-outline-medium'], display: 'block' }),
    ]),
    navCell('通用设置', [], [navSvg({ navic: '通用设置', useHrefs: ['#navic-general'] })]),
  ])
  const verdict = judgePackage('dsh-settings-nav-icons', {
    results: [
      { name: 'c3-stable', ok: true, value: 2 },
      { name: 'c3-taken', ok: true, value: snapshot },
    ],
    consoleErrors: [],
    consoleDetails: [],
  })
  const check = verdict.checks.find((entry) => entry.id === 3)
  assert.equal(check.ok, true)
  assert.equal(check.findings.length, 1)
  assert.equal(check.findings[0].id, EXTERNAL_SUPPLY_HIDDEN_BROKEN)
  assert.equal(check.findings[0].cell, '插件市场')
})

test('judgePackage #3:普通齿轮未被接管仍判失败(残差口径未被放宽)', () => {
  const snapshot = navSnapshot([
    navCell('插件市场', ['data-dsh-market-nav-icon'], [navSvg({ display: 'none' })]),
    navCell('通用设置', [], [navSvg({ navic: '通用设置', useHrefs: ['#navic-general'] })]),
    navCell('漏接管分区', [], [navSvg({ pathStarts: ['M14.0861 2.5H17.9139'] })]),
  ])
  const verdict = judgePackage('dsh-settings-nav-icons', {
    results: [
      { name: 'c3-stable', ok: true, value: 2 },
      { name: 'c3-taken', ok: true, value: snapshot },
    ],
    consoleErrors: [],
    consoleDetails: [],
  })
  const check = verdict.checks.find((entry) => entry.id === 3)
  assert.equal(check.ok, false)
  assert.deepEqual(check.actual.residual, ['漏接管分区'])
  assert.equal(check.findings.length, 0)
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
