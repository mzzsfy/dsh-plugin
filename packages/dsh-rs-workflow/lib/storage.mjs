// storage — rs-workflow 自有文件存储(不经宿主 settings 服务,settings.yaml 不承载本插件配置)
// 布局:<dataDir>/v5/{templates,config}.json;dataDir(DSH_RS_WORKFLOW_DATA_DIR 覆写)
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function dataDir() {
  if (process.env.DSH_RS_WORKFLOW_DATA_DIR) return process.env.DSH_RS_WORKFLOW_DATA_DIR
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-rs-workflow')
}

function v5File(name) {
  return join(dataDir(), 'v5', name)
}

// 解析失败的文件路径:整进程拒写,直到人工恢复。只记内存,不落盘标记。
const broken = new Set()

function backupCorrupt(target) {
  let backup = target + '.bak'
  if (existsSync(backup)) backup = `${target}.${Date.now()}.bak`
  try {
    copyFileSync(target, backup)
    return backup
  } catch (error) {
    console.error(`[rsww] ${target} 损坏备份失败:${error?.message ?? error}`)
    return null
  }
}

export function loadJson(name, fallback) {
  const target = v5File(name)
  let raw
  try {
    raw = readFileSync(target, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    // 存在但读失败同样可能丢数据,按损坏拒写,避免下一次 save 覆盖
    broken.add(target)
    console.error(`[rsww] ${name} 读取失败,已拒写:${error?.message ?? error}`)
    return fallback
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    // 损坏不可静默吞成默认值:备份原件并拒写,否则下一次 save 会无声覆盖
    broken.add(target)
    const backup = backupCorrupt(target)
    console.error(`[rsww] ${name} 解析失败,已拒写${backup ? `,备份:${backup}` : '(备份失败)'}:${e?.message ?? e}`)
    return fallback
  }
}

// 写同目录临时文件后原子改名:跨卷 tmpdir 会触发 EXDEV;同盘保证 rename 原子性
export function saveJson(name, data) {
  const target = v5File(name)
  if (broken.has(target)) {
    throw new Error(`${name} 已损坏,拒绝覆盖;请修复或删除 ${target} 后重启`)
  }
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { force: true })
  }
}
