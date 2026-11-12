// 最近输出速度口径测试:当前窗口最近最多 20 步的加权平均输出速度与官方胶囊替换
// Given/When/Then 场景内嵌于用例描述
// 数据形态取宿主 AssistantMessageNode:timing{stepStartTime,firstTokenTime,completedTime} + usage.outputTokens
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const { RECENT_SPEED_STEPS, recentSpeedOf, rewriteSpeedText, observeSpeedCapsule, observeStatDialog, keepSpeedRowLast } = core

const step = (outputTokens, firstTokenTime, completedTime) => ({
  kind: 'assistant',
  time: completedTime,
  timing: { stepStartTime: firstTokenTime - 100, firstTokenTime, completedTime },
  usage: { outputTokens },
})

test('Given 单步 500 token 解码 2 秒 When 取速度 Then 每 token 竖秒为单位换算', () => {
  assert.equal(RECENT_SPEED_STEPS, 20)
  assert.equal(recentSpeedOf([step(500, 0, 2000)]), 250)
})

test('Given 两步不同长度 When 聚合 Then 用总 token 除总时长而非算术平均', () => {
  assert.equal(recentSpeedOf([step(300, 0, 1000), step(700, 0, 3000)]), 250)
})

test('Given 超过窗口上限 When 聚合 Then 只取最近 RECENT_SPEED_STEPS 步', () => {
  const slow = Array.from({ length: 5 }, () => step(10, 0, 10000))
  const fast = Array.from({ length: RECENT_SPEED_STEPS }, () => step(100, 0, 1000))
  assert.equal(recentSpeedOf([...slow, ...fast]), 100)
})

test('Given 显式窗口小于上限 When 聚合 Then 只取指定步数', () => {
  assert.equal(recentSpeedOf([step(10, 0, 10000), step(100, 0, 1000)], 1), 100)
})

test('Given 步骤缺 timing 或缺 usage When 聚合 Then 跳过该步不影响其余读数', () => {
  assert.equal(recentSpeedOf([{ kind: 'assistant' }, step(500, 0, 2000)]), 250)
  assert.equal(recentSpeedOf([{ kind: 'assistant', timing: { firstTokenTime: 0, completedTime: 1000 } }, step(500, 0, 2000)]), 250)
  assert.equal(recentSpeedOf([{ kind: 'assistant', timing: { firstTokenTime: 0, completedTime: 1000 }, usage: { outputTokens: '500' } }, step(500, 0, 2000)]), 250)
})

test('Given 首 token 缺席 When 聚合 Then 回退端到端时长仍出读数', () => {
  assert.equal(recentSpeedOf([{ kind: 'assistant', timing: { stepStartTime: 0, firstTokenTime: null, completedTime: 1000 }, usage: { outputTokens: 10 } }]), 10)
  assert.equal(recentSpeedOf([step(500, 1000, 1000)]), null)
  assert.equal(recentSpeedOf([step(500, 2000, 1000)]), null)
})

test('Given 首 token 与步骤启动都缺失 When 聚合 Then 该步不参与', () => {
  assert.equal(recentSpeedOf([{ kind: 'assistant', timing: { stepStartTime: null, firstTokenTime: null, completedTime: 1000 }, usage: { outputTokens: 10 } }]), null)
  assert.equal(recentSpeedOf([{ kind: 'assistant', usage: { outputTokens: 10 } }]), null)
})

test('Given 步骤零输出或含非有限时长 When 聚合 Then 该步不参与', () => {
  assert.equal(recentSpeedOf([{ kind: 'assistant', timing: { stepStartTime: 0, firstTokenTime: 0, completedTime: 2000 }, usage: { outputTokens: 0 } }]), null)
  assert.equal(recentSpeedOf([{ kind: 'assistant', timing: { stepStartTime: 0, firstTokenTime: Number.NaN, completedTime: Number.POSITIVE_INFINITY }, usage: { outputTokens: 10 } }]), null)
  assert.equal(recentSpeedOf([{ kind: 'assistant', timing: { stepStartTime: 0, firstTokenTime: Number.NaN, completedTime: 2000 }, usage: { outputTokens: 10 } }]), 5)
})

test('Given 窗口无可用步骤 When 聚合 Then 返回 null 供渲染层省略该行', () => {
  assert.equal(recentSpeedOf(null), null)
  assert.equal(recentSpeedOf(undefined), null)
  assert.equal(recentSpeedOf([]), null)
  assert.equal(recentSpeedOf([{ kind: 'tool-result' }, { kind: 'user' }]), null)
})

