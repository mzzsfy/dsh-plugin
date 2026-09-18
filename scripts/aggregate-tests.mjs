// CI 全量测试聚合:自动发现测试单元,重复多轮执行,失败单元按 单元-轮次 落盘日志,
// 收尾聚合失败轮次与用例锚点(::error 注解 + GITHUB_STEP_SUMMARY 折叠明细)。
// 从 test.yml 内嵌 bash 等价移植;--rounds 供本地验证降轮次,CI 维持默认值。
// 用法:node scripts/aggregate-tests.mjs [--rounds N]
import {spawn} from 'node:child_process'
import {mkdtempSync, readdirSync, existsSync, statSync, readFileSync, rmSync, appendFileSync, createWriteStream} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, basename} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOTAL_ROUNDS = 10
const PREVIEW_LIMIT = 5
const DETAIL_LIMIT = 200
const FALLBACK_TAIL_LIMIT = 50
const FAILING_SECTION_ANCHOR = '✖ failing tests:'

// 失败用例名提取:删段头行,去缩进/✖ 字形/耗时,按执行序去重(对齐 bash names_from_logs)
export function namesFromLogs(lines) {
  const names = []
  for (const line of lines) {
    if (!/^\s*✖/.test(line)) continue
    if (line.includes(FAILING_SECTION_ANCHOR)) continue
    const name = line.replace(/^\s*✖\s*/, '').replace(/ \([\d.]+ms\)$/, '')
    if (!names.includes(name)) names.push(name)
  }
  return names
}

// spec reporter 统计行第三个字段;崩溃无统计 -> null(展示为 ?)
export function unitFailCount(logText) {
  const line = logText.split('\n').find(candidate => candidate.startsWith('ℹ fail'))
  return line ? line.split(' ')[2] : null
}

// 单元发现:冒烟 + 含 test/ 的包(字典序,保轮次间顺序稳定)+ 仓库根 tests(补 CI 盲区)
export function discoverUnits(repoRoot) {
  const units = [{name: 'smoke-load', command: [process.execPath, 'scripts/smoke-load.mjs'], cwd: repoRoot}]
  for (const dir of readdirSync(join(repoRoot, 'packages')).sort()) {
    const testPath = join(repoRoot, 'packages', dir, 'test')
    if (!existsSync(testPath) || !statSync(testPath).isDirectory()) continue
    units.push({name: dir, command: [process.execPath, '--test', 'test/*.test.mjs'], cwd: join(repoRoot, 'packages', dir)})
  }
  units.push({name: 'repo-tests', command: [process.execPath, '--test', 'tests/*.test.mjs'], cwd: repoRoot})
  return units
}

export function parseRounds(argv) {
  let rounds = TOTAL_ROUNDS
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rounds') rounds = Number(argv[++i])
    else throw new Error(`未知参数: ${argv[i]}`)
  }
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error(`轮次非法: ${rounds}`)
  return rounds
}

