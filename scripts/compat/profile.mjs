// 隔离 profile 构建:复刻真实 profile 骨架(docs/兼容性测试/测试与隔离方法.md)。
// deps = dshmarket + 全部 @mzzsfy 包(pnpm hoisted 装载,装完 symlink 覆盖指向仓库工作副本);
// bundles = 三基座(@deepseek-ai/dsh-base + dsh-web-app + dshmarket)+ 带 dsh.bundle 标记且入口存在的包。
// @deepseek-ai/* 是宿主内部 bundle,不进 profile deps;dsh-toast 无 dsh.bundle 标记,
// 只进 dependencies 由消费包代挂装载(直入 bundles 会被 cordis loader 判 invalid plugin 拖树)。
import { readdirSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, DSHMARKET_PIN, workspaceYaml, runCmd, symlinkDir, log } from './lib.mjs'

const PROFILE_PACKAGES_DIR = 'node_modules/@mzzsfy'
// 宿主内部基座 bundle,随宿主安装解析,不进 profile dependencies
const HOST_BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

// 枚举仓库包:bundles = 带 dsh.bundle 标记且 main 入口存在的包;依赖目标 = 全部 @mzzsfy 包
export function enumeratePackages() {
  const bundles = []
  const all = []
  for (const dir of readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const pkgDir = join(REPO_ROOT, 'packages', dir.name)
    const manifestPath = join(pkgDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    all.push(manifest.name)
    const entryExists = manifest.main && existsSync(join(pkgDir, manifest.main))
    if (manifest.dsh?.bundle && entryExists) bundles.push(manifest.name)
    else if (manifest.dsh?.bundle && !entryExists) log(`SKIP ${manifest.name}(入口缺失:实现未就绪)`)
  }
  return { bundles, all }
}

function profileManifest(bundleNames, allNames) {
  const dependencies = { dshmarket: DSHMARKET_PIN }
  for (const name of allNames) dependencies[name] = '*'
  return {
    name: 'dsh-compat-profile',
    private: true,
    dependencies,
    dsh: { profile: { bundles: [...HOST_BASE_BUNDLES, 'dshmarket', ...bundleNames], patchReload: 'live' } },
  }
}

// 逐包安装 deps+devDeps(--omit=peer,与 CI test job 同款):包内模块级 import 的
// 宿主稳定导出(@deepseek-ai/*)靠包内 devDeps 解析;仓库文件解析链碰不到宿主安装目录。
// 过滤同 test job:仅含非 @mzzsfy 外部依赖的包安装,自依赖统一走符号链接桥。
// 幂等,CI 维度全窗口只执行一次
export async function installPackageExternals() {
  const installed = []
  for (const dir of readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const pkgDir = join(REPO_ROOT, 'packages', dir.name)
    const manifestPath = join(pkgDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const hasExternal = [manifest.dependencies, manifest.devDependencies]
      .some((deps) => deps && Object.keys(deps).some((name) => !name.startsWith('@mzzsfy/')))
    if (!hasExternal) continue
    try {
      await runCmd('npm', ['install', '--omit=peer', '--legacy-peer-deps', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], { cwd: pkgDir })
    } catch {
      // 本地陈旧 node_modules(如 pnpm 残留 .pnpm 虚拟 store)会让 npm arborist 崩溃,清空重装自愈
      log(`外部依赖安装失败,清空 ${manifest.name} node_modules 重装`)
      rmSync(join(pkgDir, 'node_modules'), { recursive: true, force: true })
      await runCmd('npm', ['install', '--omit=peer', '--legacy-peer-deps', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], { cwd: pkgDir })
    }
    installed.push(manifest.name)
  }
  return installed
}

export async function buildProfile({ version, workRoot, hostDir }) {
  const homeDir = join(workRoot, version, 'home')
  const profileDir = join(homeDir, 'profiles', 'web')
  const { bundles, all } = enumeratePackages()

  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profileManifest(bundles, all), null, 2) + '\n', 'utf8')
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  writeFileSync(join(profileDir, '.npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  // minimumReleaseAge: 0 覆盖全局宽限配置,隔离环境不拦刚发布版本(测试对象经 symlink 指向仓库副本);
  // allowBuilds 与真实 profile 同款:pnpm 11 对未批准的依赖构建脚本按错误处理
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), workspaceYaml(), 'utf8')

  log(`[${version}] pnpm install(隔离 profile)`)
  await runCmd('pnpm', ['install'], { cwd: profileDir })

  // 工作副本桥:profile node_modules/@mzzsfy/* 指向仓库包(同人工隔离法 junction 挂载)
  const linkBase = join(profileDir, PROFILE_PACKAGES_DIR)
  for (const name of all) {
    const shortName = name.replace('@mzzsfy/', '')
    const linkPath = join(linkBase, shortName)
    rmSync(linkPath, { recursive: true, force: true })
    symlinkDir(join(REPO_ROOT, 'packages', shortName), linkPath)
  }

  const binPath = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binPath)) throw new Error(`宿主入口缺失: ${binPath}`)
  return { homeDir, profileDir, binPath, bundleNames: bundles, allNames: all }
}
