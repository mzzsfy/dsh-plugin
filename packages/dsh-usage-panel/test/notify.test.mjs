// 通知纯逻辑层测试:规则合并 / 沿触发评估 / 投影 / 认领 / 校验。
// 场景以 Given-When-Then 注释锚定,与实现 src/notify.mjs 同步演进。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeAccountOverride,
  defaultNotifySettings,
  createNotifyState,
  normalizeNotifyState,
  evaluateAccount,
  normalizeImTargets,
  validateNotifyPatch,
  normalizeAccountNotify,
  createProjection,
  decideClaim,
  buildWebhookPayload,
  buildNotifyEvent,
  sendWebhook,
  resolvedNotifySettings,
  publicNotify,
  isValidImBotId,
  KIND_QUOTA,
  KIND_BALANCE,
  KIND_RESET,
} from '../src/notify.mjs'

test('规则合并: 账号覆盖键生效, 其余继承全局', () => {
  // Given 全局规则 quota 90 / balance 20 / resetNotice true
  const global = { ...defaultNotifySettings(), enabled: true }
  // When 账号仅覆盖 quotaThresholdPct 与 balanceThreshold
  const merged = mergeAccountOverride(global, { quotaThresholdPct: 50, balanceThreshold: 5 })
  // Then 合并结果覆盖键取账号值, resetNotice 继承全局
  assert.equal(merged.quotaThresholdPct, 50)
  assert.equal(merged.balanceThreshold, 5)
  assert.equal(merged.resetNotice, true)
})

test('规则合并: 账号 notify 缺失时全部继承全局', () => {
  // Given 全局规则已启用
  const global = { ...defaultNotifySettings(), enabled: true, quotaThresholdPct: 80 }
  // When 账号无 notify 覆盖(缺失与空对象两种形态)
  // Then 两次合并结果均等于全局规则值
  assert.deepEqual(mergeAccountOverride(global, null), { quotaThresholdPct: 80, balanceThreshold: global.balanceThreshold, resetNotice: true })
  assert.deepEqual(mergeAccountOverride(global, {}), { quotaThresholdPct: 80, balanceThreshold: global.balanceThreshold, resetNotice: true })
})

// ---- 用量阈值沿触发 + 窗口重置 ----

const quotaReading = (utilization, resetsAt, label = '5小时') => ({
  kind: 'quota',
  windows: [{ label, utilization, resetsAt }],
})

const quotaAccount = (reading) => ({ id: 'acct-1', name: '账号A', last: { ok: true, reading } })

test('用量阈值: 首次上穿阈值产生一条 quota 事件并解除武装', () => {
  // Given 阈值 90, 账号首轮查询 utilization 85 建立基线
  const rule = { quotaThresholdPct: 90, balanceThreshold: null, resetNotice: true }
  let state = createNotifyState()
  const first = evaluateAccount({ account: quotaAccount(quotaReading(85, 'T1')), rule, state, seq: 1, ts: 1000 })
  state = first.state
  assert.equal(first.events.length, 0)
  // When 第二轮查询 utilization 92 上穿阈值
  const second = evaluateAccount({ account: quotaAccount(quotaReading(92, 'T1')), rule, state, seq: 2, ts: 2000 })
  // Then 产生一条 quota 事件, 文本含账号名/窗口/读数/阈值, 新状态解除武装
  assert.equal(second.events.length, 1)
  const event = second.events[0]
  assert.equal(event.kind, KIND_QUOTA)
  assert.equal(event.accountId, 'acct-1')
  assert.equal(event.text, '[dsh] 账号A 5小时窗口用量达 92%(阈值 90%)')
  assert.equal(second.state.windows['5小时'].armed, false)
})

test('用量阈值: 已触发后持续超阈值不重复通知', () => {
  // Given 阈值 90 且已触发解除武装
  const rule = { quotaThresholdPct: 90, balanceThreshold: null, resetNotice: true }
  let state = createNotifyState()
  state = evaluateAccount({ account: quotaAccount(quotaReading(92, 'T1')), rule, state, seq: 1, ts: 1000 }).state
  // When 再次查询 utilization 95 仍超阈值
  const next = evaluateAccount({ account: quotaAccount(quotaReading(95, 'T1')), rule, state, seq: 2, ts: 2000 })
  // Then 无新事件, 峰值随读数更新
  assert.equal(next.events.length, 0)
  assert.equal(next.state.windows['5小时'].peak, 95)
})

