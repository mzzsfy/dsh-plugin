#!/usr/bin/env node
/**
 * 发版前版本枚举自检:关注版本(dist-tags 的 alpha/next/latest)与
 * `dsh-shared-terminal` 的精确枚举逐位置求差,机械补齐后跑 L1。
 *
 * 用法:
 *   node scripts/compat/enum-check.mjs [包名] [--versions a,b] [--check] [--repo <目录>]
 *
 * 退出码:
 *   0  枚举已覆盖关注版本;或补齐后 L1 通过
 *   2  --check 且存在 missing(只报告,不改文件)
 *   3  补齐后 L1 失败(保留改动供人工核对)
 *   1  参数/网络/锚点/无枚举登记等错误(不改文件或按提示中止)
 *
 * 纪律:插入一律基于固定锚点字符串;锚点缺失、格式漂移、版本乱序都报错,
 * 禁止静默猜测。版本比较复用 dsh-maintain 的 semver 实现。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver, parseSemver, fetchDistTags } from '../../packages/dsh-maintain/src/core.mjs'

export const DEFAULT_PACKAGE = 'dsh-shared-terminal'

const HOST_PACKAGE = '@deepseek-ai/dsh'
const REGISTRY_BASE = 'https://registry.npmjs.org'
const CHANNELS = ['alpha', 'next', 'latest']
const DIST_TAGS_TIMEOUT_MS = 30 * 1000
// 两代写模型分界:0.2.1-rc.2 起 Controller 移除 write,夹具用 attachEra
const ATTACH_ERA_FLOOR = '0.2.1-rc.2'
// README「dshReleases」段的语义起点:该段只列 0.2.1-rc.2 起的白名单;与夹具代际同值但语义独立
const RELEASES_FLOOR = '0.2.1-rc.2'
const L1_TEST_TIMEOUT_MS = 30 * 60 * 1000
const L1_SMOKE_TIMEOUT_MS = 10 * 60 * 1000

const SCRIPT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export class EnumCheckError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

// 各枚举位置的锚点与插入样式:新增/调整位置必须同步这里与包内文档
const ENUMERATIONS = {
  [DEFAULT_PACKAGE]: {
    locations: [
      {
        id: 'manifest.dshReleases',
        file: 'package.json',
        kind: 'object-block',
        label: 'package.json dsh.compatibility.dshReleases',
        openAnchor: '"dshReleases": {',
        closeTrim: '}',
        rowPattern: /^(\s*)"([^"]+)":\s*"(unknown|compatible|incompatible)"(,?)\s*$/,
        statusForNew: 'compatible',
      },
      {
        id: 'src.SUPPORTED_VERSIONS',
        file: 'src/index.js',
        kind: 'inline-list',
        label: 'src/index.js SUPPORTED_VERSIONS',
        openAnchor: 'export const SUPPORTED_VERSIONS = Object.freeze([',
        closeAnchor: '])',
        scan: (text) => [...text.matchAll(/'([^']+)'/g)].map((match) => ({ version: match[1], start: match.index, end: match.index + match[0].length })),
        render: (version) => `'${version}'`,
        fallbackSeparator: ', ',
      },
      {
        id: 'test.fixture',
        file: 'test/plugin.test.mjs',
        kind: 'fixture-rows',
        label: 'test/plugin.test.mjs 逐版本夹具',
        openAnchor: 'for (const [version, controller] of [',
        closeTrim: ']) {',
        rowPattern: /^(\s*)\['([^']+)',\s*(legacy|attachEra)\],?\s*$/,
      },
      {
        id: 'readme.allowlist',
        file: 'README.md',
        kind: 'inline-list',
        label: 'README.md 功能面白名单',
        openAnchor: '功能面仅接受实测版本 DSH **',
        closeAnchor: '**（精确允许表',
        scan: scanBareVersions,
        render: (version) => version,
        fallbackSeparator: '、',
      },
      {
        id: 'readme.dshReleases',
        file: 'README.md',
        kind: 'inline-list',
        label: 'README.md dshReleases 段',
        openAnchor: '版本白名单已纳入 ',
        closeAnchor: '(dshReleases `compatible`)',
        scan: scanBacktickVersions,
        render: (version) => `\`${version}\``,
        fallbackSeparator: '、',
        domainFloor: RELEASES_FLOOR,
      },
      {
        id: 'compat.allowlist',
        file: '兼容性测试.md',
        kind: 'inline-list',
        label: '兼容性测试.md 精确允许表',
        openAnchor: '本包**精确允许表**:仅 ',
        closeAnchor: ' 支持功能面',
        scan: scanBacktickVersions,
        render: (version) => `\`${version}\``,
        fallbackSeparator: '、',
      },
      {
        id: 'compat.bound',
        file: '兼容性测试.md',
        kind: 'upper-bound',
        label: '兼容性测试.md D01 上限',
        openAnchor: '(上限 `',
        closeAnchor: '`;alpha 通道',
      },
    ],
  },
}

function scanBareVersions(text) {
  return [...text.matchAll(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g)].map((match) => ({ version: match[0], start: match.index, end: match.index + match[0].length }))
}

function scanBacktickVersions(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => ({ version: match[1], start: match.index, end: match.index + match[0].length }))
}

export function hasEnumeration(packageName) {
  return Object.prototype.hasOwnProperty.call(ENUMERATIONS, packageName)
}

function configFor(packageName) {
  if (!hasEnumeration(packageName)) throw new EnumCheckError(`包 ${packageName} 没有版本枚举登记,不适用本检查`)
  return ENUMERATIONS[packageName]
}

function packageDir(repoRoot, packageName) {
  return join(repoRoot, 'packages', packageName)
}

function textOf(repoRoot, packageName, relative, cache) {
  if (!cache.has(relative)) {
    const file = join(packageDir(repoRoot, packageName), relative)
    if (!existsSync(file)) throw new EnumCheckError(`缺文件 ${relative},位置已变`)
    cache.set(relative, readFileSync(file, 'utf8'))
  }
  return cache.get(relative)
}

function sortVersions(versions) {
  return [...versions].sort((left, right) => compareSemver(left, right))
}

function assertVersions(versions, label) {
  for (const version of versions) {
    if (!parseSemver(version)) throw new EnumCheckError(`${label}:版本号非法 ${JSON.stringify(version)};位置已变,拒绝自动修改`)
  }
  for (let index = 1; index < versions.length; index += 1) {
    if (compareSemver(versions[index - 1], versions[index]) >= 0) {
      throw new EnumCheckError(`${label}:枚举顺序非严格升序或重复(${versions[index - 1]} / ${versions[index]});位置已变,拒绝自动修改`)
    }
  }
}

function inDomain(location, version) {
  return location.domainFloor === undefined || compareSemver(version, location.domainFloor) >= 0
}

/** 块状枚举(对象条目、夹具行):锚点行 + 连续条目 + 收尾行 */
function locateBlock(lines, location) {
  const hits = []
  lines.forEach((line, index) => {
    if (line.trim() === location.openAnchor) hits.push(index)
  })
  if (hits.length !== 1) {
    throw new EnumCheckError(`${location.file}:锚点 ${JSON.stringify(location.openAnchor)} 命中 ${hits.length} 处(应为 1);位置已变,拒绝自动修改`)
  }
  const open = hits[0]
  const rows = []
  let close = -1
  for (let index = open + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === location.closeTrim) {
      close = index
      break
    }
    const match = location.rowPattern.exec(lines[index])
    if (!match) {
      throw new EnumCheckError(`${location.file}:第 ${index + 1} 行不在枚举格式内:${JSON.stringify(lines[index])};位置已变,拒绝自动修改`)
    }
    rows.push({ version: match[2], indent: match[1], status: match[3], line: index })
  }
  if (close < 0) {
    throw new EnumCheckError(`${location.file}:枚举块缺收尾 ${JSON.stringify(location.closeTrim)};位置已变,拒绝自动修改`)
  }
  assertVersions(rows.map((row) => row.version), location.label)
  return { open, close, rows }
}

