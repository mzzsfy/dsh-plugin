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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_SRC = join(PKG_ROOT, 'preset', 'rs-workflow')
const USER_PRESET_DIR = '.agent-presets'
const PRESET_ID = 'rs-workflow'
const MARKER_NAME = '.dsh-rs-workflow-source.json'
const PACKAGE_NAME = '@mzzsfy/dsh-rs-workflow'

/** dsh home:CLI 配置层可显式指定,插件环境只见 $DSH_HOME;空串视同未设 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim().length > 0 ? resolve(fromEnv) : join(homedir(), '.dsh')
}

function presetDest() {
  return join(dshHome(), USER_PRESET_DIR, PRESET_ID)
}

function version() {
  return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
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

/** 同步释放;返回 'created' | 'updated' | 'unchanged' | 'skipped-foreign' */
export function syncPreset() {
  if (!existsSync(PRESET_SRC)) throw new Error(`包内 preset 缺失: ${PRESET_SRC}`)
  const dest = presetDest()
  if (!existsSync(dest)) return rewrite(dest, false)
  const marker = readMarker(dest)
  if (marker === null || marker.package !== PACKAGE_NAME) return 'skipped-foreign'
  if (marker.root === PKG_ROOT && marker.version === version()) {
    // 快路径完整性校验:核心文件缺失视为残缺,走重写自愈
    if (existsSync(join(dest, 'agent.cordis.yml')) && existsSync(join(dest, 'skills', 'rs-workflow', 'references', 'engine.js'))) return 'unchanged'
  }
  return rewrite(dest, true)
}

/** 已确认归属本包后的重写;同卷临时目录拷贝 + rename 原子换入(系统 tmpdir 可能跨盘,EXDEV 会毁掉已 rm 的旧目录)。
 *  已知行为:同一包从多个安装位置(仓库副本/store 副本)各自 apply 时 marker.root 不同,会每次启动重写一次,归属判定不受影响。 */
function rewrite(dest, existed) {
  mkdirSync(dirname(dest), { recursive: true })
  cleanStaleStaging(dirname(dest))
  const staging = mkdtempSync(join(dirname(dest), '.rs-workflow-staging-'))
  try {
    cpSync(PRESET_SRC, join(staging, 'out'), { recursive: true })
    writeFileSync(join(staging, 'out', MARKER_NAME), JSON.stringify({ package: PACKAGE_NAME, version: version(), root: PKG_ROOT }, null, 2) + '\n')
    rmSync(dest, { recursive: true, force: true })
    renameSync(join(staging, 'out'), dest)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return existed ? 'updated' : 'created'
}

/** 清理硬崩溃残留的 staging 目录(前缀为本包独占,直接删安全);避免预设扫描把它们当 broken preset 展示 */
function cleanStaleStaging(parentDir) {
  let entries = []
  try {
    entries = readdirSync(parentDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.rs-workflow-staging-')) rmSync(join(parentDir, name), { recursive: true, force: true })
  }
}

/** 删除本包释放的 preset(仅供维护脚本/手工调用,插件生命周期内不触发) */
export function removePreset() {
  const dest = presetDest()
  const marker = readMarker(dest)
  if (marker === null || marker.package !== PACKAGE_NAME) return false
  rmSync(dest, { recursive: true, force: true })
  return true
}
