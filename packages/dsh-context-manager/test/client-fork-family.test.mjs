import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

// F1 家族版本环 的客户端契约(源码切片锁定):
// - 数据源是 sessions.list 快照行(parentSessionId),零新 RPC
// - 单成员家族/快照缺失不注入
// - 箭头跳转经 sessions.open(纯打开,不 fork)
// - 计数器防重复注入,停用 fork 时随 removeAll 一并清除

test('源码契约:家族环数据源为 sessions.list 快照(零新 RPC)', () => {
  assert.ok(CLIENT_SRC.includes('sessions.list.getSnapshot()'), '家族投影应读会话列表快照')
  assert.ok(CLIENT_SRC.includes('parent.parentId'), '投影应按快照行 parentId 建链(快照字段名与 wire 不同)')
})

test('源码契约:快照行主键为 id(与服务 wire 字段名不同源)', () => {
  const slice = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function sessionFamilyMap'), CLIENT_SRC.indexOf('function familyRing'))
  assert.ok(slice.includes('item.id'), '快照行主键应取 id')
})

test('源码契约:单成员家族与快照缺失不注入计数器', () => {
  const slice = CLIENT_SRC.slice(CLIENT_SRC.indexOf('// 家族版本环'), CLIENT_SRC.indexOf('function jumpFamilyMember'))
  assert.ok(slice.includes('ring && ring.total >= 2'), '成员不足 2 不注入')
  assert.ok(slice.includes('actionsRow.querySelector'), '注入前应查重')
})

test('源码契约:箭头跳转经 sessions.open 且不 fork', () => {
  const jump = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function jumpFamilyMember'), CLIENT_SRC.indexOf('if (typeof MutationObserver'))
  assert.ok(jump.includes('openFn(target)'), '跳转应调用 open 通道')
  assert.ok(jump.includes('target !== current.sessionId'), '目标为自身时不切换')
})

test('源码契约:家族环标记与清除齐备(停用开关一并移除)', () => {
  assert.ok(CLIENT_SRC.includes("const FAMILY_RING_FLAG = 'data-cx-family-ring'"), '应有家族环标记常量')
  assert.ok(CLIENT_SRC.includes("querySelectorAll('[' + FORK_BTN_FLAG + ']')"), '清除逻辑存在(环与按钮同排,按钮清除即整排消失)')
})

test('源码契约:loadFamily 通道旧宿主降级返回 null', () => {
  assert.ok(CLIENT_SRC.includes('typeof sessions.list.getSnapshot'), '快照面应以能力探测守门')
})
