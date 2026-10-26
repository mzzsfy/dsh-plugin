import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {externalSpecs, packageDirs} from '../scripts/install-externals.mjs'

/**
 * install-externals.mjs 包外部依赖安装器
 *
 * BDD 场景:
 *   1. 混合包(外部 + @mzzsfy)→ 外部项按 name@range、@mzzsfy 项按 file:../<同层包名> 出 spec,
 *      registry 解析面不含 @mzzsfy(未发布依赖不再 ETARGET)
 *   2. devDependencies 同样进入 spec(宿主稳定导出靠包内 devDeps 解析)
 *   3. 无依赖包 → 空 spec,调用方跳过
 *   4. packageDirs 枚举含 package.json 的包目录,无清单目录不炸
 */

const pkgDir = join('packages', 'dsh-x')

test('externalSpecs_混合包_外部按range且mzzsfy映射同层file', () => {
  const manifest = {
    dependencies: {croner: '^10.0.1', '@mzzsfy/dsh-common-tools': '^0.2.0'},
    devDependencies: {'@mzzsfy/dsh-tools': 'workspace:*'},
  }
  assert.deepEqual(externalSpecs(manifest, pkgDir), [
    'croner@^10.0.1',
    '@mzzsfy/dsh-common-tools@file:../dsh-common-tools',
    '@mzzsfy/dsh-tools@file:../dsh-tools',
  ])
})

test('externalSpecs_纯mzzsfy依赖_非空不跳过CI终态等价', () => {
  // installExternals 仅对 specs 空的包跳过 npm;纯 @mzzsfy 依赖映射 file: 后非空,
  // 必须经 npm 建 symlink——CI 旧语义(此类包执行 npm install)由此钉住
  const manifest = {dependencies: {'@mzzsfy/dsh-common-tools': '^0.2.0'}}
  assert.deepEqual(externalSpecs(manifest), ['@mzzsfy/dsh-common-tools@file:../dsh-common-tools'])
})

test('externalSpecs_无依赖_空数组', () => {
  assert.deepEqual(externalSpecs({private: true}, pkgDir), [])
  assert.deepEqual(externalSpecs({}, pkgDir), [])
})

test('packageDirs_只收含清单的包目录', t => {
  const root = mkdtempSync(join(tmpdir(), 'inst-ext-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  for (const name of ['pkg-a', 'pkg-bare', 'not-a-dir']) {
    mkdirSync(join(root, 'packages', name), {recursive: true})
  }
  writeFileSync(join(root, 'packages', 'pkg-a', 'package.json'), '{}')
  writeFileSync(join(root, 'packages', 'pkg-bare', 'README.md'), 'x')
  const dirs = packageDirs(root, 'packages')
  assert.equal(dirs.length, 1)
  assert.ok(dirs[0].endsWith('pkg-a'))
})

test('packageDirs_包根缺失_空数组不崩', () => {
  assert.deepEqual(packageDirs('Z:/definitely-absent-root', 'packages'), [])
})
