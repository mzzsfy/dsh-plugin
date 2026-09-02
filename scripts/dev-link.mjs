#!/usr/bin/env node
/**
 * 开发链接:把仓库包以 NTFS junction 挂进 dsh profile 的 node_modules,
 * profile 内跑的是仓库工作副本 —— 改代码重启 dsh 即生效,无需发版。
 *
 * 用法:
 *   node scripts/dev-link.mjs <包名|all>            挂链接(包名 = packages/ 下目录名)
 *   node scripts/dev-link.mjs <包名|all> --unlink  卸链接,恢复 registry 安装版
 *
 * 原理与约束:
 *   - profile 依赖行保持 semver(线上版本),junction 只覆盖 node_modules 物理
 *     目录;dsh bundle 加载走 node_modules realpath,天然读到工作副本。
 *   - junction 会被 pnpm install 抹掉:每次在 profile 里跑过 install/add 之后
 *     需要重新执行本脚本。
 *   - link 期间 dsh-plugin list 显示的是依赖行 semver,不是工作副本版本。
 */

import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profileRoot = join(process.env.USERPROFILE, '.dsh', 'profiles', 'web')
const PACKAGES = [
  'dsh-rs-workflow',
  'dsh-usage-panel',
  'dsh-usage-stats',
  'dsh-maintain',
  'dsh-think-expand',
  'dsh-turn-notify',
  'dsh-session-manager',
  'dsh-llm-pi-gateway',
  'dsh-model-capability-editor',
]

const args = process.argv.slice(2)
const unlink = args.includes('--unlink')
const target = args.find((a) => !a.startsWith('--'))
if (!target) {
  console.error('用法: node scripts/dev-link.mjs <包名|all> [--unlink]')
  process.exit(1)
}
const names = target === 'all' ? PACKAGES : [target]
for (const name of names) {
  if (!PACKAGES.includes(name)) {
    console.error(`未知包名: ${name}(可选: ${PACKAGES.join(', ')})`)
    process.exit(1)
  }
}

if (!existsSync(join(profileRoot, 'package.json'))) {
  console.error(`profile 不存在: ${profileRoot}`)
  process.exit(1)
}

for (const name of names) {
  const linkPath = join(profileRoot, 'node_modules', '@mzzsfy', name)
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
console.log('\n提醒: profile 内执行过 pnpm install / dsh plugin add 后,链接会被覆盖,需重跑本脚本。')
