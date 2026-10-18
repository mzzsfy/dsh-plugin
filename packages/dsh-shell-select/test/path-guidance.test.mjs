// bash 路径措辞测试:shellDescription 在 bash 形可用客户端在场时追加路径引导。
// BDD 场景见 docs/feat-shell-select-pathrescue/plan.md A 节。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shellDescription } from '../src/tool.mjs'

const FACES = { backgroundEnabled: true, escalationModes: [] }
const entry = (id, kind, available, distro = '') => ({ id, kind, available, distro })

// Given 用户自定义多个客户端且删除 pwsh；When 生成描述；Then 默认值优先，各 id 独立呈现环境。
test('动态客户端:默认值优先,多个 Bash 与 WSL 发行版独立列出', () => {
  const executor = { listShells: () => ({ default: 'bash-alt', shells: [
    entry('git-bash', 'bash', true), entry('bash-alt', 'bash', true),
    entry('ubuntu', 'wsl', true, 'Ubuntu'), entry('linux', 'wsl', true),
    entry('legacy', 'cmd', false),
  ] }) }
  const text = shellDescription({ executor, ...FACES })
  assert.ok(text.startsWith('Execute commands using shell="bash-alt" by default and return stdout/stderr.'))
  assert.match(text, /Omit shell to use the default; set it to one of:/)
  assert.match(text, /^- git-bash — Bash$/m)
  assert.match(text, /^- bash-alt — Bash$/m)
  assert.match(text, /^- ubuntu — WSL \(Ubuntu\)$/m)
  assert.match(text, /^- linux — WSL$/m)
  assert.match(text, /^- legacy — Windows cmd\.exe \(unavailable\)$/m)
  assert.doesNotMatch(text, /pwsh|PowerShell/)
})

// Given 仅有一个 PowerShell 客户端；When 配置默认值更新；Then 描述同步变化且无额外客户端。
test('单客户端:默认值及工作环境来自当前配置', () => {
  let listing = { default: 'office', shells: [entry('office', 'pwsh', true)] }
  const executor = { listShells: () => listing }
  assert.match(shellDescription({ executor, ...FACES }), /shell="office"[\s\S]*^- office — PowerShell$/m)
  listing = { default: 'console', shells: [entry('console', 'cmd', true)] }
  const text = shellDescription({ executor, ...FACES })
  assert.match(text, /shell="console"[\s\S]*^- console — Windows cmd\.exe$/m)
  assert.doesNotMatch(text, /office|PowerShell/)
})

// Given 升权面存在；When 生成模型主描述；Then 只讲常规调用，不注入拒绝重试流程。
test('主描述:常规调用说明不随升权面增加拒绝流程', () => {
  const executor = { listShells: () => ({ default: 'ps', shells: [entry('ps', 'pwsh', true)] }) }
  const text = shellDescription({ executor, ...FACES, escalationModes: ['workspace-write'] })
  assert.equal(text, shellDescription({ executor, ...FACES }))
  assert.match(text, /fresh process/)
  assert.match(text, /run_in_background=true/)
  assert.match(text, /job_output.*job_kill/)
  assert.match(text, /full-output file path/)
  assert.doesNotMatch(text, /retry|denial|sandbox_permissions|DSH_\*|exit code/)
})

// Given 后台执行未启用；When 生成描述；Then 不建议后台调用。
test('后台不可用:不展示后台参数或任务工具', () => {
  const executor = { listShells: () => ({ default: 'ps', shells: [entry('ps', 'pwsh', true)] }) }
  const text = shellDescription({ executor, ...FACES, backgroundEnabled: false })
  assert.doesNotMatch(text, /run_in_background|job_output|job_kill/)
  assert.match(text, /within the timeout/)
})

test('A1 含可用 bash 条目:描述含 Windows-style 路径措辞', () => {
  const executor = { listShells: () => ({ default: 'pwsh', shells: [entry('pwsh', 'pwsh', true), entry('git-bash', 'bash', true)] }) }
  const text = shellDescription({ executor, ...FACES })
  assert.match(text, /Windows-style paths/)
  assert.match(text, /Windows-style paths \(C:\/\.\.\.\) in workdir and file-tool arguments/)
})

test('A2 仅 pwsh/cmd:不含措辞', () => {
  const executor = { listShells: () => ({ default: 'pwsh', shells: [entry('pwsh', 'pwsh', true), entry('cmd', 'cmd', true)] }) }
  const text = shellDescription({ executor, ...FACES })
  assert.doesNotMatch(text, /Windows-style paths/)
})

test('A3 bash 条目不可执行:不含措辞(可执行性事实优先)', () => {
  const executor = { listShells: () => ({ default: 'pwsh', shells: [entry('pwsh', 'pwsh', true), entry('git-bash', 'bash', false)] }) }
  const text = shellDescription({ executor, ...FACES })
  assert.doesNotMatch(text, /Windows-style paths/)
})