test('窗口重置: resetsAt 轮转产生 reset 事件报上一窗口峰值并重新武装', () => {
  // Given 阈值 90, 首轮 92 触发, 次轮 95 峰值更新
  const rule = { quotaThresholdPct: 90, balanceThreshold: null, resetNotice: true }
  let state = createNotifyState()
  state = evaluateAccount({ account: quotaAccount(quotaReading(92, 'T1')), rule, state, seq: 1, ts: 1000 }).state
  state = evaluateAccount({ account: quotaAccount(quotaReading(95, 'T1')), rule, state, seq: 2, ts: 2000 }).state
  // When 第三轮查询 resetsAt 轮转到 T2, 新窗口 utilization 5
  const next = evaluateAccount({ account: quotaAccount(quotaReading(5, 'T2')), rule, state, seq: 3, ts: 3000 })
  // Then 产生一条 reset 事件报上一窗口峰值 95, 新窗口基线重建且重新武装
  assert.equal(next.events.length, 1)
  const event = next.events[0]
  assert.equal(event.kind, KIND_RESET)
  assert.equal(event.text, '[dsh] 账号A 5小时窗口已重置,上一窗口峰值用量 95%')
  assert.equal(next.state.windows['5小时'].armed, true)
  assert.equal(next.state.windows['5小时'].peak, 5)
  // When 新窗口再次上穿阈值
  const again = evaluateAccount({ account: quotaAccount(quotaReading(91, 'T2')), rule, state: next.state, seq: 4, ts: 4000 })
  // Then 再次产生 quota 事件(重置后 re-arm 生效)
  assert.equal(again.events.length, 1)
  assert.equal(again.events[0].kind, KIND_QUOTA)
})

test('窗口重置: resetNotice 关闭时不产生 reset 事件但仍重建基线并重新武装', () => {
  // Given 阈值 90 已触发, 重置通知关闭
  const rule = { quotaThresholdPct: 90, balanceThreshold: null, resetNotice: false }
  let state = createNotifyState()
  state = evaluateAccount({ account: quotaAccount(quotaReading(92, 'T1')), rule, state, seq: 1, ts: 1000 }).state
  // When resetsAt 轮转
  const next = evaluateAccount({ account: quotaAccount(quotaReading(5, 'T2')), rule, state, seq: 2, ts: 2000 })
  // Then 无事件, 武装恢复, 峰值基线已重建
  assert.equal(next.events.length, 0)
  assert.equal(next.state.windows['5小时'].armed, true)
  assert.equal(next.state.windows['5小时'].peak, 5)
})

test('用量阈值: resetsAt 为 null 的窗口仅做阈值判断不做重置检测', () => {
  // Given 阈值 90, 读数无 resetsAt
  const rule = { quotaThresholdPct: 90, balanceThreshold: null, resetNotice: true }
  let state = createNotifyState()
  state = evaluateAccount({ account: quotaAccount(quotaReading(50, null)), rule, state, seq: 1, ts: 1000 }).state
  // When utilization 上穿阈值
  const next = evaluateAccount({ account: quotaAccount(quotaReading(95, null)), rule, state, seq: 2, ts: 2000 })
  // Then 仅产生 quota 事件, 不因 resetsAt 缺失产生 reset 事件
  assert.equal(next.events.length, 1)
  assert.equal(next.events[0].kind, KIND_QUOTA)
})

test('用量阈值: 读数 utilization 缺失的窗口跳过评估不崩', () => {
  // Given 阈值 90, 窗口无 utilization(余额型读数或字段缺失)
  const rule = { quotaThresholdPct: 90, balanceThreshold: null, resetNotice: true }
  const state = createNotifyState()
  const reading = { kind: 'quota', windows: [{ label: '5小时', utilization: null, resetsAt: 'T1' }] }
  // When 评估该账号
  const result = evaluateAccount({ account: quotaAccount(reading), rule, state, seq: 1, ts: 1000 })
  // Then 无事件无异常
  assert.equal(result.events.length, 0)
})

