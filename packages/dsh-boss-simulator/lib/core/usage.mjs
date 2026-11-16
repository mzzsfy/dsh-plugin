// 用量归并:usageLedger 键→已采纳值;同键重读/重试/fork 继承不双计(DATA-08);
// coverage 语义: null/unknown=情况未知,0/complete=确有报告且为零,部分缺失=partial(DATA-15)
import { fail, pass } from './command.mjs'

function tokensOf(usage) {
  const input = usage?.inputTokens
  const output = usage?.outputTokens
  const cacheRead = usage?.cacheReadTokens ?? 0
  const cacheWrite = usage?.cacheWriteTokens ?? 0
  if (![input, output, cacheRead, cacheWrite].every((v) => v === null || v === undefined || (Number.isInteger(v) && v >= 0))) return null
  if (input === null || input === undefined || output === null || output === undefined) return null
  return input + output + cacheRead + cacheWrite
}

// usage: { invocationKey, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, model } 或 null(未知)
// completeUsage: 明确没有任何调用时以 completeUsage=true 提交
export function mergeRunUsage(aggregate, { runId, usage, completeUsage = false }) {
  const run = aggregate.runs[runId]
  if (!run) return fail('NOT_FOUND', `Run 不存在: ${runId}`)
  const ledger = { ...aggregate.usageLedger }
  let unknownCount = run.unknownUsageCount ?? 0
  let knownTotal = run.knownTokenTotal ?? 0
  if (usage) {
    const tokens = tokensOf(usage)
    if (tokens === null) return fail('INVALID_ARGUMENT', 'usage 数值非法')
    if (ledger[usage.invocationKey] !== undefined) {
      // 已采纳:重读/重试/fork 继承路径,保持原值不双计
      if (ledger[usage.invocationKey].tokens !== tokens) {
        return fail('INVALID_ARGUMENT', `同 invocationKey 用量不一致: ${usage.invocationKey}`)
      }
      return pass({ aggregate })
    }
    ledger[usage.invocationKey] = { runId, model: usage.model ?? null, tokens }
    knownTotal += tokens
  } else if (completeUsage) {
    // 明确零:不动 ledger,coverage 由零已知与 unknown 计数决定
  } else {
    unknownCount += 1
  }
  let next = aggregate
  const tokenTotal = knownTotal
  let coverage
  if (unknownCount === 0) coverage = 'complete'
  else if (knownTotal > 0) coverage = 'partial'
  else coverage = 'unknown'
  next = { ...aggregate, usageLedger: ledger }
  next.runs = { ...aggregate.runs, [runId]: { ...run, tokenTotal, usageCoverage: coverage, unknownUsageCount: unknownCount, knownTokenTotal: knownTotal } }
  return pass({ aggregate: next })
}

// 跟随期观察:把一次模型调用的用量挂在 Run 上,终态收敛时才并入台账。
// usage 为 null 表示该次调用没有报用量(coverage 因此不能算 complete)。
export function noteRunUsage(aggregate, { runId, invocationKey, usage }) {
  const run = aggregate.runs[runId]
  if (!run) return fail('NOT_FOUND', `Run 不存在: ${runId}`)
  if (typeof invocationKey !== 'string' || !invocationKey) return fail('INVALID_ARGUMENT', '用量缺少 invocationKey')
  const observed = { ...(run.observedUsage ?? {}) }
  if (Object.hasOwn(observed, invocationKey)) {
    return JSON.stringify(observed[invocationKey]) === JSON.stringify(usage)
      ? pass({ aggregate, replayed: true })
      : fail('INVALID_ARGUMENT', `同 invocationKey 用量不一致: ${invocationKey}`)
  }
  observed[invocationKey] = usage
  return pass({ aggregate: { ...aggregate, runs: { ...aggregate.runs, [runId]: { ...run, observedUsage: observed } } } })
}

// Run 终态收敛:观察到的逐调用用量并入台账与 tokenTotal,随后清空观察区避免与台账双份。
// completeUsage=true 表示"确有证据本轮零调用"(如派发在 prompt 受理前即被拒):此时按明确零入账,
// coverage 才可能落到 complete;否则缺观察项只能算 unknown/partial。
export function convergeRunUsage(aggregate, runId, { completeUsage = false } = {}) {
  const run = aggregate.runs[runId]
  if (!run) return fail('NOT_FOUND', `Run 不存在: ${runId}`)
  let next = aggregate
  const observed = Object.entries(run.observedUsage ?? {})
  for (const [invocationKey, usage] of observed) {
    const merged = mergeRunUsage(next, { runId, usage: usage === null ? null : { ...usage, invocationKey } })
    if (!merged.ok) return merged
    next = merged.result.aggregate
  }
  if (completeUsage && observed.length === 0) {
    const merged = mergeRunUsage(next, { runId, usage: null, completeUsage: true })
    if (!merged.ok) return merged
    next = merged.result.aggregate
  }
  const { observedUsage, ...rest } = next.runs[runId]
  return pass({ aggregate: { ...next, runs: { ...next.runs, [runId]: rest } } })
}

// Task 汇总:全部 Run 并集;unknown 不换算为 0
export function taskUsageSummary(aggregate) {
  const runs = Object.values(aggregate.runs)
  let knownTotal = 0
  let unknown = 0
  for (const run of runs) {
    if (run.usageCoverage === 'unknown' || run.usageCoverage === 'partial') unknown += 1
    knownTotal += run.knownTokenTotal ?? run.tokenTotal ?? 0
  }
  let coverage = 'complete'
  if (runs.length === 0) coverage = 'unknown'
  else if (unknown > 0) coverage = knownTotal > 0 ? 'partial' : 'unknown'
  return { tokenTotal: coverage === 'unknown' && knownTotal === 0 ? null : knownTotal, coverage }
}
