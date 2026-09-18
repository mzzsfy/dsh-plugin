// 公共依赖包形态守卫:本包不声明 dsh.bundle.patch、不自带 cordis.patch.yml、
// 不进 profile 表层 manifest 依赖行与装载层。表层 dependencies 行是插件市场
// 「已安装」列表的唯一数据源(全量展示,仅过滤官方内盒),本包一旦被显式
// add 写入表层行,市场即把它当插件展示——该现象曾出现并已修复(表层数行
// 由 dev-link 对公共依赖包一律删除),此测试把约束固化为机器断言防回归。
// 规约见 DEVELOPMENT/client-dependency.md 与 DEVELOPMENT/profile-link.md 第 4 条,
// 机制推导见本包 MECHANISM.md。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = '@mzzsfy/dsh-toast'
// profile 路径与 scripts/dev-link.mjs 同构;不存在(如 CI)时终态用例跳过
const PROFILE_MANIFEST = join(homedir(), '.dsh', 'profiles', 'web', 'package.json')

test('package.json 不声明 dsh.bundle.patch,维持公共依赖包身份', () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  assert.equal(
    manifest.dsh?.bundle?.patch, undefined,
    '声明 dsh.bundle.patch 即成为插件包:官方 reconcile 会将其入 dsh.profile.bundles,dev-link 也失去删表层行的依据',
  )
})

test('不自带 cordis.patch.yml,装载靠消费方代挂占位', () => {
  assert.equal(
    existsSync(join(PKG_ROOT, 'cordis.patch.yml')), false,
    '公共依赖包禁止自带 patch;client 进入模块表由消费插件 cordis.patch.yml 代挂占位条目承载',
  )
})

test('profile 表层 dependencies 无本包行,市场已装列表不可见', (t) => {
  if (!existsSync(PROFILE_MANIFEST)) return t.skip('本机无 profile,终态由 dev-link 维护')
  const manifest = JSON.parse(readFileSync(PROFILE_MANIFEST, 'utf8').replace(/^\uFEFF/, ''))
  assert.equal(
    manifest.dependencies?.[PKG_NAME], undefined,
    '表层依赖行存在即市场已装列表展示本包;安装由消费方 dependencies 声明承载,表层行一律删除',
  )
})

test('profile dsh.profile.bundles 无本包,不进宿主装载层', (t) => {
  if (!existsSync(PROFILE_MANIFEST)) return t.skip('本机无 profile,终态由 dev-link 维护')
  const manifest = JSON.parse(readFileSync(PROFILE_MANIFEST, 'utf8').replace(/^\uFEFF/, ''))
  assert.equal(
    manifest.dsh?.profile?.bundles?.includes(PKG_NAME), false,
    '公共依赖包无宿主半区可载,入装载层即「装而不载」的伪插件形态',
  )
})
