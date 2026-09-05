// BDD 场景测试:同一套场景同时验证 src/logic.mjs 与 src/client.js 内嵌逻辑段(parity,
// 含逐函数源码文本对比防双写漂移)。new Function 体前置 "use strict" 对齐 ESM 语义。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as logic from '../src/logic.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 从 client.js 提取标记段,构造同接口的纯逻辑实现。
function clientLogic() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const factory = new Function(
    '"use strict";'
      + section
      + '; return { STATE_RUNNING, STATE_OK, createRegistry, plan, planFinal, registerCurrent, capMap, needsReattach, SEEN_MAP_CAP, prefixOf, matchMark, findSeenKey, isCurrent, putSeen, findRow };',
  )
  return factory()
}

const row = (state, bodyText, expanded = false, headable = true, plugged = false, uid = undefined) =>
  ({ uid, headable, state, bodyText, expanded, plugged })
const RUNNING = 'running'
const OK = 'ok'

const expandOf = (result, index) =>
  result.actions.filter((a) => a.index === index && a.kind === 'expand').length
const collapseOf = (result, index) =>
  result.actions.filter((a) => a.index === index && a.kind === 'collapse').length

function defineScenarios(prefix, L) {
  const { createRegistry, plan, planFinal, registerCurrent, STATE_RUNNING, STATE_OK, capMap, needsReattach, SEEN_MAP_CAP } = L

  test(prefix + '流式思考自动展开', () => {
    const reg = createRegistry()
    const result = plan(reg, [row(OK, '旧的'), row(RUNNING, '新思考')])
    assert.equal(expandOf(result, 1), 1)
    assert.equal(reg.current.seen, '新思考')
    assert.equal(reg.current.uid, undefined)
  })

  test(prefix + '正文未挂载时仅展开不登记,挂载后补登记', () => {
    const reg = createRegistry()
    const first = plan(reg, [row(RUNNING, '')])
    assert.equal(expandOf(first, 0), 1)
    assert.equal(reg.current, null)
    assert.equal(reg.marks.size, 0)
    const second = plan(reg, [row(RUNNING, '正文', true, true, true)])
    assert.equal(second.actions.length, 0)
    assert.equal(reg.current.seen, '正文')
    const done = plan(reg, [row(OK, '正文', true, true, true)])
    assert.equal(done.actions.length, 0)
    const next = plan(reg, [row(OK, '正文', true, true, true), row(RUNNING, '下一条')])
    assert.equal(collapseOf(next, 0), 1)
    assert.equal(expandOf(next, 1), 1)
  })

  test(prefix + '空正文行不误判手动与已读', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, '')])
    const result = plan(reg, [row(RUNNING, '', true, true, true)])
    assert.equal(reg.manual.size, 0)
    assert.equal(reg.read.size, 0)
  })

  test(prefix + '新思考出现收起上一条', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, 'A')])
    const result = plan(reg, [row(OK, 'A', true, true, true), row(RUNNING, 'B')])
    assert.equal(collapseOf(result, 0), 1)
    assert.equal(expandOf(result, 1), 1)
  })

  test(prefix + '流式追加不重复展开同一行', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, 'A')])
    const result = plan(reg, [row(RUNNING, 'A 追加了正文', true, true, true)])
    assert.equal(result.actions.length, 0)
    // 标记保留展开时的已见文本,后续快照按前缀匹配识别为同一行
    assert.ok(reg.current.seen.length > 0 && 'A 追加了正文'.startsWith(reg.current.seen))
  })

  test(prefix + '用户手动展开后插件不干预', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, 'A')])
    // 用户手动展开行 B:已展开、无插件标记、非当前行
    const result = plan(reg, [row(OK, 'A', true), row(OK, 'B', true)])
    assert.equal(collapseOf(result, 0), 1)
    assert.equal(expandOf(result, 1), 0)
    // 此后永不干预 B
    const again = plan(reg, [row(OK, 'A'), row(OK, 'B')])
    assert.equal(again.actions.length, 0)
    const next = plan(reg, [row(OK, 'B'), row(RUNNING, 'C')])
    assert.equal(expandOf(next, 1), 1)
    assert.equal(collapseOf(next, 0), 0)
  })

  test(prefix + '用户手动收起视为已读', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, 'A')])
    // 手动收起当前行(流式仍在追加,前缀匹配命中已读标记)
    plan(reg, [row(RUNNING, 'A 收起前正文', false, true, true)])
    const again = plan(reg, [row(RUNNING, 'A 收起前正文 继续追加', false, true, true)])
    assert.equal(again.actions.length, 0)
    // 下一条新思考行出现即恢复自动展开
    const next = plan(reg, [row(OK, 'A 收起前正文 继续追加', false, true, true), row(RUNNING, 'B')])
    assert.equal(expandOf(next, 1), 1)
  })

  test(prefix + '流式结束保留展开', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, 'A')])
    const result = plan(reg, [row(OK, 'A', true, true, true)])
    assert.equal(result.actions.length, 0)
  })

  test(prefix + '历史会话常规扫描不干预', () => {
    const reg = createRegistry()
    const result = plan(reg, [row(OK, 'A'), row(OK, 'B')])
    assert.equal(result.actions.length, 0)
  })

  test(prefix + '登记行被识别为插件展开,流式接管时收起', () => {
    // 模拟控制层 planFinal 展开后的登记形态(registerCurrent 播种)
    const reg = createRegistry()
    registerCurrent(reg, undefined, 'A')
    const result = plan(reg, [row(OK, 'A', true, true, true), row(RUNNING, 'B')])
    assert.equal(collapseOf(result, 0), 1)
    assert.equal(expandOf(result, 1), 1)
  })

  test(prefix + '登记行未登记 current 时不会被误判手动', () => {
    const reg = createRegistry()
    registerCurrent(reg, undefined, 'A')
    reg.current = null
    const result = plan(reg, [row(OK, 'A', true, true, true), row(OK, 'B')])
    assert.equal(result.actions.filter((a) => a.index === 0).length, 0)
    assert.equal(reg.manual.size, 0)
  })

  test(prefix + 'running 行用户手动展开被识别,后续不干预', () => {
    const reg = createRegistry()
    // 用户在插件处理前手动展开 running 行:已展开、无 plugged 标记、非当前行
    const result = plan(reg, [row(RUNNING, '流式正文', true)])
    assert.equal(result.actions.length, 0)
    assert.equal(reg.manual.size, 1)
    // 该行转 ok、新行出现后不被收起
    const next = plan(reg, [row(OK, '流式正文', true), row(RUNNING, 'C')])
    assert.equal(expandOf(next, 1), 1)
    assert.equal(collapseOf(next, 0), 0)
  })

  test(prefix + '插件展开未登记的行不误判手动', () => {
    const reg = createRegistry()
    // 插件展开动作已打 plugged 标,正文挂载前 current 尚未登记
    const result = plan(reg, [row(RUNNING, '正文', true, true, true)])
    assert.equal(result.actions.length, 0)
    assert.equal(reg.manual.size, 0)
    assert.equal(reg.current.seen, '正文')
    // 新行出现时照常接管收起
    const next = plan(reg, [row(OK, '正文', true, true, true), row(RUNNING, 'B')])
    assert.equal(collapseOf(next, 0), 1)
    assert.equal(expandOf(next, 1), 1)
  })

  test(prefix + 'uid 命中:同开头历史行不劫持 current 定位', () => {
    const reg = createRegistry()
    // 插件展开流式行 uid=7,登记早期快照「好的，让我」
    plan(reg, [row(OK, '好的，让我历史行完整内容', true, true, true, 3), row(RUNNING, '好的，让我', false, true, false, 7)])
    assert.equal(reg.current.uid, 7)
    // 新行 uid=9 出现:current(uid=7)定位必须命中自身而非同开头的历史行 uid=3
    const result = plan(reg, [
      row(OK, '好的，让我历史行完整内容', true, true, true, 3),
      row(OK, '好的，让我', true, true, true, 7),
      row(RUNNING, '新的思考', false, true, false, 9),
    ])
    assert.equal(collapseOf(result, 1), 1, '收起的是 uid=7 而非同开头的历史行 uid=3')
    assert.equal(collapseOf(result, 0), 0)
    assert.equal(expandOf(result, 2), 1)
  })

  test(prefix + 'uid 已读标记不拦同开头新行', () => {
    const reg = createRegistry()
    // 插件展开 uid=3 后用户收起 → 已读
    plan(reg, [row(RUNNING, '好的，让我', false, true, false, 3)])
    plan(reg, [row(RUNNING, '好的，让我', false, true, true, 3)])
    assert.equal(reg.read.size, 1)
    // 新回合行 uid=9 同开头:不因旧标记被拦
    const next = plan(reg, [row(RUNNING, '好的，让我重新分析', false, true, false, 9)])
    assert.equal(expandOf(next, 0), 1)
  })

  test(prefix + 'suppressManual 首扫不把既存展开行登记为手动', () => {
    const reg = createRegistry()
    // 容器重挂后首扫:已展开无 plugged 行视为中性
    const result = plan(reg, [row(OK, '既存展开行', true)], { suppressManual: true })
    assert.equal(result.actions.length, 0)
    assert.equal(reg.manual.size, 0)
    // 常规扫描才识别手动意图:登记 manual 后无 running 无 current,不产生干预动作
    const normal = plan(reg, [row(OK, '既存展开行', true)])
    assert.equal(reg.manual.size, 1)
    assert.equal(normal.actions.length, 0)
  })

  test(prefix + '打开会话展开最后一条', () => {
    const result = planFinal([row(OK, 'A'), row(OK, 'B')])
    assert.equal(expandOf(result, 1), 1)
    assert.equal(expandOf(result, 0), 0)
  })

  test(prefix + '打开会话已展开则无动作', () => {
    const result = planFinal([row(OK, 'A'), row(OK, 'B', true)])
    assert.equal(result.actions.length, 0)
  })

  test(prefix + '打开会话遇手动展开行不干预', () => {
    const result = planFinal([row(OK, 'A', true), row(OK, 'B')])
    assert.equal(result.actions.length, 0)
    assert.equal(expandOf(result, 1), 0)
  })

  test(prefix + '打开会话存在运行行时让位流式', () => {
    const result = planFinal([row(OK, 'A'), row(RUNNING, 'B')])
    assert.equal(result.actions.length, 0)
  })

  test(prefix + '最后一条识别失败时展开最后可识别行', () => {
    const result = planFinal([row(OK, 'A'), row(OK, 'X', false, false)])
    assert.equal(expandOf(result, 0), 1)
  })

  test(prefix + '行集为空不干预', () => {
    const result = planFinal([])
    assert.equal(result.actions.length, 0)
  })

  test(prefix + '正文未挂载照常展开', () => {
    const result = planFinal([row(OK, ''), row(OK, '')])
    assert.equal(expandOf(result, 1), 1)
  })

  test(prefix + '批量 running 降级不干预', () => {
    const reg = createRegistry()
    const result = plan(reg, [row(RUNNING, 'A'), row(RUNNING, 'B')])
    assert.equal(result.actions.length, 0)
  })

  test(prefix + '识别失败不干预', () => {
    const reg = createRegistry()
    const result = plan(reg, [row(RUNNING, 'A', false, false)])
    assert.equal(result.actions.length, 0)
    assert.equal(reg.current, null)
  })

  test(prefix + '状态字面量与官方一致', () => {
    assert.equal(STATE_RUNNING, 'running')
    assert.equal(STATE_OK, 'ok')
  })

  test(prefix + '重挂判定:节点缺失或不一致即重挂', () => {
    const el = { id: 'a' }
    assert.equal(needsReattach(null, el), true)
    assert.equal(needsReattach({ id: 'old' }, el), true)
    assert.equal(needsReattach(el, el), false)
  })

  test(prefix + '已见 Map 超容量按插入序裁剪最旧条目', () => {
    const map = new Map()
    const total = SEEN_MAP_CAP + 5
    for (let index = 0; index < total; index += 1) map.set('k' + index, index)
    capMap(map)
    assert.equal(map.size, SEEN_MAP_CAP)
    assert.equal(map.has('k0'), false)
    assert.equal(map.has('k4'), false)
    assert.equal(map.has('k5'), true)
    assert.equal(map.has('k' + (total - 1)), true)
  })

  test(prefix + 'putSeen 经 plan 增长有界', () => {
    const reg = createRegistry()
    for (let index = 0; index < SEEN_MAP_CAP + 10; index += 1) {
      // 每轮出现一条新的已展开无标记行 → manual 集合每轮新增一条
      plan(reg, [row(OK, '旧' + index, true), row(RUNNING, '流' + index)])
    }
    assert.ok(reg.manual.size > 0)
    assert.ok(reg.manual.size <= SEEN_MAP_CAP)
  })
}