// ---- 余额阈值沿触发 ----

const balanceReading = (remaining, currency = 'USD') => ({
  kind: 'balance',
  entries: [{ currency, total: remaining + 100, remaining }],
})

const balanceAccount = (reading) => ({ id: 'acct-2', name: '账号B', last: { ok: true, reading } })

test('余额阈值: 下穿阈值产生一条 balance 事件并解除武装', () => {
  // Given 阈值 20, 首轮余额 50
  const rule = { quotaThresholdPct: 90, balanceThreshold: 20, resetNotice: true }
  let state = createNotifyState()
  state = evaluateAccount({ account: balanceAccount(balanceReading(50)), rule, state, seq: 1, ts: 1000 }).state
  // When 余额降到 12.5
  const next = evaluateAccount({ account: balanceAccount(balanceReading(12.5)), rule, state, seq: 2, ts: 2000 })
  // Then 产生一条 balance 事件, 文本含币种与数值
  assert.equal(next.events.length, 1)
  const event = next.events[0]
  assert.equal(event.kind, KIND_BALANCE)
  assert.equal(event.text, '[dsh] 账号B 余额 12.5 USD,低于阈值 20 USD')
  assert.equal(next.state.balanceArmed, false)
})

test('余额阈值: 持续低于阈值不重复通知, 回升后再次下穿才重新触发', () => {
  // Given 阈值 20 且已触发
  const rule = { quotaThresholdPct: 90, balanceThreshold: 20, resetNotice: true }
  let state = createNotifyState()
  state = evaluateAccount({ account: balanceAccount(balanceReading(12.5)), rule, state, seq: 1, ts: 1000 }).state
  // When 余额仍低于阈值
  let next = evaluateAccount({ account: balanceAccount(balanceReading(10)), rule, state, seq: 2, ts: 2000 })
  // Then 无新事件
  assert.equal(next.events.length, 0)
  // When 充值回升到阈值上方
  next = evaluateAccount({ account: balanceAccount(balanceReading(50)), rule, state: next.state, seq: 3, ts: 3000 })
  assert.equal(next.events.length, 0)
  assert.equal(next.state.balanceArmed, true)
  // When 再次下穿
  next = evaluateAccount({ account: balanceAccount(balanceReading(5)), rule, state: next.state, seq: 4, ts: 4000 })
  // Then 重新产生事件
  assert.equal(next.events.length, 1)
})

test('余额阈值: 阈值未配置(null)时不评估不触发', () => {
  // Given 阈值 null, 余额极低
  const rule = { quotaThresholdPct: 90, balanceThreshold: null, resetNotice: true }
  const state = createNotifyState()
  // When 评估余额 1
  const result = evaluateAccount({ account: balanceAccount(balanceReading(1)), rule, state, seq: 1, ts: 1000 })
  // Then 无事件, 武装保持
  assert.equal(result.events.length, 0)
  assert.equal(result.state.balanceArmed, true)
})

test('余额阈值: 无 remaining 的余额读数回落 total 口径(deepseek 形态)', () => {
  // Given 阈值 20, entry 仅有 total(deepseek 余额形态)
  const rule = { quotaThresholdPct: 90, balanceThreshold: 20, resetNotice: true }
  const state = createNotifyState()
  const reading = { kind: 'balance', entries: [{ currency: 'CNY', total: 10 }] }
  // When 评估
  const result = evaluateAccount({ account: balanceAccount(reading), rule, state, seq: 1, ts: 1000 })
  // Then 以 total 口径触发, 币种 CNY
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].text, '[dsh] 账号B 余额 10 CNY,低于阈值 20 CNY')
})

test('余额阈值: remaining 为 null 回落 total 口径(openrouter/newapi 形态)', () => {
  // Given 阈值 20, entry remaining=null total=10(total_usage 缺失时解析产物)
  const rule = { quotaThresholdPct: 90, balanceThreshold: 20, resetNotice: true }
  let state = createNotifyState()
  const reading = { kind: 'balance', entries: [{ currency: 'USD', total: 10, remaining: null }] }
  // When 评估
  const result = evaluateAccount({ account: balanceAccount(reading), rule, state, seq: 1, ts: 1000 })
  // Then 以 total 口径触发, 不因 Number(null)=0 误报且不断武装
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].text, '[dsh] 账号B 余额 10 USD,低于阈值 20 USD')
  assert.equal(result.state.balanceArmed, false)
  // When total 回升到阈值上方
  state = result.state
  const recover = evaluateAccount({
    account: balanceAccount({ kind: 'balance', entries: [{ currency: 'USD', total: 100, remaining: null }] }),
    rule, state, seq: 2, ts: 2000,
  })
  // Then 重新武装, 再次下穿才重发(null 口径 armed 周期闭环)
  assert.equal(recover.events.length, 0)
  assert.equal(recover.state.balanceArmed, true)
})

