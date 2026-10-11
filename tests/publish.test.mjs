import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

for (const stream of ['stdout', 'stderr']) {
  test(`发布门失败时展示${stream}明细并阻止后续发布`, t => {
    // Given独立仓库夹具的聚合门失败；When运行发布CLI；Then明细可见且不触发npm。
    const root = mkdtempSync(join(tmpdir(), 'publish-gate-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'packages', 'probe'), { recursive: true })
    writeFileSync(join(root, 'packages', 'probe', 'package.json'), JSON.stringify({ name: '@example/probe', version: '1.0.0' }))
    copyFileSync(new URL('../scripts/publish.mjs', import.meta.url), join(root, 'scripts', 'publish.mjs'))
    writeFileSync(join(root, 'scripts', 'aggregate-tests.mjs'), `process.${stream}.write('fixture-failure-detail\\n'); process.exit(1)`)
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'publish.mjs'), 'probe'], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result[stream], /fixture-failure-detail/)
    assert.match(result.stderr, /聚合测试未通过/)
    assert.doesNotMatch(result.stdout + result.stderr, /npm view|npmPublish/)
  })
}
