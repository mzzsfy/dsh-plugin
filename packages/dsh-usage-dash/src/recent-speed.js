// 最近输出速度:会话投影单元。口径与宿主 sessionStats 逐字对齐 —— 只认 step/start
// 建立的当前步、assistant/attempt 锁定的首 token、assistant/message 的结算时刻,
// 单条 decode 时长 = 结算 - 首 token,分子取官方 usageOutputTokens 守卫后的输出 token。
// 与官方投影的唯一差别是保留最近 RECENT_SPEED_STEPS 条消息的配对以便分级加权,
// 官方只累加全局总量。state 纯 JSON 可序列化,rescan 时可从事件流重建。

import { z } from 'zod'

import { assistantStreamFirstTokenTime } from './collector.js'

export const RECENT_SPEED_STEPS = 10

const SAMPLE_KEYS = ['tokens', 'ms', 'time']

const sampleSchema = z.object({
  tokens: z.number().nonnegative(),
  ms: z.number().nonnegative(),
  time: z.number().int().nonnegative(),
}).strict()

const stateSchema = z.object({
  // 当前步:宿主同一时刻只开一个 step,与官方 openStep 同构(一条消息的采集窗口)
  open: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    startTime: z.number().nonnegative(),
    firstTokenTime: z.number().nonnegative().nullable(),
  }).strict().nullable(),
  // 已完成消息的 decode 配对,时间升序,长度上限 RECENT_SPEED_STEPS
  samples: z.array(sampleSchema),
}).strict()

const wireSchema = z.object({
  tps: z.number().nonnegative().nullable(),
  steps: z.number().int().nonnegative(),
}).strict()

// 官方 usageOutputTokens 同构:非有效数值不参与配对(0 合法)
const outputTokensOf = (usage) => {
  if (typeof usage !== 'object' || usage === null) return null
  const value = usage.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

const sameStep = (open, event) => open !== null
  && open.turn === event.data?.turn
  && open.step === event.data?.step

// 追加配对并裁到窗口上限:重报同一步骤时原位替换(回扫与实时可能各来一次)
const withSample = (samples, sample) => {
  const index = samples.findIndex((item) => item.time === sample.time)
  const next = index >= 0 ? samples.map((item, at) => (at === index ? sample : item)) : [...samples, sample]
  return next.length > RECENT_SPEED_STEPS ? next.slice(next.length - RECENT_SPEED_STEPS) : next
}

const applyRecentSpeedEvent = (state, event) => {
  switch (event.type) {
    case 'step/start':
      return {
        ...state,
        open: {
          turn: event.data?.turn,
          step: event.data?.step,
          startTime: event.time,
          firstTokenTime: null,
        },
      }
    case 'assistant/attempt': {
      if (!sameStep(state.open, event)) return state
      const first = assistantStreamFirstTokenTime(event.data?.stream)
      if (state.open.firstTokenTime !== null || typeof first !== 'number') return state
      return { ...state, open: { ...state.open, firstTokenTime: first } }
    }
    case 'assistant/message': {
      if (!sameStep(state.open, event)) return state
      const open = state.open
      const first = open.firstTokenTime ?? assistantStreamFirstTokenTime(event.data?.stream) ?? null
      const tokens = outputTokensOf(event.data?.usage)
      if (first === null || tokens === null) return { ...state, open: null }
      return {
        ...state,
        open: null,
        samples: withSample(state.samples, {
          tokens,
          ms: Math.max(0, event.time - first),
          time: event.time,
        }),
      }
    }
    default:
      return state
  }
}

// 窗口内加权速度:输出 token 合计 ÷ decode 时长合计,零输出步骤仍计分母(官方同构)
export const recentSpeedOfSamples = (samples) => {
  let tokens = 0
  let ms = 0
  for (const sample of samples) {
    tokens += sample.tokens
    ms += sample.ms
  }
  return ms > 0 ? tokens / (ms / 1000) : null
}

export const recentSpeedProjectionDefinition = {
  key: 'usageDashRecentSpeed',
  stateVersion: 1,
  stateSchema,
  init: () => ({ open: null, samples: [] }),
  apply: applyRecentSpeedEvent,
  wire: {
    viewSchema: wireSchema,
    view: (state) => ({ tps: recentSpeedOfSamples(state.samples), steps: state.samples.length }),
    summary: false,
  },
}

export const __test = { SAMPLE_KEYS, outputTokensOf, withSample, applyRecentSpeedEvent }
