// 诊断采样落盘: 每个宿主实例写自己的文件, 轮转失败不得吞掉当前样本。
// 路径优先级: 显式文件 env > 目录 env > 宿主 home 派生; 缺省 home 与仓库其它包同构。
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DIAG_FILE_ENV = 'DSH_BUG_PERF_DIAG_FILE'
export const DIAG_DIR_ENV = 'DSH_BUG_PERF_DIAG_DIR'
export const DIAG_FILE_NAME = 'diag.jsonl'
export const DIAG_MAX_BYTES = 2 * 1024 * 1024

/**
 * 解析当前实例的诊断文件路径: 默认 home 下按端口/进程派生文件名, 同一 home 的多实例不共写;
 * env 显式目录/文件保持调用方给定的精确路径。
 * @param options - env 默认进程环境; port 宿主监听端口; pid 无端口时的进程标识。
 * @returns 诊断 JSONL 路径。
 */
export function resolveDiagFile({ env = process.env, port, pid = process.pid } = {}) {
  if (env[DIAG_FILE_ENV]) return env[DIAG_FILE_ENV]
  const explicitDir = env[DIAG_DIR_ENV]
  if (explicitDir) return join(explicitDir, DIAG_FILE_NAME)
  const dir = join(env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-bug-perf')
  const instance = Number.isInteger(port) && port > 0 ? `port-${port}` : `pid-${pid}`
  return join(dir, `diag-${instance}.jsonl`)
}

const DEFAULT_FS = { appendFileSync, existsSync, mkdirSync, renameSync, statSync }

/**
 * 建立单实例诊断写入器。轮转与追加分别 catch: 轮转失败只留旧文件, 当前样本照常追加。
 * @param options - file 目标路径; maxBytes 轮转阈值; fs 测试可注入的 fs 方法。
 * @returns record(payload) 返回是否追加成功。
 */
export function createDiagStore({ file, maxBytes = DIAG_MAX_BYTES, fs = DEFAULT_FS } = {}) {
  if (typeof file !== 'string' || file.length === 0) throw new Error('diag file path required')
  const rotateIfNeeded = () => {
    if (!fs.existsSync(file)) return
    if (fs.statSync(file).size <= maxBytes) return
    fs.renameSync(file, `${file}.1`)
  }
  return {
    file,
    record(payload) {
      const line = `${JSON.stringify(payload)}\n`
      try {
        rotateIfNeeded()
      } catch {
        // 轮转失败(占用/权限/磁盘): 保留旧文件, 当前样本继续追加
      }
      try {
        fs.mkdirSync(dirname(file), { recursive: true })
        fs.appendFileSync(file, line, 'utf8')
        return true
      } catch {
        // 磁盘不可写时丢弃采样, 不影响页面与宿主
        return false
      }
    },
  }
}