test('Given 节点集为 Map 形态 When 聚合 Then 与数组形态同口径', () => {
  assert.equal(recentSpeedOf(new Map([['a', step(500, 0, 2000)]])), 250)
})

test('Given 官方速度读数 When 改写 Then 只替换 tok/s 数值并保留轮步前缀', () => {
  assert.equal(rewriteSpeedText('3 轮 3 步 · 0.2 tok/s', '267 tok/s'), '3 轮 3 步 · 267 tok/s')
  assert.equal(rewriteSpeedText('1 轮 1 步 · 1000 tok/s', '250 tok/s'), '1 轮 1 步 · 250 tok/s')
})

test('Given 宿主切换到法俄语单位 When 改写 Then 仍能替换读数片段', () => {
  assert.equal(rewriteSpeedText('12.3 jetons/s', '267 tok/s'), '267 tok/s')
  assert.equal(rewriteSpeedText('12.3 ток/с', '267 tok/s'), '267 tok/s')
  assert.equal(rewriteSpeedText('3 轮 3 步 · 42 ток/с', '267 tok/s'), '3 轮 3 步 · 267 tok/s')
})

test('Given 文本没有速度读数或值为空 When 改写 Then 原样返回', () => {
  assert.equal(rewriteSpeedText('3 轮 3 步', '267 tok/s'), '3 轮 3 步')
  assert.equal(rewriteSpeedText('3 轮 3 步 · 0.2 tok/s', null), '3 轮 3 步 · 0.2 tok/s')
  assert.equal(rewriteSpeedText(null, '267 tok/s'), null)
})

test('Given 官方用时胶囊 When 接管读数 Then 文本与 aria-label 同步替换', () => {
  const fixture = capsuleFixture('3 轮 3 步 · 0.2 tok/s', '0.2 tok/s')
  const stop = observeSpeedCapsule(fixture.anchor, fixture.document, observerStub(), '267 tok/s')
  assert.equal(fixture.speedTextNode.nodeValue, '267 tok/s')
  assert.equal(fixture.button._aria, '3 轮 3 步 · 267 tok/s')
  stop()
})

test('Given 未开启替换 When 观察 Then 官方读数保持不变', () => {
  const fixture = capsuleFixture('3 轮 3 步 · 0.2 tok/s', '0.2 tok/s')
  const stop = observeSpeedCapsule(fixture.anchor, fixture.document, observerStub(), null)
  assert.equal(fixture.speedTextNode.nodeValue, '0.2 tok/s')
  assert.equal(fixture.button._aria, '3 轮 3 步 · 0.2 tok/s')
  stop()
})

test('Given 已接管读数 When 停止观察 Then 还原官方文本', () => {
  const fixture = capsuleFixture('3 轮 3 步 · 0.2 tok/s', '0.2 tok/s')
  const stop = observeSpeedCapsule(fixture.anchor, fixture.document, observerStub(), '267 tok/s')
  stop()
  assert.equal(fixture.speedTextNode.nodeValue, '0.2 tok/s')
  assert.equal(fixture.button._aria, '3 轮 3 步 · 0.2 tok/s')
})

test('Given 官方重渲染覆盖了读数 When 停止观察 Then 不还原已被官方接管的文本', () => {
  const fixture = capsuleFixture('3 轮 3 步 · 0.2 tok/s', '0.2 tok/s')
  const stop = observeSpeedCapsule(fixture.anchor, fixture.document, observerStub(), '267 tok/s')
  fixture.speedTextNode.nodeValue = '0.5 tok/s'
  fixture.button._aria = '3 轮 3 步 · 0.5 tok/s'
  stop()
  assert.equal(fixture.speedTextNode.nodeValue, '0.5 tok/s')
  assert.equal(fixture.button._aria, '3 轮 3 步 · 0.5 tok/s')
})