/** 行内枚举:同一行内 前缀 + 版本序列 + 后缀 */
function locateSegment(text, location) {
  const lines = text.split('\n')
  const hits = []
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const at = line.indexOf(location.openAnchor)
    if (at >= 0) {
      const start = at + location.openAnchor.length
      const end = line.indexOf(location.closeAnchor, start)
      if (end >= 0) hits.push({ start: offset + start, end: offset + end, line: index + 1 })
    }
    offset += line.length + 1
  }
  if (hits.length !== 1) {
    const where = hits.length === 0 ? '' : `(命中行 ${hits.map((hit) => hit.line).join(',')})`
    throw new EnumCheckError(`${location.file}:锚点 ${JSON.stringify(location.openAnchor)}…${JSON.stringify(location.closeAnchor)} 命中 ${hits.length} 处(应为 1)${where};位置已变,拒绝自动修改`)
  }
  return hits[0]
}

function segmentItems(text, location) {
  const segment = locateSegment(text, location)
  const items = location.scan(text.slice(segment.start, segment.end))
  if (items.length === 0) throw new EnumCheckError(`${location.file}:${location.label} 未解析到任何版本;位置已变,拒绝自动修改`)
  assertVersions(items.map((item) => item.version), location.label)
  return { segment, items }
}

function readVersions(text, location) {
  if (location.kind === 'inline-list') return segmentItems(text, location).items.map((item) => item.version)
  if (location.kind === 'upper-bound') {
    const segment = locateSegment(text, location)
    return [text.slice(segment.start, segment.end).trim()]
  }
  return locateBlock(text.split('\n'), location).rows.map((row) => row.version)
}

