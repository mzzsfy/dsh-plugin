import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

function fixture(t, { hasTestScript = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publish-scope-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'packages', 'probe'), { recursive: true })
  const manifest = { name: '@example/probe', version: '1.0.0' }
  if (hasTestScript) manifest.scripts = { test: 'node test.mjs' }
  writeFileSync(join(root, 'packages', 'probe', 'package.json'), JSON.stringify(manifest))
  copyFileSync(new URL('../scripts/publish.mjs', import.meta.url), join(root, 'scripts', 'publish.mjs'))
  // 发布门前置的公共依赖检查:夹具提供成功桩,失败路径由独立用例覆盖
  writeFileSync(join(root, 'scripts', 'check-common-tools.mjs'), 'process.exit(0)')
  // I04 发布洁净门要求目标包 git 干净:夹具初始化仓库并提交基线
  for (const args of [
    ['init'],
    ['config', 'user.name', 'fixture'],
    ['config', 'user.email', 'fixture@test'],
    ['add', '.'],
    ['commit', '-m', 'fixture'],
  ]) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (r.status !== 0) throw new Error('fixture git 初始化失败: ' + (r.stderr || r.stdout))
  }
  return root
}

/** PATH 前置的 npm 桩:--bump 场景只关心版本提交边界,pack 失败在提交后中止 */
function npmStub(root) {
  const bin = join(root, 'stub-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npm-stub.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const cmd = args[0]
if (cmd === 'view') { console.log('1.0.0'); process.exit(0) }
if (cmd === 'test') process.exit(0)
if (cmd === 'version') {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const [major, minor, patch] = manifest.version.split('.').map(Number)
  manifest.version = args[1] === 'major' ? \`\${major + 1}.0.0\`
    : args[1] === 'minor' ? \`\${major}.\${minor + 1}.0\`
    : \`\${major}.\${minor}.\${patch + 1}\`
  writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\\n')
  console.log('v' + manifest.version)
  process.exit(0)
}
if (cmd === 'pack') { console.error('stub: pack blocked for commit-scope assertion'); process.exit(1) }
process.exit(0)
`)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cmd'), '@echo off\r\nnode "%~dp0npm-stub.mjs" %*\r\n')
  } else {
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/npm-stub.mjs" "$@"\n', { mode: 0o755 })
  }
  return bin
}

for (const stream of ['stdout', 'stderr']) {
  test(`all聚合门失败时透传${stream}明细并阻止发布`, t => {
    // Given聚合门失败；When全量发布；Then报告流可见且不进入npm阶段。
    const root = fixture(t)
    writeFileSync(join(root, 'scripts', 'aggregate-tests.mjs'), `process.${stream}.write('fixture-failure-detail\\n'); process.exit(1)`)
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'all'], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result[stream], /fixture-failure-detail/)
    assert.match(result.stderr, /聚合测试未通过/)
    assert.doesNotMatch(result.stdout + result.stderr, /npm view|npmPublish/)
  })
}

/** 夹具追加文件后补提交:发布洁净门要求目标包提交态(I04 契约);无变更时静默 */
function commitAll(root) {
  spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' })
  const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@test', 'commit', '-qm', 'fixture-update'], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0 && !/nothing to commit/.test(r.stdout + r.stderr)) {
    throw new Error('fixture git 提交失败: ' + (r.stderr || r.stdout))
  }
}

test('单包目标测试失败阻断npm且不调用全仓门', t => {
  // Given目标包测试失败且聚合门是失败哨兵；When单包发布；Then只运行目标测试、明细可见并中止。
  const root = fixture(t)
  writeFileSync(join(root, 'packages', 'probe', 'test.mjs'), "console.log('target-test-ran');process.exit(1)")
  writeFileSync(join(root, 'packages', 'probe', 'package.json'), JSON.stringify({ name: '@example/probe', version: '1.0.0', scripts: { test: 'node test.mjs' } }))
  writeFileSync(join(root, 'scripts', 'aggregate-tests.mjs'), "throw new Error('single-package must not run aggregate')")
  commitAll(root)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'probe'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /npm(?:\.cmd)? test/)
  assert.match(result.stdout + result.stderr, /target-test-ran/, '测试失败明细必须对用户可见,不得被管道吞掉')
  assert.doesNotMatch(result.stdout + result.stderr, /aggregate-tests|npmPublish/)
})

