#!/usr/bin/env node
/**
 * 开发链接(唯一入口):归一 profile 依赖行 + 挂 junction + 终态校验,三步保证状态统一。
 *
 * 用法:
 *   node scripts/dev-link.mjs <包名|all> [--unlink] [--allow-fresh]
 *     包名 = packages/ 下目录名;单包模式只归一/挂载/校验该包,清单内其他包不受影响
 *     --allow-fresh  pnpm install 放行 minimumReleaseAge 宽限期策略(仅限自家刚发布的包)
 *
 * 统一规则(唯一的合法形态,禁止第三种状态):
 *   - 已发布包:profile 依赖行一律 semver(^线上最新版),link:/file:/本地路径一律被本脚本归一清除
 *   - 未发布包(线上 404):依赖行 = file 协议直指仓库工作副本,不强制发布;junction 照挂,
 *     线上出版本后重跑本脚本自动归一 ^latest
 *   - 公共依赖包(manifest 无 dsh.bundle,如 dsh-toast):不走表层依赖行,任意形态残留行一律删除;
 *     安装与装载由消费插件 dependencies 声明 + dsh module fallback 启动补链承载,
 *     junction 照挂工作副本保开发热更
 *   - 工作副本挂载只靠 node_modules 里的 junction,依赖清单永不指向仓库路径(未发布包的
 *     file 行除外——它同时承担 pnpm 依赖解析)
 *   - 依赖行版本以 npm 线上 latest 为准,本地 manifest 未发布的版本不影响依赖行
 *   - pnpm-workspace.yaml 的 minimumReleaseAgeExclude 由本脚本全量重写为各包线上版本并集
 *     (pnpm 只认精确版本并集,^ ~ * 均拒绝),新发版本重跑即纳入,清单永不过期
 *   - 终态校验不过即退出码 1:已发布包依赖行必须等于 ^线上最新,未发布包必须等于
 *     file 仓库路径,挂载必须是指向仓库的 junction,pnpm install 必须成功 ——
 *     不存在"看起来 link 了"的中间态
 *
 * 原理与约束:
 *   - junction 只覆盖 node_modules 物理目录,dsh bundle 加载走 node_modules
 *     realpath,天然读到仓库工作副本;同时本脚本在 home 补丁层维护 hmr 覆盖行,
 *     watch 仓库 packages —— host 半区保存即热重载,client 半区刷新页面即生效。
 *   - 包内外部依赖(dependencies/devDependencies 含非 @mzzsfy)由本脚本自动安装
 *     (--omit=peer,与 CI test.yml 同源):工作副本经 junction realpath 解析,依赖
 *     须物理存在于包内 node_modules;已装跳过,重跑幂等
 *   - pnpm install(依赖图变化)与 dsh plugin add 会重建 node_modules:之后必须重跑本脚本;
 *     增量 install(Already up to date)按实测不动 junction,重跑幂等可作兜底。
 *   - link 期间 dsh-plugin list 显示的是依赖行 semver,不是工作副本版本。
 */
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profileRoot = join(process.env.USERPROFILE, '.dsh', 'profiles', 'web')
const profileManifest = join(profileRoot, 'package.json')
const workspaceYaml = join(profileRoot, 'pnpm-workspace.yaml')
const homePatch = join(process.env.USERPROFILE, '.dsh', 'cordis.patch.yml')
const SCOPE = '@mzzsfy/'
const REGISTRY = 'https://registry.npmjs.org'

// dev 热更新:hmr 行由本脚本在 home 补丁层维护(市场只写 profile 层,互不冲突)。
// root 指向仓库 packages;junction 挂载下 Node 按 realpath 解析模块,变更即命中。
// 测试/文档/依赖目录不参与重载,防编辑风暴。
const HOT_MARK_BEGIN = '# >>> dsh-plugin dev-hmr(本块由 scripts/dev-link.mjs 维护,勿手工编辑)'
const HOT_MARK_END = '# <<< dsh-plugin dev-hmr'
const hotRow = (repoRoot) => `${HOT_MARK_BEGIN}
- id: hmr
  disabled: false
  config:
    root:
      - ${repoRoot.replace(/\\/g, '/')}/packages
    ignored:
      - '**/node_modules/**'
      - '**/test/**'
      - '**/tests/**'
      - '**/*.test.mjs'
      - '**/*.md'
      - '**/.*'
${HOT_MARK_END}`

