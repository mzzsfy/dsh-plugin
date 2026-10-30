// CI 测试聚合:自动发现测试单元(按改动范围与平台过滤),重复多轮执行,失败单元按
// 单元-轮次 落盘日志,收尾聚合失败轮次与用例锚点(::error 注解 + GITHUB_STEP_SUMMARY 折叠明细)。
// 从 test.yml 内嵌 bash 等价移植;--rounds 供本地验证降轮次,CI 维持默认值;
// --changed-since <sha> 限定 push 改动涉及的单包(缺省/解析失败回退全量,fail-open)。
// 用法:node scripts/aggregate-tests.mjs [--rounds N] [--changed-since SHA]
import {spawn, spawnSync} from 'node:child_process'
import {mkdtempSync, readdirSync, existsSync, statSync, readFileSync, rmSync, appendFileSync, createWriteStream} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, basename} from 'node:path'
import {createEvidenceLogDir} from './aggregate-evidence.mjs'
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
const NODE_CMD = 'node '
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

// spec reporter 的 skip 统计行;无该行(旧 runner/全崩)视 0
export function unitSkipCount(logText) {
  const line = logText.split('\n').find(candidate => candidate.startsWith('ℹ skipped'))
  return line ? Number(line.split(' ')[2]) || 0 : 0
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

// 包内 test script 的 node 运行参数段(--test 锚点之前),供桩预载等 flag 随单元透传。
// 锚点为词边界 --test(含 script 以 --test 结尾形态);head 段含引号即整段回退——
// 引号值内的 --test(如 --test-name-pattern "x --test y")不做引号解析,保守安全。
// head 按 flag/值成对扫描:不以 -- 开头的 token 只能作为前一 flag 的值,违反即整体回退。
// 契约:head 不得引入改变输出统计形态的 flag(聚合器按 ℹ fail/ℹ skipped 解析),由包侧保证
export function nodeFlagsFromTestScript(testScript) {
  if (typeof testScript !== 'string' || !testScript.startsWith(NODE_CMD)) return []
  const anchor = testScript.match(/(?:^|\s)--test(?:\s|$)/)
  if (!anchor) return []
  const head = testScript.slice(NODE_CMD.length, anchor.index)
  if (head.includes('"') || head.includes("'")) return []
  const tokens = head.split(' ').filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('--')) return []
    if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('--')) i++
  }
  return tokens
}

// 包清单的 test script;清单缺失或非法 -> undefined(回退默认命令,不让发现层崩红)
function readTestScript(pkgDir) {
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))?.scripts?.test
  } catch {
    return undefined
  }
}

// runner 协议判定:test script 是 `node ... --test <files>` 形态时聚合器可重建等价命令
// (flag 段透传),否则整个 script 视为自定义 runner,原样经 shell 执行——宿主定位/版本
// 校验/NODE_PATH 等准备逻辑归包所有,聚合器不猜
export function isNodeTestScript(testScript) {
  return typeof testScript === 'string' && testScript.startsWith(NODE_CMD)
    && /(?:^|\s)--test(?:\s|$)/.test(testScript)
    && !(testScript.slice(NODE_CMD.length, testScript.match(/(?:^|\s)--test(?:\s|$)/).index).includes('"'))
    && !(testScript.slice(NODE_CMD.length, testScript.match(/(?:^|\s)--test(?:\s|$)/).index).includes("'"))
}

// 包间依赖反向闭包:dependencies 里的 @mzzsfy/dsh-* 即依赖边(去掉 @mzzsfy/ 前缀,
// 映射到 packages/ 目录名);changed ∪ 直接/传递消费者。共享库(common-tools 等)
// 变更时其消费者必须入列,漏消费方 = 绿测假象
export function expandConsumers(repoRoot, changed) {
  const dependents = new Map()
  for (const dir of readdirSync(join(repoRoot, PACKAGES_DIR))) {
    const manifestPath = join(repoRoot, PACKAGES_DIR, dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let deps
    try {
      deps = JSON.parse(readFileSync(manifestPath, 'utf8'))?.dependencies ?? {}
    } catch {
      continue
    }
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@mzzsfy/dsh-')) continue
      const target = name.slice('@mzzsfy/'.length)
      if (!dependents.has(target)) dependents.set(target, new Set())
      dependents.get(target).add(dir)
    }
  }
  const expanded = new Set(changed)
  const queue = [...changed]
  while (queue.length > 0) {
    const current = queue.pop()
    for (const consumer of dependents.get(current) ?? []) {
      if (expanded.has(consumer)) continue
      expanded.add(consumer)
      queue.push(consumer)
    }
  }
  return expanded
}