test('余额阈值: remaining=null total 充足时回落口径不触发', () => {
  // Given 阈值 20, remaining=null total=100
  const rule = { quotaThresholdPct: 90, balanceThreshold: 20, resetNotice: true }
  const state = createNotifyState()
  const reading = { kind: 'balance', entries: [{ currency: 'USD', total: 100, remaining: null }] }
  // When 评估
  const result = evaluateAccount({ account: balanceAccount(reading), rule, state, seq: 1, ts: 1000 })
  // Then 回落口径 100 不低于阈值, 无事件且武装保持
  assert.equal(result.events.length, 0)
  assert.equal(result.state.balanceArmed, true)
})

// ---- imTargets 归一 + 配置校验 ----

test('imTargets 归一: 剔除形态非法项, 仅保留两字段', () => {
  // Given 混合合法与非法形态的列表
  const raw = [
    { botId: 'wx_a', targetId: 'owner' },
    { botId: 'wx_b' },
    'junk',
    null,
    { botId: 'wx_c', targetId: 'owner', extra: 1 },
  ]
  // When 归一化
  // Then 仅完整两字段项保留且多余字段被剥离
  assert.deepEqual(normalizeImTargets(raw), [{ botId: 'wx_a', targetId: 'owner' }, { botId: 'wx_c', targetId: 'owner' }])
})

test('imTargets 归一: 非数组回空数组', () => {
  // Given 非数组输入
  // Then 归一化结果为空数组
  assert.deepEqual(normalizeImTargets(null), [])
  assert.deepEqual(normalizeImTargets('x'), [])
})

test('notify 配置补丁校验: 白名单外字段拒绝', () => {
  // Given 含未知键的补丁
  // Then 校验失败并给出原因
  const result = validateNotifyPatch({ unknownKey: 1 })
  assert.equal(result.ok, false)
})

test('notify 配置补丁校验: 合法补丁归一通过', () => {
  // Given 合法字段与值域内的补丁
  const result = validateNotifyPatch({
    enabled: true,
    quotaThresholdPct: 80,
    balanceThreshold: 5,
    resetNotice: false,
    toast: true,
    webhookUrl: 'https://hooks.example.com/a',
    imTargets: [{ botId: 'wx_a', targetId: 'owner' }],
  })
  // Then 校验通过且补丁仅含白名单键
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.patch).sort(), ['balanceThreshold', 'enabled', 'imTargets', 'quotaThresholdPct', 'resetNotice', 'toast', 'webhookUrl'])
})

test('notify 配置补丁校验: 阈值与 URL 值域拦截', () => {
  // Given 阈值越界与非法 URL 两个补丁
  // Then 分别拒绝
  assert.equal(validateNotifyPatch({ quotaThresholdPct: 0 }).ok, false)
  assert.equal(validateNotifyPatch({ quotaThresholdPct: 101 }).ok, false)
  assert.equal(validateNotifyPatch({ balanceThreshold: -1 }).ok, false)
  assert.equal(validateNotifyPatch({ webhookUrl: 'ftp://x' }).ok, false)
})

test('账号 notify 覆盖归一: 仅保留三字段且值域合法', () => {
  // Given 混合字段与非法值的账号覆盖对象
  const raw = { quotaThresholdPct: 70, balanceThreshold: 5, enabled: true, resetNotice: 'yes', junk: 1 }
  // When 归一化
  const result = normalizeAccountNotify(raw)
  // Then 仅保留值域合法的覆盖键, 非法值与未知键剔除
  assert.deepEqual(result, { quotaThresholdPct: 70, balanceThreshold: 5 })
})

