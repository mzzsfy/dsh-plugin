// release — 流程模板创建/移除/自清理(契约:docs/rsww-v4/feat/release.md)
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTemplate, validateTemplate } from './template-v4.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AGENT_YAML = 'agent.cordis.yml'
const PRESET_YML = 'preset.yml'
const FLOW_FILE = 'flow.json5'
const MARKER_NAME = '.dsh-rs-workflow-source.json'
const PACKAGE_NAME = '@mzzsfy/dsh-rs-workflow'
const MARKER_KIND_FLOW = 'flow'
const PRESET_SKELETON = join(PKG_ROOT, 'preset', 'rs-workflow', AGENT_YAML)
const USER_PRESET_DIR = '.agent-presets'
const FLOW_PRESET_PREFIX = 'rs-'
const STAGING_PREFIX = '.rs-workflow-staging-'
const OLD_PREFIX = '.rs-workflow-old-'
const ORPHAN_PREFIX = '.rs-workflow-orphan-'
// 骨架唯一源中的主组合 flows 锚定;创建产物一律改写为目录内 flow.json5(恰一处)
const FLOW_ANCHOR_MAIN = "new URL('flows/default.json5', baseUrl)"
const FLOW_ANCHOR_RELEASE = "new URL('flow.json5', baseUrl)"
const FLOW_ID_RE = /^[a-z][a-z0-9-]*$/
const DESC_MAX_CHARS = 200
const DESC_FALLBACK = '流程工作流模板'
const PRESET_NAME_PREFIX = '若水·'
// v4 时代起点主版本:包版本不可解析时现役判定退化到此(见 PKG_MAJOR)
const V4_BASE_MAJOR = 1

let PKG_VERSION = 'unknown'
try {
  const parsed = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
  if (typeof parsed === 'string' && parsed.length > 0) PKG_VERSION = parsed
} catch { /* 读包失败归 unknown */ }

// 语义化三元组主版本解析;缺失/不可解析返回 null
function parseMajor(version) {
  const m = typeof version === 'string' ? /^(\d+)(?:\.|$)/.exec(version.trim()) : null
  return m ? Number(m[1]) : null
}

// 现役判定基线 = 当前包主版本:marker 主版本不低于它即 v4 时代产物。
// 契约判定表「主版本 ≥ 4 保留」的落地形态(包版本 1.0.0 起步,写死 4 会误删 v4 自产创建物)
const PKG_MAJOR = parseMajor(PKG_VERSION) ?? V4_BASE_MAJOR

const nonEmpty = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null)

// 预设根解析:参数 > env 根 > env home > 默认家目录,统一拼 .agent-presets
function resolveHome(explicit) {
  const home = nonEmpty(explicit) ?? nonEmpty(process.env.DSH_RS_WORKFLOW_PRESET_ROOT) ?? nonEmpty(process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return resolve(home)
}

export function presetRoot(dshHome) {
  return join(resolveHome(dshHome), USER_PRESET_DIR)
}

export function flowPresetDest(flowId, dshHome) {
  return join(presetRoot(dshHome), FLOW_PRESET_PREFIX + flowId)
}

// 读 marker;缺失/损坏同义返回 null(无法证明归属)
function readMarker(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER_NAME), 'utf8'))
  } catch {
    return null
  }
}

const ownedByUs = (marker) => marker !== null && marker.package === PACKAGE_NAME

// 现役 v4 产物:本包 + kind flow + 主版本不低于当前包主版本(其余本包 marker 均判过时)
function isCurrentV4(marker) {
  if (!ownedByUs(marker) || marker.kind !== MARKER_KIND_FLOW) return false
  const major = parseMajor(marker.version)
  return major !== null && major >= PKG_MAJOR
}

const markerJson = () => JSON.stringify({ package: PACKAGE_NAME, kind: MARKER_KIND_FLOW, version: PKG_VERSION }, null, 2) + '\n'

// 创建骨架:包内唯一源逐字保留,仅改写 flowFile 锚定(必须恰一处)
function releaseAgentYaml() {
  const parts = readFileSync(PRESET_SKELETON, 'utf8').split(FLOW_ANCHOR_MAIN)
  if (parts.length !== 2) throw new Error(`创建骨架 flowFile 锚定串异常(期望恰一处): ${PRESET_SKELETON}`)
  return parts.join(FLOW_ANCHOR_RELEASE)
}

function presetYaml(entry, flowId) {
  const desc = String(entry.description ?? '').replace(/\s*\n\s*/g, ' ').slice(0, DESC_MAX_CHARS) || DESC_FALLBACK
  return `name: ${PRESET_NAME_PREFIX}${entry.label || flowId}\ndescription: >-\n  ${desc}\n`
}

// 硬崩溃残留的 staging/备份目录清理(前缀本包独占,直接删安全;orphan 前缀永不自动删)
function cleanStaleStaging(parentDir) {
  let entries
  try {
    entries = readdirSync(parentDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith(STAGING_PREFIX) || name.startsWith(OLD_PREFIX)) {
      rmSync(join(parentDir, name), { recursive: true, force: true })
    }
  }
}

