import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {namesFromLogs, unitFailCount, discoverUnits, runUnits, parseRounds} from '../scripts/aggregate-tests.mjs'

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

test('discoverUnits_真实仓库_冒烟与仓库根测试在列且顺序稳定', () => {
  const units = discoverUnits(repo)
  assert.equal(units[0].name, 'smoke-load')
  assert.equal(units.at(-1).name, 'repo-tests')
  const names = units.map(u => u.name)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.includes('dsh-turn-notify'))
  for (const unit of units) assert.ok(unit.command.length > 0)
})

test('parseRounds_默认与显式轮次_非法值拒绝', () => {
  assert.equal(parseRounds([]), 10)
  assert.equal(parseRounds(['--rounds', '3']), 3)
  assert.throws(() => parseRounds(['--unknown']))
  assert.throws(() => parseRounds(['--rounds']))
  assert.throws(() => parseRounds(['--rounds', '0']))
  assert.throws(() => parseRounds(['--rounds', 'abc']))
})
