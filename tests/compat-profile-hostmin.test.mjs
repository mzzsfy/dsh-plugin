import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enumeratePackages, selectBundles } from '../scripts/compat/profile.mjs'

// enumeratePackages dsh.hostMin 装载过滤(待办 #20):宿主低于 hostMin 的 bundle 包
// 不入 bundles(该代际 API 面未验证,强装复现 shell-select × 0.1.5 boot 崩形态);
// dependencies(all)恒全量(装而不载,保 dsh-market 记账完整)。
// 隔离:夹具 packagesDir 指向临时目录,与真实仓库包无关。
function fixtureRepo(t, packages) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-hostmin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, manifest] of Object.entries(packages)) {
    const pkgDir = join(dir, name)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest))
    if (manifest.main) writeFileSync(join(pkgDir, manifest.main), 'export {}\n')
  }
  return dir
}

const BASE = { name: '', version: '1.0.0', main: 'index.mjs' }

test('宿主低于 hostMin 的 bundle 包被摘出 bundles,all 保持全量', (t) => {
  const dir = fixtureRepo(t, {
    old: { ...BASE, name: '@mzzsfy/dsh-old', dsh: { bundle: { patch: './cordis.patch.yml' }, hostMin: '0.1.7-rc.1' } },
    plain: { ...BASE, name: '@mzzsfy/dsh-plain', dsh: { bundle: { patch: './cordis.patch.yml' } } },
  })
  const { bundles, all } = enumeratePackages({ hostVersion: '0.1.5-rc.3', packagesDir: dir })
  assert.deepEqual(bundles, ['@mzzsfy/dsh-plain'])
  assert.deepEqual([...all].sort(), ['@mzzsfy/dsh-old', '@mzzsfy/dsh-plain'])
})

test('宿主达线或无 hostVersion 时 hostMin 包照常入 bundles', (t) => {
  const dir = fixtureRepo(t, {
    gated: { ...BASE, name: '@mzzsfy/dsh-gated', dsh: { bundle: { patch: './c.yml' }, hostMin: '0.1.7-rc.1' } },
  })
  assert.deepEqual(enumeratePackages({ hostVersion: '0.1.7-rc.1', packagesDir: dir }).bundles, ['@mzzsfy/dsh-gated'])
  assert.deepEqual(enumeratePackages({ hostVersion: '0.2.0-rc.2', packagesDir: dir }).bundles, ['@mzzsfy/dsh-gated'])
  // 不传 hostVersion = 旧行为(0.2.0 主测槽路径),恒放行
  assert.deepEqual(enumeratePackages({ packagesDir: dir }).bundles, ['@mzzsfy/dsh-gated'])
})

test('形态无法比较按 skip 语义放行,入口缺失包仍不入 bundles', (t) => {
  const dir = fixtureRepo(t, {
    weird: { ...BASE, name: '@mzzsfy/dsh-weird', dsh: { bundle: { patch: './c.yml' }, hostMin: 'not-semver' } },
    noentry: { name: '@mzzsfy/dsh-noentry', version: '1.0.0', dsh: { bundle: { patch: './c.yml' } } },
  })
  const { bundles } = enumeratePackages({ hostVersion: '0.2.0-rc.2', packagesDir: dir })
  assert.deepEqual(bundles, ['@mzzsfy/dsh-weird'])
})

test('真实仓库双槽过滤:所有 hostMin 包在基线槽摘出、主测槽全量', (t) => {
  // 从仓库 manifest 动态枚举,新增 hostMin 包自动纳入断言,不再维护手写四包清单
  const hostMinPackages = readdirSync(new URL('../packages/', import.meta.url))
    .filter((name) => existsSync(new URL(`../packages/${name}/package.json`, import.meta.url)))
    .filter((name) => {
      const manifest = JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'))
      return typeof manifest.dsh?.hostMin === 'string'
    })
  assert.ok(hostMinPackages.length >= 9, `hostMin 包数量 ${hostMinPackages.length}`)
  const full = enumeratePackages({ hostVersion: '0.2.2-rc.1' })
  const baseline = enumeratePackages({ hostVersion: '0.1.5-rc.3' })
  for (const name of hostMinPackages) {
    assert.ok(full.bundles.includes(`@mzzsfy/${name}`), `主测槽应含 ${name}`)
    assert.ok(!baseline.bundles.includes(`@mzzsfy/${name}`), `基线槽应摘出 ${name}`)
  }
  assert.deepEqual([...baseline.all].sort(), [...full.all].sort())
})

// --only 装载子集与 --seed-gateway 的 gateway bundle 补入:seed 配置依赖 gateway
// 自身的 bundle patch 参与合成,只在 profile patch 写行会退化为 unbundled
test('selectBundles:--only 过滤、拼写错误报错、seedGateway 补入 gateway', () => {
  const bundles = ['@mzzsfy/dsh-alpha', '@mzzsfy/dsh-llm-pi-gateway', '@mzzsfy/dsh-beta']
  assert.deepEqual(selectBundles({ bundles, only: ['dsh-alpha'] }), ['@mzzsfy/dsh-alpha'])
  assert.deepEqual(selectBundles({ bundles, only: ['@mzzsfy/dsh-alpha'] }), ['@mzzsfy/dsh-alpha'])
  assert.deepEqual(selectBundles({ bundles, only: ['dsh-alpha'], seedGateway: true }), ['@mzzsfy/dsh-alpha', '@mzzsfy/dsh-llm-pi-gateway'])
  assert.deepEqual(selectBundles({ bundles, only: ['dsh-llm-pi-gateway'], seedGateway: true }), ['@mzzsfy/dsh-llm-pi-gateway'])
  assert.deepEqual(selectBundles({ bundles }), bundles)
  assert.deepEqual(selectBundles({ bundles, seedGateway: true }), bundles)
  assert.throws(() => selectBundles({ bundles, only: ['dsh-missing'] }), /--only 含非 bundle 包或拼写错误/)
})