// ---- 投影 / 认领 / webhook payload(turn-notify 同构语义) ----

test('投影: 环形容量截断与 TTL 过期', () => {
  // Given 容量 2 / TTL 100 / 注入时钟
  let now = 1000
  const projection = createProjection({ capacity: 2, ttlMs: 100, now: () => now })
  // When 依次推入 3 条且时间推进超过 TTL
  projection.push({ id: 'a', ts: 1000 })
  projection.push({ id: 'b', ts: 1100 })
  projection.push({ id: 'c', ts: 1350 })
  now = 1400
  // Then 列表只含未过期条目, 超容量最旧者先出
  assert.deepEqual(projection.list().map((unit) => unit.id), ['c'])
})

test('认领决策: 无锁认领 / 有效他锁跳过 / 过期锁接管 / done 终态', () => {
  // Given 锁参数窗口 w1 与 w2
  // Then 四种存储形态各自命中对应决策
  assert.equal(decideClaim({ stored: null, done: null, now: 1000, windowId: 'w1' }), 'claim')
  assert.equal(decideClaim({ stored: JSON.stringify({ wid: 'w2', at: 990 }), done: null, now: 1000, windowId: 'w1' }), 'skip')
  assert.equal(decideClaim({ stored: JSON.stringify({ wid: 'w2', at: 0 }), done: null, now: 31 * 1000, windowId: 'w1' }), 'takeover')
  assert.equal(decideClaim({ stored: null, done: 1, now: 1000, windowId: 'w1' }), 'done')
})

test('webhook payload: 事件单元字段一比一映射且 text 随行', () => {
  // Given 一个 quota 事件单元
  const unit = {
    id: 'un-x-1-quota',
    kind: KIND_QUOTA,
    accountId: 'acct-1',
    accountName: '账号A',
    label: '5小时',
    detail: { value: 92, threshold: 90 },
    text: '[dsh] 账号A 5小时窗口用量达 92%(阈值 90%)',
    ts: 1234,
  }
  // When 构建 webhook payload
  const payload = buildWebhookPayload(unit)
  // Then text 与结构化字段一一对应, 不含凭据
  assert.equal(payload.text, unit.text)
  assert.equal(payload.event, unit.id)
  assert.equal(payload.kind, unit.kind)
  assert.equal(payload.account, unit.accountName)
  assert.equal(payload.accountId, unit.accountId)
  assert.equal(payload.label, unit.label)
  assert.deepEqual(payload.detail, unit.detail)
  assert.equal(payload.ts, unit.ts)
})

// ---- webhook 直发 / 读侧归一 / 凭据脱敏 ----

test('sendWebhook: 未配置时如实返回失败且不发起请求', async () => {
  // Given 空 URL
  let called = false
  // When 直发
  const result = await sendWebhook({ url: '', payload: { text: 'x' }, fetchImpl: async () => { called = true; return { ok: true } } })
  // Then 返回失败且未发起请求
  assert.equal(result.ok, false)
  assert.equal(called, false)
})

test('sendWebhook: HTTP 失败不抛出, 错误随结果返回(fire-and-forget 语义)', async () => {
  // Given 会抛错的 fetch 桩
  const result = await sendWebhook({ url: 'https://hooks.example.com/a', payload: {}, fetchImpl: async () => { throw new Error('unreachable') } })
  // Then 结果标记失败并携带原因, 无异常逃逸
  assert.equal(result.ok, false)
  assert.match(result.detail, /unreachable/)
})

test('读侧归一: 残缺配置回退默认值', () => {
  // Given 字段类型异常的 settings 读数
  const resolved = resolvedNotifySettings({ enabled: 'yes', quotaThresholdPct: -5, balanceThreshold: 'x', imTargets: 'bad', webhookUrl: 42 })
  // Then 各字段回默认形态
  assert.equal(resolved.enabled, false)
  assert.equal(resolved.quotaThresholdPct, 90)
  assert.equal(resolved.balanceThreshold, null)
  assert.deepEqual(resolved.imTargets, [])
  assert.equal(resolved.webhookUrl, '')
})

