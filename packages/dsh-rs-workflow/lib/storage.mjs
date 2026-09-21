// storage — rs-workflow 自有文件存储(不经宿主 settings 服务,settings.yaml 不承载本插件配置)
// 布局:<dataDir>/v5/{templates,config}.json;dataDir(DSH_RS_WORKFLOW_DATA_DIR 覆写)
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function dataDir() {
  if (process.env.DSH_RS_WORKFLOW_DATA_DIR) return process.env.DSH_RS_WORKFLOW_DATA_DIR
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-rs-workflow')
}

function v5File(name) {
  return join(dataDir(), 'v5', name)
}

export function loadJson(name, fallback) {
  let raw
  try {
    raw = readFileSync(v5File(name), 'utf8')
  } catch {
    // 缺失即首启:回默认;存在但读失败同路,下次 save 重建
    return fallback
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    // 损坏不可静默吞成默认值:留痕后回退,否则损坏文件被下一次 save 无声覆盖
    console.error(`[rsww] ${name} 解析失败,回退默认值:${e?.message ?? e}`)
    return fallback
  }
}

// 写同目录临时文件后原子改名:跨卷 tmpdir 会触发 EXDEV;同盘保证 rename 原子性
export function saveJson(name, data) {
  const target = v5File(name)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { force: true })
  }
}
