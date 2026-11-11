// 全仓性能基准入口:每个用例在独立子进程里测量,多次重复取中位数,消除用例间 JIT 与堆状态的顺序耦合。
// 用例输入规模取自真实数据面(会话数 / 桶行数 / 任务数),可复现且不读写生产目录。
// 用法:
//   node scripts/perf/bench.mjs                       # 跑全部用例,人读表格
//   node scripts/perf/bench.mjs --json out.json       # 合并写入稳定测量(不稳的用例不写入)
//   node scripts/perf/bench.mjs --compare base.json    # 门禁:缺基线/不作数/劣化均非零退出
//   node scripts/perf/bench.mjs --only usage          # 只跑名字含该片段的用例
//   node scripts/perf/bench.mjs --worker <name>        # 子进程入口,供本脚本内部调用
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { measure } from './lib.mjs'
import { SCALE } from './scale.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CASES_DIR = join(REPO_ROOT, 'scripts', 'perf', 'cases')
// 每个用例用几个独立进程测量:进程间取中位数,单进程内的采样抖动不再直接决定结论
const REPEATS = 5
// 回归阈值:本机实测同一份代码重复测量的跨进程极差可达 1.46,阈值必须高于噪声底,
// 否则会把抖动当回归。代价是小于 40% 的真实劣化测不出来,这类结论需要固定环境或 A/B 交替测量
const REGRESSION_LIMIT = 1.4
// 改善阈值:与回归阈值对称,两侧都要求越过噪声底
const IMPROVEMENT_LIMIT = 0.6
// 跨进程极差上限:超过说明测量期间环境不稳,该用例不下结论
const STABLE_SPREAD_LIMIT = 1.4
// 基线里除用例键外还记录环境,供比对时判断是否同环境
const META_KEY = '__meta'
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const WORKER_TIMEOUT_MS = 120_000

