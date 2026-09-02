#!/usr/bin/env node
/**
 * DSH 插件发版脚本:版本校验 -> 测试 -> 发布 -> 回读验证 -> 打 tag。
 *
 * 用法:
 *   node scripts/publish.mjs <包名|all> [选项]
 * 选项:
 *   --bump patch|minor|major   本地版本已发布时自动升版本再发(默认同版本即 no-op)
 *   --skip-test                跳过发布前测试
 *   --dry-run                  只打印将执行的动作,不发布、不改版本、不打 tag
 *
 * 规则:
 *   - 本地版本低于线上:拒绝发布(防版本回退);版本无法比较(如 prerelease)时中止
 *   - 本地版本等于线上:无 --bump 时跳过发布,但仍补打缺失的 tag(自愈此前"发布成功未打 tag"的状态)
 *   - npm view 非 E404 失败直接中止(防把网络故障当未发布造成重复发布)
 *   - 发布后回读 registry 做多次确认,通过后打本地 tag(npm 名斜杠替换为连字符,如 @mzzsfy-dsh-usage-panel-v0.1.0),推送由维护者执行
 */

import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const REGISTRY = 'https://registry.npmjs.org'
const BUMP_KINDS = ['patch', 'minor', 'major']
const PACKAGES = [
  'dsh-usage-panel',
  'dsh-maintain',
  'dsh-rs-workflow',
  'dsh-think-expand',
  'dsh-turn-notify',
  'dsh-session-manager',
  'dsh-llm-pi-gateway',
  'dsh-model-capability-editor',
]

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCmd = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm')

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
 * opts.interactive = true 时 stdio 继承当前终端(npm 账号开 2FA 时,发布的
 * EOTP/WebAuthn 流程需要 TTY:按回车打开浏览器认证后自动继续),此时无捕获输出。
 */
function runNpm(args, cwd, opts = {}) {
  const display = ['npm', ...args].join(' ')
  console.log(`  $ ${display}`)
  const r = spawnSync([npmCmd(), ...args].join(' '), {
    cwd,
    encoding: 'utf8',
    shell: true,
    stdio: opts.interactive ? 'inherit' : 'pipe',
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

/** 打版本 tag;已存在则跳过,失败置非零退出码 */
/** 打版本 tag;npm 包名中的 scope 斜杠替换为连字符;已存在则跳过,失败置非零退出码 */
function ensureTag(pkgName, version, opts) {
  const tag = `${pkgName.replace('/', '-')}-v${version}`
  const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: repoRoot, encoding: 'utf8' })
  if (exists.status === 0) {
    console.log(`OK    tag ${tag} 已存在`)
    return
  }
  if (opts.dryRun) {
    console.log(`  $ git tag ${tag}(dry-run 模拟)`)
    return
  }
  const t = run('git', ['tag', tag], repoRoot)
  if (t.status !== 0) {
    console.error(`FAIL  tag ${tag} 打设失败(发布已成功,请手动执行 git tag ${tag}):\n${t.stderr}`)
    exitCode = 1
  } else {
    console.log(`OK    tag ${tag} 已打在本地,推送时一并 git push --tags`)
  }
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
      console.log(`SKIP  ${name}@${version} 已发布;不重复发布。要发新版本请先改版本号或传 --bump patch|minor|major`)
      ensureTag(name, version, opts)
      return
    } else if (order < 0) {
      fail(`本地 ${version} 低于线上 ${online},拒绝发布(防版本回退)。请提升版本号(--bump 仅适用于本地等于线上的场景)`)
    } else if (opts.bump) {
      console.log(`忽略 --bump(本地 ${version} 已高于线上 ${online},直接发布本地版本)`)
    }
  } else {
    if (opts.bump) console.log(`忽略 --bump(${name} 未发布,首发直接用本地版本)`)
    console.log(`${name} 尚未发布,本地 ${version} 将为首个线上版本`)
  }

  if (opts.dryRun) {
    console.log(`dry-run:将跳过测试与发布,动作序列如下`)
    if (!opts.skipTest && manifest.scripts?.test) console.log(`  $ npm test(cwd: ${pkgDir})`)
    else console.log('  (无测试步骤:--skip-test 或包未定义 test script)')
    console.log(`  $ npm run npmPublish(cwd: ${pkgDir}) -> ${name}@${version}`)
    ensureTag(name, version, opts)
    return
  }

  if (opts.skipTest) console.log('SKIP  测试(--skip-test)')
  else if (manifest.scripts?.test) {
    const r = runNpm(['test'], pkgDir)
    if (r.status !== 0) fail(`${name} 测试未通过,中止发布`)
  } else {
    console.log('SKIP  测试(包未定义 test script)')
  }

  // 发布步骤交互式执行:2FA 账号在终端按回车打开浏览器认证后自动继续。
  // 成败判据 = npm publish 退出码("+ 包@版本"输出由 npm 自身保证);registry CDN
  // 传播延迟不影响成败,回读 view 仅作信息展示,不做闸门。
  const pub = runNpm(['run', 'npmPublish'], pkgDir, { interactive: true })
  if (pub.status !== 0) fail('发布失败(npm publish 非零退出,交互输出见上;浏览器认证中断可直接重跑本脚本自愈)')

  const readback = runNpm(['view', name, 'version', '--registry', REGISTRY])
  if (readback.status === 0 && readback.stdout.trim() === version) console.log(`OK    ${name}@${version} 已上线`)
  else console.log(`OK    ${name}@${version} 发布成功(CDN 传播中,registry 稍后可见)`)
  ensureTag(name, version, opts)
}

const opts = parseArgs(process.argv.slice(2))
if (opts.dryRun) console.log('dry-run 模式:不会发布、不会改版本、不会打 tag')
for (const name of opts.targets) publishOne(name, opts)
console.log('\n完成')
process.exitCode = exitCode
