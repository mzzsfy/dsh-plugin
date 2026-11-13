// 最近请求投影:官方统计弹窗详情所需的逐 step 原始指标。
// 只做同步折叠与窗口裁剪,不计算价格/均值;价格由客户端按当前规则派生。
// state 为纯 JSON,rescan 可从事件流重建。

import { z } from 'zod'

import { assistantStreamFirstTokenTime, refOf } from './collector.js'

export const RECENT_REQUESTS_STEPS = 10

const bucketSchema = z.object({
  uncachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
}).strict()

const openSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  startTime: z.number().nonnegative(),
  firstTokenTime: z.number().nonnegative().nullable(),
  attempts: z.number().int().nonnegative(),
  model: z.string().nullable(),
  usage: bucketSchema.nullable(),
}).strict().nullable()

const rowSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  startedAt: z.number().nonnegative(),
  firstTokenTime: z.number().nonnegative().nullable(),
  completedAt: z.number().nonnegative(),
  ttftMs: z.number().nonnegative().nullable(),
  decodeMs: z.number().nonnegative().nullable(),
  attempts: z.number().int().nonnegative(),
  model: z.string().nullable(),
  usage: bucketSchema.nullable(),
}).strict()

const stateSchema = z.object({
  route: z.string().nullable(),
  open: openSchema,
  rows: z.array(rowSchema),
}).strict()

const wireSchema = z.object({
  open: openSchema,
  rows: z.array(rowSchema),
}).strict()

const sameStep = (open, event) => open !== null
  && open.turn === event.data?.turn
  && open.step === event.data?.step

const bucketsOf = (usage) => {
  if (typeof usage !== 'object' || usage === null) return null
  const value = (key) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0
    ? usage[key]
    : 0)
  return {
    uncachedInputTokens: value('inputTokens'),
    outputTokens: value('outputTokens'),
    cacheReadTokens: value('cacheReadTokens'),
    cacheWriteTokens: value('cacheWriteTokens'),
  }
}

// 与官方 usageOf 同构:message 自带 usage 优先,否则取流内最后一个 usage chunk
const usageOf = (event) => {
  if (event.type === 'assistant/chunk') {
    return event.data?.chunk?.type === 'usage' ? event.data.chunk.usage : undefined
  }
  if (event.data?.usage !== undefined) return event.data.usage
  const records = event.data?.stream
  if (!Array.isArray(records)) return undefined
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

const appendRow = (rows, row) => {
  const index = rows.findIndex((item) => item.turn === row.turn && item.step === row.step)
  const next = index >= 0 ? rows.map((item, at) => (at === index ? row : item)) : [...rows, row]
  return next.length > RECENT_REQUESTS_STEPS ? next.slice(next.length - RECENT_REQUESTS_STEPS) : next
}

const durationOf = (left, right) => (Number.isFinite(left) && Number.isFinite(right)
  ? Math.max(0, right - left)
  : null)

const applyRecentRequestsEvent = (state, event) => {
  if (event.type === 'request/context') {
    const route = refOf(event.data) ?? state.route
    return route === state.route ? state : { ...state, route }
  }
  if (event.type === 'step/start') {
    const turn = event.data?.turn
    const step = event.data?.step
    if (!Number.isInteger(turn) || !Number.isInteger(step) || !Number.isFinite(event.time)) return state
    return {
      ...state,
      open: {
        turn,
        step,
        startTime: event.time,
        firstTokenTime: null,
        attempts: 1,
        model: state.route,
        usage: null,
      },
    }
  }
  if (event.type === 'llm/retry-started') {
    if (!sameStep(state.open, event)) return state
    return { ...state, open: { ...state.open, attempts: state.open.attempts + 1 } }
  }
  if (event.type === 'assistant/attempt') {
    if (!sameStep(state.open, event)) return state
    const first = assistantStreamFirstTokenTime(event.data?.stream)
    if (state.open.firstTokenTime !== null || typeof first !== 'number') return state
    return { ...state, open: { ...state.open, firstTokenTime: first } }
  }
  if (event.type === 'assistant/chunk') {
    if (!sameStep(state.open, event)) return state
    const usage = bucketsOf(usageOf(event))
    return usage === null ? state : { ...state, open: { ...state.open, usage } }
  }
  if (event.type === 'assistant/message') {
    const turn = event.data?.turn
    const step = event.data?.step
    if (!Number.isInteger(turn) || !Number.isInteger(step) || !Number.isFinite(event.time)) return state
    const open = sameStep(state.open, event) ? state.open : null
    const previous = state.rows.find((item) => item.turn === turn && item.step === step) ?? null
    if (open === null && previous === null) return state
    const first = open?.firstTokenTime
      ?? previous?.firstTokenTime
      ?? assistantStreamFirstTokenTime(event.data?.stream)
      ?? null
    const usage = bucketsOf(usageOf(event))
    const model = refOf(event.data?.message?.source) ?? open?.model ?? previous?.model ?? state.route
    const startedAt = open?.startTime ?? previous?.startedAt
    const row = {
      turn,
      step,
      startedAt,
      firstTokenTime: first,
      completedAt: event.time,
      ttftMs: first === null ? null : durationOf(startedAt, first),
      decodeMs: first === null ? null : durationOf(first, event.time),
      attempts: open?.attempts ?? previous?.attempts ?? 1,
      model,
      usage,
    }
    return { ...state, open: null, rows: appendRow(state.rows, row) }
  }
  return state
}

export const recentRequestsProjectionDefinition = {
  key: 'usageDashRecentRequests',
  stateVersion: 1,
  stateSchema,
  init: () => ({ route: null, open: null, rows: [] }),
  apply: applyRecentRequestsEvent,
  wire: {
    viewSchema: wireSchema,
    view: (state) => ({ open: state.open, rows: state.rows }),
    summary: false,
  },
}

export const __test = { bucketsOf, usageOf, appendRow, durationOf }