test('凭据脱敏: publicNotify 不回显 webhookUrl 原文, 仅回是否已配置', () => {
  // Given 已配置 webhook 的归一配置
  const resolved = resolvedNotifySettings({ webhookUrl: 'https://hooks.example.com/private' })
  // When 转面板可见形态
  const view = publicNotify(resolved)
  // Then 原文不出主机, webhookConfigured 为 true
  assert.equal(view.webhookUrl, undefined)
  assert.equal(view.webhookConfigured, true)
  assert.equal(view.toast, true)
})

test('botId 校验: 合法字符集与长度', () => {
  // Given dsh-im 规格内的 botId 与非法形态
  // Then 分别判定
  assert.equal(isValidImBotId('wx_abc-1'), true)
  assert.equal(isValidImBotId(''), false)
  assert.equal(isValidImBotId('bad/slash'), false)
})

// ---- 审查修复回归:状态归一 / 写侧拦截 / 基线保留 / 事件构造 ----

test('notifyState 归一: peak=null 保持 null 不伪装成 0', () => {
  // Given 持久化层里 peak 为 null(该窗口从未有有效利用率)的账号状态
  const state = normalizeNotifyState({ windows: { '5小时': { resetsAt: 'T1', peak: null, armed: false } }, balanceArmed: true })
  // Then peak 保持 null, 重置检测不会误发"峰值 0%"通知
  assert.equal(state.windows['5小时'].peak, null)
  assert.equal(state.windows['5小时'].armed, false)
})

test('notifyState 归一: 非法形态回新状态', () => {
  // Given 非对象与坏窗口条目
  assert.deepEqual(normalizeNotifyState('junk'), createNotifyState())
  const state = normalizeNotifyState({ windows: { bad: null, '7天': 'junk' } })
  assert.deepEqual(state.windows, {})
})

test('notify 配置补丁校验: imTargets 项按 dsh-im ID 规格拦截', () => {
  // Given 含空格与非法字符的 botId/targetId
  assert.equal(validateNotifyPatch({ imTargets: [{ botId: 'wx a', targetId: 'owner' }] }).ok, false)
  assert.equal(validateNotifyPatch({ imTargets: [{ botId: 'wx_a', targetId: 'own er' }] }).ok, false)
  assert.equal(validateNotifyPatch({ imTargets: [{ botId: 'wx/a', targetId: 'owner' }] }).ok, false)
  // 合法项通过
  assert.equal(validateNotifyPatch({ imTargets: [{ botId: 'wx_a', targetId: 'owner' }] }).ok, true)
})

test('用量阈值: 上游缺失某窗口时不丢弃该窗口基线', () => {
  // Given 两个窗口均已建基线且 5 小时窗已触发解除武装
  const rule = { quotaThresholdPct: 90, balanceThreshold: null, resetNotice: true }
  let state = createNotifyState()
  state = evaluateAccount({
    account: { id: 'a', name: 'A', last: { ok: true, reading: { kind: 'quota', windows: [
      { label: '5小时', utilization: 95, resetsAt: 'T1' },
      { label: '7天', utilization: 40, resetsAt: 'L1' },
    ] } } },
    rule, state, seq: 1, ts: 1000,
  }).state
  // When 下一轮读数只返回 7 天窗(上游抖动)
  const next = evaluateAccount({
    account: { id: 'a', name: 'A', last: { ok: true, reading: { kind: 'quota', windows: [
      { label: '7天', utilization: 45, resetsAt: 'L1' },
    ] } } },
    rule, state, seq: 2, ts: 2000,
  })
  // Then 5 小时窗基线原样保留, 重现时不会误判新窗口重发通知
  assert.equal(next.state.windows['5小时'].resetsAt, 'T1')
  assert.equal(next.state.windows['5小时'].armed, false)
  assert.equal(next.state.windows['5小时'].peak, 95)
})

test('buildNotifyEvent: 评估产出与测试事件共用同一构造', () => {
  // Given 同一业务字段
  const base = { kind: KIND_QUOTA, accountId: 'a', accountName: 'A', label: '5小时', detail: {}, text: 't' }
  // Then 构造结果带统一 id 形态与 ts
  const event = buildNotifyEvent(base, 3, 1234)
  assert.equal(event.id, 'un-' + (1234).toString(36) + '-3-quota')
  assert.equal(event.ts, 1234)
  assert.equal(event.text, 't')
})
