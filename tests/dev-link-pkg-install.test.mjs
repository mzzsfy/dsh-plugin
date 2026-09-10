import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/**
 * dev-link.mjs 包内外部依赖自动安装
 *
 * BDD 场景:
 *   1. dependencies 含非 @mzzsfy 外部依赖的包 -> 链接时包内 node_modules 被安装
 *   2. 包内依赖已存在 -> 跳过安装(幂等)
 *   3. 纯 @mzzsfy 依赖包 -> 不触发包内安装
 *   4. 单包模式 -> 只检查目标包
 *
 * 隔离:脚本硬编码 profile 在 USERPROFILE/.dsh,测试通过 env 注入临时 USERPROFILE
 * 与真实 profile 隔离;仓库包清单同样隔离——以"沙箱仓"形态拷贝 dev-link 到临时仓执行。
 */
const repo = join(import.meta.dirname, '..')

function sandbox(t, {packages, profileDeps}) {
  const home = mkdtempSync(join(tmpdir(), 'dev-link-home-'))
  const sandRepo = mkdtempSync(join(tmpdir(), 'dev-link-repo-'))
  t.after(() => {
    rmSync(home, {recursive: true, force: true})
    rmSync(sandRepo, {recursive: true, force: true})
  })
  mkdirSync(join(home, '.dsh', 'profiles', 'web'), {recursive: true})
  // 临时仓:scripts/ 与 packages/ 齐备,dev-link 以自身路径定位 repoRoot
  mkdirSync(join(sandRepo, 'scripts'))
  writeFileSync(join(sandRepo, 'scripts', 'dev-link.mjs'), readFileSync(join(repo, 'scripts', 'dev-link.mjs')))
  for (const [name, manifest] of Object.entries(packages)) {
    const dir = join(sandRepo, 'packages', name)
    mkdirSync(dir, {recursive: true})
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  }
  const profile = join(home, '.dsh', 'profiles', 'web')
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({name: 'profile', dependencies: profileDeps ?? {}}),
  )
  // 空白 pnpm-workspace.yaml:minimumReleaseAgeExclude 重写目标
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), '# sandbox\n')
  return {home, sandRepo, profile}
}

function runDevLink(sand, args) {
  return execFileSync(process.execPath, [join(sand.sandRepo, 'scripts', 'dev-link.mjs'), ...args], {
    env: {...process.env, USERPROFILE: sand.home},
    encoding: 'utf8',
    timeout: 120 * 1000,
  })
}

test('dependencies 含非 @mzzsfy 外部依赖的包:链接时包内自动安装', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-ext': {
        name: '@mzzsfy/pkg-ext',
        dependencies: {'is-odd': '^3.0.1'},
      },
    },
  })
  const out = runDevLink(sand, ['pkg-ext'])
  assert.match(out, /pkg-ext.*包内依赖安装/, '输出应报告包内依赖安装动作')
  const installed = join(sand.sandRepo, 'packages', 'pkg-ext', 'node_modules', 'is-odd')
  assert.ok(existsSync(installed), '包内 node_modules 应出现外部依赖')
})

test('包内依赖已存在:跳过安装(幂等)', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-ext': {
        name: '@mzzsfy/pkg-ext',
        dependencies: {'is-odd': '^3.0.1'},
      },
    },
  })
  runDevLink(sand, ['pkg-ext'])
  const out = runDevLink(sand, ['pkg-ext'])
  assert.match(out, /已是最新|已存在/, '第二次运行应报告跳过')
})

test('纯 @mzzsfy 依赖包:不触发包内安装', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-pure': {
        name: '@mzzsfy/pkg-pure',
        dependencies: {'@mzzsfy/pkg-other': '^1.0.0'},
      },
    },
  })
  const out = runDevLink(sand, ['pkg-pure'])
  assert.doesNotMatch(out, /pkg-pure.*包内依赖安装/)
  assert.ok(!existsSync(join(sand.sandRepo, 'packages', 'pkg-pure', 'node_modules')))
})

test('线上 404 的包不阻断包内依赖检查(file 协议路径)', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-unpublished': {
        name: '@mzzsfy/pkg-unpublished',
        version: '0.0.1',
        dependencies: {'is-odd': '^3.0.1'},
      },
    },
  })
  const out = runDevLink(sand, ['pkg-unpublished'])
  assert.match(out, /pkg-unpublished.*包内依赖安装/)
  assert.ok(existsSync(join(sand.sandRepo, 'packages', 'pkg-unpublished', 'node_modules', 'is-odd')))
})
