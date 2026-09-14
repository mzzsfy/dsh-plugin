/**
 * preset-sync — 把包内 preset/rs-workflow 幂等同步到用户 preset 根。
 *
 * 职责:
 *   - sync:递归拷贝包内 preset/rs-workflow → <dsh-home>/.agent-presets/rs-workflow,
 *     并写入来源标记(marker),供排查"选择器里 broken 的 preset 来自哪个包"。
 *   - 所有权防线:目标目录存在但 marker 缺失或归属他人时拒绝覆盖(可能是用户手工
 *     安装或本地定制的同名 preset),告警后原样保留。
 *   - 仅在插件 apply 时运行:dsh 每次启动同步一次,升级包后重启即更新。
 *     卸载场景受 pnpm 限制(依赖的 preuninstall 脚本一律不执行,实验证实),
 *     无法自动删除,残留 preset 因 tool 行 import 失败在选择器显示 broken;
 *     手动清理命令见包 README。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { personaKeysFor, parseVersion as parseVersionCompat } from './persona-compat.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_SRC = join(PKG_ROOT, 'preset', 'rs-workflow')
const USER_PRESET_DIR = '.agent-presets'
const PRESET_ID = 'rs-workflow'
const MARKER_NAME = '.dsh-rs-workflow-source.json'
const PACKAGE_NAME = '@mzzsfy/dsh-rs-workflow'
// slots.json5 是文档引导的用户后备编辑点:rewrite 前若其内容异于包内模板,
// 备份到 home 根的该文件名,重写后恢复,升级不再静默吞掉手工定制
const SLOTS_REL = join('skills', 'rs-workflow', 'slots.json5')
const USER_SLOTS_BACKUP = 'rs-workflow.slots.user.json5'
// 完整性清单:任一缺失即视为残缺,走重写自愈(与 PRESET_SRC 产物对齐)
const MANAGED_FILES = [
  'preset.yml',
  'agent.cordis.yml',
  join('skills', 'rs-workflow', 'SKILL.md'),
  SLOTS_REL,
  join('skills', 'rs-workflow', 'references', 'engine.js'),
  join('skills', 'rs-workflow', 'references', 'templates.md'),
]

/** dsh home:CLI 配置层可显式指定,插件环境只见 $DSH_HOME;空串视同未设 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim().length > 0 ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** 释放目标绝对路径(诊断用:home 错位时可直接从日志/测试定位) */
export function presetDest() {
  return join(dshHome(), USER_PRESET_DIR, PRESET_ID)
}

// 版本读取容错:package.json 恰逢包管理器替换窗口或损坏时不让包整体加载失败,
// marker 的 version 字段恒有确定语义(缺失/非字符串归一 unknown)
let PKG_VERSION = 'unknown'
try {
  const parsed = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
  if (typeof parsed === 'string' && parsed.length > 0) PKG_VERSION = parsed
} catch { /* 保留 unknown */ }

/** 源目录内容指纹:文件名集合 + 逐文件 size 与 mtime 的聚合。粒度足够感知
 *  同版本内容改动与产物残缺,不引入 hash 依赖 */
function sourceFingerprint() {
  const parts = []
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      const st = statSync(full)
      if (st.isDirectory()) walk(full, relPath)
      else parts.push(`${relPath}:${st.size}:${st.mtimeMs}`)
    }
  }
  walk(PRESET_SRC, '')
  return parts.sort().join('|')
}

/** 读 marker;缺失或损坏返回 null(损坏与缺失同义:无法证明归属) */
function readMarker(dest) {
  const markerPath = join(dest, MARKER_NAME)
  if (!existsSync(markerPath)) return null
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}

/** 宿主版本解析:env 优先,其次从宿主入口 argv[1] 向上找 @deepseek-ai/dsh
 *  的 package.json。真实宿主进程不设 dshVersion 环境变量(0.1.5-rc.1 实测
 *  marker 恒 unknown),argv 回退是旧宿主兼容唯一可靠来源;找不到归 unknown */
export function hostVersion(argv1 = process.argv[1]) {
  const fromEnv = process.env.dshVersion
  if (fromEnv && parseVersionCompat(fromEnv) !== null) return fromEnv
  try {
    let dir = argv1 ? dirname(argv1) : ''
    for (let i = 0; i < 6 && dir; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          if (pkg.name === '@deepseek-ai/dsh' && typeof pkg.version === 'string') return pkg.version
        } catch { /* 损坏的 package.json 继续向上 */ }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* argv 异常归 unknown */ }
  return 'unknown'
}

/** 释放产物形态指纹:源内容 + 宿主版本档(persona 键名随之变化)。
 *  版本档变化即触发重写,跨版本切换宿主后释放目录随之改写。 */
function releaseFingerprint() {
  return `${sourceFingerprint()}#dsh:${hostVersion()}`
}

/** 完整性校验:受管文件任一缺失即残缺 */
function isComplete(dest) {
  return MANAGED_FILES.every((rel) => existsSync(join(dest, rel)))
}

/** 同步释放;返回 'created' | 'updated' | 'unchanged' | 'skipped-foreign' */
export function syncPreset() {
  if (!existsSync(PRESET_SRC)) throw new Error(`包内 preset 缺失: ${PRESET_SRC}`)
  const dest = presetDest()
  // staging 残留清理与快慢路径无关:硬崩溃后仅 rewrite 清理会让残留长期滞留
  cleanStaleStaging(dirname(dest))
  if (!existsSync(dest)) return rewrite(dest, false)
  const marker = readMarker(dest)
  if (marker === null || marker.package !== PACKAGE_NAME) return 'skipped-foreign'
  // 释放产物形态指纹一致即视为最新(源内容 + 宿主版本档):
  // 双副本 root 交替不再触发整目录重写,仅 marker.root 归属不同时原地改写 marker
  if (marker.fingerprint === releaseFingerprint() && isComplete(dest)) {
    if (marker.root !== PKG_ROOT) {
      writeFileSync(join(dest, MARKER_NAME), JSON.stringify({ ...marker, root: PKG_ROOT }, null, 2) + '\n')
    }
    return 'unchanged'
  }
  return rewrite(dest, true)
}

