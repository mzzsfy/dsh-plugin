#!/usr/bin/env node
/**
 * DSH 插件发版脚本:版本校验 -> 测试 -> 发布 -> 回读验证 -> 打 tag。
 *
 * 用法:
 *   node scripts/publish.mjs <包名|all> [选项]
 * 选项:
 *   --bump patch|minor|major   本地版本已发布时自动升版本再发(默认同版本即 no-op)
 *   --skip-test                跳过目标包测试;all 模式下也跳过聚合门(显式豁免,高风险)
 *   --dry-run                  只打印将执行的动作,不发布、不改版本、不打 tag
 *
 * 规则:
 *   - 发布范围必须已提交:目标包存在修改/暂存/未跟踪文件即拒绝(含 dry-run);打包前复检
 *   - 流程:测试 -> 版本提交 -> 洁净复检 -> npm pack(留档 commit/文件清单/SHA-512 到
 *     release.json)-> npm publish 同一 tarball -> 回读 registry -> tag 打在打包时 commit
 *   - 本地版本低于线上:拒绝发布(防版本回退);版本无法比较(如 prerelease)时中止
 *   - <包名> 只执行该包测试;all 先运行全仓聚合测试,再逐包运行测试
 *   - 本地版本等于线上:按版本 tag 后的包目录提交数判定——无提交则 SKIP(无需发版);
 *     有提交则拒绝并要求显式 --bump(防止代码已变而版本未动被误判为无需更新);
 *     tag 缺失拒绝自动补打(维护者核对 registry tarball 后手工恢复,不得绑定任意 HEAD)
 *   - npm view 非 E404 失败直接中止(防把网络故障当未发布造成重复发布)
 *   - 推送(main 与 tag)由维护者执行
 */

import {spawnSync} from 'node:child_process'
import {readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const REGISTRY = 'https://registry.npmjs.org'
const BUMP_KINDS = ['patch', 'minor', 'major']

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCmd = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm')

/** 包清单以 packages/ 目录为准自动发现,与 dev-link.mjs 同构,不再手工维护名单 */
function discoverPackages() {
  return readdirSync(join(repoRoot, 'packages'), {withFileTypes: true})
    .filter((e) => e.isDirectory() && existsSync(join(repoRoot, 'packages', e.name, 'package.json')))
    .map((e) => e.name)
}

const PACKAGES = discoverPackages()

let exitCode = 0

function fail(message) {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms)
}

/**
 * 执行 npm 命令。Windows 下 npm 是 .cmd 脚本,Node 对其强制要求 shell
 * (无 shell 直接 EINVAL),故走 shell 字符串形式;参数全部来自内部白名单
 * (包名白名单/版本正则校验/registry 常量),无外部输入拼接。返回 { status, stdout, stderr }。
 * opts.stdio 默认 'pipe'(捕获输出供解析);传 'inherit' 时直连当前终端:
 * 发布步骤必须如此(npm 账号开 2FA 时,EOTP/WebAuthn 流程需要 TTY,按回车打开
 * 浏览器认证后自动继续),测试步骤也如此(失败明细实时可见,与聚合门同款)。
 */
function runNpm(args, cwd, opts = {}) {
  const display = ['npm', ...args].join(' ')
  console.log(`  $ ${display}`)
  const r = spawnSync([npmCmd(), ...args].join(' '), {
    cwd,
    encoding: 'utf8',
    shell: true,
    stdio: opts.stdio ?? 'pipe',
  })
  if (r.error) fail(`命令启动失败: ${display}(${r.error.message})`)
  return r
}

/** 执行 git 等可执行文件(非 .cmd,无需 shell);返回 { status, stdout, stderr } */
function run(file, args, cwd) {
  const display = [file, ...args].join(' ')
  console.log(`  $ ${display}`)
  const r = spawnSync(file, args, { cwd, encoding: 'utf8' })
  if (r.error) fail(`命令启动失败: ${display}(${r.error.message})`)
  return r
}