function insertLines(lines, rows, open, version, render) {
  const sorted = rows.slice().sort((left, right) => compareSemver(left.version, right.version))
  const indent = sorted[0]?.indent ?? `${lines[open].match(/^\s*/)[0]}  `
  const next = sorted.find((row) => compareSemver(row.version, version) > 0)
  const line = render(version, indent)
  if (next) lines.splice(next.line, 0, line)
  else if (sorted.length > 0) lines.splice(sorted[sorted.length - 1].line + 1, 0, line)
  else lines.splice(open + 1, 0, line)
}

function applyObjectBlock(text, location, missing) {
  const lines = text.split('\n')
  for (const version of missing) {
    const block = locateBlock(lines, location)
    const existing = block.rows.find((row) => row.version === version)
    // 已登记但未实测:就地升级状态,不重复插入键
    if (existing) {
      if (existing.status === 'incompatible') {
        throw new EnumCheckError(`${location.file}:${version} 已登记 incompatible,拒绝自动改为 ${location.statusForNew};请人工确认该版本功能面`)
      }
      lines[existing.line] = `${existing.indent}"${version}": "${location.statusForNew}",`
      continue
    }
    insertLines(lines, block.rows, block.open, version, (value, indent) => `${indent}"${value}": "${location.statusForNew}",`)
  }
  const block = locateBlock(lines, location)
  block.rows.forEach((row, index) => {
    const comma = index === block.rows.length - 1 ? '' : ','
    lines[row.line] = `${row.indent}"${row.version}": "${row.status}"${comma}`
  })
  return lines.join('\n')
}

function applyFixtureRows(text, location, missing) {
  const lines = text.split('\n')
  for (const version of missing) {
    const block = locateBlock(lines, location)
    const era = compareSemver(version, ATTACH_ERA_FLOOR) >= 0 ? 'attachEra' : 'legacy'
    insertLines(lines, block.rows, block.open, version, (value, indent) => `${indent}['${value}', ${era}],`)
  }
  const block = locateBlock(lines, location)
  for (const row of block.rows) lines[row.line] = `${row.indent}['${row.version}', ${row.status}],`
  return lines.join('\n')
}

function applyInlineList(text, location, missing) {
  for (const version of missing) {
    const { segment, items } = segmentItems(text, location)
    if (items.some((item) => item.version === version)) continue
    const rendered = location.render(version)
    const next = items.find((item) => compareSemver(item.version, version) > 0)
    const prev = [...items].reverse().find((item) => compareSemver(item.version, version) < 0)
    if (next && prev) {
      // 插在两个版本之间:既有分隔符(可能是「与」)留在新版本之后,左侧统一用常规分隔符
      const at = segment.start + prev.end
      text = text.slice(0, at) + location.fallbackSeparator + rendered + text.slice(at)
    } else if (next) {
      const at = segment.start + next.start
      text = text.slice(0, at) + rendered + location.fallbackSeparator + text.slice(at)
    } else if (items.length > 0) {
      const at = segment.start + items[items.length - 1].end
      text = text.slice(0, at) + location.fallbackSeparator + rendered + text.slice(at)
    } else {
      text = text.slice(0, segment.start) + rendered + text.slice(segment.start)
    }
  }
  return text
}

/** D01 上限只随功能面最大版本前进,不构成独立版本集合 */
function applyUpperBound(text, location, maxVersion) {
  const segment = locateSegment(text, location)
  const current = text.slice(segment.start, segment.end).trim()
  if (!parseSemver(current)) throw new EnumCheckError(`${location.file}:上限版本无法解析:${JSON.stringify(current)};位置已变,拒绝自动修改`)
  if (compareSemver(maxVersion, current) <= 0) return text
  return text.slice(0, segment.start) + maxVersion + text.slice(segment.end)
}