const npmCmd = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm')

/** 包清单以 packages/ 目录为准,自动发现,不再手工维护清单 */
function discoverPackages() {
  return readdirSync(join(repoRoot, 'packages'), {withFileTypes: true})
    .filter((e) => e.isDirectory() && existsSync(join(repoRoot, 'packages', e.name, 'package.json')))
    .map((e) => e.name)
}

/** 读 profile 清单;剥掉 PowerShell 写入可能带的 UTF-8 BOM */
function readProfileManifest() {
  return JSON.parse(readFileSync(profileManifest, 'utf8').replace(/^\uFEFF/, ''))
}

/** npm 线上 latest;网络故障等非 404 失败直接中止,防止被当成版本回退;404(未发布)返回 null */
function onlineLatest(name) {
  const r = spawnSync([npmCmd(), 'view', name, 'version', '--registry', REGISTRY].join(' '), {
    encoding: 'utf8',
    shell: true,
  })
  if (r.status !== 0) {
    if (/\bE404\b|404 Not Found/.test(r.stderr)) return null
    console.error(`FAIL ${name}: 线上版本查询失败,中止:\n${r.stderr}`)
    process.exit(1)
  }
  return r.stdout.trim()
}

/** 未发布包的依赖行:file 协议直指仓库工作副本,junction 照挂,发布后重跑自动归一 ^latest */
function fileSpec(dir) {
  return `file:${join(repoRoot, 'packages', dir).replace(/\\/g, '/')}`
}

/**
 * 重写 pnpm-workspace.yaml 的 minimumReleaseAgeExclude 为 @mzzsfy 各包的线上最新版精确豁免。
 * 豁免的意义是"刚发布的版本不被宽限期卡住":历史版本早已过宽限期,无需豁免;
 * pnpm 该配置只认精确版本并集(^ ~ * 均拒绝),故每包一行精确 latest。
 * 每次运行全量重写,新发版本重跑即替换,清单永不过期。返回是否有变更。
 */
function syncReleaseAgeExclude(packages, latests) {
  if (!existsSync(workspaceYaml)) return false
  const lines = []
  for (const dir of packages) {
    const key = SCOPE + dir
    const latest = latests[dir] !== undefined ? latests[dir] : onlineLatest(key)
    if (latest === null) {
      console.log(`SKIP ${key}: 线上无版本,不进豁免清单`)
      continue
    }
    lines.push(`  - "${key}@${latest}"`)
  }
  const section = `minimumReleaseAgeExclude:\n${lines.join('\n')}\n`
  const raw = readFileSync(workspaceYaml, 'utf8').replace(/^\uFEFF/, '')
  const next = /\nminimumReleaseAgeExclude:/.test(raw)
    ? raw.replace(/\nminimumReleaseAgeExclude:[\s\S]*?(?=\n\w+:|$)/, `\n${section}`)
    : raw.replace(/\s*$/, `\n${section}`)
  if (next === raw) {
    console.log('OK   minimumReleaseAgeExclude 已是最新,无需更新')
    return false
  }
  writeFileSync(workspaceYaml, next)
  console.log('FIX  minimumReleaseAgeExclude 已重写为各包线上最新版')
  return true
}

/**
 * 维护 home 补丁层的 dev 热更新块:链接时写入 hmr 覆盖行(web bundle 默认禁用共享
 * HMR,此处按 id 重新声明并给 root),卸链时整块移除。按标记块幂等替换。
 */
