// 会话用量投影:官方 tokenUsage 只有四桶总量,底栏拿不到 routes,只能按 */* 猜价。
// 本单元复刻官方 tokenUsage 的替换/重试口径,额外记录路由与小时,供底栏按模型计量。
// 纯同步折叠,状态可 JSON 持久化;wire 只暴露小时/模型汇总,不暴露内部替换槽。

import { z } from 'zod'

import { refOf } from './collector.js'

export const MODEL_USAGE_PROJECTION_KEY = 'usageDashModelUsage'

const MODEL_UNROUTED = '*/*'
const BUCKET_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

const zeroBuckets = () => Object.fromEntries(BUCKET_KEYS.map((key) => [key, 0]))

const bucketShape = Object.fromEntries(
  BUCKET_KEYS.map((key) => [key, z.number().int().nonnegative()]),
)
const bucketSchema = z.object(bucketShape).strict()

const stateSchema = z.object({
  // 小时起点(本地整点)→ 模型引用 → 四桶
  hours: z.record(z.string(), z.record(z.string(), bucketSchema)),
  // 与官方 tokenUsage 同名替换槽:同 turn/step 的后续报告减旧值加新值
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    hour: z.number().int().nonnegative(),
    model: z.string(),
    buckets: bucketSchema,
  }).strict().nullable(),
  // request/context 与 message.source 宣告的当前路由;attempt 无 source 时沿用
  route: z.string().nullable(),
}).strict()

const wireSchema = z.object({
  hours: z.array(z.object({
    time: z.number().int().nonnegative(),
    model: z.string(),
    ...bucketShape,
  }).strict()),
}).strict()

const numberOrZero = (value) => (Number.isFinite(value) ? value : 0)

const bucketsFrom = (usage) => ({
  uncachedInputTokens: numberOrZero(usage?.inputTokens),
  outputTokens: numberOrZero(usage?.outputTokens),
  cacheReadTokens: numberOrZero(usage?.cacheReadTokens),
  cacheWriteTokens: numberOrZero(usage?.cacheWriteTokens),
})

const bucketsEqual = (left, right) => BUCKET_KEYS.every((key) => left[key] === right[key])

const bucketsAreZero = (buckets) => BUCKET_KEYS.every((key) => buckets[key] === 0)

const hourStartOf = (time) => {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return null
  date.setMinutes(0, 0, 0)
  return date.getTime()
}

// 将一份四桶增量写入小时/模型格;写空即删,避免持久化空壳。
// sign 为 -1 时是替换槽的旧值回退;返回原引用表示没有可观察变化。
const writeBuckets = (hours, hour, model, buckets, sign) => {
  if (hour === null) return hours
  const hourKey = String(hour)
  const hourBucket = hours[hourKey]
  const current = hourBucket?.[model] ?? zeroBuckets()
  const next = Object.fromEntries(BUCKET_KEYS.map((key) => [key, current[key] + sign * buckets[key]]))
  if (BUCKET_KEYS.every((key) => next[key] === current[key])) return hours
  const nextHour = { ...(hourBucket ?? {}) }
  if (bucketsAreZero(next)) delete nextHour[model]
  else nextHour[model] = next
  const nextHours = { ...hours }
  if (Object.keys(nextHour).length === 0) delete nextHours[hourKey]
  else nextHours[hourKey] = nextHour
  return nextHours
}

// 官方 usageOf 同构:message 自带 usage 优先,否则取最后一条 usage chunk
const usageOf = (event) => {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

const sampleOf = (state, event, usage, route) => {
  const hour = hourStartOf(event.time)
  if (hour === null) return state
  const turn = event.data?.turn
  const step = event.data?.step
  if (!Number.isInteger(turn) || !Number.isInteger(step)) return state
  const buckets = bucketsFrom(usage)
  const previous = state.last !== null && state.last.turn === turn && state.last.step === step
    ? state.last
    : null
  if (previous !== null && bucketsEqual(previous.buckets, buckets)) return state
  if (previous === null && bucketsAreZero(buckets)) return state
  let hours = state.hours
  if (previous !== null) hours = writeBuckets(hours, previous.hour, previous.model, previous.buckets, -1)
  hours = writeBuckets(hours, hour, route, buckets, 1)
  return {
    ...state,
    hours,
    last: { turn, step, hour, model: route, buckets },
  }
}

const applyModelUsageEvent = (state, event) => {
  if (event.type === 'llm/retry-started') {
    return state.last?.turn === event.data?.turn && state.last?.step === event.data?.step
      ? { ...state, last: null }
      : state
  }
  if (event.type === 'request/context') {
    const route = refOf(event.data) ?? state.route
    return route === state.route ? state : { ...state, route }
  }
  if (event.type === 'assistant/message') {
    const sourceRoute = refOf(event.data?.message?.source)
    const route = sourceRoute ?? state.route
    const usage = usageOf(event)
    const next = usage === undefined ? state : sampleOf(state, event, usage, route ?? MODEL_UNROUTED)
    if (sourceRoute === undefined || route === state.route) return next
    return { ...next, route }
  }
  if (event.type === 'assistant/attempt') {
    const usage = usageOf(event)
    if (usage === undefined) return state
    return sampleOf(state, event, usage, state.route ?? MODEL_UNROUTED)
  }
  return state
}

const viewHoursOf = (state) => {
  const hours = []
  for (const [time, models] of Object.entries(state.hours)) {
    for (const [model, buckets] of Object.entries(models)) {
      hours.push({ time: Number(time), model, ...buckets })
    }
  }
  hours.sort((left, right) => left.time - right.time
    || (left.model < right.model ? -1 : left.model > right.model ? 1 : 0))
  return hours
}

export const modelUsageProjectionDefinition = {
  key: MODEL_USAGE_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({ hours: {}, last: null, route: null }),
  apply: applyModelUsageEvent,
  wire: {
    viewSchema: wireSchema,
    view: (state) => ({ hours: viewHoursOf(state) }),
    summary: false,
  },
}
