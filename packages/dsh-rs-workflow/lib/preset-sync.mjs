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

const PKG_VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version

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
  // 内容指纹一致即视为最新:双副本 root 交替不再触发整目录重写,
  // 仅 marker.root 归属不同时原地改写 marker 一个文件
  if (marker.fingerprint === sourceFingerprint() && isComplete(dest)) {
    if (marker.root !== PKG_ROOT) {
      writeFileSync(join(dest, MARKER_NAME), JSON.stringify({ ...marker, root: PKG_ROOT }, null, 2) + '\n')
    }
    // 快路径兜底恢复: rewrite 换入与恢复之间硬崩溃会让定制滞留 home 备份, 逐轮幂等收敛
    restoreUserSlots(dest)
    return 'unchanged'
  }
  return rewrite(dest, true)
}

/** 已确认归属本包后的重写。换入式原子替换:旧目录先 rename 到备份名,新目录
 *  rename 入位成功后才删备份;rename 失败时把备份还原,任意时刻 dest 要么完整
 *  存在要么不存在(后者由下次启动 created 自愈),不再出现"目录在 marker 丢"。 */
function rewrite(dest, existed) {
  mkdirSync(dirname(dest), { recursive: true })
  const staging = mkdtempSync(join(dirname(dest), '.rs-workflow-staging-'))
  const backup = join(dirname(dest), `.rs-workflow-old-${Date.now()}`)
  try {
    cpSync(PRESET_SRC, join(staging, 'out'), { recursive: true })
    writeFileSync(join(staging, 'out', MARKER_NAME), JSON.stringify({
      package: PACKAGE_NAME,
      version: PKG_VERSION,
      root: PKG_ROOT,
      fingerprint: sourceFingerprint(),
    }, null, 2) + '\n')
    backupUserSlots(dest)
    const hasDest = existsSync(dest)
    if (hasDest) renameSync(dest, backup)
    try {
      renameSync(join(staging, 'out'), dest)
    } catch (error) {
      if (hasDest) renameSync(backup, dest)
      throw error
    }
    restoreUserSlots(dest)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(backup, { recursive: true, force: true })
  }
  return existed ? 'updated' : 'created'
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

/** 仅当 dest slots 尚是模板内容时写回定制(覆盖模板);dest 已有更新的定制则不动作 */
function restoreUserSlots(dest) {
  const backupPath = join(dshHome(), USER_SLOTS_BACKUP)
  if (!existsSync(backupPath)) return
  const userSlots = join(dest, SLOTS_REL)
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

/** 删除本包释放的 preset(仅供维护脚本/手工调用,插件生命周期内不触发) */
export function removePreset() {
  const dest = presetDest()
  const marker = readMarker(dest)
  if (marker === null || marker.package !== PACKAGE_NAME) return false
  rmSync(dest, { recursive: true, force: true })
  cleanStaleStaging(dirname(dest))
  return true
}