// 改动文件 -> 涉及包名集合;出现任何非 packages/ 路径 -> null(全量信号);
// 非数组输入(null = changedFilesList 的 fail-open 信号)同样返回 null,禁止崩溃
export function parseChangedPackages(lines) {
  if (!Array.isArray(lines)) return null
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

// 仓库根解析桥供给检查:root package.json 声明的依赖在 node_modules 缺项时逐个列出。
// 缺项时逐包单测会以 MODULE_NOT_FOUND 大面积恒红,且与真实代码失败不可区分(类7 现症
// 2026-10-01:宿主闭包拷贝覆盖 npm 供给,7 包 1538 用例恒红无人发现);预检把这类
// 环境损伤变成一条可行动的显式失败,先于任何单元执行
export function missingBridgeDeps(repoRoot, rootPackageJsonPath = join(repoRoot, 'package.json')) {
  const manifest = JSON.parse(readFileSync(rootPackageJsonPath, 'utf8'))
  const deps = manifest.dependencies ?? {}
  return Object.keys(deps).filter(name => !existsSync(join(repoRoot, 'node_modules', ...name.split('/'))))
}

// 单元发现:冒烟 + 含适用测试文件的包(字典序,保轮次间顺序稳定)+ 仓库根 tests
// + compat 专项(自定义发现范围外的登记测试)。changedLines 传入 push 改动清单:
// 全部落在 packages/<X>/ 时只保留 X 及其反向依赖闭包(冒烟与仓库根测试保留),否则全量。
// 测试文件按平台过滤(win32/linux 后缀约定)。
export function discoverUnits(repoRoot, changedLines) {
  const changedRaw = changedLines === undefined ? undefined : parseChangedPackages(changedLines)
  const changed = changedRaw === undefined || changedRaw === null ? changedRaw : expandConsumers(repoRoot, changedRaw)
  const units = [{name: 'smoke-load', command: [process.execPath, 'scripts/smoke-load.mjs'], cwd: repoRoot}]
  for (const dir of readdirSync(join(repoRoot, PACKAGES_DIR)).sort()) {
    const testPath = join(repoRoot, PACKAGES_DIR, dir, 'test')
    if (!existsSync(testPath) || !statSync(testPath).isDirectory()) continue
    if (changed && !changed.has(dir)) continue
    const pkgDir = join(repoRoot, PACKAGES_DIR, dir)
    const files = applicableTestFiles(pkgDir, 'test')
    if (files.length === 0) continue
    const testScript = readTestScript(pkgDir)
    // 自定义 runner 协议:非 `node --test` 形态整体执行,包保留其准备逻辑
    if (!isNodeTestScript(testScript) && testScript !== undefined) {
      units.push({name: dir, command: testScript.split(' '), cwd: pkgDir})
      continue
    }
    const flags = nodeFlagsFromTestScript(testScript)
    units.push({name: dir, command: [process.execPath, ...flags, '--test', ...files], cwd: pkgDir})
  }
  const repoFiles = applicableTestFiles(repoRoot, 'tests')
  if (repoFiles.length > 0) units.push({name: 'repo-tests', command: [process.execPath, '--test', ...repoFiles], cwd: repoRoot})
  // 公共 LLM 模拟器模块级测试:与 repo-tests 同保留策略(协议/流式/场景断言是 gateway 系包的夹具契约)
  const simDir = join(repoRoot, 'scripts', 'echo-upstream')
  const simFiles = existsSync(simDir) ? applicableTestFiles(simDir, 'test') : []
  if (simFiles.length > 0) units.push({name: 'echo-upstream', command: [process.execPath, '--test', ...simFiles], cwd: simDir})
  // compat 专项登记:发现范围不含 scripts/compat,显式列出防漏测
  const compatDir = join(repoRoot, 'scripts', 'compat')
  const compatFiles = existsSync(compatDir) ? applicableTestFiles(compatDir, '.') : []
  if (compatFiles.length > 0) units.push({name: 'compat-tests', command: [process.execPath, '--test', ...compatFiles], cwd: compatDir})
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

export async function runUnits({rounds, logDir, summaryPath, log = console.log, units, retainLogs = false}) {
  const failed = new Map()
  for (let round = 1; round <= rounds; round++) {
    log(`::group::第 ${round}/${rounds} 轮`)
    // 本轮失败单元个数(事件计数,同一单元连败多轮每轮各计 1)
    let roundFails = 0
    // skip 可见性:OK 单元的 skip 数也要呈现(CI 恒 skip 的防绿断言若不可见即假绿,F 现症)
    let roundSkips = 0
    const skipDetail = []
    for (const unit of units) {
      const logPath = roundLogPath(logDir, unit.name, round)
      if (await runUnit(unit, logPath)) {
        const skipCount = unitSkipCount(readFileSync(logPath, 'utf8'))
        roundSkips += skipCount
        if (skipCount > 0) skipDetail.push(`${unit.name}(${skipCount})`)
        log(`OK   ${unit.name}${skipCount > 0 ? ` (skipped ${skipCount})` : ''}`)
        if (!retainLogs) rmSync(logPath, {force: true})
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
    // 0 skip 也输出:汇总行缺席本身即不可观测(恒 skip 的假绿必须显式曝光)
    log(`本轮 skip 用例数: ${roundSkips}${skipDetail.length > 0 ? ` (${skipDetail.join(', ')})` : ''}`)
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
  const missing = missingBridgeDeps(REPO_ROOT)
  if (missing.length > 0) {
    console.log(`::error::仓库根解析桥缺供给: ${missing.join(', ')} — 先在仓库根执行 npm install(按 package.json dependencies 供给),再跑单元;缺项时逐包单测恒红且与代码失败不可区分`)
    return {failures: 1, failedUnits: []}
  }
  const changedLines = changedSince === undefined ? undefined : changedFilesList(changedSince)
  const units = discoverUnits(REPO_ROOT, changedLines)
  const scoped = changedLines === undefined || changedLines === null
    ? '全量'
    : `范围收敛: ${units.length} 单元`
  console.log(`测试范围: ${scoped}(单元 ${units.map(u => u.name).join(', ')})`)
  const evidenceRoot = process.env.DSH_AGGREGATE_TEST_LOG_DIR
  const preserve = Boolean(evidenceRoot)
  let logDir
  if (preserve) {
    logDir = await createEvidenceLogDir(evidenceRoot)
    console.log(`失败日志留存目录: ${logDir}`)
  } else {
    logDir = mkdtempSync(join(tmpdir(), 'aggregate-tests-'))
  }
  try {
    return await runUnits({rounds, logDir, summaryPath: process.env.GITHUB_STEP_SUMMARY ?? null, units, retainLogs: preserve})
  } finally {
    if (!preserve) rmSync(logDir, {recursive: true, force: true})
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