function applyLocation(text, location, missing) {
  if (location.kind === 'object-block') return applyObjectBlock(text, location, missing)
  if (location.kind === 'fixture-rows') return applyFixtureRows(text, location, missing)
  if (location.kind === 'inline-list') return applyInlineList(text, location, missing)
  throw new EnumCheckError(`未知枚举形态: ${location.kind}`)
}

export function readEnumerations(repoRoot, packageName) {
  const config = configFor(packageName)
  const cache = new Map()
  return config.locations.map((location) => {
    const text = textOf(repoRoot, packageName, location.file, cache)
    return {
      id: location.id,
      file: location.file,
      location,
      versions: readVersions(text, location),
      statuses: location.kind === 'object-block'
        ? new Map(locateBlock(text.split('\n'), location).rows.map((row) => [row.version, row.status]))
        : null,
    }
  })
}

/**
 * 对象块按状态判定纳表:compatible 才算已纳表,unknown 待升级,incompatible 交人工。
 * 其余位置按版本集合判定;missing 为各位置差集的并集。
 */
function entryHasVersion(entry, version) {
  if (entry.location.kind !== 'object-block') return entry.versions.includes(version)
  const status = entry.statuses.get(version)
  if (status === 'incompatible') {
    throw new EnumCheckError(`${entry.file}:${version} 已登记 incompatible,拒绝自动补齐;请人工确认该版本功能面`)
  }
  return status === 'compatible'
}

export function computeMissing(hostVersions, enumerations) {
  const missing = new Set()
  for (const entry of enumerations) {
    if (entry.location.kind === 'upper-bound') continue
    for (const version of hostVersions) {
      if (inDomain(entry.location, version) && !entryHasVersion(entry, version)) missing.add(version)
    }
  }
  return sortVersions([...missing])
}

export function applyInsertions(repoRoot, packageName, hostVersions) {
  const config = configFor(packageName)
  const versions = normalizeVersionList(hostVersions)
  const cache = new Map()
  const changed = new Set()
  const missing = new Set()
  const inserted = new Set()
  const entries = readEnumerations(repoRoot, packageName)
  const known = new Set(versions)
  for (const entry of entries) {
    if (entry.location.kind === 'upper-bound') continue
    for (const version of entry.versions) known.add(version)
  }
  const maxVersion = sortVersions([...known]).at(-1)

  for (const entry of entries) {
    const location = entry.location
    const text = textOf(repoRoot, packageName, location.file, cache)
    let next = text
    if (location.kind === 'upper-bound') {
      next = applyUpperBound(text, location, maxVersion)
    } else {
      const missingHere = versions.filter((version) => inDomain(location, version) && !entryHasVersion(entry, version))
      if (missingHere.length > 0) {
        next = applyLocation(text, location, missingHere)
        for (const version of missingHere) {
          missing.add(version)
          inserted.add(version)
        }
      }
    }
    if (next !== text) {
      cache.set(location.file, next)
      changed.add(location.file)
    }
  }

  for (const file of changed) {
    writeFileSync(join(packageDir(repoRoot, packageName), file), cache.get(file), 'utf8')
  }

  const changedFiles = []
  for (const location of config.locations) {
    const relative = posix.join('packages', packageName, location.file)
    if (changed.has(location.file) && !changedFiles.includes(relative)) changedFiles.push(relative)
  }
  return {
    missing: sortVersions([...missing]),
    changedFiles,
    inserted: sortVersions([...inserted]),
  }
}

export async function resolveHostVersions({ fetchImpl = fetch, registryBase = REGISTRY_BASE, timeoutMs = DIST_TAGS_TIMEOUT_MS } = {}) {
  let tags
  try {
    tags = await fetchDistTags({ registryBase, fetchImpl, timeoutMs })
  } catch (error) {
    throw new EnumCheckError(`拉取 ${HOST_PACKAGE} dist-tags 失败,拒绝猜测关注版本: ${error.message}`)
  }
  const versions = []
  for (const channel of CHANNELS) {
    const version = tags[channel]
    if (typeof version !== 'string') throw new EnumCheckError(`dist-tags 缺渠道 ${channel},拒绝猜测关注版本`)
    if (!parseSemver(version)) throw new EnumCheckError(`dist-tags 渠道 ${channel} 版本非法: ${version}`)
    versions.push(version)
  }
  return sortVersions([...new Set(versions)])
}

function normalizeVersionList(list) {
  const versions = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))]
  if (versions.length === 0) throw new EnumCheckError('版本清单为空')
  assertVersions(sortVersions(versions), '版本清单')
  return sortVersions(versions)
}

