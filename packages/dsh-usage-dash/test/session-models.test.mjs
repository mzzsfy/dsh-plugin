import { test } from 'node:test'
import assert from 'node:assert/strict'

import { modelUsageProjectionDefinition } from '../src/session-models.js'

const at = (hour, minute = 0) => new Date(2026, 10, 12, hour, minute).getTime()
const hourStart = (time) => {
  const date = new Date(time)
  date.setMinutes(0, 0, 0)
  return date.getTime()
}
const usage = (overrides = {}) => ({
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 2,
  ...overrides,
})
const buckets = (overrides = {}) => ({
  uncachedInputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 2,
  ...overrides,
})
const message = (turn, step, time, body = {}) => ({
  type: 'assistant/message',
  time,
  data: { turn, step, message: { source: { provider: 'newapi', model: 'auto-free' } }, ...body },
})
const requestContext = (provider, model, time) => ({
  type: 'request/context',
  time,
  data: { provider, model },
})
const attempt = (turn, step, time, stream) => ({
  type: 'assistant/attempt',
  time,
  data: { turn, step, stream },
})
const usageChunk = (value) => [{ type: 'chunk', chunk: { type: 'usage', usage: value } }]
const apply = (state, event) => modelUsageProjectionDefinition.apply(state, event)
const initial = () => modelUsageProjectionDefinition.init({}, 0)
const wire = (state) => modelUsageProjectionDefinition.wire.view(state)

test('Given request/context 路由与 message usage When 折叠 Then 按小时/模型写入四桶', () => {
  // Given 路由 newapi/auto-free 与一条 100/20/5/2 的 message
  // When 依次折叠路由和 message
  // Then wire 只有一个小时条目,模型带 provider,四桶与官方 tokenUsage 同口径
  let state = initial()
  const time = at(9, 20)
  state = apply(state, requestContext('newapi', 'auto-free', time))
  state = apply(state, message(1, 1, time, { usage: usage() }))
  assert.deepEqual(wire(state), {
    hours: [{ time: hourStart(time), model: 'newapi/auto-free', ...buckets() }],
  })
})

test('Given 供应商+多级模型名 When 折叠 Then 保留完整三段键供底层匹配', () => {
  // Given provider=oc、model=xx/xx(模型段自身含斜杠)
  // When 折叠路由与 message
  // Then wire 键为 oc/xx/xx,不被截成 oc/xx 或丢掉末段
  let state = initial()
  const time = at(9)
  state = apply(state, requestContext('oc', 'xx/xx', time))
  state = apply(state, message(1, 1, time, {
    usage: usage(),
    message: { source: { provider: 'oc', model: 'xx/xx' } },
  }))
  assert.deepEqual(wire(state).hours.map((entry) => [entry.model, entry.uncachedInputTokens]), [['oc/xx/xx', 100]])
})

test('Given message.source 与 request/context 不同 When 折叠 Then message.source 权威并刷新后续路由', () => {
  // Given request/context 指向 old/model
  // When message 自带 new/model source,随后 attempt 无 source 复用 message 路由
  // Then 两条样本都归到 new/model,old/model 不出现
  let state = initial()
  state = apply(state, requestContext('old', 'model', at(9)))
  state = apply(state, message(1, 1, at(9), {
    usage: usage({ inputTokens: 10 }),
    message: { source: { provider: 'new', model: 'model' } },
  }))
  state = apply(state, attempt(1, 2, at(10), usageChunk(usage({ inputTokens: 30 }))))
  assert.deepEqual(
    wire(state).hours.map((entry) => [entry.model, entry.uncachedInputTokens]),
    [['new/model', 10], ['new/model', 30]],
  )
})

test('Given 同 turn/step 换路由与小时 When 折叠 Then 旧小时/模型桶减掉,新桶只留新值', () => {
  // Given 旧路由 old/model 在 9 点已记 10 input
  // When 同 turn/step 的 message 改为 new/model、10 点、30 input
  // Then 替换槽从旧小时/模型回退,新小时/模型只留 30,不残留旧样本
  let state = initial()
  state = apply(state, requestContext('old', 'model', at(9)))
  state = apply(state, message(1, 1, at(9), { usage: usage({ inputTokens: 10 }) }))
  state = apply(state, requestContext('new', 'model', at(10)))
  state = apply(state, message(1, 1, at(10), {
    usage: usage({ inputTokens: 30 }),
    message: { source: { provider: 'new', model: 'model' } },
  }))
  assert.deepEqual(wire(state).hours.map((entry) => [entry.time, entry.model, entry.uncachedInputTokens]), [
    [hourStart(at(10)), 'new/model', 30],
  ])
})