/** 解析参数;--bump 的值支持 --bump=patch 与 --bump patch 两种形式 */
function parseArgs(argv) {
  const opts = { bump: null, skipTest: false, dryRun: false, target: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--skip-test') opts.skipTest = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--bump') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) fail('--bump 需要一个值: patch|minor|major')
      opts.bump = value
      i += 1
    } else if (arg.startsWith('--bump=')) {
      opts.bump = arg.slice('--bump='.length)
    } else if (opts.target === null) opts.target = arg
    else fail(`多余参数: ${arg}`)
  }
  if (opts.target === null) fail('用法: node scripts/publish.mjs <包名|all> [--bump patch|minor|major] [--skip-test] [--dry-run]')
  if (opts.bump !== null && !BUMP_KINDS.includes(opts.bump)) fail(`--bump 仅支持 ${BUMP_KINDS.join('/')}`)
  opts.targets = opts.target === 'all' ? PACKAGES.slice() : [opts.target]
  for (const name of opts.targets) {
    if (!PACKAGES.includes(name)) fail(`未知包名: ${name}(可选: ${PACKAGES.join(', ')} 或 all)`)
  }
  return opts
}

/** 逐段数值比较;任一侧不是纯 x.y.z 形式返回 null(调用方必须中止,不得放行) */
function compareSemver(a, b) {
  const toInts = (v) => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null)
  const va = toInts(a)
  const vb = toInts(b)
  if (!va || !vb) return null
  const width = Math.max(va.length, vb.length)
  for (let i = 0; i < width; i += 1) {
    const diff = (va[i] || 0) - (vb[i] || 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

/** 同版本升级的预期结果版本 */
function nextVersion(version, kind) {
  const [major, minor, patch] = version.split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** 线上版本;未发布返回 null;非 E404 失败直接中止,防网络故障被当成未发布 */
function onlineVersion(name) {
  const r = runNpm(['view', name, 'version', '--registry', REGISTRY])
  if (r.status === 0) return r.stdout.trim()
  if (/E404/.test(r.stderr || '')) return null
  fail(`查询 ${name} 线上版本失败(非 E404,可能是网络问题),中止以避免误判:\n${r.stderr}`)
}

/** 版本 tag 名;npm 包名中的 scope 斜杠替换为连字符 */
function tagFor(pkgName, version) {
  return `${pkgName.replace('/', '-')}-v${version}`
}

function tagExists(tag) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: repoRoot, encoding: 'utf8' }).status === 0
}

/** 版本 tag 之后涉及包目录的提交数;tag 不存在或 git 失败返回 null(调用方走自愈分支) */
function commitsSinceTag(dirName, tag) {
  const r = spawnSync('git', ['log', `${tag}..HEAD`, '--oneline', '--', `packages/${dirName}`], { cwd: repoRoot, encoding: 'utf8' })
  if (r.status !== 0) return null
  return r.stdout.split('\n').filter(Boolean).length
}

/** 打版本 tag;已存在则跳过;commit 指定发布证据的确切源码提交(发布期间 HEAD 推进不改指向) */
function ensureTag(pkgName, version, opts, commit = undefined) {
  const tag = tagFor(pkgName, version)
  if (tagExists(tag)) {
    console.log(`OK    tag ${tag} 已存在`)
    return
  }
  if (opts.dryRun) {
    console.log(`  $ git tag ${tag}(dry-run 模拟)`)
    return
  }
  const target = commit ?? 'HEAD'
  const t = run('git', ['tag', tag, target], repoRoot)
  if (t.status !== 0) {
    console.error(`FAIL  tag ${tag} 打设失败(发布已成功,请手动执行 git tag ${tag} ${target}):\n${t.stderr}`)
    exitCode = 1
  } else {
    console.log(`OK    tag ${tag} 已打在 ${target.slice(0, 10)}(发布证据 commit),推送时一并 git push --tags`)
  }
}

