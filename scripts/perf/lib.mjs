// 性能基准计时工具:单轮按时间预算自动定迭代数,预热按时间预算而非固定轮数。
// 进程内的 JIT 与堆状态会随前序用例改变,所以迭代数与预热都按"跑够时长"算,不按"跑够次数"算。
import { performance } from 'node:perf_hooks'

// 单轮目标时长:低于该量级的单轮会被计时精度与调度抖动主导
const TARGET_ROUND_MS = 2
// 预热预算:预热不足会让首轮显著偏慢,固定 1 轮预热在本机实测造成 1.2-2.2 倍偏差
const WARMUP_BUDGET_MS = 500
// 预热轮数上下限:防止极快用例空转、极慢用例预热到天荒地老
const MIN_WARMUP_ROUNDS = 2
const MAX_WARMUP_ROUNDS = 2000
// 自动迭代数的上下限
const MIN_ITERATIONS = 1
const MAX_ITERATIONS = 1_000_000
// 定标试跑次数:取最小值估计单次耗时,避免首次调用的类加载开销把迭代数压得过低
const CALIBRATION_RUNS = 3

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function runOnce(run, iterations) {
  const started = performance.now()
  for (let index = 0; index < iterations; index += 1) run()
  return (performance.now() - started) / iterations
}

// 按目标单轮时长反推迭代数:同一用例在不同机器上得到相同的单轮量级
function calibrate(run) {
  let fastest = Number.POSITIVE_INFINITY
  for (let index = 0; index < CALIBRATION_RUNS; index += 1) fastest = Math.min(fastest, runOnce(run, 1))
  if (!Number.isFinite(fastest) || fastest <= 0) return MIN_ITERATIONS
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, Math.ceil(TARGET_ROUND_MS / fastest)))
}

// 轮间离散 = 最大轮与最小轮之比:接近 1 说明各轮成本一致,远离 1 说明测量期间有外部负载
function spreadOf(perCall) {
  const low = Math.min(...perCall)
  return low === 0 ? Number.POSITIVE_INFINITY : Math.max(...perCall) / low
}

/**
 * 测量一个同步用例。用例若在单次 run 内批量调用被测量函数,用 callsPerIteration 声明批大小,
 * 统计量归一为"每次调用",否则不同用例的中位数会因为批大小不同而不可比。
 * @param context - 用例 setup 产出的上下文,原样传给 run。
 * @param spec - { run, samples, callsPerIteration }。
 * @returns 每次调用的毫秒统计,含实际迭代数与轮间离散度。
 */
export function measure(context, spec) {
  const run = () => spec.run(context)
  let iterations = calibrate(run)
  // 校准来自单次估计,补一轮实测把单轮真正拉到目标量级
  const probeMs = runOnce(run, iterations)
  if (probeMs * iterations < TARGET_ROUND_MS) iterations = Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, Math.ceil(TARGET_ROUND_MS / probeMs)))
  // 预热按累计时长,不按轮数:极快用例需要上万次才追上极慢用例一轮的预热量
  let warmed = 0
  let warmupRounds = 0
  while ((warmed < WARMUP_BUDGET_MS || warmupRounds < MIN_WARMUP_ROUNDS) && warmupRounds < MAX_WARMUP_ROUNDS) {
    warmed += runOnce(run, iterations) * iterations
    warmupRounds += 1
  }
  const samples = spec.samples ?? 5
  const calls = Math.max(1, spec.callsPerIteration ?? 1)
  const perBatch = []
  for (let round = 0; round < samples; round += 1) perBatch.push(runOnce(run, iterations))
  const perCall = perBatch.map((ms) => ms / calls)
  const medianMs = median(perCall)
  return {
    iterations,
    samples,
    callsPerIteration: calls,
    warmupRounds,
    warmupMs: warmed,
    medianMs,
    batchMs: median(perBatch),
    minMs: Math.min(...perCall),
    maxMs: Math.max(...perCall),
    spread: spreadOf(perBatch),
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
