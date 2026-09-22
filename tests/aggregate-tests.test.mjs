import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {namesFromLogs, unitFailCount, discoverUnits, runUnits, parseArgs, parseChangedPackages, filterTestFiles} from '../scripts/aggregate-tests.mjs'

/**
 * aggregate-tests.mjs CI 全量测试聚合
 *
 * BDD 场景:
 *   1. 失败用例名提取 -> 删汇总行/去缩进/去耗时/按执行序去重
 *   2. 失败计数提取 -> 取 spec reporter 统计行首值;无统计行 -> 未知(null)
 *   3. 全部单元通过 -> 失败数 0,日志即时清理,输出 OK 行
 *   4. 单元失败 -> 失败数按轮累计,失败日志保留,汇总含轮次与用例锚点,summary 落失败明细
 *   5. 混合单元 -> 通过单元日志删,失败单元日志留
 *   6. 单元发现 -> 冒烟 + 仓库根测试 + 含 test 目录的包,顺序确定
 *   7. spawn 失败 -> 仍按失败计数,日志留错误锚点,与"跑了但失败"可区分
 */

const repo = join(import.meta.dirname, '..')

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  return dir
}

test('namesFromLogs_混合日志_只留去重去耗时的用例名', () => {
  const logs = [
    '✖ failing tests:',
    '  ✖ 包A 用例一 (12.3ms)',
    '    ✖ 用例二 (0.5ms)',
    '  ✖ 包A 用例一 (9ms)',
    '✔ 通过行不提取',
  ]
  assert.deepEqual(namesFromLogs(logs), ['包A 用例一', '用例二'])
})

test('unitFailCount_统计行_取失败数', () => {
  assert.equal(unitFailCount('ℹ tests 10\nℹ fail 3\n'), '3')
})

test('unitFailCount_无统计行_未知', () => {
  assert.equal(unitFailCount('崩溃堆栈,无统计'), null)
})

test('runUnits_全部通过_零失败且日志清理', async t => {
  const logDir = tempDir(t, 'agg-pass-')
  const lines = []
  const result = await runUnits({
    rounds: 2,
    logDir,
    summaryPath: null,
    log: line => lines.push(line),
    units: [
      {name: 'good-a', command: [process.execPath, '-e', 'process.exit(0)'], cwd: repo},
      {name: 'good-b', command: [process.execPath, '-e', 'process.exit(0)'], cwd: repo},
    ],
  })
  assert.equal(result.failures, 0)
  assert.equal(readdirSync(logDir).length, 0)
  assert.ok(lines.includes('OK   good-a'))
  assert.ok(lines.some(line => line.startsWith('汇总: 2 轮, 失败单元累计 0')))
})

test('runUnits_单元失败_轮次累计且明细可查', async t => {
  const logDir = tempDir(t, 'agg-fail-')
  const summaryPath = join(tempDir(t, 'agg-sum-'), 'summary.md')
  const lines = []
  const failer = [
    process.execPath, '-e',
    'console.error("✖ failing tests:");console.log("  ✖ caseA%2F (1ms)");console.log("ℹ fail 1");process.exit(1)',
  ]
  const result = await runUnits({
    rounds: 2,
    logDir,
    summaryPath,
    log: line => lines.push(line),
    units: [{name: 'failer', command: failer, cwd: repo}],
  })
  assert.equal(result.failures, 2)
  assert.deepEqual(result.failedUnits.map(u => u.name), ['failer'])
  assert.deepEqual(result.failedUnits[0].rounds, ['1', '2'])
  assert.ok(readdirSync(logDir).includes('failer-1.log'))
  assert.ok(lines.some(line => line.includes('FAIL failer (失败用例 1)')))
  // 同一单元连败多轮,每轮计数各自为 1,不因去重漂移为 0
  assert.deepEqual(lines.filter(line => line.startsWith('本轮失败单元数: ')), ['本轮失败单元数: 1', '本轮失败单元数: 1'])
  assert.ok(lines.includes('失败单元清单(次数=失败轮数):'))
  const annotation = lines.find(line => line.startsWith('::error::单元失败 2/2 轮: failer'))
  assert.ok(annotation)
  // 用例名中的 % 须转义为 %25,防 runner 误解码
  assert.ok(annotation.includes('caseA%252F'))
  const summary = readFileSync(summaryPath, 'utf8')
  assert.ok(summary.includes('### failer(失败 2/2 轮:'))
  assert.ok(summary.includes('失败明细(首轮错误与堆栈)'))
})

test('runUnits_混合单元_过删败留', async t => {
  const logDir = tempDir(t, 'agg-mix-')
  const lines = []
  const result = await runUnits({
    rounds: 1,
    logDir,
    summaryPath: null,
    log: line => lines.push(line),
    units: [
      {name: 'good', command: [process.execPath, '-e', 'process.exit(0)'], cwd: repo},
      {name: 'bad', command: [process.execPath, '-e', 'process.exit(1)'], cwd: repo},
    ],
  })
  assert.equal(result.failures, 1)
  const logs = readdirSync(logDir)
  assert.deepEqual(logs, ['bad-1.log'])
})

