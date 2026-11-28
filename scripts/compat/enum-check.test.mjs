// enum-check 自身:缺项检测、排序去重、幂等、锚点漂移拒绝、--check 退出码、
// 补齐后 L1 失败保留改动。fixture 为临时伪包,版本经 --versions 注入,不触网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyInsertions, readEnumerations, resolveHostVersions } from './enum-check.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = fileURLToPath(new URL('./enum-check.mjs', import.meta.url))
const PACKAGE = 'dsh-shared-terminal'
const FILES = ['package.json', 'src/index.js', 'test/plugin.test.mjs', 'README.md', '兼容性测试.md']

const FIXTURE = {
  'package.json': `{
  "name": "@mzzsfy/dsh-shared-terminal",
  "version": "0.0.0",
  "dsh": {
    "compatibility": {
      "dshReleases": {
        "0.2.0-rc.1": "unknown",
        "0.2.0-rc.2": "compatible",
        "0.2.1-alpha.2": "compatible",
        "0.2.2-rc.5": "compatible",
        "0.2.3-alpha.2": "compatible",
        "0.2.3-alpha.3": "compatible"
      }
    }
  }
}
`,
  'src/index.js': `// 夹具:功能面精确枚举
export const SUPPORTED_VERSIONS = Object.freeze(['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2', '0.2.2-rc.5', '0.2.3-alpha.2', '0.2.3-alpha.3'])
`,
  'test/plugin.test.mjs': `import test from 'node:test'

const legacy = { owners: new Map() }
const attachEra = { owners: new Map() }

test('夹具:逐版本夹具行可枚举', () => {
  for (const [version, controller] of [
    ['0.2.0-rc.1', legacy],
    ['0.2.0-rc.2', legacy],
    ['0.2.1-alpha.2', legacy],
    ['0.2.2-rc.5', attachEra],
    ['0.2.3-alpha.2', attachEra],
    ['0.2.3-alpha.3', attachEra],
  ]) {
    void version
    void controller
  }
})
`,
  'README.md': `# 夹具

功能面仅接受实测版本 DSH **0.2.0-rc.1、0.2.0-rc.2、0.2.1-alpha.2、0.2.2-rc.5 与 0.2.3-alpha.2、0.2.3-alpha.3**（精确允许表；其余干净禁用）。

版本白名单已纳入 \`0.2.1-alpha.2\`、\`0.2.2-rc.5\` 与 \`0.2.3-alpha.2\`、\`0.2.3-alpha.3\`(dshReleases \`compatible\`)。
`,
  '兼容性测试.md': `# 夹具

本包**精确允许表**:仅 \`0.2.0-rc.1\`、\`0.2.0-rc.2\`、\`0.2.1-alpha.2\`、\`0.2.2-rc.5\`、\`0.2.3-alpha.2\`、\`0.2.3-alpha.3\` 支持功能面;其余干净禁用。

| D01 | 核对宿主版本 ∈ 精确允许表(上限 \`0.2.3-alpha.3\`;alpha 通道同代) | x | B |
`,
}

function makeFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'enum-check-'))
  const pkgDir = join(root, 'packages', PACKAGE)
  for (const [relative, content] of Object.entries({ ...FIXTURE, ...overrides })) {
    const file = join(pkgDir, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'smoke-load.mjs'), 'console.log("smoke ok")\n', 'utf8')
  return root
}

function readFixture(root, relative) {
  return readFileSync(join(root, 'packages', PACKAGE, relative), 'utf8')
}

function snapshot(root) {
  return Object.fromEntries(FILES.map((file) => [file, readFixture(root, file)]))
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120 * 1000, windowsHide: true })
}

test('真实包:七处枚举按锚点解析成功且已覆盖当前最大版本', () => {
  const entries = readEnumerations(REPO_ROOT, PACKAGE)
  assert.equal(entries.length, 7)
  const sets = entries.filter((entry) => entry.location.kind !== 'upper-bound')
  assert.equal(sets.length, 6)
  for (const entry of sets) {
    assert.ok(entry.versions.length > 10, `${entry.id} 版本数异常: ${entry.versions.length}`)
    assert.ok(entry.versions.includes('0.2.3-alpha.3'), `${entry.id} 缺 0.2.3-alpha.3`)
  }
})

