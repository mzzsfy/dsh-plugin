import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/**
 * dev-link.mjs 包内外部依赖自动安装
 * 仅 Windows:dev-link 依赖 cmd mklink junction 与 pnpm/USERPROFILE,Linux(CI)跳过。
 *
 * BDD 场景:
 *   1. dependencies 含非 @mzzsfy 外部依赖的包 -> 链接时包内 node_modules 被安装
 *   2. 包内依赖已存在 -> 跳过安装(幂等)
 *   3. 纯 @mzzsfy 依赖包 -> 不触发包内安装
 *   4. 单包模式 -> 只检查目标包
 *   5. 纯 devDependencies 包 -> 不装不校验(devDeps 不进 host 装载解析面)
 *   6. ESM-only 依赖(exports 仅 import 条件)物理存在 -> 幂等跳过(require.resolve 探测不到)
 *   7. 已装依赖被删(半装态)-> REPAIR 重装恢复,不固化坏态
 *   8. deps+devDeps 混合形态 -> devDeps 缺失不触发 REPAIR,也不被安装(变更动机场景)
 *   9. 包内已装 devDeps 时触发 REPAIR -> --omit=dev 重装剪除 devDeps(安装口径固有代价)
 *
 * 隔离:脚本硬编码 profile 在 USERPROFILE/.dsh,测试通过 env 注入临时 USERPROFILE
 * 与真实 profile 隔离;仓库包清单同样隔离——以"沙箱仓"形态拷贝 dev-link 到临时仓执行。
 */
const repo = join(import.meta.dirname, '..')

function sandbox(t, {packages, profileDeps, auxPackages}) {
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
  assert.doesNotMatch(out, /pkg-devonly.*包内依赖安装/, 'devDeps 不应触发安装')
  assert.ok(!existsSync(join(sand.sandRepo, 'packages', 'pkg-devonly', 'node_modules')), '不应存在包内 node_modules')
})

// 纯 import 条件 exports 的 ESM-only 夹具:require.resolve 恒 ERR_PACKAGE_PATH_NOT_EXPORTED,
// 模拟 lightweight-charts 形态;__files 由 sandbox 写为实体文件,不入 package.json
const esmOnlyLib = {
  name: '@mzzsfy/esm-only-lib',
  version: '1.0.0',
  type: 'module',
  exports: {'.': {'import': './index.js'}},
  __files: [{path: 'index.js', content: 'export const marker = 1\n'}],
}

test('ESM-only 依赖物理存在:幂等跳过(require.resolve 探测不到的形态)', (t) => {
  const sand = sandbox(t, {
    auxPackages: {'esm-only-lib': esmOnlyLib},
    packages: {
      'pkg-esm': {
        name: '@mzzsfy/pkg-esm',
        dependencies: {'esm-only-lib': 'file:../esm-only-lib'},
      },
    },
  })
  runDevLink(sand, ['pkg-esm'])
  const out = runDevLink(sand, ['pkg-esm'])
  assert.doesNotMatch(out, /REPAIR/, 'ESM-only 物理存在时不应误报 REPAIR')
  assert.match(out, /pkg-esm.*已存在/, '应按已存在跳过安装')
})

test('deps+devDeps 混合形态:devDeps 缺失不触发 REPAIR,也不被安装', (t) => {
  const sand = sandbox(t, {
    auxPackages: {
      'esm-only-lib': esmOnlyLib,
      'dev-only-lib': {
        name: 'dev-only-lib',
        version: '1.0.0',
        type: 'module',
        __files: [{path: 'index.js', content: 'export const dev = 1\n'}],
      },
    },
    packages: {
      'pkg-mixed': {
        name: '@mzzsfy/pkg-mixed',
        dependencies: {'esm-only-lib': 'file:../esm-only-lib'},
        // devDep 名非 scoped:旧代码把非 @mzzsfy 的 devDeps 纳入校验清单,缺失即误报 REPAIR(红面所在)
        devDependencies: {'dev-only-lib': 'file:../dev-only-lib'},
      },
    },
  })
  runDevLink(sand, ['pkg-mixed'])
  const out = runDevLink(sand, ['pkg-mixed'])
  assert.doesNotMatch(out, /REPAIR/, 'devDeps 不在校验清单,缺失不应触发 REPAIR')
  assert.match(out, /pkg-mixed.*已存在/, '应按已存在跳过安装')
  assert.ok(!existsSync(join(sand.sandRepo, 'packages', 'pkg-mixed', 'node_modules', 'dev-only-lib')), 'devDeps 不应被安装')
})

test('REPAIR 重装剪除包内已装 devDeps(安装口径的固有代价)', (t) => {
  const sand = sandbox(t, {
    auxPackages: {'esm-only-lib': esmOnlyLib},
    packages: {
      'pkg-esm': {
        name: '@mzzsfy/pkg-esm',
        dependencies: {'esm-only-lib': 'file:../esm-only-lib'},
      },
    },
  })
  runDevLink(sand, ['pkg-esm'])
  // 模拟 install-externals 补装的构建态 devDep 已落包内
  const devTool = join(sand.sandRepo, 'packages', 'pkg-esm', 'node_modules', 'dev-only-lib')
  mkdirSync(devTool, {recursive: true})
  writeFileSync(join(devTool, 'package.json'), JSON.stringify({name: 'dev-only-lib', version: '1.0.0', type: 'module'}))
  rmSync(join(sand.sandRepo, 'packages', 'pkg-esm', 'node_modules', 'esm-only-lib'), {recursive: true, force: true})
  const out = runDevLink(sand, ['pkg-esm'])
  assert.match(out, /REPAIR/, 'dep 缺失应触发 REPAIR')
  assert.ok(!existsSync(devTool), 'REPAIR 的 --omit=dev 重装应剪除包内已装 devDeps')
  assert.ok(existsSync(join(sand.sandRepo, 'packages', 'pkg-esm', 'node_modules', 'esm-only-lib')), '缺失 dep 应恢复')
})

test('已装依赖被删(半装态):REPAIR 重装恢复', (t) => {
  const sand = sandbox(t, {
    auxPackages: {'esm-only-lib': esmOnlyLib},
    packages: {
      'pkg-esm': {
        name: '@mzzsfy/pkg-esm',
        dependencies: {'esm-only-lib': 'file:../esm-only-lib'},
      },
    },
  })
  runDevLink(sand, ['pkg-esm'])
  rmSync(join(sand.sandRepo, 'packages', 'pkg-esm', 'node_modules', 'esm-only-lib'), {recursive: true, force: true})
  const out = runDevLink(sand, ['pkg-esm'])
  assert.match(out, /REPAIR/, '缺失应显式报告 REPAIR')
  assert.ok(existsSync(join(sand.sandRepo, 'packages', 'pkg-esm', 'node_modules', 'esm-only-lib')), '重装后依赖应恢复')
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
