// render 工具渲染镜像:BDD 场景见 docs/progress/shell-select-plan.md「模块 render」。
// 期望文本与官方 dsh-tool-pwsh 渲染逐字对齐,terminal 卡解析(parseExitStatus)才能复原退出 pill。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderResult, renderProcessRead } from '../src/render.mjs'

const NO_ESCALATION = []

test('干净退出:仅 stdout,无标记', () => {
  const text = renderResult({
    stdout: { text: 'hello\n', truncated: false },
    stderr: { text: '', truncated: false },
    exitCode: 0, signal: null, timedOut: false, sandbox: undefined,
  }, NO_ESCALATION)
  assert.equal(text, 'hello\n')
})

test('S20h shell 客户端标记:首标记行落,官方退出锚保持末行', () => {
  // BDD:Given 调用经 git-bash 客户端执行且非零退出,When 渲染模型可见文本,Then 首行标记 [shell: git-bash],[exit code] 仍居末(官方 parseExitStatus 锚不被破坏)
  const text = renderResult({
    stdout: { text: 'out\n', truncated: false },
    stderr: { text: '', truncated: false },
    exitCode: 2, signal: null, timedOut: false, sandbox: undefined,
  }, NO_ESCALATION, 'git-bash')
  assert.equal(text, 'out\n[shell: git-bash]\n[exit code: 2]')
})

test('S20h shell 标记:干净成功仅标记行,退出锚缺省形态不变', () => {
  // BDD:Given exit 0 成功调用,When 渲染,Then 输出尾追 [shell: id] 单行,无退出标记
  const text = renderResult({
    stdout: { text: 'hello\n', truncated: false },
    stderr: { text: '', truncated: false },
    exitCode: 0, signal: null, timedOut: false, sandbox: undefined,
  }, NO_ESCALATION, 'pwsh')
  assert.equal(text, 'hello\n[shell: pwsh]')
})

test('S20h shell 标记:先于超时/信号标记,退出锚仍居末', () => {
  const text = renderResult({
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    exitCode: null, signal: 'SIGTERM', timedOut: true, timeoutMs: 1000, sandbox: undefined,
  }, NO_ESCALATION, 'pwsh')
  assert.equal(text, '(no output)\n[shell: pwsh]\n[timed out after 1000ms]\n[killed by signal: SIGTERM]')
})

test('S20h shell 标记:未传 id 不加标记(渲染面与官方逐字同构)', () => {
  // BDD:Given 调用方未携带客户端事实,When 渲染,Then 文本与官方 pwsh 工具逐字一致
  const text = renderResult({
    stdout: { text: 'hello\n', truncated: false },
    stderr: { text: '', truncated: false },
    exitCode: 0, signal: null, timedOut: false, sandbox: undefined,
  }, NO_ESCALATION)
  assert.equal(text, 'hello\n')
})

test('stderr 段 + 非零退出标记次序', () => {
  const text = renderResult({
    stdout: { text: 'out\n', truncated: false },
    stderr: { text: 'err\n', truncated: false },
    exitCode: 2, signal: null, timedOut: false, sandbox: undefined,
  }, NO_ESCALATION)
  assert.equal(text, 'out\n[stderr]\nerr\n[exit code: 2]')
})

test('超时与信号标记', () => {
  const text = renderResult({
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    exitCode: null, signal: 'SIGTERM', timedOut: true, timeoutMs: 1000, sandbox: undefined,
  }, NO_ESCALATION)
  assert.equal(text, '(no output)\n[timed out after 1000ms]\n[killed by signal: SIGTERM]')
})

test('截断输出追加 spill 提示', () => {
  const text = renderResult({
    stdout: { text: 'partial', truncated: true, spillPath: 'C:\\spill.txt' },
    stderr: { text: '', truncated: false },
    exitCode: 0, signal: null, timedOut: false, sandbox: undefined,
  }, NO_ESCALATION)
  assert.equal(text, 'partial\n[output truncated; full output: C:\\spill.txt]')
})

test('沙箱拒绝:拒绝标记 + 升权提示', () => {
  const text = renderResult({
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    exitCode: 1, signal: null, timedOut: false,
    sandbox: { mode: 'workspace-write', denied: true },
  }, ['read-only', 'workspace-write'])
  assert.match(text, /\[sandbox: file access denied under workspace-write mode\]/)
  assert.match(text, /sandbox_permissions/)
})

test('后台 read:lossy 丢弃提示带 spill 路径', () => {
  const text = renderProcessRead({
    delta: 'chunk',
    lossy: true,
    stdoutSpillPath: 'C:\\out.txt',
    stderrSpillPath: 'C:\\err.txt',
  }, undefined, NO_ESCALATION)
  assert.match(text, /some output was dropped from memory; full output: C:\\out\.txt, C:\\err\.txt/)
})

test('后台 read:runnerFailed 提示优先于 denial', () => {
  const text = renderProcessRead({ delta: '', lossy: false }, {
    mode: 'read-only', runnerFailed: true, denied: false,
  }, ['read-only'])
  assert.match(text, /sandbox runner itself failed/)
  assert.doesNotMatch(text, /file access denied/)
})
