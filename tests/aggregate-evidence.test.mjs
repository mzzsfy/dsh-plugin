import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverUnits, runUnits } from '../scripts/aggregate-tests.mjs'
import { createEvidenceLogDir } from '../scripts/aggregate-evidence.mjs'

const repo = join(import.meta.dirname, '..')

test('仓库发布门包含全部包、冒烟、公共模拟器测试', () => {
  // Given仓库测试清单；When发现测试单元；Then发布目标包均在范围内。
  const names = discoverUnits(repo).map(unit => unit.name)
  assert.ok(names.includes('smoke-load'))
  assert.ok(names.includes('dsh-shell-select'))
  assert.ok(names.includes('dsh-llm-pi-gateway'))
  assert.ok(names.includes('echo-upstream'))
})

test('显式证据目录保留失败单元日志且不影响默认清理模式', async t => {
  // Given调用者拥有的证据目录与失败单元；When聚合执行；Then原始stderr写入日志文件。
  const root = mkdtempSync(join(tmpdir(), 'aggregate-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lines = []
  const result = await runUnits({
    rounds: 1,
    logDir: root,
    summaryPath: null,
    retainLogs: true,
    log: line => lines.push(line),
    units: [{ name: 'fixture-unit', command: [process.execPath, '-e', "console.error('fixture-unit failure');process.exit(1)"], cwd: repo }],
  })
  assert.equal(result.failures, 1)
  assert.deepEqual(readdirSync(root), ['fixture-unit-1.log'])
  assert.match(readFileSync(join(root, 'fixture-unit-1.log'), 'utf8'), /fixture-unit failure/)
})

test('多次证据轮次使用独立子目录不覆盖既有用户文件', async t => {
  // Given测试创建的两轮独立证据目录；When写入相同文件名；Then旧轮内容仍原样保留。
  const root = mkdtempSync(join(tmpdir(), 'aggregate-runs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = await createEvidenceLogDir(root)
  const second = await createEvidenceLogDir(root)
  const oldPath = join(first, 'fixture-unit-1.log')
  writeFileSync(oldPath, 'preserve me')
  assert.notEqual(first, second)
  assert.equal(readFileSync(oldPath, 'utf8'), 'preserve me')
})

test('证据日志根目录符号链接拒绝且目标目录不被写入', async t => {
  // Given指向目标目录的根符号链接；When创建日志目录；Then拒绝且不写目标。
  const parent = mkdtempSync(join(tmpdir(), 'aggregate-symlink-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const target = join(parent, 'target')
  const link = join(parent, 'link')
  mkdirSync(target)
  symlinkSync(target, link, 'junction')
  await assert.rejects(createEvidenceLogDir(link), /不接受符号链接/)
  assert.deepEqual(readdirSync(target), [])
})