/** 发布工件的临时目录(系统临时目录下按包名隔离),失败时保留供人工核对 */
function publishArtifactsDir(packageName) {
  const dir = join(tmpdir(), 'dsh-plugin-publish', tagSafe(packageName))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 临时目录路径段白名单:仅字母数字连字符下划线,防包名注入路径 */
function tagSafe(value) {
  return value.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** dirName 是 packages/ 下的目录名;npm 包名以目录内 package.json 为准(可为 scoped) */
function publishOne(dirName, opts) {
  console.log(`\n=== ${dirName} ===`)
  const pkgDir = join(repoRoot, 'packages', dirName)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const name = manifest.name
  if (!name) fail(`${dirName} 的 package.json 缺少 name 字段`)
  let version = manifest.version
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${name} 版本号 ${version} 不是 x.y.z 形式,不支持`)

  const online = onlineVersion(name)
  if (online !== null) {
    const order = compareSemver(version, online)
    if (order === null) fail(`无法比较版本 ${version} 与线上 ${online}(prerelease 或非法格式不受支持),中止`)
    if (order === 0 && opts.bump) {
      if (opts.dryRun) {
        console.log(`本地 ${version} 与线上相同,将按 ${opts.bump} 升级(预期 ${nextVersion(version, opts.bump)})`)
        version = nextVersion(version, opts.bump)
      } else {
        console.log(`本地 ${version} 与线上相同,按 ${opts.bump} 升级`)
        const r = runNpm(['version', opts.bump, '--no-git-tag-version'], pkgDir)
        if (r.status !== 0) fail(`npm version 失败:\n${r.stderr}`)
        version = r.stdout.trim().replace(/^v/, '')
        if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`npm version 输出异常: ${version}`)
      }
    } else if (order === 0) {
      const tag = tagFor(name, version)
      // 缺 tag 不自愈:tag 是发布源码身份声明,registry tarball 与哪个提交对应未证时
      // 补打会把任意 HEAD 绑上线上版本;恢复必须由维护者核对 tarball 后手工执行
      if (!tagExists(tag)) {
        fail(`本地 ${version} 与线上相同但 tag ${tag} 缺失,拒绝自动补打。请先核对 registry tarball 与可还原的历史提交,确认后再手工 git tag`)
      }
      const commits = commitsSinceTag(dirName, tag)
      if (commits === null) fail(`查询 tag ${tag} 后的变更失败,中止以避免误判`)
      if (commits === 0) {
        console.log(`SKIP  ${name}@${version} 线上已最新,tag ${tag} 后包目录无变更,无需发版`)
        return
      }
      fail(`本地 ${version} 与线上相同,但 tag ${tag} 后包目录有 ${commits} 个新提交未发布。请传 --bump patch|minor|major 后发布(feat 用 minor,fix/style 用 patch;完整映射见 DEVELOPMENT/structure-and-release.md 版本位规则)`)
    } else if (order < 0) {
      fail(`本地 ${version} 低于线上 ${online},拒绝发布(防版本回退)。请提升版本号(--bump 仅适用于本地等于线上的场景)`)
    } else if (opts.bump) {
      console.log(`忽略 --bump(本地 ${version} 已高于线上 ${online},直接发布本地版本)`)
    }
  } else {
    if (opts.bump) console.log(`忽略 --bump(${name} 未发布,首发直接用本地版本)`)
    console.log(`${name} 尚未发布,本地 ${version} 将为首个线上版本`)
  }

  // 发布范围洁净门:目标包内任何修改/暂存/未跟踪文件都改变打包内容,
  // tag 却只能指向一个提交——dirty 即拒绝(含 dry-run),先提交再发版
  const dirty = spawnSync('git', ['status', '--porcelain', '--', `packages/${dirName}`], { cwd: repoRoot, encoding: 'utf8' })
  if (dirty.status !== 0) fail(`查询 ${dirName} 工作区状态失败,中止`)
  if (dirty.stdout.trim() !== '') {
    fail(`${dirName} 发布范围存在未提交变更,拒绝发布(tag 须指向可还原的源码提交)。先提交或清理:\n${dirty.stdout.trim()}`)
  }

  const hasPackageTest = typeof manifest.scripts?.test === 'string' && manifest.scripts.test.trim().length > 0
  if (opts.dryRun) {
    console.log(`dry-run:将跳过测试与发布,动作序列如下`)
    if (!opts.skipTest && hasPackageTest) console.log(`  $ npm test(cwd: ${pkgDir})`)
    else if (opts.skipTest) console.log('  (显式 --skip-test:目标包测试跳过)')
    else if (opts.target !== 'all' && !hasPackageTest) console.log('  (缺少有效 test script:单包正式发布会拒绝)')
    else console.log('  (无测试步骤:--skip-test 或包未定义 test script)')
    console.log(`  $ npm pack --ignore-scripts + npm publish <tarball>(cwd: ${pkgDir}) -> ${name}@${version}`)
    ensureTag(name, version, opts)
    return
  }

  if (!opts.skipTest && opts.target !== 'all' && !hasPackageTest) {
    fail(`${name} 未定义有效 test script,单包发布拒绝无目标测试发版`)
  }
  if (opts.skipTest) {
    console.log('SKIP  测试(--skip-test)')
  } else if (hasPackageTest) {
    const r = runNpm(['test'], pkgDir, { stdio: 'inherit' })
    if (r.status !== 0) fail(`${name} 测试未通过,中止发布`)
  } else {
    console.log('SKIP  测试(包未定义 test script)')
  }

  // 版本号变更入库后 tag 才指向该版本的完整源码状态,tag 后无提交的判定才能成立;
  // manifest 无变更(如首发时版本已提交)则跳过。提交失败不继续发布,仅提示手动收尾
  const manifestDirty = spawnSync('git', ['status', '--porcelain', '--', `packages/${dirName}/package.json`], { cwd: repoRoot, encoding: 'utf8' })
  if (manifestDirty.status === 0 && manifestDirty.stdout.trim() !== '') {
    const c = run('git', ['add', `packages/${dirName}/package.json`], repoRoot)
    const cm = c.status === 0 ? run('git', ['commit', '-m', `chore(${dirName}): 发版版本号 ${version}`], repoRoot) : { status: 1 }
    if (cm.status !== 0) {
      fail(`版本号提交失败,中止发布(请手动 git commit packages/${dirName}/package.json 后重跑)`)
    }
  }
  // 打包前洁净复检:--bump 改版本只动 manifest,版本提交后不得再有其他变更——
  // tag 只能指向一个提交,打包内容必须可还原到它
  const recheck = spawnSync('git', ['status', '--porcelain', '--', `packages/${dirName}`], { cwd: repoRoot, encoding: 'utf8' })
  if (recheck.status === 0 && recheck.stdout.trim() !== '') {
    fail(`${dirName} 打包前发布范围仍有未提交变更,拒绝发布:\n${recheck.stdout.trim()}`)
  }

  // 打包同一份 tarball 再发布:记录 commit、文件清单与 SHA-512 integrity 到临时目录
  // release.json,发布内容与源码提交的绑定证据落盘(registry 同版本回读不能替代内容相等)
  const artifactsDir = publishArtifactsDir(name)
  const pack = runNpm(['pack', '--ignore-scripts', '--pack-destination', artifactsDir], pkgDir)
  if (pack.status !== 0) fail(`npm pack 失败,中止发布(打包内容不可证):\n${pack.stderr}`)
  const tarball = join(artifactsDir, `${name.replace('/', '-')}-${version}.tgz`)
  if (!existsSync(tarball)) fail(`npm pack 产物缺失: ${tarball}`)
  const integrity = spawnSync(process.execPath, ['-e', `
    const {createHash} = require('node:crypto');
    const {readFileSync} = require('node:fs');
    const h = createHash('sha512');
    h.update(readFileSync(process.argv[1]));
    console.log('sha512-' + h.digest('base64'));
  `, tarball], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
  if (integrity.status !== 0 || !integrity.stdout.trim()) fail(`tarball integrity 计算失败:\n${integrity.stderr}`)
  const commitAtPack = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
  const fileList = spawnSync('tar', ['-tzf', tarball], { cwd: repoRoot, encoding: 'utf8' })
  const record = {
    package: name,
    version,
    commit: commitAtPack,
    tarball,
    integrity: integrity.stdout.trim(),
    files: fileList.status === 0 ? fileList.stdout.split('\n').filter(Boolean) : null,
    recordedAt: new Date().toISOString(),
  }
  const recordPath = join(artifactsDir, 'release.json')
  writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf8')
  console.log(`OK    打包证据已落盘: ${recordPath}(commit ${commitAtPack.slice(0, 10)}, integrity ${record.integrity.slice(0, 20)}...)`)

  // 发布步骤交互式执行:2FA 账号在终端按回车打开浏览器认证后自动继续。
  // 成败判据 = npm publish 退出码("+ 包@版本"输出由 npm 自身保证);registry CDN
  // 传播延迟不影响成败,回读 view 仅作信息展示,不做闸门。
  // 发布这同一份 tarball(非重新 pack):内容与 release.json 记录严格一致
  const pub = runNpm(['publish', tarball, '--registry', REGISTRY], pkgDir, { stdio: 'inherit' })
  if (pub.status !== 0) fail('发布失败(npm publish 非零退出,交互输出见上;浏览器认证中断可直接重跑本脚本自愈)')

  const readback = runNpm(['view', name, 'version', '--registry', REGISTRY])
  if (readback.status === 0 && readback.stdout.trim() === version) console.log(`OK    ${name}@${version} 已上线`)
  else console.log(`OK    ${name}@${version} 发布成功(CDN 传播中,registry 稍后可见)`)

  ensureTag(name, version, opts, commitAtPack)
}

const opts = parseArgs(process.argv.slice(2))
if (opts.dryRun) console.log('dry-run 模式:不会发布、不会改版本、不会打 tag')

/** 单包目标只执行包测试;all 目标先执行全仓聚合测试,之后逐包测试。 */
function aggregateGate() {
  if (opts.dryRun) {
    if (opts.skipTest) console.log('dry-run:--skip-test 将跳过全仓聚合门和目标包测试')
    else console.log(opts.target === 'all'
      ? 'dry-run:全量发布将先运行 node scripts/aggregate-tests.mjs --rounds 1 聚合门,再逐包测试'
      : 'dry-run:单包发布只运行目标包测试,不运行全仓聚合门')
    return
  }
  if (opts.skipTest) {
    console.log('WARN  --skip-test:测试已显式跳过,发布未经测试验证')
    return
  }
  if (opts.target !== 'all') {
    console.log('单包发布:全仓聚合门不运行,目标包测试在发版前执行')
    return
  }
  console.log('  $ node scripts/aggregate-tests.mjs --rounds 1(全量发布门引用 CI 同源单测)')
  const gate = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'aggregate-tests.mjs'), '--rounds', '1'], { cwd: repoRoot, stdio: 'inherit', windowsHide: true })
  if (gate.error) fail(`聚合测试启动失败: ${gate.error.message}`)
  if (gate.status !== 0) fail(`聚合测试未通过(exit ${gate.status}),中止发布;明细见上方输出`)
  const compatVersions = existsSync(join(repoRoot, '.compat'))
    ? readdirSync(join(repoRoot, '.compat')).filter((v) => /^\d/.test(v) && existsSync(join(repoRoot, '.compat', v, 'result.json')))
    : []
  for (const version of compatVersions) {
    try {
      const result = JSON.parse(readFileSync(join(repoRoot, '.compat', version, 'result.json'), 'utf8'))
      console.log(`INFO  最近 compat 结论: ${version} ${result.ok === true ? 'PASS' : 'FAIL'}(mode=${result.mode ?? '?'})`)
    } catch { /* 结果文件损坏不阻塞发布,聚合门才是闸门 */ }
  }
  if (compatVersions.length === 0) console.log('INFO  无 compat 结论留档(聚合门已过;兼容面未覆盖)')
}

aggregateGate()
for (const name of opts.targets) publishOne(name, opts)
console.log('\n完成')
process.exitCode = exitCode
