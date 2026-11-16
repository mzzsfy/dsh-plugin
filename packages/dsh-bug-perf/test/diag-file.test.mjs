import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIAG_DIR_ENV, DIAG_FILE_ENV, createDiagStore, resolveDiagFile } from '../src/diag-file.mjs'

const makeTempDir = () => mkdtempSync(join(tmpdir(), 'dsh-bug-perf-diag-'))
const readLines = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))

// Given 宿主 home 不同, When 解析诊断路径, Then 各实例落到各自 home 的 dsh-bug-perf 目录
test('Given different DSH_HOME values, When resolving diag files, Then each instance gets its own path', () => {
  const first = join(tmpdir(), 'dsh-home-a')
  const second = join(tmpdir(), 'dsh-home-b')
  assert.equal(resolveDiagFile({ env: { DSH_HOME: first }, port: 4001 }), join(first, 'dsh-bug-perf', 'diag-port-4001.jsonl'))
  assert.equal(resolveDiagFile({ env: { DSH_HOME: second }, port: 4002 }), join(second, 'dsh-bug-perf', 'diag-port-4002.jsonl'))
  assert.notEqual(resolveDiagFile({ env: { DSH_HOME: first }, port: 4001 }), resolveDiagFile({ env: { DSH_HOME: second }, port: 4002 }))
})

// Given 两个实例共用默认 home, When 监听端口不同/无端口, Then 文件名按实例标识区分而不共写
test('Given one DSH_HOME, When two instances resolve diag files, Then port or pid isolates them', () => {
  const home = join(tmpdir(), 'dsh-home-shared')
  assert.equal(resolveDiagFile({ env: { DSH_HOME: home }, port: 5001 }), join(home, 'dsh-bug-perf', 'diag-port-5001.jsonl'))
  assert.equal(resolveDiagFile({ env: { DSH_HOME: home }, port: 5002 }), join(home, 'dsh-bug-perf', 'diag-port-5002.jsonl'))
  assert.equal(resolveDiagFile({ env: { DSH_HOME: home }, pid: 1234 }), join(home, 'dsh-bug-perf', 'diag-pid-1234.jsonl'))
  assert.notEqual(
    resolveDiagFile({ env: { DSH_HOME: home }, port: 5001 }),
    resolveDiagFile({ env: { DSH_HOME: home }, port: 5002 }),
  )
})

// Given 显式文件或目录 env, When 解析, Then 优先于 DSH_HOME(测试可注入隔离目录)
test('Given explicit diag env entries, When resolving, Then they override DSH_HOME', () => {
  const home = join(tmpdir(), 'dsh-home-c')
  const explicitFile = join(tmpdir(), 'explicit', 'diag.jsonl')
  const explicitDir = join(tmpdir(), 'explicit-dir')
  assert.equal(resolveDiagFile({ env: { DSH_HOME: home, [DIAG_FILE_ENV]: explicitFile }, port: 4003 }), explicitFile)
  assert.equal(resolveDiagFile({ env: { DSH_HOME: home, [DIAG_DIR_ENV]: explicitDir }, port: 4003 }), join(explicitDir, 'diag.jsonl'))
})

// Given 没有 DSH_HOME 与注入, When 解析, Then 按宿主默认 home(~/.dsh)派生而非全局临时文件
test('Given no env override, When resolving, Then the default host home and pid are used', () => {
  assert.equal(resolveDiagFile({ env: {}, pid: 4321 }), join(homedir(), '.dsh', 'dsh-bug-perf', 'diag-pid-4321.jsonl'))
})

// Given 两个实例各自目录, When 分别写入, Then 文件互不污染
test('Given two diag stores with different files, When both record, Then each file only holds its own sample', () => {
  const firstDir = makeTempDir()
  const secondDir = makeTempDir()
  try {
    const first = createDiagStore({ file: join(firstDir, 'diag.jsonl') })
    const second = createDiagStore({ file: join(secondDir, 'diag.jsonl') })
    assert.equal(first.record({ marker: 'first' }), true)
    assert.equal(second.record({ marker: 'second' }), true)
    assert.deepEqual(readLines(join(firstDir, 'diag.jsonl')), [{ marker: 'first' }])
    assert.deepEqual(readLines(join(secondDir, 'diag.jsonl')), [{ marker: 'second' }])
  } finally {
    rmSync(firstDir, { recursive: true, force: true })
    rmSync(secondDir, { recursive: true, force: true })
  }
})

// Given 文件超过上限, When 写入新样本, Then 旧文件轮转为 .1 且当前文件只含新样本
test('Given an oversized diag file, When recording, Then it rotates to .1 and keeps the new sample', () => {
  const dir = makeTempDir()
  try {
    const file = join(dir, 'diag.jsonl')
    const seed = `${JSON.stringify({ marker: 'seed' })}\n`
    writeFileSync(file, seed, 'utf8')
    const store = createDiagStore({ file, maxBytes: 4 })
    assert.equal(store.record({ marker: 'new' }), true)
    assert.equal(readFileSync(`${file}.1`, 'utf8'), seed)
    assert.deepEqual(readLines(file), [{ marker: 'new' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Given 轮转失败, When 写入当前样本, Then 追加仍执行, 当前样本不丢
test('Given rotation fails, When recording, Then the current sample is still appended', () => {
  const dir = makeTempDir()
  try {
    const file = join(dir, 'diag.jsonl')
    const seed = { marker: 'seed' }
    writeFileSync(file, `${JSON.stringify(seed)}\n`, 'utf8')
    const failingFs = {
      ...fs,
      renameSync() { throw Object.assign(new Error('file busy'), { code: 'EBUSY' }) },
    }
    const store = createDiagStore({ file, maxBytes: 4, fs: failingFs })
    assert.equal(store.record({ marker: 'survives' }), true)
    assert.equal(fs.existsSync(`${file}.1`), false)
    assert.deepEqual(readLines(file), [seed, { marker: 'survives' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
