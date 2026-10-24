// 克隆仓库纯逻辑:请求校验(目标全路径)、git 参数构造与克隆执行。
// 全部依赖注入(spawn/targetState),无模块级可变状态;错误一律抛中文业务
// Error(无错误码),由路由层原样透传。

import { join, isAbsolute, dirname } from 'node:path'

// 克隆整体超时:大仓库完整克隆的真实上界;超时树杀并按业务错误透出
export const CLONE_TIMEOUT_MS = 30 * 60 * 1000
// 失败时透出的 stderr 尾部行数:git 的错误说明集中在输出末尾
export const STDERR_TAIL_LINES = 6
// git 在 PATH 缺失时 spawn 抛 ENOENT,收敛为可行动文案
export const GIT_MISSING_MESSAGE = 'git 不可用:未安装或不在宿主 PATH 中'

// 远程仓库地址形态:https/http/ssh/git 协议与 git@host:path scp 语法;
// 本地路径与 file:// 不收(克隆来源限定远程,防与目录选择语义混淆)
const REMOTE_URL_RE = /^(?:https?|ssh|git):\/\/\S+|^git@[^\s:/]+:[^\s]+$/

// 目标路径状态(宿主 stat/readdir 的归一结果)
export const TARGET_MISSING = 'missing'
export const TARGET_EMPTY_DIR = 'empty'
export const TARGET_NONEMPTY_DIR = 'nonempty'
export const TARGET_FILE = 'file'

// 请求解析与校验:target 为目标完整目录路径(IDEA Get from VCS 同构),必须是
// 可 ~ 展开的绝对路径;已存在时须为空目录(git 允许克隆进空目录),非空目录与
// 文件一律拒绝。targetState 注入以便测试与路由层共用同一校验形态,
// 返回 { url, target, shallow }
export async function resolveCloneRequest(body, { homedirPath, targetState }) {
  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  if (url === '') throw new Error('仓库地址不能为空')
  if (url.startsWith('-')) throw new Error('仓库地址不合法')
  if (!REMOTE_URL_RE.test(url)) throw new Error('仓库地址必须是 http(s)/ssh/git 远程地址或 git@ 形式')

  const raw = typeof body?.target === 'string' ? body.target.trim() : ''
  if (raw === '') throw new Error('目标目录不能为空')
  const expanded = expandHome(raw, homedirPath)
  if (!isAbsolute(expanded)) throw new Error('目标目录必须是绝对路径')

  const state = await targetState(expanded)
  if (state === TARGET_NONEMPTY_DIR) throw new Error('目标目录已存在且非空:' + expanded)
  if (state === TARGET_FILE) throw new Error('目标路径已被文件占用:' + expanded)

  return { url, target: expanded, shallow: body?.shallow === true }
}

// 目标支持 ~ 前缀(客户端记忆值跨机器迁移时宿主侧展开);~ 单独出现或 ~/ 开头
function expandHome(pathValue, homedirPath) {
  if (!homedirPath) return pathValue
  if (pathValue === '~') return homedirPath
  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) return join(homedirPath, pathValue.slice(2))
  return pathValue
}

// 目标目录的父路径(clone 的 cwd)
export const parentOf = (target) => dirname(target)

// git 参数:选项必须在 `--` 之前,`--` 之后才是 url 与目标目录(url 以 `-` 开头
// 的注入形态已被校验拦截,`--` 兜底)
export function buildCloneArgs({ url, target, shallow }) {
  return ['clone', ...(shallow ? ['--depth', '1'] : []), '--', url, target]
}

// 克隆执行:spawn 注入(node:child_process.spawn 兼容形态),收集 stderr 尾部,
// ENOENT 收敛为 GIT_MISSING_MESSAGE,非零退出透出 stderr 尾巴,超时树杀
export function runClone({ url, target, parent, shallow, spawn, timeoutMs = CLONE_TIMEOUT_MS, treeKill }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', buildCloneArgs({ url, target, shallow }), { cwd: parent })
    } catch (error) {
      reject(error && error.code === 'ENOENT' ? new Error(GIT_MISSING_MESSAGE) : error)
      return
    }
    let settled = false
    let stderrText = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        treeKill(child.pid)
      } catch {
        child.kill()
      }
      reject(new Error('克隆超时(超过 ' + Math.round(timeoutMs / (60 * 1000)) + ' 分钟),已终止'))
    }, timeoutMs)
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => {
      stderrText += chunk
      if (stderrText.length > 64 * 1024) stderrText = stderrText.slice(-32 * 1024)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error && error.code === 'ENOENT' ? new Error(GIT_MISSING_MESSAGE) : error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ path: target })
        return
      }
      reject(new Error(cloneFailureMessage(stderrText)))
    })
  })
}

export function tailLines(text, lines) {
  const parts = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '')
  return parts.slice(-lines).join('\n')
}

function cloneFailureMessage(stderrText) {
  const tail = tailLines(stderrText, STDERR_TAIL_LINES)
  return tail !== '' ? '克隆失败:\n' + tail : '克隆失败(git 非零退出,无错误输出)'
}