function parseArgs(argv) {
  const args = {}
  const requireValue = (flag, next) => {
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} 缺少取值`)
    return next
  }
  for (let index = 0; index < argv.length; index += 1) {
    const handlers = {
      '--json': () => { args.json = requireValue('--json', argv[++index]) },
      '--compare': () => { args.compare = requireValue('--compare', argv[++index]) },
      '--only': () => { args.only = requireValue('--only', argv[++index]) },
      '--worker': () => { args.worker = requireValue('--worker', argv[++index]) },
    }
    const handler = handlers[argv[index]]
    if (handler === undefined) throw new Error(`未知参数: ${argv[index]}`)
    handler()
  }
  return args
}

async function loadCases(only) {
  if (!existsSync(CASES_DIR)) return []
  const files = readdirSync(CASES_DIR).filter((name) => name.endsWith('.mjs')).sort()
  const cases = []
  for (const file of files) {
    const module = await import(pathToFileURL(join(CASES_DIR, file)).href)
    const entries = module.cases ?? [module.default]
    for (const entry of entries) {
      if (entry === undefined) continue
      if (only !== undefined && !entry.name.includes(only)) continue
      cases.push(entry)
    }
  }
  return cases
}

function runInWorker(name) {
  const output = execFileSync(process.execPath, [SCRIPT_PATH, '--worker', name], {
    encoding: 'utf8', timeout: WORKER_TIMEOUT_MS, windowsHide: true,
  })
  return JSON.parse(output).stats
}

async function measureCase(name) {
  const perProcess = []
  for (let repeat = 0; repeat < REPEATS; repeat += 1) perProcess.push(runInWorker(name))
  const medians = perProcess.map((stats) => stats.medianMs).sort((a, b) => a - b)
  const medianMs = medians[Math.floor(medians.length / 2)]
  return {
    ...perProcess[0],
    medianMs,
    minMs: medians[0],
    maxMs: medians[medians.length - 1],
    spread: medians[0] === 0 ? Number.POSITIVE_INFINITY : medians[medians.length - 1] / medians[0],
    opsPerSec: medianMs === 0 ? Number.POSITIVE_INFINITY : 1000 / medianMs,
    processSpreads: perProcess.map((stats) => stats.spread),
  }
}

const formatMs = (value) => (value < 1 ? `${(value * 1000).toFixed(1)}us` : `${value.toFixed(2)}ms`)

function printTable(results) {
  const nameWidth = Math.max(...results.map((item) => item.name.length), 4)
  console.log(`${'用例'.padEnd(nameWidth)}  ${'中位数'.padStart(10)}  ${'最小'.padStart(10)}  ${'最大'.padStart(10)}  ${'离散'.padStart(6)}  ${'次/秒'.padStart(12)}  ${'迭代'.padStart(8)}`)
  for (const item of results) {
    const stats = item.stats
    const ops = Number.isFinite(stats.opsPerSec) ? Math.round(stats.opsPerSec).toLocaleString('en-US') : 'inf'
    const spread = Number.isFinite(stats.spread) ? `${stats.spread.toFixed(2)}x` : 'inf'
    const unstable = isStable(stats) ? '' : ' (不稳)'
    console.log(`${item.name.padEnd(nameWidth)}  ${formatMs(stats.medianMs).padStart(10)}  ${formatMs(stats.minMs).padStart(10)}  ${formatMs(stats.maxMs).padStart(10)}  ${spread.padStart(6)}  ${ops.padStart(12)}  ${String(stats.iterations).padStart(8)}${unstable}`)
  }
}

// 无离散记录(旧基线)按不稳处理:JSON 会把 Infinity 写成 null,不可当稳定
const isStable = (stats) => typeof stats.spread === 'number' && Number.isFinite(stats.spread) && stats.spread <= STABLE_SPREAD_LIMIT

const shapeSpread = (value) => (value === undefined ? '未记录' : Number.isFinite(value) ? `${value.toFixed(2)}x` : 'inf')

// 基线必须能支撑一次有意义的比对:缺关键字段或字段非法都按坏基线处理
function validateBaseline(entry, name) {
  if (entry === null || typeof entry !== 'object') return `${name} 不是对象`
  if (!Number.isFinite(entry.medianMs) || entry.medianMs <= 0) return `${name} 的 medianMs 非法`
  if (!Number.isFinite(entry.spread)) return `${name} 的 spread 非法`
  return null
}

function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) throw new Error(`基线不存在: ${baselinePath}`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch (error) {
    throw new Error(`基线不是合法 JSON: ${baselinePath} (${error.message})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`基线结构非法: ${baselinePath}`)
  return parsed
}

