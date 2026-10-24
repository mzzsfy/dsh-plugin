// 包外部依赖安装器:deps+devDeps 显式 CLI spec 安装(--omit=peer,与 CI 旧 bash 段同款语义)。
// 裸 npm install 按 manifest 全量建理想树,未发布的 @mzzsfy 依赖即 ETARGET;显式 spec 把
// 非 @mzzsfy 项按 name@range 传递、@mzzsfy 项映射 file:../<同层包名>(npm 9 对 file: 目录
// 装 symlink,与仓库根符号链接桥同语义),registry 解析面只剩真实外部包。
// 用法:node scripts/install-externals.mjs [包根目录相对路径](缺省 packages,枚举子目录)
import {spawnSync} from 'node:child_process'
import {readdirSync, existsSync, readFileSync, rmSync} from 'node:fs'
import {join, basename} from 'node:path'
import {fileURLToPath} from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MZZSFY_SCOPE = '@mzzsfy/'
const NPM_BASE_ARGS = ['install', '--omit=peer', '--legacy-peer-deps', '--no-save', '--no-package-lock', '--no-audit', '--no-fund']

// manifest 的外部安装 spec 列表:非 @mzzsfy → name@range;@mzzsfy → name@file:../<同层包名>
// (布局假设:被依赖包与当前包同层,仓库 packages/ 布局保证)
export function externalSpecs(manifest) {
  return ['dependencies', 'devDependencies'].flatMap(section => Object.entries(manifest[section] ?? {}).map(([name, range]) =>
    name.startsWith(MZZSFY_SCOPE) ? `${name}@file:../${name.slice(MZZSFY_SCOPE.length)}` : `${name}@${range}`))
}

export function packageDirs(repoRoot = REPO_ROOT, packagesDir = 'packages') {
  const base = join(repoRoot, packagesDir)
  if (!existsSync(base)) return []
  return readdirSync(base, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map(entry => join(base, entry.name))
}

export function installExternals({pkgDir, log = () => {}}) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const name = manifest.name ?? basename(pkgDir)
  const specs = externalSpecs(manifest)
  if (specs.length === 0) return {name, skipped: true}
  const first = runNpmInstall({pkgDir, specs, log, name})
  if (first.ok) return first
  // 本地陈旧 node_modules(pnpm 残留 .pnpm 虚拟 store 等)会让 npm arborist 崩溃,
  // 清残留重装自愈;真失败(版本不存在等)两轮同样失败,结论不变
  log(`${name} 首轮失败,清 node_modules 重装`)
  rmSync(join(pkgDir, 'node_modules'), {recursive: true, force: true})
  return runNpmInstall({pkgDir, specs, log, name})
}

function runNpmInstall({pkgDir, specs, log, name}) {
  log(`::group::安装包依赖 ${name}: ${specs.join(' ')}`)
  // Windows 下 npm 是 npm.cmd,spawnSync 无 shell 跑 .cmd 即 EINVAL(CVE-2024-27980 防护),
  // 与 compat runCmd 同款经 shell 拼接;spec 可能含空白(复合 range "a || b"),逐个加引号
  // 防 cmd 把 || 当命令分隔符截断
  const isWin = process.platform === 'win32'
  const npmArgs = [...NPM_BASE_ARGS, ...specs.map(spec => isWin ? `"${spec}"` : spec)]
  const result = spawnSync(isWin ? ['npm.cmd', ...npmArgs].join(' ') : 'npm',
    isWin ? [] : npmArgs,
    {cwd: pkgDir, encoding: 'utf8', windowsHide: true, shell: isWin})
  log('::endgroup::')
  if (result.status !== 0) {
    log(`npm install 失败(${name}):${result.error ?? ''}`)
    log(result.stdout ?? '')
    log(result.stderr ?? '')
  }
  return {name, skipped: false, ok: result.status === 0, status: result.status}
}

function main() {
  const packagesDir = process.argv[2] ?? 'packages'
  let failed = 0
  for (const pkgDir of packageDirs(REPO_ROOT, packagesDir)) {
    const outcome = installExternals({pkgDir, log: line => console.log(line)})
    if (!outcome.skipped && !outcome.ok) failed++
  }
  process.exitCode = failed > 0 ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