// 原子换入:staging 组装 → 旧目录 rename 备份 → 新目录入位 → 删备份;
// 入位失败还原,还原也失败改 orphan 前缀保留待人工处置,绝不静默销毁
function atomicReplace(dest, existed, build) {
  const parent = dirname(dest)
  mkdirSync(parent, { recursive: true })
  const stagingRoot = mkdtempSync(join(parent, STAGING_PREFIX))
  const out = join(stagingRoot, 'out')
  const backup = join(parent, OLD_PREFIX + Date.now())
  let orphan = null
  try {
    mkdirSync(out, { recursive: true })
    build(out)
    const hasDest = existsSync(dest)
    if (hasDest) renameSync(dest, backup)
    try {
      renameSync(out, dest)
    } catch (error) {
      if (hasDest) {
        try {
          renameSync(backup, dest)
        } catch {
          orphan = join(parent, ORPHAN_PREFIX + Date.now())
          try {
            renameSync(backup, orphan)
          } catch {
            orphan = backup
          }
          console.warn(`[rs-workflow] 创建换入失败且还原失败,旧目录保留在 ${orphan}(不会被自动清理,需人工处置)`)
        }
      }
      throw error
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
    if (orphan === null) rmSync(backup, { recursive: true, force: true })
  }
  return existed ? 'updated' : 'created'
}

export function releaseFlowTemplate(entry, dshHome) {
  const flowId = typeof entry?.id === 'string' ? entry.id.trim() : ''
  if (!FLOW_ID_RE.test(flowId)) throw new Error(`流程 id 非法: ${JSON.stringify(entry?.id)}(须匹配 ${FLOW_ID_RE.source})`)
  // 创建前重校验(设置里可能被外部改坏)
  let parsed
  try {
    parsed = parseTemplate(entry.json5)
  } catch (error) {
    throw new Error(`模板 json5 解析失败: ${error.message}`)
  }
  const errors = validateTemplate(parsed)
  if (errors.length > 0) throw new Error('模板校验失败:\n' + errors.map((e) => `${e.target}: ${e.message}`).join('\n'))
  const dest = flowPresetDest(flowId, dshHome)
  cleanStaleStaging(dirname(dest))
  const existed = existsSync(dest)
  if (existed && !ownedByUs(readMarker(dest))) throw new Error(`目标目录归属他人,拒绝覆盖: ${dest}`)
  return atomicReplace(dest, existed, (out) => {
    writeFileSync(join(out, FLOW_FILE), entry.json5, 'utf8')
    writeFileSync(join(out, PRESET_YML), presetYaml(entry, flowId), 'utf8')
    writeFileSync(join(out, AGENT_YAML), releaseAgentYaml(), 'utf8')
    writeFileSync(join(out, MARKER_NAME), markerJson(), 'utf8')
  })
}

export function unreleaseFlowTemplate(flowId, dshHome) {
  const dest = flowPresetDest(String(flowId ?? '').trim(), dshHome)
  if (!existsSync(dest)) return 'missing'
  if (!ownedByUs(readMarker(dest))) return 'foreign'
  rmSync(dest, { recursive: true, force: true })
  cleanStaleStaging(dirname(dest))
  return 'removed'
}

function isReleaseDir(root, name) {
  return name.startsWith(FLOW_PRESET_PREFIX) && statSync(join(root, name), { throwIfNoEntry: false })?.isDirectory() === true
}

export function releasedTemplateIds(dshHome) {
  const root = presetRoot(dshHome)
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const ids = []
  for (const name of entries) {
    if (!isReleaseDir(root, name)) continue
    const marker = readMarker(join(root, name))
    if (ownedByUs(marker) && marker.kind === MARKER_KIND_FLOW) ids.push(name.slice(FLOW_PRESET_PREFIX.length))
  }
  return ids
}

// v3 遗留自清理:只删能证明归属本包且非现役 v4 的创建物;缺失/损坏/外来一律不动
export function sweepLegacyReleases(dshHome) {
  const root = presetRoot(dshHome)
  const removed = []
  const kept = []
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return { removed, kept }
  }
  cleanStaleStaging(root)
  for (const name of entries) {
    if (!isReleaseDir(root, name)) continue
    const dir = join(root, name)
    const marker = readMarker(dir)
    if (!ownedByUs(marker)) continue
    const id = name.slice(FLOW_PRESET_PREFIX.length)
    if (isCurrentV4(marker)) {
      kept.push(id)
      continue
    }
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(id)
    } catch (error) {
      console.warn(`[rs-workflow] 遗留模式清理失败: ${name} (${error.message})`)
    }
  }
  return { removed, kept }
}

// 出厂创建:目标缺失或 marker 非现役 v4 时重放,已是现役即幂等跳过
export function ensureMainReleased(defaultEntry, dshHome) {
  const dest = flowPresetDest(defaultEntry.id, dshHome)
  cleanStaleStaging(dirname(dest))
  if (existsSync(dest) && isCurrentV4(readMarker(dest))) return 'current'
  return releaseFlowTemplate(defaultEntry, dshHome)
}
