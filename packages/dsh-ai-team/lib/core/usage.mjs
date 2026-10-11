// 用量归并:usageLedger 键→已采纳值;同键重读/重试/fork 继承不双计(DATA-08);
// coverage 语义: null/unknown=情况未知,0/complete=确有报告且为零,部分缺失=partial(DATA-15)
import { fail, pass } from './command.mjs'

const COVERAGE = ['complete', 'partial', 'unknown']

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
