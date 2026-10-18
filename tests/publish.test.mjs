import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function fixture(t, { hasTestScript = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publish-scope-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'packages', 'probe'), { recursive: true })
  const manifest = { name: '@example/probe', version: '1.0.0' }
  if (hasTestScript) manifest.scripts = { test: 'node test.mjs' }
  writeFileSync(join(root, 'packages', 'probe', 'package.json'), JSON.stringify(manifest))
  copyFileSync(new URL('../scripts/publish.mjs', import.meta.url), join(root, 'scripts', 'publish.mjs'))
  return root
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

test('单包目标测试失败阻断npm且不调用全仓门', t => {
  // Given目标包测试失败且聚合门是失败哨兵；When单包发布；Then只运行目标测试、明细可见并中止。
  const root = fixture(t)
  writeFileSync(join(root, 'packages', 'probe', 'test.mjs'), "console.log('target-test-ran');process.exit(1)")
  writeFileSync(join(root, 'packages', 'probe', 'package.json'), JSON.stringify({ name: '@example/probe', version: '1.0.0', scripts: { test: 'node test.mjs' } }))
  writeFileSync(join(root, 'scripts', 'aggregate-tests.mjs'), "throw new Error('single-package must not run aggregate')")
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'probe'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /npm(?:\.cmd)? test/)
  assert.match(result.stdout + result.stderr, /target-test-ran/, '测试失败明细必须对用户可见,不得被管道吞掉')
  assert.doesNotMatch(result.stdout + result.stderr, /aggregate-tests|npmPublish/)
})

test('单包未定义test script时拒绝无测试发布', t => {
  // Given目标包没有test script；When真实单包发布；Then必须在npm publish前拒绝。
  const root = fixture(t, { hasTestScript: false })
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

test('all dry-run with skip-test明确报告测试均跳过', t => {
  // Given显式测试豁免；When all dry-run；Then文案不声称会运行聚合门。
  const root = fixture(t)
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'all', '--dry-run', '--skip-test'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--skip-test/)
  assert.match(result.stdout, /dry-run:--skip-test 将跳过全仓聚合门和目标包测试/)
  assert.doesNotMatch(result.stdout, /将先运行.*aggregate-tests/)
})