defineScenarios('[logic.mjs] ', logic)
defineScenarios('[client.js] ', clientLogic())

test('client.js 语法可被 node 解析', () => {
  execFileSync(process.execPath, ['--check', join(PKG_ROOT, 'src', 'client.js')])
})

test('client.js 逻辑段导出与 logic.mjs 完全一致(漏登记即失败)', () => {
  const client = clientLogic()
  const clientKeys = Object.keys(client).sort()
  for (const key of Object.keys(logic).sort()) {
    assert.ok(clientKeys.includes(key), '逻辑段漏登记导出: ' + key)
  }
})

// logic.mjs 内部函数不经 ESM 导出,经源码剥 export 求值取同一批函数体做对比
function logicInternals() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'logic.mjs'), 'utf8')
  const stripped = source.replace(/^export /gm, '')
  const factory = new Function(
    '"use strict";'
      + stripped
      + '; return { prefixOf, matchMark, findSeenKey, isCurrent, putSeen, findRow };',
  )
  return factory()
}

test('LOGIC 段与 logic.mjs 逐函数源码一致(归一化注释与空白,含内部助手)', () => {
  const client = clientLogic()
  const internals = logicInternals()
  const normalize = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '')
  for (const name of ['plan', 'planFinal', 'createRegistry', 'capMap', 'needsReattach', 'registerCurrent']) {
    assert.equal(
      normalize(client[name].toString()),
      normalize(logic[name].toString()),
      'LOGIC 段与 logic.mjs 漂移: ' + name,
    )
  }
  for (const name of ['prefixOf', 'matchMark', 'findSeenKey', 'isCurrent', 'putSeen', 'findRow']) {
    assert.equal(
      normalize(client[name].toString()),
      normalize(internals[name].toString()),
      'LOGIC 段内部助手与 logic.mjs 漂移: ' + name,
    )
  }
  for (const name of ['STATE_RUNNING', 'STATE_OK', 'SEEN_MAP_CAP']) {
    assert.equal(client[name], logic[name], '常量漂移: ' + name)
  }
})
