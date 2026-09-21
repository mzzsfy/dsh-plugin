// 模型可见渲染:官方 dsh-tool-pwsh 渲染逐字镜像(stdout、[stderr] 段、
// 截断/超时/信号/退出/沙箱标记),文本形态变更必须与官方同步,否则
// terminal 卡的 parseExitStatus 退出 pill 复原失效。

import { sandboxDenialMarker, escalationHintMarker } from '@deepseek-ai/dsh-sandbox'

/** 追加单流截断提示(带全量输出 spill 路径)。 */
function streamText(output) {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * 前台运行结果 → 模型可见文本。
 * @param {object} result ShellRunResult(含 sandbox 事实)
 * @param {string[]} escalationModes 本组合公示的升权目标;非空时拒绝标记后附升权提示
 */
export function renderResult(result, escalationModes = []) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    if (escalationModes.length > 0) markers.push(escalationHintMarker('command'))
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * 后台进程一次增量读 → job_output 增量文本。
 * @param {object} read ShellProcessRead
 * @param {object|undefined} sandbox 已定进程的沙箱事实
 * @param {string[]} escalationModes
 */
export function renderProcessRead(read, sandbox, escalationModes = []) {
  const notices = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) notices.push('[sandbox: the sandbox runner itself failed under ' + sandbox.mode + ' mode — the command did not run; this is a sandbox problem, not a command failure]')
  else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) notices.push(escalationHintMarker('command'))
  }
  if (notices.length === 0) return read.delta
  return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}