function compareWithBaseline(results, baselinePath) {
  const baseline = readBaseline(baselinePath)
  const meta = baseline[META_KEY]
  const blocking = []
  if (meta !== undefined) {
    if (meta.node !== process.version) blocking.push(`基线记录于 Node ${meta.node}, 当前 Node ${process.version}`)
    if (meta.platform !== undefined && meta.platform !== process.platform) blocking.push(`基线记录于 ${meta.platform}, 当前 ${process.platform}`)
    if (meta.tz !== undefined && meta.tz !== TIME_ZONE) blocking.push(`基线记录于时区 ${meta.tz}, 当前 ${TIME_ZONE}`)
    const scaleChanged = Object.keys(SCALE).filter((key) => meta.scale?.[key] !== SCALE[key])
    if (scaleChanged.length > 0) blocking.push(`输入规模已变: ${scaleChanged.map((key) => `${key} ${meta.scale?.[key] ?? '未记录'} -> ${SCALE[key]}`).join(', ')}`)
  }
  const regressions = []
  const improvements = []
  const skipped = []
  const missing = []
  const observational = []
  let compared = 0
  for (const item of results) {
    // 低于本机计时噪声底的对照组只报数字,不参与判定
    if (item.judgeable === false) { observational.push(item.name); continue }
    const before = baseline[item.name]
    if (before === undefined) { missing.push(item.name); continue }
    const invalid = validateBaseline(before, item.name)
    if (invalid !== null) { skipped.push({ name: item.name, reason: invalid }); continue }
    if (!isStable(item.stats) || !isStable(before)) {
      skipped.push({ name: item.name, reason: `本次离散 ${shapeSpread(item.stats.spread)}, 基线离散 ${shapeSpread(before.spread)}` })
      continue
    }
    compared += 1
    const ratio = item.stats.medianMs / before.medianMs
    if (ratio > REGRESSION_LIMIT) regressions.push({ name: item.name, before: before.medianMs, after: item.stats.medianMs, ratio })
    if (ratio < IMPROVEMENT_LIMIT) improvements.push({ name: item.name, before: before.medianMs, after: item.stats.medianMs, ratio })
  }
  const notRun = Object.keys(baseline).filter((name) => name !== META_KEY && !results.some((item) => item.name === name))
  console.log('')
  console.log(`基线比对: ${baselinePath}`)
  for (const reason of blocking) console.log(`  环境/规模不符: ${reason}`)
  for (const item of improvements) console.log(`  改善 ${item.name}: ${formatMs(item.before)} -> ${formatMs(item.after)} (x${(1 / item.ratio).toFixed(2)})`)
  for (const item of regressions) console.log(`  劣化 ${item.name}: ${formatMs(item.before)} -> ${formatMs(item.after)} (x${item.ratio.toFixed(2)})`)
  for (const item of skipped) console.log(`  不作数 ${item.name}: ${item.reason}`)
  for (const name of observational) console.log(`  仅观察 ${name}: 低于本机计时噪声底,不参与判定`)
  for (const name of missing) console.log(`  缺基线 ${name}: 该用例无历史数字`)
  for (const name of notRun) console.log(`  未运行 ${name}: 基线里有但本次没跑`)
  // 门禁语义:任何一项无法比对都是失败,跳过不等于通过
  const failed = blocking.length > 0 || regressions.length > 0 || skipped.length > 0 || missing.length > 0 || notRun.length > 0 || compared === 0
  if (!failed) console.log(`  通过: 参与比对 ${compared} 项, 无劣化`)
  else if (regressions.length === 0 && compared > 0) console.log(`  未通过: 有 ${blocking.length + skipped.length + missing.length + notRun.length} 项无法比对`)
  else if (regressions.length === 0) console.log(`  无法判定: 没有可参与比对的用例${observational.length === 0 ? '' : `, 仅观察 ${observational.join(', ')}`}`)
  return !failed
}

function writeBaseline(results, target) {
  const existing = existsSync(target) ? readBaseline(target) : {}
  const payload = { ...existing }
  let written = 0
  const rejected = []
  for (const item of results) {
    // 不稳的测量不写进基线:否则它会成为后续比对的假基准
    if (!isStable(item.stats)) { rejected.push(item.name); continue }
    payload[item.name] = { ...item.stats, description: item.description, scale: item.scale }
    written += 1
  }
  payload[META_KEY] = { node: process.version, platform: process.platform, tz: TIME_ZONE, scale: SCALE }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(payload, null, 2))
  console.log(`基线已写入 ${target}: 写入 ${written} 项${rejected.length === 0 ? '' : `, 跳过不稳 ${rejected.join(', ')}`}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.worker !== undefined) {
    const cases = await loadCases(args.worker)
    const entry = cases.find((item) => item.name === args.worker)
    if (entry === undefined) throw new Error(`找不到用例: ${args.worker}`)
    const context = entry.setup === undefined ? undefined : await entry.setup()
    const stats = measure(context, { run: entry.run, samples: entry.samples, callsPerIteration: entry.callsPerIteration })
    // 子进程只输出机器可读结果,主进程据此汇总
    process.stdout.write(JSON.stringify({ name: entry.name, stats }))
    return
  }
  const cases = await loadCases(args.only)
  if (cases.length === 0) {
    console.error('没有匹配的用例')
    process.exitCode = 1
    return
  }
  const results = []
  for (const entry of cases) {
    const stats = await measureCase(entry.name)
    results.push({ name: entry.name, description: entry.description, scale: entry.scale, judgeable: entry.judgeable, stats })
  }
  printTable(results)
  if (args.json !== undefined) writeBaseline(results, args.json)
  if (args.compare !== undefined) {
    if (!compareWithBaseline(results, args.compare)) process.exitCode = 1
  }
}

try {
  await main()
} catch (error) {
  console.error(`基准运行失败: ${error.message}`)
  process.exitCode = 1
}