test('runUnits_spawn失败_失败计数且日志留错误锚点', async t => {
  const logDir = tempDir(t, 'agg-spawn-')
  const result = await runUnits({
    rounds: 1,
    logDir,
    summaryPath: null,
    units: [{name: 'missing', command: ['missing-executable-xyz'], cwd: repo}],
  })
  assert.equal(result.failures, 1)
  assert.deepEqual(result.failedUnits[0].rounds, ['1'])
  const logText = readFileSync(join(logDir, 'missing-1.log'), 'utf8')
  assert.ok(logText.includes('[unit-error] spawn:'), '日志须留 spawn 错误锚点')
  assert.ok(logText.includes('ENOENT'), '锚点须携带失败原因')
})

test('runUnits_双流输出_同一日志完整留痕', async t => {
  const logDir = tempDir(t, 'agg-dual-')
  await runUnits({
    rounds: 1,
    logDir,
    summaryPath: null,
    units: [{
      name: 'dual',
      command: [process.execPath, '-e', 'console.error("stderr-mark");console.log("stdout-mark");process.exit(1)'],
      cwd: repo,
    }],
  })
  const logText = readFileSync(join(logDir, 'dual-1.log'), 'utf8')
  assert.ok(logText.includes('stderr-mark'), 'stderr 须进日志')
  assert.ok(logText.includes('stdout-mark'), 'stdout 须进日志')
})

test('discoverUnits_真实仓库_冒烟与仓库根测试在列且顺序稳定', () => {
  const units = discoverUnits(repo)
  assert.equal(units[0].name, 'smoke-load')
  assert.equal(units.at(-1).name, 'repo-tests')
  const names = units.map(u => u.name)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.includes('dsh-turn-notify'))
  for (const unit of units) assert.ok(unit.command.length > 0)
})

test('discoverUnits_单包改动清单_只保留该包', () => {
  const units = discoverUnits(repo, ['packages/dsh-turn-notify/client.js', 'packages/dsh-turn-notify/package.json'])
  assert.deepEqual(units.map(u => u.name), ['smoke-load', 'dsh-turn-notify', 'repo-tests'])
  const turnNotify = units.find(u => u.name === 'dsh-turn-notify')
  assert.ok(turnNotify.command.some(arg => arg.includes('test')))
})

test('discoverUnits_非包改动清单_全量回退', () => {
  const full = discoverUnits(repo).map(u => u.name)
  const scoped = discoverUnits(repo, ['scripts/smoke-load.mjs']).map(u => u.name)
  assert.deepEqual(scoped, full)
})

test('parseArgs_默认与显式轮次_非法值拒绝', () => {
  assert.deepEqual(parseArgs([]), {rounds: 10})
  assert.deepEqual(parseArgs(['--rounds', '3']), {rounds: 3})
  assert.deepEqual(parseArgs(['--changed-since', 'abc123']), {rounds: 10, changedSince: 'abc123'})
  assert.deepEqual(parseArgs(['--rounds', '3', '--changed-since', 'abc123']), {rounds: 3, changedSince: 'abc123'})
  assert.throws(() => parseArgs(['--unknown']))
  assert.throws(() => parseArgs(['--rounds']))
  assert.throws(() => parseArgs(['--rounds', '0']))
  assert.throws(() => parseArgs(['--rounds', 'abc']))
})

test('filterTestFiles_linux_跑通用与linux专属', () => {
  const files = ['a.test.mjs', 'b.win.test.mjs', 'c.linux.test.mjs']
  assert.deepEqual(filterTestFiles(files, 'linux'), ['a.test.mjs', 'c.linux.test.mjs'])
})

test('filterTestFiles_win32_跑通用与win专属', () => {
  const files = ['a.test.mjs', 'b.win.test.mjs', 'c.linux.test.mjs']
  assert.deepEqual(filterTestFiles(files, 'win32'), ['a.test.mjs', 'b.win.test.mjs'])
})

test('filterTestFiles_其他平台_仅通用', () => {
  const files = ['a.test.mjs', 'b.win.test.mjs', 'c.linux.test.mjs']
  assert.deepEqual(filterTestFiles(files, 'darwin'), ['a.test.mjs'])
})

test('parseChangedPackages_单包改动_只报该包', () => {
  assert.deepEqual(parseChangedPackages(['packages/dsh-toast/src/index.js', 'packages/dsh-toast/README.md']), new Set(['dsh-toast']))
})

test('parseChangedPackages_多包改动_全部上报', () => {
  assert.deepEqual(parseChangedPackages(['packages/dsh-toast/src/index.js', 'packages/dsh-turn-notify/client.js']), new Set(['dsh-toast', 'dsh-turn-notify']))
})

test('parseChangedPackages_含非包路径_判全量', () => {
  assert.equal(parseChangedPackages(['packages/dsh-toast/src/index.js', 'scripts/smoke-load.mjs']), null)
  assert.equal(parseChangedPackages(['README.md']), null)
  assert.equal(parseChangedPackages(['.github/workflows/test.yml']), null)
})

test('parseChangedPackages_无改动_判全量', () => {
  assert.equal(parseChangedPackages([]), null)
})

test('parseChangedPackages_前缀相近目录_不串包', () => {
  assert.deepEqual(parseChangedPackages(['packages/dsh-maintain/src/index.js']), new Set(['dsh-maintain']))
  assert.deepEqual(parseChangedPackages(['packages/a/b/c.test.mjs']), new Set(['a']))
})
