import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/**
 * dev-link.mjs dsh.profile.bundles 对账
 *
 * BDD 场景:
 *   1. 清单内插件包(声明 dsh.bundle)且依赖行已声明 -> 链接后加入 bundles
 *   2. 公共依赖包残留 bundles 条目 -> 移出;非本仓条目(官方内盒)不动
 *   3. 单包模式 -> 只对账该包,清单内其他插件包不动
 *   4. 已一致 -> 报告无需更新(幂等)
 *
 * 对账语义镜像官方 dsh plugin reconcilePlugins(dsh lib/plugin-Ddi42qoW.js):
 * 依赖行解析到 dsh.bundle 声明包即入层(尾部追加),失去声明或依赖行即出层。
 *
 * 隔离:临时 USERPROFILE + 沙箱仓(拷贝 dev-link.mjs),与真实 profile 无关。
 * 插件包场景 onlineLatest 查真实 npm registry(沙箱包名线上 404 -> 依赖行走 file 协议,
 * 预写同值依赖行避免触发真实 pnpm install);离线环境此类用例会失败(404 判定依赖
 * registry 响应),属已知环境假设。
 */
const repo = join(import.meta.dirname, '..')

const PLUGIN_MANIFEST = {name: '', version: '0.1.0', dsh: {bundle: {patch: './cordis.patch.yml'}}}
const LIB_MANIFEST = {name: '', version: '0.1.0', main: 'index.js'}

function fileSpec(sandRepo, dir) {
  return `file:${join(sandRepo, 'packages', dir).replace(/\\/g, '/')}`
}

function sandbox(t, {packages, profileDeps = {}, bundles}) {
  const home = mkdtempSync(join(tmpdir(), 'dev-link-bundles-home-'))
  const sandRepo = mkdtempSync(join(tmpdir(), 'dev-link-bundles-repo-'))
  t.after(() => {
    rmSync(home, {recursive: true, force: true})
    rmSync(sandRepo, {recursive: true, force: true})
  })
  mkdirSync(join(home, '.dsh', 'profiles', 'web'), {recursive: true})
  mkdirSync(join(sandRepo, 'scripts'))
  writeFileSync(join(sandRepo, 'scripts', 'dev-link.mjs'), readFileSync(join(repo, 'scripts', 'dev-link.mjs')))
  for (const [dir, manifest] of Object.entries(packages)) {
    const pkgDir = join(sandRepo, 'packages', dir)
    mkdirSync(pkgDir, {recursive: true})
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({...manifest, name: `@mzzsfy/${dir}`}))
  }
  const profile = join(home, '.dsh', 'profiles', 'web')
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'profile',
      dependencies: profileDeps,
      ...(bundles === undefined ? {} : {dsh: {profile: {bundles}}}),
    }),
  )
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

function readBundles(sand) {
  const manifest = JSON.parse(readFileSync(join(sand.profile, 'package.json'), 'utf8'))
  return manifest.dsh?.profile?.bundles
}

test('插件包且依赖行已声明:链接后加入 dsh.profile.bundles', (t) => {
  const sand = sandbox(t, {
    packages: {'pkg-plugin': PLUGIN_MANIFEST},
    profileDeps: {'@mzzsfy/pkg-plugin': ''},
  })
  // 依赖行预写为 file 协议,与未发布包归一结果一致,避免触发真实 pnpm install
  const profileManifest = JSON.parse(readFileSync(join(sand.profile, 'package.json'), 'utf8'))
  profileManifest.dependencies['@mzzsfy/pkg-plugin'] = fileSpec(sand.sandRepo, 'pkg-plugin')
  writeFileSync(join(sand.profile, 'package.json'), JSON.stringify(profileManifest))

  const out = runDevLink(sand, ['pkg-plugin'])
  assert.match(out, /pkg-plugin.*加入 dsh\.profile\.bundles/, '输出应报告加入动作')
  assert.deepEqual(readBundles(sand), ['@mzzsfy/pkg-plugin'])
})

test('公共依赖包残留 bundles 条目:移出,官方内盒条目不动', (t) => {
  const sand = sandbox(t, {
    packages: {'pkg-lib': LIB_MANIFEST},
    bundles: ['@deepseek-ai/dsh-base', '@mzzsfy/pkg-lib'],
  })
  const out = runDevLink(sand, ['pkg-lib'])
  assert.match(out, /pkg-lib.*移出 dsh\.profile\.bundles/, '输出应报告移出动作')
  assert.deepEqual(readBundles(sand), ['@deepseek-ai/dsh-base'])
})

