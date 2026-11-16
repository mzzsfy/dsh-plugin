// 客户端历史对账与可访问性契约(行为级):
// - U4/P2-07 历史装载闸门:初始 /history 快照与 resync 谁先落地都不丢数据
// - U9/P3-9 详情对话框语义属性、Escape 关闭与挂载聚焦(纯逻辑驱动,非源码正则)
// - P3-3 通知配置视图只消费 webhookConfigured 布尔,不承载明文地址
// P3-5(无游标长轮询)由 client-bus-lifecycle.test.mjs 的请求路径断言覆盖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

// 从 client.js 提取 LOGIC 标记段构造同接口的纯逻辑实例(与 parity.test.mjs 同法)
function clientLogic() {
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少逻辑标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  return new Function(
    section
      + '; return { createHistorySync, createTrailingSingleFlight, detailDialogA11y, isEscapeKey, bindDialogKeys, focusDialog,'
      + ' notifyConfigView };',
  )()
}

const logic = clientLogic()

test('U4 历史闸门:初始快照成功应用后才算装载,resync 随后只拉增量', () => {
  const sync = logic.createHistorySync()
  assert.equal(sync.isLoaded(), false)
  // 初始快照未到达/resync 早于快照:即便修订号未变也必须补拉全量
  assert.equal(sync.needsLoad(false), true)
  assert.equal(sync.wantsFullSnapshot(), true)
  assert.equal(sync.acceptsInitialSnapshot(), true)
  sync.markApplied(true)
  assert.equal(sync.isLoaded(), true)
  // 已装载:修订号未变不再重复拉取;变化时按增量
  assert.equal(sync.needsLoad(false), false)
  assert.equal(sync.needsLoad(true), true)
  assert.equal(sync.wantsFullSnapshot(), false)
})

test('U4 历史闸门:resync 全量装载后迟到的初始快照被丢弃(旧快照不覆盖新快照)', () => {
  const sync = logic.createHistorySync()
  sync.markApplied(true)
  assert.equal(sync.acceptsInitialSnapshot(), false)
})

test('U4 历史闸门:resync 请求失败/增量补丁不置位,后续 resync 仍会补拉全量', () => {
  const sync = logic.createHistorySync()
  // 只发起了请求、未应用响应:门不得关闭
  assert.equal(sync.needsLoad(false), true)
  sync.markApplied(false)
  assert.equal(sync.isLoaded(), false)
  assert.equal(sync.needsLoad(false), true)
  assert.equal(sync.wantsFullSnapshot(), true)
})

test('A3 resync 单飞+尾随:在途期间的第二次广播不丢,完成后补跑一轮', async () => {
  // Given task 由测试手动放行,记录每次运行
  const releases = []
  let runs = 0
  const gate = logic.createTrailingSingleFlight(() => {
    runs += 1
    return new Promise((resolve) => releases.push(resolve))
  })
  const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
  // When 首次触发进入在途
  gate.trigger()
  assert.equal(runs, 1)
  assert.equal(gate.isInFlight(), true)
  // Then 在途期间的两次广播只记一次尾随,不并发重入
  gate.trigger()
  gate.trigger()
  assert.equal(runs, 1, '在途期间不得并发重入')
  // When 首个往返完成 Then 自动补跑且只补一次
  releases.shift()()
  await flush()
  assert.equal(runs, 2, '在途结束后必须补跑一轮')
  assert.equal(gate.isInFlight(), true)
  // When 尾随轮完成且期间无新触发 Then 停止
  releases.shift()()
  await flush()
  assert.equal(runs, 2)
  assert.equal(gate.isInFlight(), false)
})

test('A3 resync 单飞+尾随:任务异常同样释放互斥并保留尾随重跑', async () => {
  let runs = 0
  const gate = logic.createTrailingSingleFlight(() => {
    runs += 1
    if (runs === 1) throw new Error('first failed')
    return Promise.resolve()
  })
  const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
  gate.trigger()
  gate.trigger()
  await flush()
  assert.equal(runs, 2, '失败任务收尾后仍须执行尾随轮')
  assert.equal(gate.isInFlight(), false)
})

test('U9 详情对话框语义属性:模态 + 标题关联 + 可编程聚焦', () => {
  assert.deepEqual(logic.detailDialogA11y('up-detail-title'), {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'up-detail-title',
    tabIndex: -1,
  })
})

test('U9 Escape 关闭:仅 Escape 触发,其余按键与空事件不触发,解绑后不再触发', () => {
  const listeners = new Set()
  const target = {
    addEventListener: (type, fn) => { if (type === 'keydown') listeners.add(fn) },
    removeEventListener: (type, fn) => { if (type === 'keydown') listeners.delete(fn) },
  }
  let closed = 0
  const unbind = logic.bindDialogKeys(target, () => { closed += 1 })
  assert.equal(listeners.size, 1)
  for (const listener of listeners) listener({ key: 'a' })
  for (const listener of listeners) listener(null)
  assert.equal(closed, 0)
  for (const listener of listeners) listener({ key: 'Escape' })
  assert.equal(closed, 1)
  unbind()
  assert.equal(listeners.size, 0)
})

test('U9 无键盘目标时不注册且解绑可安全调用', () => {
  const unbind = logic.bindDialogKeys(null, () => { throw new Error('不应触发') })
  assert.equal(typeof unbind, 'function')
  unbind()
})

test('U9 挂载聚焦:有 focus 的节点被聚焦,无焦点能力的环境不报错', () => {
  let focused = 0
  logic.focusDialog({ focus: () => { focused += 1 } })
  assert.equal(focused, 1)
  logic.focusDialog(null)
  logic.focusDialog({})
})

test('P3-3 通知配置视图:严格 true 才算已配置,视图不携带明文地址', () => {
  assert.deepEqual(logic.notifyConfigView({ webhookConfigured: true }), {
    configured: true,
    placeholder: '已配置,留空保持不变',
  })
  assert.equal(logic.notifyConfigView({ webhookConfigured: 'true' }).configured, false)
  assert.equal(logic.notifyConfigView({}).configured, false)
  assert.equal(logic.notifyConfigView(null).configured, false)
  const view = logic.notifyConfigView({ webhookConfigured: true, webhookUrl: 'https://hooks.test/secret' })
  assert.deepEqual(Object.keys(view).sort(), ['configured', 'placeholder'])
  assert.equal(JSON.stringify(view).includes('hooks.test'), false)
})

test('P3-9 趋势浮层键盘可见:focus-within 规则存在(CSS 伪类无法在无渲染环境求值,锁定规则本身)', () => {
  assert.match(source, /\.up-card:focus-within \.up-trend \{[^}]*visibility:\s*visible/)
})
