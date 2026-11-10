// 公共 client 依赖(common-tools)的托管形态守真:每个消费插件自带装载行,
// 依赖范围锁在同一 minor、external 声明齐全,库内版本字面量与 package.json 同锁。
// 用法:node scripts/check-common-tools.mjs   (不一致即非零退出并列出问题)
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url)
const PACKAGES = fileURLToPath(new URL('packages/', ROOT))
const LIB = '@mzzsfy/dsh-common-tools'
const CLIENT_SPEC = LIB + '/client'
const ROW_SUFFIX = '-dsh-common-tools'

// js-yaml 经 dsh-shell-select 的 devDep 解析(根未提升),与 patch-keys 同源
const yaml = createRequire(fileURLToPath(new URL('../packages/dsh-shell-select/package.json', import.meta.url)))('js-yaml')

export function parsePatchRows(text) {
  const parsed = yaml.load(text)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(op => (Array.isArray(op?.insert) ? op.insert : []))
    .filter(row => row && typeof row === 'object')
    .map(row => ({ id: row.id, name: row.name }))
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

export function check({ packagesDir = PACKAGES } = {}) {
  const problems = []
  const libManifest = JSON.parse(readFileSync(join(packagesDir, 'dsh-common-tools/package.json'), 'utf8'))
  const version = libManifest.version

  const client = readFileSync(join(packagesDir, 'dsh-common-tools/src/client.js'), 'utf8')
  const host = readFileSync(join(packagesDir, 'dsh-common-tools/src/host.js'), 'utf8')
  const literal = /const VERSION = '([^']+)'/.exec(client)?.[1]
  const hostLiteral = /const PKG_VERSION = '([^']+)'/.exec(host)?.[1]
  if (literal !== version) problems.push(`common-tools/src/client.js 的 VERSION=${literal} 与 package.json ${version} 不一致`)
  if (hostLiteral !== version) problems.push(`common-tools/src/host.js 的 PKG_VERSION=${hostLiteral} 与 package.json ${version} 不一致`)

  const consumers = readdirSync(packagesDir, { withFileTypes: true })
    .filter(dir => dir.isDirectory())
    .map(dir => dir.name)
    .filter(name => name !== 'dsh-common-tools')
    .filter(name => {
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, 'package.json'), 'utf8'))
      return Boolean(manifest.dependencies?.[LIB])
    })
  if (consumers.length === 0) problems.push('未发现任何消费方:依赖解析桥可能已断裂')

  const rowIds = []

  for (const name of consumers) {
    const dir = join(packagesDir, name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const mismatch = rangeMismatch(manifest.dependencies?.[LIB], version)
    if (mismatch) problems.push(`${name}: ${mismatch}`)

    if (!(manifest.dsh?.client?.external ?? []).includes(CLIENT_SPEC)) problems.push(`${name}: dsh.client.external 未声明 ${CLIENT_SPEC}`)

    const patchPath = join(dir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) { problems.push(`${name}: 缺 cordis.patch.yml`); continue }
    const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
    const own = rows.filter(row => row.name === LIB)
    if (own.length !== 1) problems.push(`${name}: 装载行应恰有一条指向 ${LIB},实际 ${own.length}`)
    else if (!String(own[0].id).endsWith(ROW_SUFFIX)) problems.push(`${name}: 装载行 id 应以 ${ROW_SUFFIX} 收尾,实际 ${own[0].id}`)
    else rowIds.push({ name, id: own[0].id })

    const sourcePath = join(dir, 'src/client.js')
    if (!existsSync(sourcePath)) continue
    const source = readFileSync(sourcePath, 'utf8')
    if (source.includes('<common-tools-inline>')) problems.push(`${name}: src/client.js 残留内联生成区(托管形态不应内联)`)
    if (source.includes(`require('@${LIB.slice(1)}/client')`) === false && source.includes('tools =')) {
      problems.push(`${name}: src/client.js 未按 ${CLIENT_SPEC} 消费`)
    }
  }
  const seen = new Map()
  for (const { name, id } of rowIds) {
    if (seen.has(id)) problems.push(`装载行 id 冲突:${id} 同时出现在 ${seen.get(id)} 与 ${name}`)
    else seen.set(id, name)
  }
  return { version, consumers, problems }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('check-common-tools.mjs')) {
  const { version, consumers, problems } = check()
  if (problems.length > 0) {
    console.error(`common-tools 托管形态不一致(${problems.length}):`)
    for (const problem of problems) console.error(' - ' + problem)
    process.exit(1)
  }
  console.log(`common-tools ${version} 托管形态一致(${consumers.length} 个消费方)`)
}
