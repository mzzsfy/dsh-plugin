// bash 路径措辞测试:shellDescription 在 bash 形可用客户端在场时追加路径引导。
// BDD 场景见 docs/feat-shell-select-pathrescue/plan.md A 节。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shellDescription } from '../src/tool.mjs'

const FACES = { backgroundEnabled: true, escalationModes: [] }
const entry = (id, kind, available) => ({ id, kind, available })

test('A1 含可用 bash 条目:描述含 Windows-style 路径措辞', () => {
  const executor = { listShells: () => ({ default: 'pwsh', shells: [entry('pwsh', 'pwsh', true), entry('git-bash', 'bash', true)] }) }
  const text = shellDescription({ executor, ...FACES })
  assert.match(text, /Windows-style paths/)
  assert.match(text, /`workdir`/)
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
