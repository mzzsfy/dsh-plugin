import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/**
 * dev-link.mjs 仓库根解析桥
 * 仅 Windows:dev-link 依赖 cmd mklink junction 与 pnpm/USERPROFILE,Linux(CI)跳过。
 *
 * BDD 场景:
 *   1. dependencies 含非 @mzzsfy 外部依赖 -> 补进仓库根 node_modules,包内不落依赖,
 *      传递依赖一并并入,点开头元数据(.bin/.package-lock.json)不并入
 *   2. 根桥已齐备 -> 二次运行报告齐备,不重装(幂等)
 *   3. 根桥已有同名实体且另有缺失 -> 触发补齐,既有实体原样保留(只补不覆盖)
 *   4. 纯 @mzzsfy 依赖包 -> 无外部依赖,根桥无动作
 *   5. 纯 devDependencies 包 -> 不装不校验(devDeps 不进 host 装载解析面)
 *   6. 未发布包(线上 404,file 协议)-> 不阻断根桥补齐
 *   7. scope 依赖 -> scope 目录逐项并入,既有 scope 条目不被覆盖
 *   8. 根桥补齐失败 -> 不挂 junction 且终态校验判失败(不产出"看起来 link 了"的中间态)
 *
 * 隔离:脚本硬编码 profile 在 USERPROFILE/.dsh,测试通过 env 注入临时 USERPROFILE
 * 与真实 profile 隔离;仓库包清单同样隔离——以"沙箱仓"形态拷贝 dev-link 到临时仓执行,
 * 根 node_modules 即沙箱仓根目录。
 */
const repo = join(import.meta.dirname, '..')
const EXTERNAL = 'is-odd'
const TRANSITIVE = 'is-number'