test('Given 同 turn/step 的 usage 被替换 When 折叠 Then 减旧值加新值且只留最新小时桶', () => {
  // Given 同一 (turn,step) 先报 100 后报 150,发生在不同小时
  // When 两次折叠
  // Then 旧小时桶被移除,新小时桶为 150,不重复累计
  let state = initial()
  state = apply(state, requestContext('newapi', 'auto-free', at(9)))
  state = apply(state, message(1, 1, at(9), { usage: usage({ inputTokens: 100 }) }))
  state = apply(state, message(1, 1, at(10), { usage: usage({ inputTokens: 150 }) }))
  assert.deepEqual(
    wire(state).hours.map((entry) => [entry.time, entry.uncachedInputTokens]),
    [[hourStart(at(10)), 150]],
  )
})

test('Given llm/retry-started 关闭替换槽 When 重试成功 Then 失败尝试保留并叠加成功尝试', () => {
  // Given 失败尝试先报 100,随后 retry-started 清槽
  // When 成功尝试报 50
  // Then 两个小时的样本都在,总额 150,与官方 tokenUsage 的 retry 口径一致
  let state = initial()
  state = apply(state, requestContext('newapi', 'auto-free', at(9)))
  state = apply(state, message(1, 1, at(9), { usage: usage({ inputTokens: 100 }) }))
  state = apply(state, {
    type: 'llm/retry-started',
    time: at(9, 5),
    data: { turn: 1, step: 1, retry: 1 },
  })
  state = apply(state, message(1, 1, at(10), { usage: usage({ inputTokens: 50 }) }))
  assert.deepEqual(
    wire(state).hours.map((entry) => [entry.time, entry.uncachedInputTokens]),
    [[hourStart(at(9)), 100], [hourStart(at(10)), 50]],
  )
})

test('Given attempt 的 stream 携带 usage When 折叠 Then 取最后一个 usage chunk', () => {
  // Given attempt 流里先后有两个 usage chunk
  // When 折叠
  // Then 取最后一个,与官方 lastAssistantStreamChunk 口径一致
  let state = initial()
  state = apply(state, requestContext('newapi', 'auto-free', at(9)))
  state = apply(state, attempt(2, 1, at(9), [
    { type: 'chunk', chunk: { type: 'usage', usage: usage({ inputTokens: 10 }) } },
    { type: 'chunk', chunk: { type: 'usage', usage: usage({ inputTokens: 40 }) } },
  ]))
  assert.equal(wire(state).hours[0].uncachedInputTokens, 40)
})

test('Given 全无路由 When 折叠 message Then 归入 */* 兜底键', () => {
  // Given 没有 request/context 且 message.source 缺失
  // When 折叠 usage
  // Then 模型键为 */*,仍保留用量供底栏按全局规则回退
  let state = initial()
  state = apply(state, {
    type: 'assistant/message',
    time: at(9),
    data: { turn: 1, step: 1, message: {}, usage: usage({ inputTokens: 10 }) },
  })
  assert.equal(wire(state).hours[0].model, '*/*')
})

test('Given 无关事件 When 折叠 Then 返回同一状态引用', () => {
  // Given 已有一条样本
  // When 喂入无关事件
  // Then apply 返回原引用,框架不产生无谓发布
  const state = apply(initial(), message(1, 1, at(9), { usage: usage() }))
  assert.equal(apply(state, { type: 'turn/start', time: at(9), data: { turn: 1 } }), state)
})

test('Given 空日志 When 初始化 Then wire 为空小时表', () => {
  assert.deepEqual(wire(initial()), { hours: [] })
})

test('Given 状态被持久化 When 用 stateSchema 解析 Then 结构通过', () => {
  // Given 路由、message 与 retry 都折叠过
  // When 状态经 stateSchema 解析
  // Then 不抛错且 wire 仍可生成
  let state = initial()
  state = apply(state, requestContext('newapi', 'auto-free', at(9)))
  state = apply(state, message(1, 1, at(9), { usage: usage() }))
  state = apply(state, { type: 'llm/retry-started', time: at(9, 5), data: { turn: 1, step: 1, retry: 1 } })
  assert.doesNotThrow(() => modelUsageProjectionDefinition.stateSchema.parse(state))
  assert.equal(wire(state).hours.length, 1)
})