function syncDevHmr(enable) {
  const block = hotRow(repoRoot)
  const raw = existsSync(homePatch) ? readFileSync(homePatch, 'utf8').replace(/^\uFEFF/, '') : ''
  const pattern = new RegExp(`${HOT_MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${HOT_MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`)
  const stripped = raw.replace(pattern, '')
  if (!enable) {
    if (stripped === raw) {
      console.log('OK   dev 热更新块不存在,无需移除')
      return
    }
    writeFileSync(homePatch, stripped)
    console.log('OK   已从 home 补丁层移除 dev 热更新块')
    return
  }
  if (raw.includes(block)) {
    console.log('OK   dev 热更新块已是最新,无需更新')
    return
  }
  const base = stripped.replace(/\s*$/, '')
  const next = base === '' ? `${block}\n` : `${base}\n\n${block}\n`
  writeFileSync(homePatch, next)
  console.log('FIX  已在 home 补丁层写入 dev 热更新块(hmr root -> 仓库 packages)')
}

/** 读包 manifest;dsh.bundle 缺失即公共依赖包(装载经消费方依赖声明 + dsh fallback 补链,不走表层依赖行) */
function isLibPackage(dir) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  return manifest.dsh?.bundle === undefined
}

/**
 * 归一依赖行:非 semver(历史 link:/file: 残留)或落后线上的一律改为 ^线上最新;返回 变更与否 + 各包线上 latest。
 * 公共依赖包不走表层依赖行:任意形态残留行一律删除(删除计入变更,触发 install),版本语义由消费方 dependencies 承载
 */
function normalizeDeps(packages) {
  const manifest = readProfileManifest()
  manifest.dependencies = manifest.dependencies || {}
  let changed = false
  const latests = {}
  for (const dir of packages) {
    const key = SCOPE + dir
    if (isLibPackage(dir)) {
      if (manifest.dependencies[key] !== undefined) {
        console.log(`FIX  ${key}: 删除表层依赖行 ${manifest.dependencies[key]}(公共依赖包由消费方声明承载)`)
        delete manifest.dependencies[key]
        changed = true
      } else {
        console.log(`OK   ${key}: 公共依赖包,无表层行`)
      }
      continue
    }
    latests[dir] = onlineLatest(key)
    // 未发布包(线上 404)不强制发布:依赖行走 file 协议,junction 照挂,发布后重跑自动归一 ^latest
    const want = latests[dir] === null ? fileSpec(dir) : `^${latests[dir]}`
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
  return {changed, latests}
}

function pnpmInstall(allowFresh) {
  const args = allowFresh ? ['install', '--config.minimum-release-age=0'] : ['install']
  console.log(`$ pnpm ${args.join(' ')}(profile 内)`)
  const r = spawnSync('pnpm', args, {cwd: profileRoot, encoding: 'utf8', shell: true})
  if (r.status !== 0) console.error(`FAIL pnpm install 非零退出:\n${r.stderr || '(无输出;被 minimumReleaseAge 拦截时可加 --allow-fresh)'}`)
  return r.status === 0
}

/**
 * 包内外部依赖自动安装(发现口径与 CI test.yml"安装含外部依赖的包"同源):
 * dependencies/devDependencies 含非 @mzzsfy 依赖的包,包内 npm install --omit=dev --omit=peer,
 * 供工作副本(junction realpath)的 Node ESM 逐级向上解析命中包内 node_modules。
 * 只装 dependencies:devDeps 的 @deepseek-ai 钉版若落包内会截胡宿主 API 解析链,
 * 废掉"本体升级立即生效"模型;profile 安装态由 pnpm 依赖声明承载,此安装只为开发态。
 * 已装过(包内有 node_modules)即跳过,重跑幂等;失败清残留再计入失败,防半装态固化。
 */
function installPackageDeps(name) {
  const pkgDir = join(repoRoot, 'packages', name)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  const hasExternal = ['dependencies', 'devDependencies']
    .some((k) => Object.keys(manifest[k] ?? {}).some((n) => !n.startsWith(SCOPE)))
  if (!hasExternal) return true
  if (existsSync(join(pkgDir, 'node_modules'))) {
    console.log(`OK   ${name}: 包内依赖已存在,跳过安装`)
    return true
  }
  console.log(`$ 包内依赖安装 ${name}(npm install --omit=dev --omit=peer)`)
  const r = spawnSync(npmCmd(), ['install', '--omit=dev', '--omit=peer', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], {
    cwd: pkgDir, encoding: 'utf8', shell: true,
  })
  if (r.status !== 0) {
    // 失败必不留可被跳过的残留:半装态 node_modules 会让后续重跑误判"已存在"而固化坏态
    rmSync(join(pkgDir, 'node_modules'), {recursive: true, force: true})
    console.error(`FAIL ${name}: 包内依赖安装失败\n${r.stderr}`)
    return false
  }
  console.log(`OK   ${name}: 包内依赖安装完成`)
  return true
}

function junctionPath(name) {
  return join(profileRoot, 'node_modules', SCOPE, name)
}

/** 挂/重挂单个 junction;返回是否成功 */
function mountJunction(name) {
  const sourcePath = join(repoRoot, 'packages', name)
  if (!existsSync(sourcePath)) {
    console.error(`FAIL ${name}: 仓库目录缺失 ${sourcePath}`)
    return false
  }
  const linkPath = junctionPath(name)
  mkdirSync(dirname(linkPath), {recursive: true})
  if (existsSync(linkPath)) rmSync(linkPath, {recursive: true, force: true})
  const run = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, sourcePath], {encoding: 'utf8'})
  if (run.status !== 0) {
    console.error(`FAIL ${name}: mklink 失败\n${run.stderr}`)
    return false
  }
  console.log(`OK   ${name}: ${linkPath} -> ${sourcePath}`)
  return true
}

