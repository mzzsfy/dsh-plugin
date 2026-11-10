// 公共 client 依赖(common-tools)的托管形态守真:每个消费插件自带装载行,
// 依赖范围锁在同一 minor、external 声明齐全,库内版本字面量与 package.json 同锁。
// 消费方集合从三处证据取并集(依赖声明/装载行/源码引用),任一处残留即按消费方校验,
// 避免"删掉依赖声明就整包逃出校验"。
// 用法:node scripts/check-common-tools.mjs   (不一致即非零退出并列出问题)
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url)
const PACKAGES = fileURLToPath(new URL('packages/', ROOT))
const LIB = '@mzzsfy/dsh-common-tools'
const CLIENT_SPEC = LIB + '/client'
const ROW_SUFFIX = '-dsh-common-tools'
const REQUIRE_RE = /\brequire\(\s*['"]@mzzsfy\/dsh-common-tools\/client['"]\s*\)/

// js-yaml 经 dsh-shell-select 的 devDep 解析(根未提升),与 patch-keys 同源
const yaml = createRequire(fileURLToPath(new URL('../packages/dsh-shell-select/package.json', import.meta.url)))('js-yaml')

// !!js 标签本地同形 Type:tag 必须写完整 URI,与 patch-keys 同源
const SCHEMA = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
}))

export function parsePatchRows(text) {
  const parsed = yaml.load(text, { schema: SCHEMA })
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(op => (Array.isArray(op?.insert) ? op.insert : []))
    .filter(row => row && typeof row === 'object')
    .map(row => ({ id: row.id, name: row.name }))
}

// 宿主按 data.push(...insert) 应用,单行 insert 形态(insert: true)不被支持
export function hasInlineRowForm(text) {
  const parsed = yaml.load(text, { schema: SCHEMA })
  return Array.isArray(parsed) && parsed.some(op => op && typeof op === 'object' && op.insert === true)
}

// 依赖范围必须落在库的同一 minor 内(^<major>.<minor>.x),且下限不高于库版本
export function rangeMismatch(range, version) {
  const [major, minor] = version.split('.')
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range ?? ''))
  if (!match) return `范围 ${range} 不是 ^<major>.<minor>.<patch> 形态`
  if (match[1] !== major || match[2] !== minor) return `范围 ${range} 与库版本 ${version} 不在同一 minor`
  const floor = Number(match[3])
  const current = Number(version.split('.')[2])
  if (floor > current) return `范围 ${range} 的下限高于库版本 ${version}`
  return null
}

// 注释里出现同样的字面量不算声明:逐字符剥注释(字符串原样保留,
// 避免把 '/*' 之类的字符串内容当注释边界吞掉大段代码)
export function stripComments(source) {
  let out = ''
  let quote = null
  let block = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]
    if (block) {
      if (ch === '*' && next === '/') { block = false; i++ }
      else if (ch === '\n') out += ch
      continue
    }
    if (quote) {
      out += ch
      if (ch === '\\') { out += source[++i] ?? ''; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') { block = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    out += ch
  }
  return out
}

function literalOf(source, pattern) {
  const hits = [...stripComments(source).matchAll(pattern)]
  return hits.at(-1)?.[1]
}

function packageNames(packagesDir) {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(dir => dir.isDirectory())
    .map(dir => dir.name)
    .filter(name => name !== 'dsh-common-tools')
    .filter(name => existsSync(join(packagesDir, name, 'package.json')))
}