function runUnit(unit, logPath) {
  return new Promise(resolve => {
    const out = createWriteStream(logPath)
    const child = spawn(unit.command[0], unit.command.slice(1), {cwd: unit.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
    child.stdout.pipe(out)
    child.stderr.pipe(out)
    child.on('close', code => {
      // 等落盘回调再返回,防下游读到未刷满的日志
      out.end(() => resolve(code === 0))
    })
  })
}

const roundLogPath = (logDir, name, round) => join(logDir, `${name}-${round}.log`)
const countOrUnknown = count => count ?? '?'
const totalFailures = failed => [...failed.values()].reduce((sum, entry) => sum + entry.count, 0)

export async function runUnits({rounds, logDir, summaryPath, log = console.log, units}) {
  const failed = new Map()
  for (let round = 1; round <= rounds; round++) {
    log(`::group::第 ${round}/${rounds} 轮`)
    // 本轮失败单元个数(事件计数,同一单元连败多轮每轮各计 1)
    let roundFails = 0
    for (const unit of units) {
      const logPath = roundLogPath(logDir, unit.name, round)
      if (await runUnit(unit, logPath)) {
        log(`OK   ${unit.name}`)
        rmSync(logPath, {force: true})
        continue
      }
      const logText = readFileSync(logPath, 'utf8')
      const failCount = unitFailCount(logText)
      log(`FAIL ${unit.name} (失败用例 ${countOrUnknown(failCount)})`)
      const entry = failed.get(unit.name) ?? {count: 0, rounds: [], logs: []}
      entry.count += 1
      roundFails += 1
      entry.rounds.push(String(round))
      entry.logs.push(logPath)
      failed.set(unit.name, entry)
      // 失败用例名预览(套件标记一并呈现)
      for (const name of namesFromLogs(logText.split('\n')).slice(0, PREVIEW_LIMIT)) log(`  ✖ ${name}`)
    }
    log(`本轮失败单元数: ${roundFails}`)
    log('::endgroup::')
  }
  log(`汇总: ${rounds} 轮, 失败单元累计 ${totalFailures(failed)}`)

  if (failed.size > 0) log('失败单元清单(次数=失败轮数):')
  for (const name of [...failed.keys()].sort()) {
    const entry = failed.get(name)
    // 轮次从日志文件名提取(单元-轮次.log),与落盘命名同源
    const roundLogs = entry.logs.map(path => ({round: basename(path, '.log').slice(name.length + 1), path}))
    const roundsInfo = roundLogs
      .map(({round, path}) => `第${round}轮(${countOrUnknown(unitFailCount(readFileSync(path, 'utf8')))}) `)
      .join('')
    // 注解 message 段中 % 须转义,防止用例名含 %xx 被 runner 解码
    const caseNames = [...new Set(entry.logs.flatMap(path => namesFromLogs(readFileSync(path, 'utf8').split('\n'))))]
      .slice(0, PREVIEW_LIMIT).join(';').replaceAll('%', '%25').replace(/[\r\n]+/g, ' ')
    log(`  ${entry.count}x ${name}`)
    log(`::error::单元失败 ${entry.count}/${rounds} 轮: ${name} | 失败轮次: ${roundsInfo}| 用例: ${caseNames || '无用例锚点,看失败明细'}`)
    if (!summaryPath) continue
    const firstLogLines = readFileSync(entry.logs[0], 'utf8').split('\n')
    const anchor = firstLogLines.findIndex(line => line.startsWith(FAILING_SECTION_ANCHOR))
    const detail = anchor >= 0
      ? firstLogLines.slice(anchor, anchor + DETAIL_LIMIT).join('\n')
      : firstLogLines.slice(-FALLBACK_TAIL_LIMIT).join('\n')
    appendFileSync(summaryPath, [
      `### ${name}(失败 ${entry.count}/${rounds} 轮: ${roundsInfo})`,
      '<details><summary>失败明细(首轮错误与堆栈)</summary>',
      '',
      '```text',
      detail,
      '```',
      '</details>',
      '',
    ].join('\n'))
  }
  return {failures: totalFailures(failed), failedUnits: [...failed.entries()].map(([unitName, entry]) => ({name: unitName, rounds: entry.rounds}))}
}

async function main() {
  const rounds = parseRounds(process.argv.slice(2))
  const logDir = mkdtempSync(join(tmpdir(), 'aggregate-tests-'))
  try {
    return await runUnits({rounds, logDir, summaryPath: process.env.GITHUB_STEP_SUMMARY ?? null, units: discoverUnits(REPO_ROOT)})
  } finally {
    rmSync(logDir, {recursive: true, force: true})
  }
}

// 仅直接执行时运行(被测模块导入不触发 CLI)
const isEntrypoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isEntrypoint) {
  main().then(({failures}) => {
    if (failures > 0) process.exitCode = 1
  }).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
