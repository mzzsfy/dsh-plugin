// CI 测试聚合:自动发现测试单元(按改动范围与平台过滤),重复多轮执行,失败单元按
// 单元-轮次 落盘日志,收尾聚合失败轮次与用例锚点(::error 注解 + GITHUB_STEP_SUMMARY 折叠明细)。
// 从 test.yml 内嵌 bash 等价移植;--rounds 供本地验证降轮次,CI 维持默认值;
// --changed-since <sha> 限定 push 改动涉及的单包(缺省/解析失败回退全量,fail-open)。
// 用法:node scripts/aggregate-tests.mjs [--rounds N] [--changed-since SHA]
import {spawn, spawnSync} from 'node:child_process'
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
// 单元运行错误锚点:写入单元日志,供失败明细区分"没跑起来"与"跑了但失败"
const UNIT_ERROR_ANCHOR = '[unit-error]'
const PACKAGES_DIR = 'packages'
const GENERIC_TEST_SUFFIX = '.test.mjs'
// 平台专属测试文件后缀:通用 *.test.mjs 两平台都跑,专属文件仅对应平台跑(CI=linux)
const PLATFORM_TEST_SUFFIXES = {
  win32: '.win.test.mjs',
  linux: '.linux.test.mjs',
}

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

// 测试文件平台过滤:通用 + 当前平台专属;platform 参数供测试注入
export function filterTestFiles(files, platform = process.platform) {
  const platformSuffix = PLATFORM_TEST_SUFFIXES[platform]
  const exclusiveSuffixes = Object.values(PLATFORM_TEST_SUFFIXES)
  return files.filter(file => {
    const exclusive = exclusiveSuffixes.some(suffix => file.endsWith(suffix))
    if (exclusive) return platformSuffix !== undefined && file.endsWith(platformSuffix)
    return file.endsWith(GENERIC_TEST_SUFFIX)
  })
}

// 单个测试目录的适用文件(相对该目录),全平台不适用 -> 空数组
export function applicableTestFiles(dir, testDir) {
  return filterTestFiles(readdirSync(join(dir, testDir)).filter(f => f.endsWith(GENERIC_TEST_SUFFIX) || Object.values(PLATFORM_TEST_SUFFIXES).some(s => f.endsWith(s))).sort())
    .map(f => join(testDir, f))
}

// 改动文件 -> 涉及包名集合;出现任何非 packages/ 路径 -> null(全量信号)
export function parseChangedPackages(lines) {
  const packages = new Set()
  for (const line of lines) {
    const segments = line.split('/')
    if (segments[0] !== PACKAGES_DIR || segments[1] === undefined || segments[1] === '') return null
    packages.add(segments[1])
  }
  return packages.size > 0 ? packages : null
}

// git diff 改动清单;无法可靠取得(空/全零/force push/非祖先)-> null 回退全量(fail-open)
export function changedFilesList(base) {
  if (!base || /^0+$/.test(base)) return null
  const result = spawnSync('git', ['diff', '--name-only', `${base}..HEAD`], {cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true})
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

// 单元发现:冒烟 + 含适用测试文件的包(字典序,保轮次间顺序稳定)+ 仓库根 tests。
// changedLines 传入 push 改动清单:全部落在 packages/<X>/ 时只保留 X(冒烟与仓库根测试保留),
// 否则全量。测试文件按平台过滤(win32/linux 后缀约定)。
export function discoverUnits(repoRoot, changedLines) {
  const changed = changedLines === undefined ? undefined : parseChangedPackages(changedLines)
  const units = [{name: 'smoke-load', command: [process.execPath, 'scripts/smoke-load.mjs'], cwd: repoRoot}]
  for (const dir of readdirSync(join(repoRoot, PACKAGES_DIR)).sort()) {
    const testPath = join(repoRoot, PACKAGES_DIR, dir, 'test')
    if (!existsSync(testPath) || !statSync(testPath).isDirectory()) continue
    if (changed && !changed.has(dir)) continue
    const files = applicableTestFiles(join(repoRoot, PACKAGES_DIR, dir), 'test')
    if (files.length === 0) continue
    units.push({name: dir, command: [process.execPath, '--test', ...files], cwd: join(repoRoot, PACKAGES_DIR, dir)})
  }
  const repoFiles = applicableTestFiles(repoRoot, 'tests')
  if (repoFiles.length > 0) units.push({name: 'repo-tests', command: [process.execPath, '--test', ...repoFiles], cwd: repoRoot})
  return units
}

export function parseArgs(argv) {
  const args = {rounds: TOTAL_ROUNDS}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rounds') args.rounds = Number(argv[++i])
    else if (argv[i] === '--changed-since') args.changedSince = argv[++i]
    else throw new Error(`未知参数: ${argv[i]}`)
  }
  if (!Number.isInteger(args.rounds) || args.rounds < 1) throw new Error(`轮次非法: ${args.rounds}`)
  return args
}

function runUnit(unit, logPath) {
  return new Promise(resolve => {
    const out = createWriteStream(logPath)
    out.on('error', error => {
      // out 已不可写,留痕失败再降级控制台,防错误处理自身抛出
      try {
        appendFileSync(logPath, `${UNIT_ERROR_ANCHOR} 日志流: ${error}\n`)
      } catch {
        console.error(`${UNIT_ERROR_ANCHOR} 日志流留痕失败: ${error}`)
      }
    })
    const child = spawn(unit.command[0], unit.command.slice(1), {cwd: unit.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
    // 经 out 写入保持与管道数据同一写入方,顺序一致
    child.on('error', error => out.write(`${UNIT_ERROR_ANCHOR} spawn: ${error}\n`))
    // 双源汇入同一文件流,end 统一由 close 收口,防源间 end 竞争
    child.stdout.pipe(out, {end: false})
    child.stderr.pipe(out, {end: false})
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
  const {rounds, changedSince} = parseArgs(process.argv.slice(2))
  const changedLines = changedSince === undefined ? undefined : changedFilesList(changedSince)
  const units = discoverUnits(REPO_ROOT, changedLines)
  const scoped = changedLines === undefined || changedLines === null
    ? '全量'
    : `范围收敛: ${units.length} 单元`
  console.log(`测试范围: ${scoped}(单元 ${units.map(u => u.name).join(', ')})`)
  const logDir = mkdtempSync(join(tmpdir(), 'aggregate-tests-'))
  try {
    return await runUnits({rounds, logDir, summaryPath: process.env.GITHUB_STEP_SUMMARY ?? null, units})
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