/** 读物理路径的 junction 指向;非链接返回 null */
function readJunctionTarget(linkPath) {
  try {
    return readlinkSync(linkPath)
  } catch {
    return null
  }
}

/** 终态校验:依赖行、挂载指向、(卸链时的)安装版本逐项比对,任一不符即整体失败 */
function verifyAll(packages, latests, unlink, scope) {
  const manifest = readProfileManifest()
  const failures = []
  for (const dir of packages) {
    const key = SCOPE + dir
    // 单包模式只校验指定包,其余包终态不随之校验
    if (!scope.includes(dir)) continue
    const phys = junctionPath(dir)
    if (isLibPackage(dir)) {
      // 公共依赖包无表层依赖行与版本语义:链接态只验 junction 指向仓库;卸链后顶层留空由 dsh fallback 启动接管
      if (unlink) {
        if (readJunctionTarget(phys) !== null) failures.push(`${key}: 卸链后 node_modules 仍是链接`)
        continue
      }
      const target = existsSync(phys) ? readJunctionTarget(phys) : null
      if (target === null) {
        failures.push(`${key}: node_modules 不是 junction(实体目录或缺失),工作副本不生效`)
        continue
      }
      const expected = resolve(join(repoRoot, 'packages', dir)).toLowerCase()
      if (resolve(target).toLowerCase() !== expected) {
        failures.push(`${key}: junction 指向 ${target} 应为 ${expected}`)
      }
      continue
    }
    const latest = latests[dir] !== undefined ? latests[dir] : onlineLatest(key)
    const want = latest === null ? fileSpec(dir) : `^${latest}`
    const dep = manifest.dependencies[key]
    if (dep !== want) failures.push(`${key}: 依赖行 ${dep ?? '(缺声明)'} 应为 ${want}`)

    if (unlink) {
      if (readJunctionTarget(phys) !== null) {
        failures.push(`${key}: 卸链后 node_modules 仍是链接`)
        continue
      }
      const manifestPath = join(phys, 'package.json')
      if (!existsSync(manifestPath)) {
        failures.push(`${key}: node_modules 未安装`)
        continue
      }
      const installed = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')).version
      // 未发布包(latest=null)无线上版本可比:依赖行已按 file 协议校验,安装版本不比对
      if (latest !== null && installed !== latest) failures.push(`${key}: 安装版本 ${installed} 应为线上 ${latest}`)
      continue
    }
    const target = existsSync(phys) ? readJunctionTarget(phys) : null
    if (target === null) {
      failures.push(`${key}: node_modules 不是 junction(实体目录或缺失),工作副本不生效`)
      continue
    }
    const expected = resolve(join(repoRoot, 'packages', dir)).toLowerCase()
    if (resolve(target).toLowerCase() !== expected) {
      failures.push(`${key}: junction 指向 ${target} 应为 ${expected}`)
    }
  }
  if (failures.length) {
    console.error(`\n校验失败 ${failures.length} 项,终态不统一:`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exitCode = 1
    return false
  }
  console.log(`\n校验通过:${scope.length} 个包(插件包依赖行 = ^线上最新,公共依赖包仅验挂载),挂载/安装状态与声明一致`)
  return true
}

const args = process.argv.slice(2)
const unlink = args.includes('--unlink')
const allowFresh = args.includes('--allow-fresh')
const target = args.find((a) => !a.startsWith('--'))
if (!target) {
  console.error('用法: node scripts/dev-link.mjs <包名|all> [--unlink] [--allow-fresh]')
  process.exit(1)
}
if (!existsSync(profileManifest)) {
  console.error(`profile 不存在: ${profileRoot}`)
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

let latests = {}
if (!unlink) {
  // 单包模式只归一指定包,不被清单内其他未发布包(线上查询 404)阻断;all 仍全量归一
  const scope = target === 'all' ? packages : names
  const normalized = normalizeDeps(scope)
  latests = normalized.latests
  // 豁免清单是全 profile 级策略,仅在 all 模式全量重写(只豁免各包线上最新版——
  // 历史版本早已过宽限期)
  const excludeChanged = target === 'all' ? syncReleaseAgeExclude(packages, latests) : false
  if (normalized.changed || excludeChanged) {
    if (!pnpmInstall(allowFresh)) {
      console.error('FAIL 依赖行已写入但安装失败,终态不保证;处理后同参数重跑本脚本')
      process.exitCode = 1
    }
    // pnpm 重建过整个 node_modules:凡有依赖声明的包与公共依赖包全部重挂,保住既有链接;
    // 公共依赖包无依赖声明(依赖行走消费方声明),须显式纳入否则删行后漏挂
    const declared = readProfileManifest().dependencies || {}
    for (const dir of packages) {
      if (declared[SCOPE + dir] !== undefined || isLibPackage(dir)) mountJunction(dir)
    }
  }
}

if (unlink) {
  syncDevHmr(false)
  for (const name of names) {
    if (!existsSync(junctionPath(name))) {
      console.log(`SKIP ${name}: 未挂链接`)
      continue
    }
    const lib = isLibPackage(name)
    rmSync(junctionPath(name), {recursive: true, force: true})
    const run = spawnSync('pnpm', ['install'], {cwd: profileRoot, encoding: 'utf8', shell: true})
    const done = lib ? '已卸链接,顶层不留实体,dsh fallback 启动接管' : '已卸链接并恢复 registry 版本'
    console.log(`${run.status === 0 ? 'OK  ' : 'FAIL'} ${name}: ${done}`)
  }
} else {
  syncDevHmr(true)
  let installFailures = 0
  for (const name of names) {
    if (!installPackageDeps(name)) installFailures++
    mountJunction(name)
  }
  if (installFailures) {
    console.error(`FAIL ${installFailures} 个包包内依赖安装失败,host 工作副本启动会 ERR_MODULE_NOT_FOUND`)
    process.exitCode = 1
  }
}

verifyAll(packages, latests, unlink, names)
console.log(`\n提醒: 依赖图变化的 pnpm install / dsh plugin add 之后须重跑本脚本;增量 install 不动 junction,重跑幂等。`)
