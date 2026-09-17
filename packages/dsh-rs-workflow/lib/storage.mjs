// storage — rs-workflow 自有文件存储(不经宿主 settings 服务,settings.yaml 不承载本插件配置)
// 布局:<dataDir>/v5/{templates,config}.json;dataDir(DSH_RS_WORKFLOW_DATA_DIR 覆写)
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function dataDir() {
  if (process.env.DSH_RS_WORKFLOW_DATA_DIR) return process.env.DSH_RS_WORKFLOW_DATA_DIR
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-rs-workflow')
}

function v5File(name) {
  return join(dataDir(), 'v5', name)
}

export function loadJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(v5File(name), 'utf8'))
  } catch {
    return fallback
  }
}

// 写临时文件后原子改名,断电不产生半截 JSON
export function saveJson(name, data) {
  const target = v5File(name)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${join(tmpdir(), 'rsww')}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, target)
  } finally {
    rmSync(tmp, { force: true })
  }
}