test('单包模式:只对账该包,清单内其他插件包不动', (t) => {
  const sand = sandbox(t, {
    packages: {'pkg-a': PLUGIN_MANIFEST, 'pkg-b': PLUGIN_MANIFEST},
    profileDeps: {'@mzzsfy/pkg-a': '', '@mzzsfy/pkg-b': ''},
  })
  const profileManifest = JSON.parse(readFileSync(join(sand.profile, 'package.json'), 'utf8'))
  profileManifest.dependencies['@mzzsfy/pkg-a'] = fileSpec(sand.sandRepo, 'pkg-a')
  profileManifest.dependencies['@mzzsfy/pkg-b'] = fileSpec(sand.sandRepo, 'pkg-b')
  writeFileSync(join(sand.profile, 'package.json'), JSON.stringify(profileManifest))

  runDevLink(sand, ['pkg-a'])
  assert.deepEqual(readBundles(sand), ['@mzzsfy/pkg-a'], '单包模式不得触碰 pkg-b')
})

test('已一致:报告无需更新,幂等', (t) => {
  const sand = sandbox(t, {
    packages: {'pkg-plugin': PLUGIN_MANIFEST},
    profileDeps: {'@mzzsfy/pkg-plugin': ''},
  })
  const profileManifest = JSON.parse(readFileSync(join(sand.profile, 'package.json'), 'utf8'))
  profileManifest.dependencies['@mzzsfy/pkg-plugin'] = fileSpec(sand.sandRepo, 'pkg-plugin')
  writeFileSync(join(sand.profile, 'package.json'), JSON.stringify(profileManifest))

  runDevLink(sand, ['pkg-plugin'])
  const out = runDevLink(sand, ['pkg-plugin'])
  assert.match(out, /dsh\.profile\.bundles 与依赖行一致/, '第二次运行应报告已一致')
  assert.deepEqual(readBundles(sand), ['@mzzsfy/pkg-plugin'])
})

test('公共依赖包带残留依赖行与 bundles 条目:一次运行联动治愈', (t) => {
  const sand = sandbox(t, {
    packages: {'pkg-lib': LIB_MANIFEST},
    profileDeps: {'@mzzsfy/pkg-lib': ''},
    bundles: ['@deepseek-ai/dsh-base', '@mzzsfy/pkg-lib'],
  })
  const profileManifest = JSON.parse(readFileSync(join(sand.profile, 'package.json'), 'utf8'))
  profileManifest.dependencies['@mzzsfy/pkg-lib'] = fileSpec(sand.sandRepo, 'pkg-lib')
  writeFileSync(join(sand.profile, 'package.json'), JSON.stringify(profileManifest))

  const out = runDevLink(sand, ['pkg-lib'])
  assert.match(out, /pkg-lib.*删除表层依赖行/, '残留依赖行应被删除')
  assert.match(out, /pkg-lib.*移出 dsh\.profile\.bundles/, '残留装载条目应被移出')
  assert.deepEqual(readBundles(sand), ['@deepseek-ai/dsh-base'])
  const deps = JSON.parse(readFileSync(join(sand.profile, 'package.json'), 'utf8')).dependencies
  assert.deepEqual(deps, {}, '依赖行应清空')
})

test('all 模式:批量加入缺失插件包并移出公共依赖包残留', (t) => {
  const sand = sandbox(t, {
    packages: {'pkg-a': PLUGIN_MANIFEST, 'pkg-b': PLUGIN_MANIFEST, 'pkg-lib': LIB_MANIFEST},
    profileDeps: {'@mzzsfy/pkg-a': '', '@mzzsfy/pkg-b': ''},
    bundles: ['@deepseek-ai/dsh-base', '@mzzsfy/pkg-lib'],
  })
  const profileManifest = JSON.parse(readFileSync(join(sand.profile, 'package.json'), 'utf8'))
  profileManifest.dependencies['@mzzsfy/pkg-a'] = fileSpec(sand.sandRepo, 'pkg-a')
  profileManifest.dependencies['@mzzsfy/pkg-b'] = fileSpec(sand.sandRepo, 'pkg-b')
  writeFileSync(join(sand.profile, 'package.json'), JSON.stringify(profileManifest))

  const out = runDevLink(sand, ['all'])
  assert.match(out, /校验通过:3 个包/, '终态校验应通过')
  assert.deepEqual(readBundles(sand), ['@deepseek-ai/dsh-base', '@mzzsfy/pkg-a', '@mzzsfy/pkg-b'])
})
