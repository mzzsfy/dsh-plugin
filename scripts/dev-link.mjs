#!/usr/bin/env node
/**
 * 开发链接(唯一入口):归一 profile 依赖行 + 挂 junction,两步保证状态统一。
 *
 * 用法:
 *   node scripts/dev-link.mjs <包名|all>            归一依赖行并挂链接(包名 = packages/ 下目录名)
 *   node scripts/dev-link.mjs <包名|all> --unlink   卸链接,恢复 registry 安装版
 *
 * 统一规则(唯一的合法形态,禁止第三种状态):
 *   - profile 依赖行一律 semver(^线上最新版),link:/file:/本地路径一律被本脚本归一清除
 *   - 工作副本挂载只靠 node_modules 里的 junction,依赖清单永不指向仓库路径
 *   - 依赖行版本以 npm 线上 latest 为准,本地 manifest 未发布的版本不影响依赖行
 *
 * 原理与约束:
 *   - junction 只覆盖 node_modules 物理目录,dsh bundle 加载走 node_modules
 *     realpath,天然读到仓库工作副本 —— 改代码重启 dsh 即生效,无需发版。
 *   - pnpm install / dsh plugin add 会重建 node_modules:两者之后必须重跑本脚本。
 *   - link 期间 dsh-plugin list 显示的是依赖行 semver,不是工作副本版本。
 */
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profileRoot = join(process.env.USERPROFILE, '.dsh', 'profiles', 'web')
const profileManifest = join(profileRoot, 'package.json')
const SCOPE = '@mzzsfy/'
const REGISTRY = 'https://registry.npmjs.org'

const npmCmd = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm')

/** 包清单以 packages/ 目录为准,自动发现,不再手工维护清单 */
function discoverPackages() {
  return readdirSync(join(repoRoot, 'packages'), {withFileTypes: true})
    .filter((e) => e.isDirectory() && existsSync(join(repoRoot, 'packages', e.name, 'package.json')))
    .map((e) => e.name)
}

/** npm 线上 latest;查询失败直接中止,防止网络故障被当成版本回退 */
function onlineLatest(name) {
  const r = spawnSync([npmCmd(), 'view', name, 'version', '--registry', REGISTRY].join(' '), {
    encoding: 'utf8',
    shell: true,
  })
  if (r.status !== 0) {
    console.error(`FAIL ${name}: 线上版本查询失败,中止归一:\n${r.stderr}`)
    process.exit(1)
  }
  return r.stdout.trim()
}

/** 读 profile 清单;剥掉 PowerShell 写入可能带的 UTF-8 BOM */
function readProfileManifest() {
  const raw = readFileSync(profileManifest, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

/** 归一依赖行:非 semver(历史 link:/file: 残留)或落后线上的一律改为 ^线上最新;返回是否有变更 */
function normalizeDeps(packages) {
  const manifest = readProfileManifest()
  manifest.dependencies = manifest.dependencies || {}
  let changed = false
  for (const dir of packages) {
    const key = SCOPE + dir
    const want = `^${onlineLatest(key)}`
    const current = manifest.dependencies[key]
    if (current === want) {
      console.log(`OK   ${key}: ${want}`)
      continue
    }
    console.log(`FIX  ${key}: ${current ?? '(缺声明)'} -> ${want}`)
    manifest.dependencies[key] = want
    changed = true
  }
  if (changed) writeFileSync(profileManifest, JSON.stringify(manifest, null, 2) + '\n')
  return changed
}

function pnpmInstall(reason) {
  console.log(`$ pnpm install(profile 内,${reason})`)
  const r = spawnSync('pnpm', ['install'], {cwd: profileRoot, encoding: 'utf8', shell: true})
  if (r.status !== 0) console.error(`FAIL pnpm install 非零退出(依赖行已写入,可单独重跑后重挂链接):\n${r.stderr}`)
  return r.status === 0
}

const args = process.argv.slice(2)
const unlink = args.includes('--unlink')
const target = args.find((a) => !a.startsWith('--'))
if (!target) {
  console.error('用法: node scripts/dev-link.mjs <包名|all> [--unlink]')
  process.exit(1)
}
const packages = discoverPackages()
const names = target === 'all' ? packages : [target]
for (const name of names) {
  if (!packages.includes(name)) {
    console.error(`未知包名: ${name}(可选: ${packages.join(', ')})`)
    process.exit(1)
  }
}

if (!existsSync(profileManifest)) {
  console.error(`profile 不存在: ${profileRoot}`)
  process.exit(1)
}

let depsChanged = false
if (!unlink) depsChanged = normalizeDeps(names)

for (const name of names) {
  const linkPath = join(profileRoot, 'node_modules', SCOPE, name)
  const sourcePath = join(repoRoot, 'packages', name)
  if (!existsSync(sourcePath)) {
    console.error(`FAIL ${name}: 仓库目录缺失 ${sourcePath}`)
    continue
  }
  if (unlink) {
    if (!existsSync(linkPath)) {
      console.log(`SKIP ${name}: 未挂链接`)
      continue
    }
    rmSync(linkPath, {recursive: true, force: true})
    const run = spawnSync('pnpm', ['install'], {cwd: profileRoot, encoding: 'utf8', shell: true})
    console.log(`${run.status === 0 ? 'OK  ' : 'FAIL'} ${name}: 已卸链接并恢复 registry 版本`)
    continue
  }
  mkdirSync(dirname(linkPath), {recursive: true})
  if (existsSync(linkPath)) rmSync(linkPath, {recursive: true, force: true})
  const run = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, sourcePath], {encoding: 'utf8'})
  if (run.status !== 0) {
    console.error(`FAIL ${name}: mklink 失败\n${run.stderr}`)
    continue
  }
  console.log(`OK   ${name}: ${linkPath} -> ${sourcePath}`)
}

// 依赖行被改写时:先重装清掉 link:/file: 时代的实体拷贝与过期安装,再把链接重挂一遍
if (depsChanged) {
  pnpmInstall('依赖行已归一,清残留')
  for (const name of names) {
    const linkPath = join(profileRoot, 'node_modules', SCOPE, name)
    if (!existsSync(linkPath)) continue
    rmSync(linkPath, {recursive: true, force: true})
    spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, join(repoRoot, 'packages', name)], {encoding: 'utf8'})
  }
  console.log('OK   已按归一后的依赖行重装并重挂链接')
}
console.log('\n提醒: profile 内执行过 pnpm install / dsh plugin add 后,链接会被覆盖,需重跑本脚本。')