export function check({ packagesDir = PACKAGES } = {}) {
  const problems = []
  const libManifest = JSON.parse(readFileSync(join(packagesDir, 'dsh-common-tools/package.json'), 'utf8'))
  const version = libManifest.version

  const client = readFileSync(join(packagesDir, 'dsh-common-tools/src/client.js'), 'utf8')
  const host = readFileSync(join(packagesDir, 'dsh-common-tools/src/host.js'), 'utf8')
  const literal = literalOf(client, /const VERSION = ['"]([^'"]+)['"]/g)
  const hostLiteral = literalOf(host, /const PKG_VERSION = ['"]([^'"]+)['"]/g)
  if (literal !== version) problems.push(`common-tools/src/client.js 的 VERSION=${literal} 与 package.json ${version} 不一致`)
  if (hostLiteral !== version) problems.push(`common-tools/src/host.js 的 PKG_VERSION=${hostLiteral} 与 package.json ${version} 不一致`)

  const consumers = []
  const rowIds = []

  for (const name of packageNames(packagesDir)) {
    const dir = join(packagesDir, name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const sourcePath = join(dir, 'src/client.js')
    const source = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : ''
    const patchPath = join(dir, 'cordis.patch.yml')
    const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    const rows = patchText ? parsePatchRows(patchText) : []
    const declared = Boolean(manifest.dependencies?.[LIB])
    const hasRow = rows.some(row => row.name === LIB)
    if (!declared && !hasRow && !source.includes(LIB)) continue
    consumers.push(name)

    const mismatch = rangeMismatch(manifest.dependencies?.[LIB], version)
    if (mismatch) problems.push(`${name}: ${mismatch}`)

    const external = manifest.dsh?.client?.external
    if (external !== undefined && !Array.isArray(external)) problems.push(`${name}: dsh.client.external 必须是字符串数组`)
    else if (!(external ?? []).includes(CLIENT_SPEC)) problems.push(`${name}: dsh.client.external 未声明 ${CLIENT_SPEC}`)

    if (!patchPath) { problems.push(`${name}: 缺 cordis.patch.yml`); continue }
    if (hasInlineRowForm(patchText)) problems.push(`${name}: 装载行不得用单行 insert 形态(宿主只支持数组)`)
    const own = rows.filter(row => row.name === LIB)
    const expected = name.replace(/^dsh-/, '') + ROW_SUFFIX
    if (own.length !== 1) problems.push(`${name}: 装载行应恰有一条指向 ${LIB},实际 ${own.length}`)
    else if (own[0].id !== expected) problems.push(`${name}: 装载行 id 应为 ${expected},实际 ${own[0].id}`)
    else rowIds.push({ name, id: own[0].id })

    const patchFile = manifest.dsh?.bundle?.patch
    if (patchFile !== undefined && !existsSync(join(dir, patchFile))) problems.push(`${name}: dsh.bundle.patch 指向不存在的 ${patchFile}`)

    if (!source) continue
    if (source.includes('<common-tools-inline>')) problems.push(`${name}: src/client.js 残留内联生成区(托管形态不应内联)`)
    if (!REQUIRE_RE.test(stripComments(source))) problems.push(`${name}: src/client.js 未按 ${CLIENT_SPEC} 消费`)
  }
  if (consumers.length === 0) problems.push('未发现任何消费方:依赖解析桥可能已断裂')

  // 行 id 在全部包的 patch 里唯一:宿主按 id 插入,撞车会互相顶掉
  const seen = new Map()
  for (const name of packageNames(packagesDir)) {
    const dir = join(packagesDir, name)
    const patchPath = join(dir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) continue
    for (const row of parsePatchRows(readFileSync(patchPath, 'utf8'))) {
      if (!row.id) continue
      if (seen.has(row.id)) problems.push(`装载行 id 冲突:${row.id} 同时出现在 ${seen.get(row.id)} 与 ${name}`)
      else seen.set(row.id, name)
    }
  }
  return { version, consumers, problems }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version, consumers, problems } = check()
  if (problems.length > 0) {
    console.error(`common-tools 托管形态不一致(${problems.length}):`)
    for (const problem of problems) console.error(' - ' + problem)
    process.exit(1)
  }
  console.log(`common-tools ${version} 托管形态一致(${consumers.length} 个消费方)`)
}
