// BDD 场景测试:同一套场景同时验证 src/logic.mjs 与 src/client.js 内嵌逻辑段(parity)。
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
    section
      + '; return { STATE_RUNNING, STATE_OK, hashText, createRegistry, plan, planFinal, capMap, needsReattach, SEEN_MAP_CAP };',
  )
  return factory()
}

const row = (state, bodyText, expanded = false, headable = true) => ({ headable, state, bodyText, expanded })
const RUNNING = 'running'
const OK = 'ok'

const expandOf = (result, index) =>
  result.actions.filter((a) => a.index === index && a.kind === 'expand').length
const collapseOf = (result, index) =>
  result.actions.filter((a) => a.index === index && a.kind === 'collapse').length

function defineScenarios(prefix, L) {
  const { createRegistry, plan, planFinal, hashText, STATE_RUNNING, STATE_OK, capMap, needsReattach, SEEN_MAP_CAP } = L

  test(prefix + '哈希确定性', () => {
    assert.equal(hashText('思考正文'), hashText('思考正文'))
    assert.notEqual(hashText('a'), hashText('b'))
  })

  test(prefix + '流式思考自动展开', () => {
    const reg = createRegistry()
    const result = plan(reg, [row(OK, '旧的'), row(RUNNING, '新思考')])
    assert.equal(expandOf(result, 1), 1)
    assert.equal(reg.current.hash, hashText('新思考'))
  })

  test(prefix + '正文未挂载时仅展开不登记,挂载后补登记', () => {
    const reg = createRegistry()
    const first = plan(reg, [row(RUNNING, '')])
    assert.equal(expandOf(first, 0), 1)
    assert.equal(reg.current, null)
    assert.equal(reg.marks.size, 0)
    const second = plan(reg, [row(RUNNING, '正文', true)])
    assert.equal(second.actions.length, 0)
    assert.equal(reg.current.hash, hashText('正文'))
    const done = plan(reg, [row(OK, '正文', true)])
    assert.equal(done.actions.length, 0)
    const next = plan(reg, [row(OK, '正文', true), row(RUNNING, '下一条')])
    assert.equal(collapseOf(next, 0), 1)
    assert.equal(expandOf(next, 1), 1)
  })

  test(prefix + '空正文行不误判手动与已读', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, '')])
    const result = plan(reg, [row(RUNNING, '')])
    assert.equal(reg.manual.size, 0)
    assert.equal(reg.read.size, 0)
  })

  test(prefix + '新思考出现收起上一条', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, 'A')])
    const result = plan(reg, [row(OK, 'A', true), row(RUNNING, 'B')])
    assert.equal(collapseOf(result, 0), 1)
    assert.equal(expandOf(result, 1), 1)
  })

  test(prefix + '流式追加不重复展开同一行', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, 'A')])
    const result = plan(reg, [row(RUNNING, 'A 追加了正文', true)])
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
    plan(reg, [row(RUNNING, 'A 收起前正文')])
    const again = plan(reg, [row(RUNNING, 'A 收起前正文 继续追加')])
    assert.equal(again.actions.length, 0)
    // 下一条新思考行出现即恢复自动展开
    const next = plan(reg, [row(OK, 'A 收起前正文 继续追加'), row(RUNNING, 'B')])
    assert.equal(expandOf(next, 1), 1)
  })

  test(prefix + '流式结束保留展开', () => {
    const reg = createRegistry()
    plan(reg, [row(RUNNING, 'A')])
    const result = plan(reg, [row(OK, 'A', true)])
    assert.equal(result.actions.length, 0)
  })

  test(prefix + '历史会话常规扫描不干预', () => {
    const reg = createRegistry()
    const result = plan(reg, [row(OK, 'A'), row(OK, 'B')])
    assert.equal(result.actions.length, 0)
  })

  test(prefix + '登记行被识别为插件展开,流式接管时收起', () => {
    // 模拟控制层 planFinal 展开后的登记形态(marks + current)
    const reg = createRegistry()
    reg.marks.set(hashText('A'), 'A')
    reg.current = { hash: hashText('A'), seen: 'A' }
    const result = plan(reg, [row(OK, 'A', true), row(RUNNING, 'B')])
    assert.equal(collapseOf(result, 0), 1)
    assert.equal(expandOf(result, 1), 1)
  })

  test(prefix + '登记行未登记 current 时不会被误判手动', () => {
    const reg = createRegistry()
    reg.marks.set(hashText('A'), 'A')
    const result = plan(reg, [row(OK, 'A', true), row(OK, 'B')])
    assert.equal(result.actions.filter((a) => a.index === 0).length, 0)
    assert.equal(reg.manual.size, 0)
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