test('单包未定义test script时拒绝无测试发布', t => {
  // Given目标包没有test script；When真实单包发布；Then必须在npm publish前拒绝。
  const root = fixture(t, { hasTestScript: false })
  commitAll(root)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'probe'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未定义有效 test script.*拒绝无目标测试发版/)
  assert.doesNotMatch(result.stdout + result.stderr, /npmPublish/)
})

for (const testScript of ['', '   ']) {
  test(`单包test script为空白时拒绝无测试发布(${JSON.stringify(testScript)})`, t => {
    // Given目标包test script为空或纯空白；When真实单包发布；Then不得无测试发布。
    const root = fixture(t)
    writeFileSync(join(root, 'packages', 'probe', 'package.json'), JSON.stringify({ name: '@example/probe', version: '1.0.0', scripts: { test: testScript } }))
    commitAll(root)
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'probe'], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /未定义有效 test script.*拒绝无目标测试发版/)
    assert.doesNotMatch(result.stdout + result.stderr, /npmPublish/)
  })
}


test('单包未定义test script时dry-run提示正式发布会拒绝', t => {
  // Given单包没有test script；When预演；Then明确说明正式单包发布会拒绝。
  const root = fixture(t, { hasTestScript: false })
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'probe', '--dry-run'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /缺少有效 test script:单包正式发布会拒绝/)
})

test('单包dry-run不调用全仓门且展示目标测试', t => {
  // Given单包目标；When dry-run；Then只展示目标包测试计划。
  const root = fixture(t)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'probe', '--dry-run'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /npm test\(cwd:/)
  assert.doesNotMatch(result.stdout, /aggregate-tests\.mjs/)
})

test('all dry-run展示全仓聚合门及逐包测试计划', t => {
  // Given all；When dry-run；Then输出聚合门与逐包测试计划。
  const root = fixture(t)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'all', '--dry-run'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /dry-run:全量发布将先运行/)
  assert.match(result.stdout, /aggregate-tests\.mjs/)
  assert.match(result.stdout, /npm test\(cwd:/)
})

test('--bump 版本提交限定包目录_不吞预暂存无关改动', t => {
  // Given 工作区已暂存无关文件、线上版本与本地相同;When --bump 发布走到版本提交;
  // Then commit 只含 packages/probe,无关暂存保持原状(pack 桩失败用于停在提交之后)
  const root = fixture(t)
  const bin = npmStub(root)
  writeFileSync(join(root, 'unrelated.txt'), 'must stay staged\n')
  execFileSync('git', ['add', 'unrelated.txt'], { cwd: root, encoding: 'utf8' })
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'probe', '--bump', 'patch', '--skip-test'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /npm pack 失败/)
  const log = execFileSync('git', ['log', '-1', '--name-only', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  assert.equal(log[0], 'chore(probe): 发版版本号 1.0.1')
  assert.ok(log.includes('packages/probe/package.json'), '版本提交应包含目标包 manifest')
  assert.ok(!log.includes('unrelated.txt'), '版本提交不得吞预暂存的无关改动')
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  assert.match(status, /^A  unrelated\.txt$/m, '无关文件必须保持暂存态')
  assert.equal(JSON.parse(readFileSync(join(root, 'packages', 'probe', 'package.json'), 'utf8')).version, '1.0.1')
})

test('all dry-run with skip-test明确报告测试均跳过', t => {
  // Given显式测试豁免；When all dry-run；Then文案不声称会运行聚合门。
  const root = fixture(t)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'all', '--dry-run', '--skip-test'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--skip-test/)
  assert.match(result.stdout, /dry-run:--skip-test 将跳过全仓聚合门和目标包测试/)
  assert.doesNotMatch(result.stdout, /将先运行.*aggregate-tests/)
})