export function normalizeVersions(raw) {
  const list = String(raw).split(',')
  if (!list.some((item) => item.trim() !== '')) throw new EnumCheckError('--versions 未给出有效版本')
  return normalizeVersionList(list)
}

export function runL1(repoRoot, pkgDir) {
  const commands = [
    { label: 'node --test "test/*.test.mjs"', args: ['--test', 'test/*.test.mjs'], cwd: pkgDir, timeout: L1_TEST_TIMEOUT_MS },
    { label: 'node scripts/smoke-load.mjs', args: [join(repoRoot, 'scripts', 'smoke-load.mjs')], cwd: repoRoot, timeout: L1_SMOKE_TIMEOUT_MS },
  ]
  const failures = []
  // 在 node:test 进程内被调用时,子进程会继承 NODE_TEST_CONTEXT 而被判成递归运行并跳过文件;
  // 剥掉该变量,L1 无论从 CLI 还是测试内触发都真正执行
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  for (const command of commands) {
    const result = spawnSync(process.execPath, command.args, {
      cwd: command.cwd,
      env,
      encoding: 'utf8',
      timeout: command.timeout,
      windowsHide: true,
    })
    if (result.status !== 0) {
      failures.push({
        label: command.label,
        status: result.status,
        signal: result.signal,
        output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
      })
    }
  }
  return { ok: failures.length === 0, failures }
}

export function parseArgs(argv) {
  const opts = { packageName: null, versions: null, check: false, repo: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') opts.check = true
    else if (arg === '--versions') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new EnumCheckError('--versions 需要逗号分隔的版本清单')
      opts.versions = value
      index += 1
    } else if (arg.startsWith('--versions=')) opts.versions = arg.slice('--versions='.length)
    else if (arg === '--repo') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new EnumCheckError('--repo 需要目录')
      opts.repo = value
      index += 1
    } else if (arg.startsWith('--repo=')) opts.repo = arg.slice('--repo='.length)
    else if (arg.startsWith('--')) throw new EnumCheckError(`未知参数: ${arg}`)
    else if (opts.packageName === null) opts.packageName = arg
    else throw new EnumCheckError(`多余参数: ${arg}`)
  }
  opts.packageName ??= DEFAULT_PACKAGE
  return opts
}

async function main(argv) {
  const opts = parseArgs(argv)
  if (!hasEnumeration(opts.packageName)) throw new EnumCheckError(`包 ${opts.packageName} 没有版本枚举登记,不适用本检查`)
  const repoRoot = opts.repo === null ? SCRIPT_REPO_ROOT : resolve(opts.repo)
  const pkgDir = packageDir(repoRoot, opts.packageName)
  if (!existsSync(join(pkgDir, 'package.json'))) throw new EnumCheckError(`找不到包目录: ${pkgDir}`)
  const hostVersions = opts.versions === null ? await resolveHostVersions() : normalizeVersions(opts.versions)
  const enumerations = readEnumerations(repoRoot, opts.packageName)
  const missing = computeMissing(hostVersions, enumerations)

  if (opts.check) {
    console.log(JSON.stringify({ missing, changedFiles: [], inserted: [] }, null, 2))
    if (missing.length > 0) {
      process.stderr.write(`MISS  ${opts.packageName} 缺宿主版本: ${missing.join(', ')}\n`)
      process.exitCode = 2
    }
    return
  }
  if (missing.length === 0) {
    console.log(JSON.stringify({ missing: [], changedFiles: [], inserted: [] }, null, 2))
    return
  }

  const result = applyInsertions(repoRoot, opts.packageName, hostVersions)
  // 补齐后复检:半应用(例如状态未升级)必须在跑 L1 前暴露,不能靠第二次运行"看起来幂等"
  const remaining = computeMissing(hostVersions, readEnumerations(repoRoot, opts.packageName))
  if (remaining.length > 0) {
    process.stderr.write(`FAIL  补齐后仍有未纳表版本: ${remaining.join(', ')}\n`)
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = 1
    return
  }
  const l1 = runL1(repoRoot, pkgDir)
  if (!l1.ok) {
    process.stderr.write('FAIL  补齐后 L1 未通过,改动保留供人工核对(不自动回滚):\n')
    for (const failure of l1.failures) {
      process.stderr.write(`\n[${failure.label}] exit ${failure.status ?? failure.signal}\n${failure.output}\n`)
    }
  }
  console.log(JSON.stringify(result, null, 2))
  if (!l1.ok) process.exitCode = 3
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`FAIL  ${error.message}\n`)
    process.exitCode = error instanceof EnumCheckError ? error.exitCode : 1
  })
}