/** 已确认归属本包后的重写。换入式原子替换:旧目录先 rename 到备份名,新目录
 *  rename 入位成功后才删备份;换入失败时尽力还原,还原也失败则把旧副本改名为
 *  orphan 前缀(不匹配清理规则,永不被自动删除)并告警,绝不静默销毁。 */
function rewrite(dest, existed) {
  mkdirSync(dirname(dest), { recursive: true })
  const staging = mkdtempSync(join(dirname(dest), '.rs-workflow-staging-'))
  const backup = join(dirname(dest), `.rs-workflow-old-${Date.now()}`)
  let orphan = null
  try {
    cpSync(PRESET_SRC, join(staging, 'out'), { recursive: true })
    rewritePersonaKeys(join(staging, 'out', 'agent.cordis.yml'))
    writeFileSync(join(staging, 'out', MARKER_NAME), JSON.stringify({
      package: PACKAGE_NAME,
      version: PKG_VERSION,
      root: PKG_ROOT,
      fingerprint: releaseFingerprint(),
    }, null, 2) + '\n')
    backupUserSlots(dest)
    restoreUserSlots(join(staging, 'out'))
    const hasDest = existsSync(dest)
    if (hasDest) renameSync(dest, backup)
    try {
      renameSync(join(staging, 'out'), dest)
    } catch (error) {
      if (hasDest) {
        try {
          renameSync(backup, dest)
        } catch (restoreError) {
          // dest 缺失且旧副本留存:改用清理规则不匹配的 orphan 前缀,保留待人工处置
          orphan = join(dirname(backup), `.rs-workflow-orphan-${Date.now()}`)
          try {
            renameSync(backup, orphan)
          } catch {
            orphan = backup
          }
          console.warn(`[rs-workflow] preset 换入失败且还原失败,旧目录保留在 ${orphan}(不会被自动清理,需人工处置)`)
        }
      }
      throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
    if (orphan === null) rmSync(backup, { recursive: true, force: true })
  }
  return existed ? 'updated' : 'created'
}

/** persona 行键名按宿主版本改写(见 persona-compat.mjs):仓库源码恒为新版
 *  prefix/suffix 形态,旧宿主(text required)释放时回退改写,并重算指纹 */
function rewritePersonaKeys(agentYamlPath) {
  if (!existsSync(agentYamlPath)) return
  const raw = readFileSync(agentYamlPath, 'utf8')
  const converted = personaKeysFor(hostVersion(), raw)
  if (converted !== raw) {
    writeFileSync(agentYamlPath, converted)
  }
}

/** 用户改过的 slots.json5 在重写前备份;已回退到模板内容时清除旧备份,防陈旧定制复活 */
function backupUserSlots(dest) {
  const userSlots = join(dest, SLOTS_REL)
  const template = join(PRESET_SRC, SLOTS_REL)
  const backupPath = join(dshHome(), USER_SLOTS_BACKUP)
  if (!existsSync(userSlots)) return
  let userText
  try {
    userText = readFileSync(userSlots, 'utf8')
  } catch {
    return
  }
  let templateText = ''
  try {
    templateText = readFileSync(template, 'utf8')
  } catch { /* 模板不可读视同定制, 保留现有备份 */ }
  if (userText === templateText && templateText !== '') {
    rmSync(backupPath, { force: true })
    return
  }
  writeFileSync(backupPath, userText)
}

/** 待换入目录的 slots 若为模板内容且 home 有备份,写入用户定制;
 *  恢复随换入原子完成,dest 不再出现"模板+待恢复"中间态(崩溃窗口与复活窗口同消) */
function restoreUserSlots(stagingOut) {
  const backupPath = join(dshHome(), USER_SLOTS_BACKUP)
  if (!existsSync(backupPath)) return
  const userSlots = join(stagingOut, SLOTS_REL)
  if (!existsSync(userSlots)) return
  let userText
  try {
    userText = readFileSync(userSlots, 'utf8')
  } catch {
    return
  }
  let templateText = ''
  try {
    templateText = readFileSync(join(PRESET_SRC, SLOTS_REL), 'utf8')
  } catch { /* 模板不可读时无法判定, 不动作 */ }
  if (templateText !== '' && userText === templateText) {
    writeFileSync(userSlots, readFileSync(backupPath, 'utf8'))
  }
}

/** 清理硬崩溃残留的 staging/备份目录(前缀为本包独占,直接删安全);避免预设扫描把它们当 broken preset 展示 */
function cleanStaleStaging(parentDir) {
  let entries = []
  try {
    entries = readdirSync(parentDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.rs-workflow-staging-') || name.startsWith('.rs-workflow-old-')) {
      rmSync(join(parentDir, name), { recursive: true, force: true })
    }
  }
}

/** 删除本包释放的 preset(仅供维护脚本/手工调用,插件生命周期内不触发)。
 *  返回三态:'removed' 已删 | 'missing' 目录不存在 | 'foreign' 外来目录拒绝删除 */
export function removePreset() {
  const dest = presetDest()
  if (!existsSync(dest)) return 'missing'
  const marker = readMarker(dest)
  if (marker === null || marker.package !== PACKAGE_NAME) return 'foreign'
  rmSync(dest, { recursive: true, force: true })
  cleanStaleStaging(dirname(dest))
  return 'removed'
}