// dock 最小 DOM 桩:锚点 -> dock -> activity 胶囊 -> button -> label(前缀文本/分隔/速度文本)
function capsuleFixture(ariaLabel, labelText) {
  const prefixTextNode = { nodeType: 3, nodeValue: '3 轮 3 步' }
  const separatorNode = { nodeType: 3, nodeValue: '·' }
  const speedTextNode = { nodeType: 3, nodeValue: labelText }
  const label = { nodeType: 1, childNodes: [prefixTextNode, separatorNode, speedTextNode] }
  const button = {
    _aria: ariaLabel,
    getAttribute: (name) => (name === 'aria-label' ? button._aria : null),
    setAttribute: (name, value) => { if (name === 'aria-label') button._aria = value },
    childNodes: [label],
  }
  const pill = { querySelector: (selector) => (selector === 'button' ? button : null), childNodes: [button] }
  const dock = { querySelector: (selector) => (selector === '[data-composer-stat="activity"]' ? pill : null) }
  const anchor = { closest: (selector) => (selector === '[data-slot="conversation.composer.dock"]' ? dock : null) }
  return { anchor, document: { body: {}, contains: () => true }, button, speedTextNode, prefixTextNode }
}

function observerStub() {
  class Observer {
    static last = null
    static instances = []
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      Observer.instances.push(this)
      Observer.last = this
    }
    observe() {}
    takeRecords() { return [] }
    disconnect() { this.disconnected = true }
  }
  Observer.notify = () => Observer.instances.at(-1)?.callback([])
  return Observer
}

test('Given 胶囊展开与关闭 When 观察 Then 只在弹窗唯一且展开时交付目标', () => {
  const fx = statDialogFixture()
  const seen = []
  const Stub = observerStub()
  const stop = observeStatDialog(fx.anchor, fx.document, Stub, (target) => seen.push(target), 'activity', '[data-session-stats-details]')
  assert.deepEqual(seen, [fx.dialog])
  fx.close()
  Stub.notify()
  assert.deepEqual(seen, [fx.dialog, null])
  fx.open()
  Stub.notify()
  assert.deepEqual(seen, [fx.dialog, null, fx.dialog])
  fx.duplicate()
  Stub.notify()
  assert.deepEqual(seen, [fx.dialog, null, fx.dialog, null])
  fx.close()
  stop()
  assert.equal(Stub.last?.disconnected, true)
})

test('Given 官方在读数行之后追加了新行 When 归位 Then 读数行搬回明细末尾', () => {
  const list = speedListFixture()
  const dt = list.append('dt', true)
  const dd = list.append('dd', true)
  const officialDt = list.append('dt', false)
  const officialDd = list.append('dd', false)
  assert.equal(keepSpeedRowLast(list.root), true)
  assert.deepEqual(list.order(), [officialDt, officialDd, dt, dd])
  assert.equal(keepSpeedRowLast(list.root), false)
  assert.equal(keepSpeedRowLast(null), false)
})

// 用时弹窗桩:胶囊展开状态与弹窗数量可切换,notify 由测试手动驱动观察器回调
function statDialogFixture() {
  const dialog = { id: 'dialog-1' }
  const state = { expanded: true, dialogs: [dialog] }
  const button = { getAttribute: (name) => (name === 'aria-expanded' ? String(state.expanded) : null) }
  const pill = { querySelector: (selector) => (selector === 'button' ? button : null) }
  const dock = { querySelector: (selector) => (selector === '[data-composer-stat="activity"]' ? pill : null) }
  const anchor = { closest: (selector) => (selector === '[data-slot="conversation.composer.dock"]' ? dock : null) }
  const document = { body: {}, querySelectorAll: () => state.dialogs, contains: () => true }
  return {
    anchor,
    document,
    dialog,
    open: () => { state.expanded = true; state.dialogs = [dialog] },
    close: () => { state.expanded = false; state.dialogs = [] },
    duplicate: () => { state.expanded = true; state.dialogs = [dialog, { id: 'dialog-2' }] },
  }
}

// 明细桩:按 dt/dd 顺序维护子节点,支持最后节点判定与 append 归位
function speedListFixture() {
  const children = []
  const root = {
    children,
    get lastElementChild() { return children[children.length - 1] ?? null },
    querySelector(selector) {
      const tag = selector.startsWith('dt') ? 'dt' : 'dd'
      return children.find((node) => node.tag === tag && node.marked) ?? null
    },
    append(...nodes) {
      for (const node of nodes) {
        const from = children.indexOf(node)
        if (from >= 0) children.splice(from, 1)
        children.push(node)
      }
    },
  }
  const append = (tag, marked) => {
    const node = { tag, marked, get nextElementSibling() { const index = children.indexOf(node); return children[index + 1] ?? null } }
    children.push(node)
    return node
  }
  return { root, append, order: () => [...children] }
}
