// 全仓性能基准入口:按用例文件的 meta/setup/run 逐个测量,报中位数并可与基线比对。
// 用例输入规模取自真实数据面(会话数 / 桶行数 / 任务数),可复现且不读写生产目录。
// 用法:
//   node scripts/perf/bench.mjs                      # 跑全部用例,人读表格
//   node scripts/perf/bench.mjs --json out.json      # 追加写入基线 JSON
//   node scripts/perf/bench.mjs --compare base.json   # 与基线比对,超阈值非零退出
//   node scripts/perf/bench.mjs --only usage         # 只跑名字含该片段的用例
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { measure, measureAsync } from './lib.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CASES_DIR = join(REPO_ROOT, 'scripts', 'perf', 'cases')
// 回归阈值:同环境比对时允许的劣化比例
const REGRESSION_LIMIT = 1.15
// 改善阈值:超过该比例才在报告里标为改善
const IMPROVEMENT_LIMIT = 0.85

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const handlers = {
      '--json': () => { args.json = argv[++index] },
      '--compare': () => { args.compare = argv[++index] },
      '--only': () => { args.only = argv[++index] },
    }
    handlers[argv[index]]?.()
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

async function runCase(entry) {
  const context = entry.setup === undefined ? undefined : await entry.setup()
  const spec = { iterations: entry.iterations, samples: entry.samples, run: entry.run }
  const stats = entry.runAsync === undefined
    ? measure(context, spec)
    : await measureAsync(context, { ...spec, run: entry.runAsync })
  return { stats, context }
}

const formatMs = (value) => (value < 1 ? `${(value * 1000).toFixed(1)}us` : `${value.toFixed(2)}ms`)

function printTable(results) {
  const nameWidth = Math.max(...results.map((item) => item.name.length), 4)
  console.log(`${'用例'.padEnd(nameWidth)}  ${'中位数'.padStart(10)}  ${'最小'.padStart(10)}  ${'p95'.padStart(10)}  ${'次/秒'.padStart(12)}`)
  for (const item of results) {
    const ops = Number.isFinite(item.stats.opsPerSec) ? Math.round(item.stats.opsPerSec).toLocaleString('en-US') : 'inf'
    console.log(`${item.name.padEnd(nameWidth)}  ${formatMs(item.stats.medianMs).padStart(10)}  ${formatMs(item.stats.minMs).padStart(10)}  ${formatMs(item.stats.p95Ms).padStart(10)}  ${ops.padStart(12)}`)
  }
}

function compareWithBaseline(results, baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const regressions = []
  const improvements = []
  for (const item of results) {
    const before = baseline[item.name]
    if (before === undefined) continue
    const ratio = item.stats.medianMs / before.medianMs
    if (ratio > REGRESSION_LIMIT) regressions.push({ name: item.name, before: before.medianMs, after: item.stats.medianMs, ratio })
    if (ratio < IMPROVEMENT_LIMIT) improvements.push({ name: item.name, before: before.medianMs, after: item.stats.medianMs, ratio })
  }
  console.log('')
  console.log(`基线比对: ${baselinePath}`)
  for (const item of improvements) console.log(`  改善 ${item.name}: ${formatMs(item.before)} -> ${formatMs(item.after)} (x${(1 / item.ratio).toFixed(2)})`)
  for (const item of regressions) console.log(`  劣化 ${item.name}: ${formatMs(item.before)} -> ${formatMs(item.after)} (x${item.ratio.toFixed(2)})`)
  if (regressions.length === 0) console.log('  无劣化')
  return regressions.length === 0
}

function writeBaseline(results, target) {
  const payload = {}
  for (const item of results) payload[item.name] = { ...item.stats, description: item.description, scale: item.scale }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(payload, null, 2))
  console.log(`基线已写入 ${target}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cases = await loadCases(args.only)
  if (cases.length === 0) {
    console.error('没有匹配的用例')
    process.exitCode = 1
    return
  }
  const results = []
  for (const entry of cases) {
    const { stats } = await runCase(entry)
    results.push({ name: entry.name, description: entry.description, scale: entry.scale, stats })
  }
  printTable(results)
  if (args.json !== undefined) writeBaseline(results, args.json)
  if (args.compare !== undefined) {
    const passed = compareWithBaseline(results, args.compare)
    if (!passed) process.exitCode = 1
  }
}

await main()