function sandbox(t, {packages, profileDeps, auxPackages, rootModules}) {
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
  writeFileSync(join(sandRepo, 'scripts', 'compare-version.mjs'), readFileSync(join(repo, 'scripts', 'compare-version.mjs')))
  for (const [name, manifest] of Object.entries({...auxPackages, ...packages})) {
    const dir = join(sandRepo, 'packages', name)
    mkdirSync(dir, {recursive: true})
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    for (const file of manifest.__files ?? []) writeFileSync(join(dir, file.path), file.content)
  }
  // 预置根桥实体:用于"只补不覆盖"与"已齐备"场景
  for (const [dep, marker] of Object.entries(rootModules ?? {})) {
    const dir = join(sandRepo, 'node_modules', dep)
    mkdirSync(dir, {recursive: true})
    writeFileSync(join(dir, 'package.json'), JSON.stringify({name: dep, version: '0.0.0-sandbox', marker}))
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

/** 允许非零退出:根桥失败场景要同时看 stdout/stderr 与状态码 */
function runDevLinkSafe(sand, args) {
  const run = spawnSync(process.execPath, [join(sand.sandRepo, 'scripts', 'dev-link.mjs'), ...args], {
    env: {...process.env, USERPROFILE: sand.home},
    encoding: 'utf8',
    timeout: 120 * 1000,
  })
  return {status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`}
}

test('外部依赖补进仓库根解析桥:包内不落 node_modules,传递依赖与元数据边界正确', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-ext': {
        name: '@mzzsfy/pkg-ext',
        dependencies: {[EXTERNAL]: '^3.0.1'},
      },
    },
  })
  const out = runDevLink(sand, ['pkg-ext'])
  assert.match(out, /REPAIR 根解析桥/, '输出应报告根桥补齐动作')
  assert.ok(existsSync(join(sand.sandRepo, 'node_modules', EXTERNAL, 'package.json')), '外部依赖应落在仓库根 node_modules')
  assert.ok(existsSync(join(sand.sandRepo, 'node_modules', TRANSITIVE, 'package.json')), '传递依赖应一并并入')
  assert.ok(!existsSync(join(sand.sandRepo, 'packages', 'pkg-ext', 'node_modules')), '包内不应再产生 node_modules')
  assert.ok(!existsSync(join(sand.sandRepo, 'node_modules', '.package-lock.json')), 'npm 的局部元数据不应并入根桥')
})

test('根桥已齐备:二次运行幂等不重装', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-ext': {
        name: '@mzzsfy/pkg-ext',
        dependencies: {[EXTERNAL]: '^3.0.1'},
      },
    },
  })
  runDevLink(sand, ['pkg-ext'])
  const out = runDevLink(sand, ['pkg-ext'])
  assert.doesNotMatch(out, /REPAIR 根解析桥/, '已齐备时不应再触发补齐')
  assert.match(out, /根解析桥: 1 个外部依赖齐备/, '应报告外部依赖齐备')
})

test('根桥已有同名实体且另有缺失:只补缺失项,既有实体原样保留', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-ext': {
        name: '@mzzsfy/pkg-ext',
        dependencies: {[EXTERNAL]: '^3.0.1', [TRANSITIVE]: '^6.0.0'},
      },
    },
    rootModules: {[EXTERNAL]: 'sandbox-marker'},
  })
  const out = runDevLink(sand, ['pkg-ext'])
  assert.match(out, /REPAIR 根解析桥: 缺失 is-number/, '应只针对缺失项触发补齐')
  const manifest = JSON.parse(readFileSync(join(sand.sandRepo, 'node_modules', EXTERNAL, 'package.json'), 'utf8'))
  assert.equal(manifest.marker, 'sandbox-marker', '既有实体必须原样保留')
  assert.ok(existsSync(join(sand.sandRepo, 'node_modules', TRANSITIVE, 'package.json')), '缺失项应被并入')
})

test('纯 @mzzsfy 依赖包:无外部依赖,根桥无动作', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-pure': {
        name: '@mzzsfy/pkg-pure',
        dependencies: {'@mzzsfy/pkg-other': '^1.0.0'},
      },
    },
  })
  const out = runDevLink(sand, ['pkg-pure'])
  assert.match(out, /根解析桥: 0 个外部依赖齐备/)
  assert.ok(!existsSync(join(sand.sandRepo, 'node_modules')), '不应创建根 node_modules')
})

test('纯 devDependencies 包:不装不校验', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-devonly': {
        name: '@mzzsfy/pkg-devonly',
        devDependencies: {'esbuild': '^0.25.0'},
      },
    },
  })
  const out = runDevLink(sand, ['pkg-devonly'])
  assert.match(out, /根解析桥: 0 个外部依赖齐备/, 'devDeps 不进入根桥口径')
  assert.ok(!existsSync(join(sand.sandRepo, 'node_modules')), 'devDeps 不应产生根 node_modules')
})

test('未发布包(线上 404,file 协议):根桥照常补齐', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-unpublished': {
        name: '@mzzsfy/pkg-unpublished',
        version: '0.0.1',
        dependencies: {[EXTERNAL]: '^3.0.1'},
      },
    },
  })
  const out = runDevLink(sand, ['pkg-unpublished'])
  assert.match(out, /REPAIR 根解析桥/)
  assert.ok(existsSync(join(sand.sandRepo, 'node_modules', EXTERNAL, 'package.json')))
})

test('scope 依赖:scope 目录逐项并入,既有条目不被覆盖', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-scope': {
        name: '@mzzsfy/pkg-scope',
        dependencies: {'@types/semver': '^7.5.0'},
      },
    },
    rootModules: {'@types/keep': 'sandbox-marker'},
  })
  runDevLink(sand, ['pkg-scope'])
  assert.ok(existsSync(join(sand.sandRepo, 'node_modules', '@types', 'semver', 'package.json')), 'scope 依赖应并入根桥')
  const kept = JSON.parse(readFileSync(join(sand.sandRepo, 'node_modules', '@types', 'keep', 'package.json'), 'utf8'))
  assert.equal(kept.marker, 'sandbox-marker', '既有 scope 条目必须原样保留')
})

test('根桥补齐失败:不挂 junction,终态校验判失败', (t) => {
  const sand = sandbox(t, {
    packages: {
      'pkg-bad': {
        name: '@mzzsfy/pkg-bad',
        // 本地路径缺失:npm 立即 ENOENT,不走 registry 重试,失败路径判定与网络无关
        dependencies: {'dsh-root-bridge-missing-fixture': 'file:./does-not-exist'},
      },
    },
  })
  const {status, out} = runDevLinkSafe(sand, ['pkg-bad'])
  assert.equal(status, 1, '根桥失败必须非零退出')
  assert.match(out, /FAIL 根解析桥/, '应报告根桥失败')
  assert.match(out, /校验失败/, '终态校验应失败')
  assert.match(out, /根解析桥: 缺 dsh-root-bridge-missing-fixture/, '终态校验应列出缺失依赖')
  assert.doesNotMatch(out, /-> .*packages[\\/]pkg-bad/, '根桥失败时不得挂载 junction')
})
