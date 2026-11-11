// 性能基准计时工具:固定迭代批量计时,多轮取样报中位数,避免单次测量定结论。
// 计时不含 setup,每轮独立取样使 GC 抖动均匀落在各轮之间。
import { performance } from 'node:perf_hooks'

// 预热量占总迭代的比例
const WARMUP_RATIO = 0.2
// 中位数取分的分位点
const P95_QUANTILE = 0.95
// 单轮最小迭代数,保证短用例也有可读的量级
const MIN_ITERATIONS = 1

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

// 单轮:跑 iterations 次 run,报每次耗时(毫秒)
function runOnce(run, iterations) {
  const started = performance.now()
  for (let index = 0; index < iterations; index += 1) run()
  return (performance.now() - started) / iterations
}

/**
 * 测量一个同步用例。
 * @param context - 用例 setup 产出的上下文,原样传给 run。
 * @param spec - { run, iterations, samples }。
 * @returns 单次调用的毫秒统计。
 */
export function measure(context, spec) {
  const iterations = Math.max(MIN_ITERATIONS, spec.iterations)
  const samples = spec.samples ?? 5
  const warmupRounds = Math.max(1, Math.round(samples * WARMUP_RATIO))
  for (let round = 0; round < warmupRounds; round += 1) runOnce((...args) => spec.run(context, ...args), iterations)
  const perCall = []
  for (let round = 0; round < samples; round += 1) perCall.push(runOnce((...args) => spec.run(context, ...args), iterations))
  const medianMs = median(perCall)
  return {
    iterations,
    samples,
    medianMs,
    minMs: Math.min(...perCall),
    p95Ms: quantile(perCall, P95_QUANTILE),
    opsPerSec: medianMs === 0 ? Number.POSITIVE_INFINITY : 1000 / medianMs,
  }
}

/**
 * 测量一个异步用例,序列执行避免并发掩盖单次成本。
 * @param context - 用例 setup 产出的上下文。
 * @param spec - { run, iterations, samples }。
 * @returns 单次调用的毫秒统计。
 */
export async function measureAsync(context, spec) {
  const iterations = Math.max(MIN_ITERATIONS, spec.iterations)
  const samples = spec.samples ?? 5
  const warmupRounds = Math.max(1, Math.round(samples * WARMUP_RATIO))
  const runSeries = async () => {
    const started = performance.now()
    for (let index = 0; index < iterations; index += 1) await spec.run(context)
    return (performance.now() - started) / iterations
  }
  for (let round = 0; round < warmupRounds; round += 1) await runSeries()
  const perCall = []
  for (let round = 0; round < samples; round += 1) perCall.push(await runSeries())
  const medianMs = median(perCall)
  return {
    iterations,
    samples,
    medianMs,
    minMs: Math.min(...perCall),
    p95Ms: quantile(perCall, P95_QUANTILE),
    opsPerSec: medianMs === 0 ? Number.POSITIVE_INFINITY : 1000 / medianMs,
  }
}

/**
 * 建立可复现的伪随机序列:基准以外的输入规模由固定种子生成,同一 seed 结果恒定。
 * @param seed - 初始状态。
 * @returns 返回 [0,1) 的取值函数。
 */
export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}