test('缺项检测:补齐缺失版本、保持升序、输入重复只插一次', () => {
  const root = makeFixture()
  try {
    const result = applyInsertions(root, PACKAGE, ['0.2.3-alpha.99', '0.2.1-rc.2', '0.2.3-alpha.99'])
    assert.deepEqual(result.missing, ['0.2.1-rc.2', '0.2.3-alpha.99'])
    assert.deepEqual(result.inserted, ['0.2.1-rc.2', '0.2.3-alpha.99'])
    assert.deepEqual(result.changedFiles, FILES.map((file) => `packages/${PACKAGE}/${file}`))

    const manifest = JSON.parse(readFixture(root, 'package.json'))
    assert.deepEqual(Object.keys(manifest.dsh.compatibility.dshReleases), [
      '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2', '0.2.1-rc.2',
      '0.2.2-rc.5', '0.2.3-alpha.2', '0.2.3-alpha.3', '0.2.3-alpha.99',
    ])

    const supported = readFixture(root, 'src/index.js').match(/Object\.freeze\(\[([^\]]+)\]\)/)[1]
      .match(/'([^']+)'/g).map((item) => item.slice(1, -1))
    assert.deepEqual(supported, [
      '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2', '0.2.1-rc.2',
      '0.2.2-rc.5', '0.2.3-alpha.2', '0.2.3-alpha.3', '0.2.3-alpha.99',
    ])

    const fixtureRows = readFixture(root, 'test/plugin.test.mjs')
    assert.match(fixtureRows, /\['0\.2\.1-rc\.2', attachEra\],/)
    assert.match(fixtureRows, /\['0\.2\.3-alpha\.99', attachEra\],/)
    assert.equal(fixtureRows.split("['0.2.3-alpha.99', attachEra]").length - 1, 1)

    const readme = readFixture(root, 'README.md')
    assert.match(readme, /0\.2\.1-alpha\.2、0\.2\.1-rc\.2、0\.2\.2-rc\.5/)
    assert.match(readme, /0\.2\.3-alpha\.3、0\.2\.3-alpha\.99\*\*/)
    assert.match(readme, /`0\.2\.3-alpha\.3`、`0\.2\.3-alpha\.99`/)

    const compat = readFixture(root, '兼容性测试.md')
    assert.match(compat, /`0\.2\.3-alpha\.3`、`0\.2\.3-alpha\.99` 支持功能面/)
    assert.match(compat, /上限 `0\.2\.3-alpha\.99`/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('排序与去重:中间版本落在两个相邻版本之间,不产生重复条目', () => {
  const root = makeFixture()
  try {
    const result = applyInsertions(root, PACKAGE, ['0.2.2-rc.1', '0.2.2-rc.5', '0.2.2-rc.9'])
    assert.deepEqual(result.inserted, ['0.2.2-rc.1', '0.2.2-rc.9'])
    const supported = readFixture(root, 'src/index.js').match(/Object\.freeze\(\[([^\]]+)\]\)/)[1]
      .match(/'([^']+)'/g).map((item) => item.slice(1, -1))
    assert.deepEqual(supported, [
      '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2',
      '0.2.2-rc.1', '0.2.2-rc.5', '0.2.2-rc.9',
      '0.2.3-alpha.2', '0.2.3-alpha.3',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('幂等:同版本集合二次执行无改动、文件字节不变', () => {
  const root = makeFixture()
  try {
    applyInsertions(root, PACKAGE, ['0.2.3-alpha.99'])
    const before = snapshot(root)
    const second = applyInsertions(root, PACKAGE, ['0.2.3-alpha.99'])
    assert.deepEqual(second, { missing: [], changedFiles: [], inserted: [] })
    assert.deepEqual(snapshot(root), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('锚点缺失:报错说明位置已变,且不落盘', () => {
  const root = makeFixture({ 'README.md': '# 夹具\n\n白名单改版了,锚点不复存在。\n' })
  try {
    const before = snapshot(root)
    assert.throws(() => applyInsertions(root, PACKAGE, ['0.2.3-alpha.99']), /位置已变|锚点/)
    assert.deepEqual(snapshot(root), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dshReleases 登记 unknown:升级为 compatible,不重复插键', () => {
  const root = makeFixture({
    'package.json': FIXTURE['package.json'].replace(
      '        "0.2.3-alpha.3": "compatible"\n',
      '        "0.2.3-alpha.3": "compatible",\n        "0.2.3-alpha.4": "unknown"\n',
    ),
  })
  try {
    const result = applyInsertions(root, PACKAGE, ['0.2.3-alpha.4'])
    assert.deepEqual(result.inserted, ['0.2.3-alpha.4'])
    const manifest = JSON.parse(readFixture(root, 'package.json'))
    assert.equal(manifest.dsh.compatibility.dshReleases['0.2.3-alpha.4'], 'compatible')
    assert.equal(Object.keys(manifest.dsh.compatibility.dshReleases).filter((key) => key === '0.2.3-alpha.4').length, 1)
    assert.match(readFixture(root, 'src/index.js'), /'0\.2\.3-alpha\.4'/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dshReleases 登记 incompatible:拒绝自动改为 compatible 且不落盘', () => {
  const root = makeFixture({
    'package.json': FIXTURE['package.json'].replace(
      '        "0.2.3-alpha.3": "compatible"\n',
      '        "0.2.3-alpha.3": "compatible",\n        "0.2.3-alpha.4": "incompatible"\n',
    ),
  })
  try {
    const before = snapshot(root)
    assert.throws(() => applyInsertions(root, PACKAGE, ['0.2.3-alpha.4']), /incompatible/)
    assert.deepEqual(snapshot(root), before)
    const checked = runCli([PACKAGE, '--repo', root, '--versions', '0.2.3-alpha.4', '--check'])
    assert.equal(checked.status, 1)
    assert.match(checked.stderr, /incompatible/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dist-tags:三渠道去重,网络失败与缺渠道明确报错', async () => {
  const tags = { alpha: '0.2.3-alpha.3', next: '0.2.2-rc.5', latest: '0.2.2-rc.5' }
  assert.deepEqual(
    await resolveHostVersions({ fetchImpl: async () => new Response(JSON.stringify(tags), { status: 200 }) }),
    ['0.2.2-rc.5', '0.2.3-alpha.3'],
  )
  await assert.rejects(
    resolveHostVersions({ fetchImpl: async () => new Response('{}', { status: 503 }) }),
    /拒绝猜测关注版本/,
  )
  await assert.rejects(
    resolveHostVersions({ fetchImpl: async () => new Response(JSON.stringify({ latest: '0.2.2-rc.5' }), { status: 200 }) }),
    /缺渠道 alpha/,
  )
})

test('--check:missing 退出码 2 且不改文件,已覆盖退出码 0', () => {
  const root = makeFixture()
  try {
    const before = snapshot(root)
    const missing = runCli([PACKAGE, '--repo', root, '--versions', '0.2.3-alpha.99', '--check'])
    assert.equal(missing.status, 2, missing.stderr)
    assert.deepEqual(JSON.parse(missing.stdout), {
      missing: ['0.2.3-alpha.99'],
      changedFiles: [],
      inserted: [],
    })
    assert.deepEqual(snapshot(root), before)

    const covered = runCli([PACKAGE, '--repo', root, '--versions', '0.2.3-alpha.3', '--check'])
    assert.equal(covered.status, 0, covered.stderr)
    assert.deepEqual(JSON.parse(covered.stdout), { missing: [], changedFiles: [], inserted: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('补齐后 L1 通过:exit 0 且改动落盘', () => {
  const root = makeFixture()
  try {
    const result = runCli([PACKAGE, '--repo', root, '--versions', '0.2.3-alpha.99'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout).inserted, ['0.2.3-alpha.99'])
    assert.match(readFixture(root, 'test/plugin.test.mjs'), /\['0\.2\.3-alpha\.99', attachEra\],/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('补齐后 L1 失败:exit 3 且保留已改文件', () => {
  const root = makeFixture({
    'test/fail.test.mjs': "import test from 'node:test'\n\ntest('夹具故意失败', () => { throw new Error('boom') })\n",
  })
  try {
    const result = runCli([PACKAGE, '--repo', root, '--versions', '0.2.3-alpha.99'])
    assert.equal(result.status, 3, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }))
    assert.match(result.stderr, /L1 未通过/)
    assert.deepEqual(JSON.parse(result.stdout).inserted, ['0.2.3-alpha.99'])
    assert.match(readFixture(root, 'src/index.js'), /'0\.2\.3-alpha\.99'/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('无枚举登记与非法 --versions:报错退出 1', () => {
  const root = makeFixture()
  try {
    assert.equal(runCli(['dsh-other', '--repo', root, '--versions', '0.2.3-alpha.3', '--check']).status, 1)
    assert.equal(runCli([PACKAGE, '--repo', root, '--versions', 'not-a-version', '--check']).status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
