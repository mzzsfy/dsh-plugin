// 沙箱结果分类助手:官方 dsh-pwsh-sandbox helpers 逐项镜像(call-for-call),
// 拒绝/runner 失败判据必须与官方执行器族完全一致,工具层的沙箱渲染才成立。

import { accessSync, constants, statSync } from 'node:fs'

// Node 本地 spawn 码中可证实 runner 可执行文件解析/权限失败的两类
const EXECUTABLE_SPAWN_CODES = new Set(['EACCES', 'ENOENT'])

/** 调用方 spawn cwd 可进入。 */
export function isUsableWorkdir(path) {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 仅在排除 cwd 因素后,凭 argv[0] 溯源把 ENOENT/EACCES 归为 runner 自身失败。
 * @param {unknown} error spawn 拒绝原因
 * @param {string|undefined} runnerProgram provider argv[0]
 * @param {string} workdir 调用方 cwd
 */
export function isRunnerSpawnFailure(error, runnerProgram, workdir) {
  if (runnerProgram === undefined || !isUsableWorkdir(workdir)) return false
  if (typeof error !== 'object' || error === null) return false
  const { code, path, syscall } = error
  if (typeof code !== 'string' || !EXECUTABLE_SPAWN_CODES.has(code)) return false
  if (typeof syscall !== 'string') return false
  const exactSyscall = `spawn ${runnerProgram}`
  if (path === undefined) return syscall === exactSyscall
  if (typeof path !== 'string' || path.length === 0 || path !== runnerProgram) return false
  return syscall === 'spawn' || syscall === exactSyscall
}

/**
 * 按所选 runner 的拒绝方言分类失败运行。
 * @param {{exitCode: number|null, stderr: {text: string}}} result
 * @param {string[]} signatures 拒绝签名(大小写不敏感子串)
 */
export function classifyDenial(result, signatures) {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}

/**
 * 结构化 runner 失败规则匹配:非零退出 + 可选允许码 + 例外信息行后的致命行。
 * @param {number|null} exitCode
 * @param {string} stderr
 * @param {Array<{allowedExitCodes?: number[], informationalLines?: string[], fatalSignatures: string[]}>} rules
 * @returns {{detail: string}|undefined}
 */
export function classifyRunnerFailure(exitCode, stderr, rules) {
  if (exitCode === null || exitCode === 0) return undefined
  const lines = stderr.split(/\r?\n/)
  for (const rule of rules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informationalLines = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()))
    const fatalSignatures = rule.fatalSignatures
      .filter((signature) => signature.trim().length > 0)
      .map((signature) => signature.toLowerCase())
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informationalLines.has(lowered)) continue
      if (fatalSignatures.some((signature) => lowered.includes(signature))) return { detail: line }
    }
  }
  return undefined
}

/**
 * 非零退出 + stderr 命中任一签名(大小写不敏感)。
 * @param {number|null} exitCode
 * @param {string} stderr
 * @param {string[]} signatures
 */
export function matchesSignature(exitCode, stderr, signatures) {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some((signature) => lowered.includes(signature.toLowerCase()))
}
